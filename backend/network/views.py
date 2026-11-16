import asyncio
import logging
import math
from datetime import timedelta

from django.db.models import Avg, Count, Max, Q, Sum
from django.db.models.deletion import ProtectedError
from django.db.models.functions import Greatest, TruncHour, TruncMinute
from django.utils import timezone
from asgiref.sync import sync_to_async
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView

from eventwall.models import EventRecord
from eventwall.services import record_event
from ops.alerting import apply_alert_action
from ops.models import Alert, AlertAction
from rbac.permissions import RBACPermissionMixin, build_rbac_permission

from .alerting import ALERT_SOURCE
from .collector import collect_device_interfaces, collect_device_system, detect_vendor
from .models import DeviceMetricSample, InterfaceMetricSample, NetworkAlertRule, NetworkDevice, NetworkInterface, SnmpCredential
from .oids import OPER_STATUS_DOWN, OPER_STATUS_UP, SYSTEM_OIDS
from .serializers import (
    DeviceMetricSampleSerializer,
    InterfaceMetricSampleSerializer,
    NetworkAlertRuleSerializer,
    NetworkAlertSerializer,
    NetworkDeviceSerializer,
    NetworkInterfaceSerializer,
    SnmpCredentialSerializer,
)
from .snmp import SnmpError, snmp_get, target_from_device

logger = logging.getLogger(__name__)


def _audit(request, action_name, title, resource_type, instance, result='success', summary=''):
    record_event(
        request=request, module='network', category='config', action=action_name, title=title,
        summary=summary or title, result=result,
        severity='info' if result == 'success' else 'warning',
        resource_type=resource_type, resource_id=instance.pk if instance else '',
        resource_name=getattr(instance, 'name', str(instance)) if instance else '',
    )


def _parse_hours(request, default=24, max_hours=720):
    try:
        hours = float(request.query_params.get('hours', default))
    except (TypeError, ValueError):
        hours = default
    if not math.isfinite(hours):
        hours = default
    return min(max(hours, 0.5), max_hours)


def _metric_series(queryset, start, end, fields):
    """≤2h 原始点；≤48h 分钟桶；更久小时桶。AVG 看趋势，MAX 看尖峰。"""
    span_hours = (end - start).total_seconds() / 3600
    if span_hours <= 2:
        return [
            {'ts': sample.sampled_at.isoformat(), **{field: getattr(sample, field) for field in fields}}
            for sample in queryset.order_by('sampled_at')
        ]
    trunc = TruncMinute if span_hours <= 48 else TruncHour
    annotations = {}
    for field in fields:
        annotations[f'{field}_avg'] = Avg(field)
        annotations[f'{field}_max'] = Max(field)
    rows = (
        queryset.annotate(bucket=trunc('sampled_at'))
        .values('bucket')
        .annotate(**annotations)
        .order_by('bucket')
    )
    return [{'ts': row['bucket'].isoformat(), **{key: row[key] for key in annotations}} for row in rows]


class SnmpCredentialViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = SnmpCredential.objects.all()
    serializer_class = SnmpCredentialSerializer
    rbac_permissions = {
        'list': ['network.device.view'],
        'retrieve': ['network.device.view'],
        'create': ['network.device.manage'],
        'update': ['network.device.manage'],
        'partial_update': ['network.device.manage'],
        'destroy': ['network.device.manage'],
    }

    def perform_create(self, serializer):
        credential = serializer.save()
        _audit(self.request, 'create_credential', f'新建 SNMP 凭据：{credential.name}', 'snmp_credential', credential)

    def perform_update(self, serializer):
        credential = serializer.save()
        _audit(self.request, 'update_credential', f'更新 SNMP 凭据：{credential.name}', 'snmp_credential', credential)

    def perform_destroy(self, instance):
        if instance.devices.exists():
            raise ProtectedError('凭据仍被设备引用', set(instance.devices.all()))
        name = instance.name
        instance.delete()
        record_event(
            request=self.request, module='network', category='config', action='delete_credential',
            title=f'删除 SNMP 凭据：{name}', resource_type='snmp_credential', resource_name=name,
        )

    def handle_exception(self, exc):
        if isinstance(exc, ProtectedError):
            return Response({'detail': '该凭据仍被网络设备引用，请先调整设备凭据后再删除。'}, status=status.HTTP_400_BAD_REQUEST)
        return super().handle_exception(exc)


class NetworkDeviceViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = NetworkDevice.objects.select_related('credential').all()
    serializer_class = NetworkDeviceSerializer
    rbac_permissions = {
        'list': ['network.device.view'],
        'retrieve': ['network.device.view'],
        'create': ['network.device.manage'],
        'update': ['network.device.manage'],
        'partial_update': ['network.device.manage'],
        'destroy': ['network.device.manage'],
        'test': ['network.device.manage'],
        'poll': ['network.device.manage'],
        'interfaces': ['network.device.view'],
        'metrics': ['network.monitor.view'],
    }

    def get_queryset(self):
        queryset = super().get_queryset()
        params = self.request.query_params
        for field in ('device_type', 'vendor', 'status'):
            value = params.get(field, '').strip()
            if value:
                queryset = queryset.filter(**{field: value})
        search = params.get('search', '').strip()
        if search:
            queryset = queryset.filter(
                Q(name__icontains=search) | Q(mgmt_ip__icontains=search)
                | Q(model__icontains=search) | Q(location__icontains=search)
            )
        return queryset

    def perform_create(self, serializer):
        device = serializer.save()
        _audit(self.request, 'create_device', f'纳管网络设备：{device.name}', 'network_device', device,
               summary=f'{device.name} ({device.mgmt_ip}:{device.snmp_port}) 已纳管')

    def perform_update(self, serializer):
        device = serializer.save()
        _audit(self.request, 'update_device', f'更新网络设备：{device.name}', 'network_device', device)

    def perform_destroy(self, instance):
        name, mgmt_ip = instance.name, instance.mgmt_ip
        instance.delete()
        record_event(
            request=self.request, module='network', category='config', action='delete_device',
            title=f'移除网络设备：{name}', summary=f'{name} ({mgmt_ip}) 已移除，接口与历史样本一并清理',
            resource_type='network_device', resource_name=name,
        )

    @action(detail=True, methods=['post'])
    def test(self, request, pk=None):
        device = self.get_object()
        try:
            target = target_from_device(device, timeout=5, retries=1)
            values = asyncio.run(snmp_get(target, list(SYSTEM_OIDS.values())))
        except SnmpError as exc:
            _audit(request, 'test_device', f'测试设备连通性：{device.name}', 'network_device', device,
                   result='failed', summary=f'{device.name} SNMP 测试失败：{exc}')
            return Response({'reachable': False, 'error': str(exc)})
        sys_descr = str(values.get(SYSTEM_OIDS['sys_descr']) or '')
        uptime_ticks = values.get(SYSTEM_OIDS['sys_uptime'])
        payload = {
            'reachable': True,
            'sys_descr': sys_descr,
            'sys_name': str(values.get(SYSTEM_OIDS['sys_name']) or ''),
            'sys_uptime_seconds': int(uptime_ticks // 100) if isinstance(uptime_ticks, (int, float)) else None,
            'vendor_hint': detect_vendor(sys_descr),
        }
        _audit(request, 'test_device', f'测试设备连通性：{device.name}', 'network_device', device,
               summary=f'{device.name} SNMP 测试成功')
        return Response(payload)

    @action(detail=True, methods=['post'])
    def poll(self, request, pk=None):
        device = self.get_object()

        async def _poll():
            target = await sync_to_async(target_from_device, thread_sensitive=False)(device)
            device_status = await collect_device_system(device, target)
            interface_count = None
            if device_status == NetworkDevice.STATUS_ONLINE:
                interface_count = await collect_device_interfaces(device, target)
            return device_status, interface_count

        try:
            device_status, interface_count = asyncio.run(_poll())
        except SnmpError as exc:
            _audit(request, 'poll_device', f'手动采集设备：{device.name}', 'network_device', device,
                   result='failed', summary=f'{device.name} 手动采集失败：{exc}')
            return Response({'detail': f'采集失败：{exc}'}, status=status.HTTP_502_BAD_GATEWAY)
        device.refresh_from_db()
        _audit(request, 'poll_device', f'手动采集设备：{device.name}', 'network_device', device,
               summary=f'{device.name} 手动采集完成，状态 {device.status}，接口 {interface_count if interface_count is not None else 0} 个')
        return Response({'status': device.status, 'interface_count': interface_count})

    @action(detail=True, methods=['get'])
    def interfaces(self, request, pk=None):
        device = self.get_object()
        queryset = device.interfaces.all()
        oper_status = request.query_params.get('oper_status', '').strip()
        if oper_status:
            queryset = queryset.filter(oper_status=oper_status)
        return Response(NetworkInterfaceSerializer(queryset, many=True).data)

    @action(detail=True, methods=['get'])
    def metrics(self, request, pk=None):
        device = self.get_object()
        end = timezone.now()
        start = end - timedelta(hours=_parse_hours(request))
        queryset = DeviceMetricSample.objects.filter(device=device, sampled_at__gte=start, sampled_at__lte=end)
        series = _metric_series(queryset, start, end, ['cpu_pct', 'mem_pct', 'temperature'])
        return Response({'device': device.pk, 'start': start.isoformat(), 'end': end.isoformat(), 'series': series})


class NetworkInterfaceViewSet(RBACPermissionMixin, viewsets.ReadOnlyModelViewSet):
    queryset = NetworkInterface.objects.select_related('device').all()
    serializer_class = NetworkInterfaceSerializer
    rbac_permissions = {
        'list': ['network.device.view'],
        'retrieve': ['network.device.view'],
        'metrics': ['network.monitor.view'],
    }

    def get_queryset(self):
        queryset = super().get_queryset()
        params = self.request.query_params
        device = params.get('device', '').strip()
        if device:
            try:
                queryset = queryset.filter(device_id=int(device))
            except (TypeError, ValueError):
                return queryset.none()
        oper_status = params.get('oper_status', '').strip()
        if oper_status:
            try:
                queryset = queryset.filter(oper_status=int(oper_status))
            except (TypeError, ValueError):
                return queryset.none()
        search = params.get('search', '').strip()
        if search:
            queryset = queryset.filter(
                Q(name__icontains=search) | Q(alias__icontains=search) | Q(descr__icontains=search)
            )
        return queryset

    @action(detail=True, methods=['get'])
    def metrics(self, request, pk=None):
        interface = self.get_object()
        end = timezone.now()
        start = end - timedelta(hours=_parse_hours(request))
        queryset = InterfaceMetricSample.objects.filter(interface=interface, sampled_at__gte=start, sampled_at__lte=end)
        series = _metric_series(queryset, start, end, ['in_bps', 'out_bps', 'in_util', 'out_util'])
        return Response({'interface': interface.pk, 'start': start.isoformat(), 'end': end.isoformat(), 'series': series})


class NetworkAlertRuleViewSet(RBACPermissionMixin, viewsets.ModelViewSet):
    queryset = NetworkAlertRule.objects.select_related('device').all()
    serializer_class = NetworkAlertRuleSerializer
    rbac_permissions = {
        'list': ['network.alert.view'],
        'retrieve': ['network.alert.view'],
        'create': ['network.alert.manage'],
        'update': ['network.alert.manage'],
        'partial_update': ['network.alert.manage'],
        'destroy': ['network.alert.manage'],
    }

    def get_queryset(self):
        queryset = super().get_queryset()
        params = self.request.query_params
        target = params.get('target', '').strip()
        if target:
            queryset = queryset.filter(target=target)
        enabled = params.get('enabled', '').strip()
        if enabled in ('true', 'false'):
            queryset = queryset.filter(enabled=(enabled == 'true'))
        search = params.get('search', '').strip()
        if search:
            queryset = queryset.filter(name__icontains=search)
        return queryset

    def perform_create(self, serializer):
        rule = serializer.save()
        _audit(self.request, 'create_alert_rule', f'新建网络告警规则：{rule.name}', 'network_alert_rule', rule)

    def perform_update(self, serializer):
        rule = serializer.save()
        _audit(self.request, 'update_alert_rule', f'更新网络告警规则：{rule.name}', 'network_alert_rule', rule)

    def perform_destroy(self, instance):
        if instance.is_builtin:
            raise ProtectedError('内置告警规则不可删除', {instance})
        name = instance.name
        instance.delete()
        record_event(
            request=self.request, module='network', category='config', action='delete_alert_rule',
            title=f'删除网络告警规则：{name}', resource_type='network_alert_rule', resource_name=name,
        )

    def handle_exception(self, exc):
        if isinstance(exc, ProtectedError):
            return Response({'detail': '内置告警规则不可删除，如需停用请关闭启用开关。'}, status=status.HTTP_400_BAD_REQUEST)
        return super().handle_exception(exc)


class NetworkAlertViewSet(RBACPermissionMixin, viewsets.ReadOnlyModelViewSet):
    serializer_class = NetworkAlertSerializer
    rbac_permissions = {
        'list': ['network.alert.view'],
        'retrieve': ['network.alert.view'],
        'acknowledge': ['network.alert.manage'],
    }

    def get_queryset(self):
        queryset = Alert.objects.filter(source=ALERT_SOURCE)
        params = self.request.query_params
        status_param = params.get('status', '').strip()
        if status_param:
            queryset = queryset.filter(status=status_param)
        level = params.get('level', '').strip()
        if level:
            queryset = queryset.filter(level=level)
        device = params.get('device', '').strip()
        if device:
            queryset = queryset.filter(labels__device=device)
        search = params.get('search', '').strip()
        if search:
            queryset = queryset.filter(Q(title__icontains=search) | Q(resource__icontains=search))
        return queryset

    @action(detail=True, methods=['post'])
    def acknowledge(self, request, pk=None):
        alert = self.get_object()
        apply_alert_action(alert, AlertAction.ACTION_ACKNOWLEDGE, actor=request.user.username, request=request)
        alert.refresh_from_db()
        return Response(NetworkAlertSerializer(alert).data)


class NetworkOverviewView(APIView):
    permission_classes = [build_rbac_permission('network.monitor.view')]

    def get(self, request):
        devices = NetworkDevice.objects.all()
        device_status = {row['status']: row['count'] for row in devices.values('status').annotate(count=Count('id'))}
        interfaces = NetworkInterface.objects.all()
        up_interfaces = interfaces.filter(oper_status=OPER_STATUS_UP)
        top_util = list(
            up_interfaces.filter(speed_bps__gt=0)
            .annotate(util=Greatest('in_util', 'out_util'))
            .order_by('-util')[:10]
            .values('id', 'device_id', 'device__name', 'name', 'alias', 'speed_bps', 'in_bps', 'out_bps', 'in_util', 'out_util', 'util')
        )
        traffic = up_interfaces.aggregate(in_bps=Sum('in_bps'), out_bps=Sum('out_bps'))
        recent_events = [
            {
                'id': event.pk, 'occurred_at': event.occurred_at.isoformat(), 'action': event.action,
                'title': event.title, 'summary': event.summary, 'severity': event.severity,
                'result': event.result, 'resource_name': event.resource_name,
            }
            for event in EventRecord.objects.filter(module='network').order_by('-occurred_at')[:10]
        ]
        network_alerts = Alert.objects.filter(source=ALERT_SOURCE)
        active_alerts = network_alerts.filter(status=Alert.STATUS_ACTIVE)
        recent_alerts = [
            {
                'id': alert.pk, 'title': alert.title, 'level': alert.level, 'status': alert.status,
                'resource': alert.resource, 'metric_name': alert.metric_name,
                'is_acknowledged': alert.is_acknowledged,
                'starts_at': alert.starts_at.isoformat() if alert.starts_at else None,
                'created_at': alert.created_at.isoformat(),
            }
            for alert in network_alerts.order_by('-created_at')[:10]
        ]
        return Response({
            'devices': {
                'total': devices.count(),
                'online': device_status.get(NetworkDevice.STATUS_ONLINE, 0),
                'offline': device_status.get(NetworkDevice.STATUS_OFFLINE, 0),
                'unknown': device_status.get(NetworkDevice.STATUS_UNKNOWN, 0),
                'enabled': devices.filter(enabled=True).count(),
            },
            'device_types': list(devices.values('device_type').annotate(count=Count('id')).order_by('-count')),
            'vendors': list(devices.values('vendor').annotate(count=Count('id')).order_by('-count')),
            'interfaces': {
                'total': interfaces.count(),
                'up': up_interfaces.count(),
                'down': interfaces.filter(oper_status=OPER_STATUS_DOWN).count(),
            },
            'traffic': {'in_bps': traffic['in_bps'] or 0, 'out_bps': traffic['out_bps'] or 0},
            'top_utilization': top_util,
            'recent_events': recent_events,
            'alerts': {
                'active': active_alerts.count(),
                'critical': active_alerts.filter(level='critical').count(),
                'warning': active_alerts.filter(level='warning').count(),
                'acknowledged': active_alerts.filter(is_acknowledged=True).count(),
            },
            'recent_alerts': recent_alerts,
        })