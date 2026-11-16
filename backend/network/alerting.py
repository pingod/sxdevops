"""网络阈值告警评估：把越限指标喂入 ops 告警框架，复用其去重/通知/升级/静默能力。

防抖状态存 NetworkAlertState：指标持续越限达到规则 for_seconds 才触发 ops.Alert，
越限清除即恢复并删除状态行（历史告警留存于 ops.Alert 与事件墙）。同一 (规则,设备,接口)
用稳定 fingerprint 去重，一个越限周期只通知一次触发与一次恢复。
"""
import logging

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from eventwall.services import record_event
from ops.alerting import (
    apply_alert_suppression,
    apply_escalation_policy,
    dispatch_alert_notifications,
    upsert_alert,
)
from ops.models import Alert

from .models import NetworkAlertRule, NetworkAlertState, NetworkDevice
from .oids import ADMIN_STATUS_UP, OPER_STATUS_DOWN

logger = logging.getLogger(__name__)

ALERT_SOURCE = 'network-snmp'
POLLER_ACTOR = {'actor_username': 'network-poller', 'actor_display': '网络采集器'}

_OPERATORS = {
    'gt': lambda a, b: a > b,
    'gte': lambda a, b: a >= b,
    'lt': lambda a, b: a < b,
    'lte': lambda a, b: a <= b,
}


def _compare(value, operator, threshold):
    fn = _OPERATORS.get(operator)
    return bool(fn(value, threshold)) if fn else False


def _device_value(device, health, metric):
    if metric == 'offline':
        return 1.0 if device.status == NetworkDevice.STATUS_OFFLINE else 0.0
    return health.get(metric)


def _interface_value(interface, sample, metric):
    if metric == 'down':
        down = interface.admin_status == ADMIN_STATUS_UP and interface.oper_status == OPER_STATUS_DOWN
        return 1.0 if down else 0.0
    if metric in ('in_errors', 'out_errors'):
        return getattr(sample, metric, None) if sample is not None else None
    return getattr(interface, metric, None)


def _dedup_key(rule, device, interface):
    return f'{rule.pk}:{device.pk}:{interface.pk if interface else 0}'


def _resource(rule, device, interface):
    if interface is not None:
        return 'network_interface', f'{device.name}:{interface.name or interface.if_index}'
    return 'network_device', device.name


def _value_text(value):
    return value if value is not None else '无数据'


def _normalized(rule, device, interface, state, value, status):
    resource_type, resource = _resource(rule, device, interface)
    metric_label = rule.get_metric_display()
    operator = rule.get_operator_display()
    target = device.name + (f' {interface.name or interface.if_index}' if interface is not None else '')
    resolved = status == Alert.STATUS_RESOLVED
    if resolved:
        title = f'网络告警恢复：{rule.name}'
        message = f'{target} {metric_label} 已恢复正常（最近值 {_value_text(value)}，阈值 {operator} {rule.threshold}）。'
    else:
        title = f'网络告警：{rule.name}'
        message = f'{target} {metric_label} 当前 {_value_text(value)}，越限阈值 {operator} {rule.threshold}，峰值 {_value_text(state.peak_value)}。'
    now = timezone.now()
    return {
        'title': title,
        'level': rule.severity,
        'status': status,
        'source': ALERT_SOURCE,
        'source_type': Alert.SOURCE_GENERIC,
        'fingerprint': f'{ALERT_SOURCE}:{_dedup_key(rule, device, interface)}',
        'message': message,
        'resource_type': resource_type,
        'resource': resource,
        'metric_name': rule.metric,
        'labels': {
            'module': 'network', 'device': device.name, 'device_id': str(device.pk),
            'interface': (interface.name or str(interface.if_index)) if interface is not None else '',
            'rule': rule.name, 'rule_id': str(rule.pk), 'metric': rule.metric,
        },
        'annotations': {
            'threshold': str(rule.threshold), 'operator': operator,
            'value': str(_value_text(value)), 'peak': str(_value_text(state.peak_value)),
        },
        'starts_at': state.first_breach_at,
        'ends_at': now if resolved else None,
        'last_received_at': now,
    }


def _emit(rule, device, interface, state, value, status):
    normalized = _normalized(rule, device, interface, state, value, status)
    with transaction.atomic():
        alert, _ = upsert_alert(normalized, integration=None, actor='network-poller')
        apply_alert_suppression(alert)
        apply_escalation_policy(alert)
    dispatch_alert_notifications(alert, action='resolved' if status == Alert.STATUS_RESOLVED else 'fire')
    return alert


def _record(rule, device, interface, value, status):
    resource_type, resource = _resource(rule, device, interface)
    firing = status == Alert.STATUS_ACTIVE
    record_event(
        module='network', category='monitor',
        action='alert_firing' if firing else 'alert_resolved',
        title=f'网络告警{"触发" if firing else "恢复"}：{rule.name}',
        summary=f'{resource} {rule.get_metric_display()} {"越限" if firing else "恢复正常"}（值 {_value_text(value)}，阈值 {rule.get_operator_display()} {rule.threshold}）',
        severity=rule.severity if firing else 'info',
        resource_type=resource_type, resource_id=(interface.pk if interface is not None else device.pk),
        resource_name=resource,
        metadata={'rule_id': rule.pk, 'metric': rule.metric, 'value': value, 'threshold': rule.threshold},
        **POLLER_ACTOR,
    )


def _evaluate(rule, device, interface, value):
    now = timezone.now()
    key = _dedup_key(rule, device, interface)
    state = NetworkAlertState.objects.filter(dedup_key=key).first()
    breach = value is not None and _compare(value, rule.operator, rule.threshold)
    if breach:
        if state is None:
            state = NetworkAlertState(rule=rule, device=device, interface=interface, dedup_key=key, first_breach_at=now, peak_value=value)
        state.last_value = value
        state.peak_value = max(state.peak_value if state.peak_value is not None else value, value)
        state.last_evaluated_at = now
        if not state.fired and (now - state.first_breach_at).total_seconds() >= rule.for_seconds:
            alert = _emit(rule, device, interface, state, value, Alert.STATUS_ACTIVE)
            _record(rule, device, interface, value, Alert.STATUS_ACTIVE)
            state.fired = True
            state.fired_at = now
            state.alert = alert
        state.save()
    elif state is not None:
        if state.fired:
            _emit(rule, device, interface, state, value, Alert.STATUS_RESOLVED)
            _record(rule, device, interface, value, Alert.STATUS_RESOLVED)
        state.delete()


def evaluate_device_alerts(device, health):
    """系统采集后评估设备级规则；health 为 {} 时 CPU/内存/温度视为无数据并恢复，离线指标按状态判定。"""
    rules = NetworkAlertRule.objects.filter(enabled=True, target=NetworkAlertRule.TARGET_DEVICE).filter(
        Q(device__isnull=True) | Q(device=device))
    for rule in rules:
        try:
            _evaluate(rule, device, None, _device_value(device, health, rule.metric))
        except Exception:
            logger.exception('设备 %s 告警规则 %s 评估失败', device.name, rule.name)


def evaluate_interface_alerts(interface, sample=None):
    """接口采集后评估接口级规则；sample 提供错包增量，利用率/中断取自接口当前字段。"""
    device = interface.device
    rules = NetworkAlertRule.objects.filter(enabled=True, target=NetworkAlertRule.TARGET_INTERFACE).filter(
        Q(device__isnull=True) | Q(device=device))
    for rule in rules:
        try:
            _evaluate(rule, device, interface, _interface_value(interface, sample, rule.metric))
        except Exception:
            logger.exception('接口 %s 告警规则 %s 评估失败', interface, rule.name)