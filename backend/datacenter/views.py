"""三维机房项目 API 与只读查看器静态托管。

项目内容是「覆盖保存 + 乐观锁 + 快照」：设计器每次保存带 `base_version`，
版本不一致返回 409 让用户选择重新加载或另存；每次内容变化前留一份快照，
保留最近 30 个版本，可回滚为新的版本。
"""
import mimetypes
from pathlib import Path

from django.db import IntegrityError, transaction
from django.http import FileResponse, Http404, HttpResponse
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from eventwall.services import record_event
from rbac.permissions import RBACPermissionMixin, build_rbac_permission

from . import live
from .models import TwinProject, TwinProjectSnapshot
from .serializers import (
    MAX_PROJECT_BYTES, TwinMetaUpdateSerializer, TwinProjectSerializer,
    TwinProjectUpdateSerializer, TwinProjectUploadSerializer, TwinRollbackSerializer,
)

#: 仓库根/tools/dc-viewer/dist（本文件位于 backend/datacenter/）。
VIEWER_DIST_DIR = Path(__file__).resolve().parents[2] / 'tools' / 'dc-viewer' / 'dist'
VIEWER_PATH = '/dc-viewer-app/'
#: 机房 CAD 设计器（tools/dc-designer 的独立构建产物，含 inspect/ 检视子应用）。
DESIGNER_DIST_DIR = Path(__file__).resolve().parents[2] / 'tools' / 'dc-designer' / 'dist'
DESIGNER_PATH = '/dc-designer-app/'
IMMUTABLE_SUFFIXES = {'.js', '.css', '.wasm', '.webp', '.png', '.svg', '.woff2'}
MIME_OVERRIDES = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
}


def _audit(request, action_name, title, *, resource_id='', resource_name='', summary=''):
    record_event(
        request=request, module='datacenter', category='config', action=action_name, title=title,
        summary=summary or title, result='success', severity='info',
        resource_module='datacenter', resource_type='twin_project',
        resource_id=str(resource_id or ''), resource_name=resource_name or '',
    )


def _snapshot_of(project, editor=''):
    return TwinProjectSnapshot(
        project=project, version=project.version, content=project.content,
        object_count=project.object_count, size_bytes=project.size_bytes,
        checksum=project.checksum, created_by=editor or project.updated_by or '',
    )


def _prune_snapshots(project):
    keep = list(
        project.snapshots.order_by('-version').values_list('id', flat=True)[:TwinProjectSnapshot.SNAPSHOT_KEEP]
    )
    if keep:
        project.snapshots.exclude(id__in=keep).delete()


def _version_conflict(project):
    return Response(
        {
            'code': 'version_conflict',
            'detail': f'项目已被 {project.updated_by or "他人"} 更新到 v{project.version}',
            'current_version': project.version,
            'updated_by': project.updated_by,
            'updated_at': project.updated_at,
        },
        status=status.HTTP_409_CONFLICT,
    )


def _require_base_version(request):
    raw = request.data.get('base_version')
    if raw in (None, ''):
        raise ValidationError({'base_version': ['保存必须携带 base_version（当前内容版本）。']})
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ValidationError({'base_version': ['base_version 必须是整数。']}) from exc


class TwinProjectViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = TwinProject.objects.all()
    serializer_class = TwinProjectSerializer
    # 设计器按 id 覆盖保存项目；改名/换内容都走 update，PATCH 只改元数据。
    http_method_names = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['name', 'description', 'project_name']
    ordering_fields = ['updated_at', 'created_at', 'name', 'object_count']
    ordering = ['-updated_at']
    rbac_permissions = {
        'list': ('datacenter.twin.view',),
        'retrieve': ('datacenter.twin.view',),
        'content': ('datacenter.twin.view',),
        'versions': ('datacenter.twin.view',),
        'version_content': ('datacenter.twin.view',),
        'live': ('datacenter.twin.view',),
        'create': ('datacenter.twin.manage',),
        'update': ('datacenter.twin.manage',),
        'partial_update': ('datacenter.twin.manage',),
        'rollback': ('datacenter.twin.manage',),
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
        pk = kwargs.get('pk')
        base_version = _require_base_version(request)
        with transaction.atomic():
            # 先锁行再比版本：校验本身要查库，不锁会把「校验期间被改」也算成成功。
            project = TwinProject.objects.select_for_update().get(pk=pk)
            if base_version != project.version:
                return _version_conflict(project)

            serializer = TwinProjectUpdateSerializer(instance=project, data=request.data)
            serializer.is_valid(raise_exception=True)
            old = serializer.old_state()
            editor = request.user.username
            if old['checksum'] != serializer.validated_data['parsed']['checksum']:
                _snapshot_of(project, editor).save()
            project = serializer.apply(editor)
            _prune_snapshots(project)

        _audit(
            request, 'update_twin_project', '更新三维机房项目',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：{project.object_count} 个对象，{project.size_bytes / 1024:.0f} KB，v{project.version}',
        )
        return Response(TwinProjectSerializer(project).data)

    def partial_update(self, request, *args, **kwargs):
        project = self.get_object()
        serializer = TwinMetaUpdateSerializer(instance=project, data=request.data, partial=True)
        serializer.context['editor'] = request.user.username
        serializer.is_valid(raise_exception=True)
        project = serializer.save()
        _audit(
            request, 'rename_twin_project', '修改三维机房项目信息',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}（v{project.version} 内容未变）',
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

    @action(detail=True, methods=['get'])
    def versions(self, request, pk=None):
        project = self.get_object()
        rows = project.snapshots.order_by('-version').values(
            'version', 'object_count', 'size_bytes', 'created_by', 'created_at',
        )
        return Response([
            {
                'version': row['version'],
                'object_count': row['object_count'],
                'size_bytes': row['size_bytes'],
                'created_by': row['created_by'],
                'created_at': row['created_at'],
            }
            for row in rows
        ])

    @action(detail=True, methods=['get'], url_path=r'versions/(?P<version>\d+)/content')
    def version_content(self, request, pk=None, version=None):
        project = self.get_object()
        snapshot = project.snapshots.filter(version=int(version)).first()
        if snapshot is None:
            raise Http404('该版本不存在')
        response = HttpResponse(snapshot.content, content_type='application/json; charset=utf-8')
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response

    @action(detail=True, methods=['post'])
    def rollback(self, request, pk=None):
        """回滚 = 把目标版本内容写成新版本；当前内容先进快照，回滚本身可再回滚。"""
        serializer = TwinRollbackSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target_version = serializer.validated_data['version']
        with transaction.atomic():
            project = TwinProject.objects.select_for_update().get(pk=pk)
            snapshot = project.snapshots.filter(version=target_version).first()
            if snapshot is None:
                raise ValidationError({'version': [f'版本 v{target_version} 不存在。']})
            editor = request.user.username
            _snapshot_of(project, editor).save()
            project.content = snapshot.content
            project.object_count = snapshot.object_count
            project.size_bytes = snapshot.size_bytes
            project.checksum = snapshot.checksum
            project.version = (project.version or 0) + 1
            project.updated_by = editor
            project.save()
            _prune_snapshots(project)

        _audit(
            request, 'rollback_twin_project', '回滚三维机房项目',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：回滚到 v{target_version}，当前 v{project.version}',
        )
        return Response(TwinProjectSerializer(project).data)

    @action(detail=True, methods=['get'])
    def live(self, request, pk=None):
        """机柜实时状态：服务端聚合，前端只按状态着色。"""
        project = self.get_object()
        return Response(live.build_live_payload(project))


class TwinMonitorTargetsView(APIView):
    """设计器绑定下拉：只暴露名称/位置/在线状态，不返回 IP 与凭据。"""

    permission_classes = [IsAuthenticated, build_rbac_permission('datacenter.twin.view')]

    def get(self, request):
        return Response({'items': live.monitor_targets()})


class TwinViewerStatusView(APIView):
    permission_classes = [IsAuthenticated, build_rbac_permission('datacenter.twin.view')]

    def get(self, request):
        return Response({
            'viewer_built': (VIEWER_DIST_DIR / 'index.html').is_file(),
            'designer_built': (VIEWER_DIST_DIR / 'design.html').is_file(),
            'cad_designer_built': (DESIGNER_DIST_DIR / 'index.html').is_file(),
            'viewer_path': VIEWER_PATH,
            'cad_designer_path': DESIGNER_PATH,
            'max_upload_bytes': MAX_PROJECT_BYTES,
        })


def _viewer_file(rel_path, cache_control, dist_dir=None):
    dist_root = (dist_dir or VIEWER_DIST_DIR).resolve()
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
    return _viewer_file(rel, cache_control, VIEWER_DIST_DIR)


def dc_designer_app(request, path=''):
    """托管机房 CAD 设计器构建产物（含 inspect/ 检视子应用）。"""
    if not (DESIGNER_DIST_DIR / 'index.html').is_file():
        raise Http404('机房设计器未构建：请在 tools/dc-designer 执行 npm install && npm run build')
    rel = (path or '').strip('/')
    if not rel:
        return _viewer_file('index.html', 'no-cache, no-store, must-revalidate', DESIGNER_DIST_DIR)
    if rel.endswith('/') or (DESIGNER_DIST_DIR / rel).is_dir():
        rel = rel.rstrip('/') + '/index.html'
    suffix = Path(rel).suffix.lower()
    cache_control = 'public, max-age=31536000, immutable' if suffix in IMMUTABLE_SUFFIXES else 'no-cache'
    return _viewer_file(rel, cache_control, DESIGNER_DIST_DIR)
