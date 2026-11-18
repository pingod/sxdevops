"""规划模块 HTTP 接缝：RBAC 认证反代、状态端点、前端静态托管。

数据接口一律走平台 DRF Token + RBAC；引擎默认只监听 127.0.0.1（Compose
内绑定容器接口、不发布宿主机端口），无会话概念，平台 Token 不下发给引擎。
静态资源不含业务数据，无需鉴权（与 NAP 一致）。
"""
from __future__ import annotations

import logging
import mimetypes
import re
from pathlib import Path
from urllib.parse import parse_qsl

import requests
from django.http import FileResponse, Http404, HttpResponse, StreamingHttpResponse
from rest_framework.negotiation import DefaultContentNegotiation
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from eventwall.models import EventRecord
from eventwall.services import record_event
from rbac.permissions import RBACPermission, build_rbac_permission

from .config import load_config
from .supervisor import probe_health

logger = logging.getLogger('planning')

SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS'}
HOP_HEADERS = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length',
}

# 只有真正落库的端点才记审计；intent/check、row、paste 等 POST 是纯计算，
# 每次单元格编辑都会触发，记进去只会淹没事件墙。
PERSISTING_ROUTES = [
    ('POST', re.compile(r'^api/projects/?$'), 'create_project', '新建规划项目', ''),
    ('PUT', re.compile(r'^api/projects/([^/]+)/intent/?$'), 'save_intent', '保存规划意图版本', 1),
    ('POST', re.compile(r'^api/models/import/?$'), 'import_models', '导入规划型号库', ''),
]


class PlanningProxyPermission(RBACPermission):
    required_permissions = ('datacenter.planning.view', 'datacenter.planning.manage')

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            self.required_permissions = ('datacenter.planning.view',)
        else:
            self.required_permissions = ('datacenter.planning.manage',)
        return super().has_permission(request, view)


def _persisting_audit(method: str, engine_path: str):
    for route_method, pattern, action, title, name_group in PERSISTING_ROUTES:
        match = pattern.match(engine_path)
        if route_method == method and match:
            resource_name = match.group(name_group) if name_group else ''
            return action, title, resource_name
    return None


class ProxyContentNegotiation(DefaultContentNegotiation):
    # 引擎有自己的 ?format=json|text 查询参数（标签打印直出文本）。
    # DRF 默认会拿 format 参数挑渲染器，挑不到就 404；代理透传上游
    # 字节与 Content-Type，渲染器根本不参与，协商必须直通。
    def select_renderer(self, request, renderers, format_suffix=None):
        return renderers[0], renderers[0].media_type


class PlanningProxyView(APIView):
    permission_classes = [IsAuthenticated, PlanningProxyPermission]
    content_negotiation_class = ProxyContentNegotiation

    def get(self, request, engine_path=''):
        return self._proxy(request, engine_path)

    def post(self, request, engine_path=''):
        return self._proxy(request, engine_path)

    def put(self, request, engine_path=''):
        return self._proxy(request, engine_path)

    def patch(self, request, engine_path=''):
        return self._proxy(request, engine_path)

    def delete(self, request, engine_path=''):
        return self._proxy(request, engine_path)

    def _proxy(self, request, engine_path: str):
        engine_path = (engine_path or '').lstrip('/')
        if not engine_path.startswith('api/'):
            raise Http404('规划代理仅转发引擎 /api/ 接口')
        cfg = load_config()
        if not cfg.enabled:
            return Response({'detail': '规划模块未启用（PLANNING_ENABLED=false）。'}, status=503)
        if cfg.error:
            return Response({'detail': f'规划引擎未配置：{cfg.error}'}, status=503)

        headers = {}
        if request.META.get('CONTENT_TYPE'):
            headers['Content-Type'] = request.META['CONTENT_TYPE']
        if request.META.get('HTTP_ACCEPT'):
            headers['Accept'] = request.META['HTTP_ACCEPT']
        try:
            upstream = requests.request(
                request.method,
                f'{cfg.base_url}/{engine_path}',
                params=parse_qsl(request.META.get('QUERY_STRING', ''), keep_blank_values=True),
                data=None if request.method in SAFE_METHODS else request.body,
                headers=headers,
                timeout=(5, 120),
                stream=True,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            logger.warning('规划引擎请求失败 %s /%s: %s', request.method, engine_path, exc)
            return Response({'detail': f'规划引擎不可用，请稍后重试或联系管理员检查引擎进程。{exc}'}, status=503)

        audit = _persisting_audit(request.method, engine_path)
        if audit:
            action, title, resource_name = audit
            ok = 200 <= upstream.status_code < 300
            record_event(
                request=request,
                module='planning',
                category='config',
                action=action,
                title=title,
                summary=f'{request.method} /{engine_path} → {upstream.status_code}',
                result=EventRecord.RESULT_SUCCESS if ok else EventRecord.RESULT_FAILED,
                severity=EventRecord.SEVERITY_INFO if ok else EventRecord.SEVERITY_WARNING,
                resource_type='planning_project',
                resource_name=resource_name,
            )

        def _stream():
            try:
                yield from upstream.iter_content(chunk_size=64 * 1024)
            finally:
                # 客户端中断时也要释放上游连接，否则 stream=True 的连接要等 GC。
                upstream.close()

        response = StreamingHttpResponse(
            _stream(),
            status=upstream.status_code,
        )
        for key, value in upstream.headers.items():
            if key.lower() not in HOP_HEADERS:
                response[key] = value
        return response


class PlanningStatusView(APIView):
    permission_classes = [IsAuthenticated, build_rbac_permission('datacenter.planning.view')]

    def get(self, request):
        cfg = load_config()
        payload = {
            'enabled': cfg.enabled,
            'state': 'disabled',
            'error': cfg.error,
            'port': cfg.port,
            'root': str(cfg.root) if cfg.root else '',
            'db_path': str(cfg.db_path),
            'static_built': bool(cfg.static_dir and (cfg.static_dir / 'index.html').is_file()),
            'engine_reachable': False,
        }
        if cfg.enabled and not cfg.error:
            ok, detail = probe_health(cfg, timeout=1.5)
            payload['engine_reachable'] = ok
            payload['state'] = 'up' if ok else 'down'
            if not ok:
                payload['error'] = detail
        return Response(payload)


def _serve_dist_file(target: Path, cache_control: str) -> FileResponse:
    content_type, _ = mimetypes.guess_type(target.name)
    response = FileResponse(open(target, 'rb'), content_type=content_type)
    response['Cache-Control'] = cache_control
    return response


def planning_app(request, path: str = ''):
    """托管规划前端构建产物（/planning-app/），SPA 回退到 index.html。"""
    cfg = load_config()
    dist = cfg.static_dir
    if dist is None or not (dist / 'index.html').is_file():
        return HttpResponse(
            '<!doctype html><meta charset="utf-8"><title>规划前端未构建</title>'
            '<body style="font-family:system-ui;padding:48px">'
            '<h1>规划前端未构建</h1>'
            '<p>请在 <code>planning/web</code> 执行 <code>pnpm install</code> 后运行 '
            '<code>VITE_BASE=/planning-app/ VITE_API_BASE=/api/planning pnpm build</code>，'
            '或用 <code>PLANNING_STATIC_DIR</code> 指向已构建的 dist 目录。</p></body>',
            status=503,
            content_type='text/html; charset=utf-8',
        )
    rel = (path or '').lstrip('/')
    dist = dist.resolve()
    target = (dist / rel).resolve() if rel else dist / 'index.html'
    if dist not in target.parents and target != dist:
        raise Http404('Invalid planning asset path')
    if rel and target.is_file():
        cache = 'public, max-age=31536000, immutable' if rel.startswith('assets/') else 'no-cache'
        return _serve_dist_file(target, cache)
    if rel and '.' in Path(rel).name:
        raise Http404('Planning asset not found')
    response = _serve_dist_file(dist / 'index.html', 'no-cache, no-store, must-revalidate')
    response['Content-Security-Policy'] = "frame-ancestors 'self'"
    return response