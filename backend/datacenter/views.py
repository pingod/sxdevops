"""三维机房项目 API 与只读查看器静态托管。

查看器是独立构建产物（`tools/dc-viewer/dist`），由 Django 同源托管在
`/dc-viewer-app/`，页面用 iframe 承载——它的全屏画布、fixed 遮罩、全局快捷键
和独立 CSS 令牌不该侵入 Vue 应用壳层。
"""
import mimetypes
from pathlib import Path

from django.db import IntegrityError
from django.http import FileResponse, Http404, HttpResponse
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from eventwall.services import record_event
from rbac.permissions import RBACPermissionMixin, build_rbac_permission

from .models import TwinProject
from .serializers import (
    MAX_PROJECT_BYTES, TwinProjectSerializer, TwinProjectUpdateSerializer, TwinProjectUploadSerializer,
)

#: 仓库根/tools/dc-viewer/dist（本文件位于 backend/datacenter/）。
VIEWER_DIST_DIR = Path(__file__).resolve().parents[2] / 'tools' / 'dc-viewer' / 'dist'
VIEWER_PATH = '/dc-viewer-app/'
IMMUTABLE_SUFFIXES = {'.js', '.css', '.wasm', '.webp', '.png', '.svg', '.woff2'}
MIME_OVERRIDES = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.webp': 'image/webp',
}


def _audit(request, action_name, title, *, resource_id='', resource_name='', summary=''):
    record_event(
        request=request, module='datacenter', category='config', action=action_name, title=title,
        summary=summary or title, result='success', severity='info',
        resource_module='datacenter', resource_type='twin_project',
        resource_id=str(resource_id or ''), resource_name=resource_name or '',
    )


class TwinProjectViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = TwinProject.objects.all()
    serializer_class = TwinProjectSerializer
    # 设计器按 id 覆盖保存项目；改名/换内容都走 update，不走「同名新建」。
    http_method_names = ['get', 'post', 'put', 'delete', 'head', 'options']
    rbac_permissions = {
        'list': ('datacenter.twin.view',),
        'retrieve': ('datacenter.twin.view',),
        'content': ('datacenter.twin.view',),
        'create': ('datacenter.twin.manage',),
        'update': ('datacenter.twin.manage',),
        'destroy': ('datacenter.twin.manage',),
    }

    def create(self, request, *args, **kwargs):
        serializer = TwinProjectUploadSerializer(data=request.data)
        serializer.context['uploader'] = request.user.username
        serializer.is_valid(raise_exception=True)
        try:
            project = serializer.save()
        except IntegrityError:
            # 并发上传同名项目：唯一约束兜底，返回 400 而不是 500。
            return Response({'name': ['项目名称已存在。']}, status=status.HTTP_400_BAD_REQUEST)
        _audit(
            request, 'upload_twin_project', '上传三维机房项目',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：{project.object_count} 个对象，{project.size_bytes / 1024:.0f} KB',
        )
        return Response(TwinProjectSerializer(project).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        project = self.get_object()
        serializer = TwinProjectUpdateSerializer(instance=project, data=request.data)
        serializer.is_valid(raise_exception=True)
        project = serializer.save()
        _audit(
            request, 'update_twin_project', '更新三维机房项目',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：{project.object_count} 个对象，{project.size_bytes / 1024:.0f} KB',
        )
        return Response(TwinProjectSerializer(project).data)

    def destroy(self, request, *args, **kwargs):
        project = self.get_object()
        resource_id, resource_name, object_count = project.pk, project.name, project.object_count
        response = super().destroy(request, *args, **kwargs)
        _audit(
            request, 'delete_twin_project', '删除三维机房项目',
            resource_id=resource_id, resource_name=resource_name,
            summary=f'{resource_name}：{object_count} 个对象',
        )
        return response

    @action(detail=True, methods=['get'])
    def content(self, request, pk=None):
        """原样返回项目 JSON；前端取到后转 Blob URL 交给 iframe，令牌不出前端。"""
        project = self.get_object()
        response = HttpResponse(project.content, content_type='application/json; charset=utf-8')
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class TwinViewerStatusView(APIView):
    permission_classes = [IsAuthenticated, build_rbac_permission('datacenter.twin.view')]

    def get(self, request):
        return Response({
            'viewer_built': (VIEWER_DIST_DIR / 'index.html').is_file(),
            'viewer_path': VIEWER_PATH,
            'max_upload_bytes': MAX_PROJECT_BYTES,
        })


def _viewer_file(rel_path, cache_control):
    dist_root = VIEWER_DIST_DIR.resolve()
    target = (dist_root / rel_path).resolve()
    if target != dist_root and dist_root not in target.parents:
        raise Http404('Invalid viewer asset path')
    if not target.is_file():
        raise Http404('Viewer asset not found')
    suffix = target.suffix.lower()
    content_type = MIME_OVERRIDES.get(suffix) or mimetypes.guess_type(target.name)[0]
    response = FileResponse(open(target, 'rb'), content_type=content_type)
    response['Cache-Control'] = cache_control
    response['X-Content-Type-Options'] = 'nosniff'
    response['Referrer-Policy'] = 'no-referrer'
    return response


def dc_viewer_app(request, path=''):
    """托管查看器构建产物；未构建时给 404 并说明构建命令。"""
    rel = (path or '').strip('/')
    if not rel:
        return _viewer_file('index.html', 'no-cache, no-store, must-revalidate')
    if not (VIEWER_DIST_DIR / 'index.html').is_file():
        raise Http404('三维查看器未构建：请在 tools/dc-viewer 执行 npm install && npm run build')
    suffix = Path(rel).suffix.lower()
    cache_control = 'public, max-age=31536000, immutable' if suffix in IMMUTABLE_SUFFIXES else 'no-cache'
    return _viewer_file(rel, cache_control)
