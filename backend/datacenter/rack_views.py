"""机柜布设方案 API：覆盖保存 + 乐观锁 + 快照。

与三维机房项目库同一套版本语义：每次保存携带 `base_version`，版本不一致
返回 409；内容变化前留一份快照，保留最近 30 个版本，回滚写为新版本。
"""
from django.db import IntegrityError, transaction
from django.http import Http404, HttpResponse
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.response import Response

from eventwall.services import record_event
from rbac.permissions import RBACPermissionMixin

from .models import RackProject, RackProjectSnapshot
from .rack_serializers import (
    RackMetaUpdateSerializer, RackProjectCreateSerializer, RackProjectSerializer,
    RackProjectUpdateSerializer, RackRollbackSerializer,
)


def _audit(request, action_name, title, *, resource_id='', resource_name='', summary=''):
    record_event(
        request=request, module='datacenter', category='config', action=action_name, title=title,
        summary=summary or title, result='success', severity='info',
        resource_module='datacenter', resource_type='rack_project',
        resource_id=str(resource_id or ''), resource_name=resource_name or '',
    )


def _snapshot_of(project, editor=''):
    return RackProjectSnapshot(
        project=project, version=project.version, content=project.content,
        device_count=project.device_count, used_u=project.used_u,
        size_bytes=project.size_bytes, checksum=project.checksum,
        created_by=editor or project.updated_by or '',
    )


def _prune_snapshots(project):
    keep = list(
        project.snapshots.order_by('-version').values_list('id', flat=True)[
            :RackProjectSnapshot.SNAPSHOT_KEEP
        ]
    )
    if keep:
        project.snapshots.exclude(id__in=keep).delete()


def _version_conflict(project):
    return Response(
        {
            'code': 'version_conflict',
            'detail': f'方案已被 {project.updated_by or "他人"} 更新到 v{project.version}',
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


class RackProjectViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = RackProject.objects.all()
    serializer_class = RackProjectSerializer
    http_method_names = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
    filter_backends = [SearchFilter, OrderingFilter]
    search_fields = ['name', 'description']
    ordering_fields = ['updated_at', 'created_at', 'name', 'device_count', 'used_u']
    ordering = ['-updated_at']
    rbac_permissions = {
        'list': ('datacenter.rack.view',),
        'retrieve': ('datacenter.rack.view',),
        'content': ('datacenter.rack.view',),
        'versions': ('datacenter.rack.view',),
        'version_content': ('datacenter.rack.view',),
        'create': ('datacenter.rack.manage',),
        'update': ('datacenter.rack.manage',),
        'partial_update': ('datacenter.rack.manage',),
        'rollback': ('datacenter.rack.manage',),
        'destroy': ('datacenter.rack.manage',),
    }

    def create(self, request, *args, **kwargs):
        serializer = RackProjectCreateSerializer(data=request.data)
        serializer.context['owner'] = request.user.username
        serializer.is_valid(raise_exception=True)
        try:
            project = serializer.save()
        except IntegrityError:
            return Response({'name': ['方案名称已存在。']}, status=status.HTTP_400_BAD_REQUEST)
        _audit(
            request, 'create_rack_project', '新建机柜布设方案',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：{project.rack_kind}，{project.device_count} 台设备',
        )
        return Response(RackProjectSerializer(project).data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        pk = kwargs.get('pk')
        base_version = _require_base_version(request)
        with transaction.atomic():
            try:
                project = RackProject.objects.select_for_update().get(pk=pk)
            except RackProject.DoesNotExist as exc:
                raise Http404('机柜布设方案不存在') from exc
            if base_version != project.version:
                return _version_conflict(project)

            serializer = RackProjectUpdateSerializer(instance=project, data=request.data)
            serializer.is_valid(raise_exception=True)
            old = serializer.old_state()
            editor = request.user.username
            if old['checksum'] != serializer.validated_data['parsed']['checksum']:
                _snapshot_of(project, editor).save()
            project = serializer.apply(editor)
            _prune_snapshots(project)

        _audit(
            request, 'update_rack_project', '更新机柜布设方案',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：{project.device_count} 台设备，占用 {project.used_u}U，v{project.version}',
        )
        return Response(RackProjectSerializer(project).data)

    def partial_update(self, request, *args, **kwargs):
        project = self.get_object()
        serializer = RackMetaUpdateSerializer(instance=project, data=request.data, partial=True)
        serializer.context['editor'] = request.user.username
        serializer.is_valid(raise_exception=True)
        project = serializer.save()
        _audit(
            request, 'rename_rack_project', '修改机柜布设方案信息',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}（v{project.version} 内容未变）',
        )
        return Response(RackProjectSerializer(project).data)

    def destroy(self, request, *args, **kwargs):
        project = self.get_object()
        resource_id, resource_name = project.pk, project.name
        response = super().destroy(request, *args, **kwargs)
        _audit(
            request, 'delete_rack_project', '删除机柜布设方案',
            resource_id=resource_id, resource_name=resource_name,
            summary=resource_name,
        )
        return response

    @action(detail=True, methods=['get'])
    def content(self, request, pk=None):
        project = self.get_object()
        response = HttpResponse(project.content, content_type='application/json; charset=utf-8')
        response['Cache-Control'] = 'no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response

    @action(detail=True, methods=['get'])
    def versions(self, request, pk=None):
        project = self.get_object()
        rows = project.snapshots.order_by('-version').values(
            'version', 'device_count', 'used_u', 'size_bytes', 'created_by', 'created_at',
        )
        return Response([
            {
                'version': row['version'],
                'device_count': row['device_count'],
                'used_u': row['used_u'],
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
        serializer = RackRollbackSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        target_version = serializer.validated_data['version']
        with transaction.atomic():
            try:
                project = RackProject.objects.select_for_update().get(pk=pk)
            except RackProject.DoesNotExist as exc:
                raise Http404('机柜布设方案不存在') from exc
            snapshot = project.snapshots.filter(version=target_version).first()
            if snapshot is None:
                raise ValidationError({'version': [f'版本 v{target_version} 不存在。']})
            editor = request.user.username
            _snapshot_of(project, editor).save()
            project.content = snapshot.content
            project.device_count = snapshot.device_count
            project.used_u = snapshot.used_u
            project.size_bytes = snapshot.size_bytes
            project.checksum = snapshot.checksum
            project.version = (project.version or 0) + 1
            project.updated_by = editor
            project.save()
            _prune_snapshots(project)

        _audit(
            request, 'rollback_rack_project', '回滚机柜布设方案',
            resource_id=project.pk, resource_name=project.name,
            summary=f'{project.name}：回滚到 v{target_version}，当前 v{project.version}',
        )
        return Response(RackProjectSerializer(project).data)