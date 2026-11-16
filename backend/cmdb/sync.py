from contextlib import contextmanager
import ipaddress
from threading import local
from urllib.parse import urlparse

from django.db.models import Q
from django.utils import timezone

from .models import CISourceMapping, CIType, ConfigItem


_SYNC_STATE = local()
HOST_SOURCE_TYPE = 'host_asset'
HOST_SOURCE_ACCOUNT = 'sxdevops'
HOST_SOURCE_REGION = 'local'


def _garbled_utf8_as_gbk(value):
    return value.encode('utf-8').decode('gbk', errors='ignore')

CI_TYPE_NAME_ALIASES = {
    _garbled_utf8_as_gbk('应用服务'): '应用服务',
    'Docker 环境': 'Docker环境',
    _garbled_utf8_as_gbk('Docker环境'): 'Docker环境',
    'K8s集群': 'K8s 集群',
    _garbled_utf8_as_gbk('K8s集群'): 'K8s 集群',
    '云主机': '云主机(ECS)',
    '机房服务器': '物理机',
}

HOST_LIKE_CI_TYPE_NAMES = {
    '云主机(ECS)',
    '云主机',
    '机房服务器',
    '主机',
    '物理机/宿主机',
    '物理机',
    'Host',
}

HOST_LIKE_CI_TYPE_CODES = {
    'CLOUD_SERVER',
    'IDC_SERVER',
    'PHYSICAL_SERVER',
}

CI_IP_ATTRIBUTE_CANDIDATES = (
    'ip_address',
    'private_ip',
    'public_ip',
    'host_ip',
    'docker_environment_ip',
)


def normalize_ci_type_name(name):
    normalized = (name or '').strip()
    if not normalized:
        return normalized
    return CI_TYPE_NAME_ALIASES.get(normalized, normalized)


def is_placeholder_ci_type_name(name):
    normalized = (name or '').strip()
    if not normalized:
        return True
    if set(normalized) == {'?'}:
        return True
    return '\ufffd' in normalized


def _attribute_text(value):
    if value in (None, ''):
        return ''
    if isinstance(value, (list, tuple, set)):
        # 云同步/字段映射可能产出数组；取第一个可读值，避免把 "['1.2.3.4']" 当 IP。
        for item in value:
            text = _attribute_text(item)
            if text:
                return text
        return ''
    if isinstance(value, dict):
        return ''
    return str(value).strip()


def infer_ci_ip_address(attributes):
    attrs = dict(attributes or {})
    for key in CI_IP_ATTRIBUTE_CANDIDATES:
        value = _attribute_text(attrs.get(key))
        if value:
            return value
    api_server = _attribute_text(attrs.get('api_server'))
    if api_server:
        hostname = (urlparse(api_server).hostname or '').strip()
        if hostname:
            try:
                return str(ipaddress.ip_address(hostname))
            except ValueError:
                return ''
    return ''


def normalize_ci_attributes(attributes):
    attrs = dict(attributes or {})
    inferred_ip = infer_ci_ip_address(attrs)
    if inferred_ip and not attrs.get('ip_address'):
        attrs['ip_address'] = inferred_ip
    return attrs


def is_host_like_ci(config_item):
    ci_type = getattr(config_item, 'ci_type', None)
    ci_type_code = (getattr(ci_type, 'code', '') or '').strip()
    if ci_type_code in HOST_LIKE_CI_TYPE_CODES:
        return True
    ci_type_name = normalize_ci_type_name(getattr(ci_type, 'name', ''))
    return ci_type_name in HOST_LIKE_CI_TYPE_NAMES


def resolve_config_item_type_meta(config_item):
    ci_type = getattr(config_item, 'ci_type', None)
    normalized_name = normalize_ci_type_name(getattr(ci_type, 'name', ''))
    color = getattr(ci_type, 'color', '') or '#64748b'

    if normalized_name and not is_placeholder_ci_type_name(normalized_name):
        return {
            'name': normalized_name,
            'color': color,
            'icon': getattr(ci_type, 'icon', '') or 'Monitor',
        }

    for sibling in ConfigItem.objects.select_related('ci_type').filter(name=config_item.name).exclude(pk=config_item.pk):
        sibling_name = normalize_ci_type_name(getattr(sibling.ci_type, 'name', ''))
        if sibling_name and not is_placeholder_ci_type_name(sibling_name):
            return {
                'name': sibling_name,
                'color': getattr(sibling.ci_type, 'color', '') or color,
                'icon': getattr(sibling.ci_type, 'icon', '') or 'Monitor',
            }

    return {
        'name': normalized_name or '未分类配置项',
        'color': color,
        'icon': getattr(ci_type, 'icon', '') or 'Monitor',
    }


def _sync_suppressed():
    return getattr(_SYNC_STATE, 'suspended', 0) > 0


@contextmanager
def suspend_cmdb_host_sync():
    _SYNC_STATE.suspended = getattr(_SYNC_STATE, 'suspended', 0) + 1
    try:
        yield
    finally:
        _SYNC_STATE.suspended = max(getattr(_SYNC_STATE, 'suspended', 1) - 1, 0)


def ensure_host_ci_type():
    ci_type = CIType.objects.filter(code='IDC_SERVER').first()
    if ci_type is None:
        ci_type = CIType.objects.filter(name__in=['物理机', '机房服务器']).first()
    if ci_type is None:
        ci_type = CIType.objects.create(
            name='物理机',
            code='IDC_SERVER',
            icon='Cpu',
            color='#475569',
            description='从主机中心或私有云平台同步的物理服务器资产',
            is_builtin=True,
        )
    changed = False
    if ci_type.name != '物理机':
        ci_type.name = '物理机'
        changed = True
    if ci_type.code != 'IDC_SERVER':
        ci_type.code = 'IDC_SERVER'
        changed = True
    if not ci_type.icon:
        ci_type.icon = 'Cpu'
        changed = True
    if not ci_type.color:
        ci_type.color = '#475569'
        changed = True
    if not ci_type.description:
        ci_type.description = '从主机中心或私有云平台同步的物理服务器资产'
        changed = True
    if not ci_type.is_builtin:
        ci_type.is_builtin = True
        changed = True
    if changed:
        ci_type.save(update_fields=['name', 'code', 'icon', 'color', 'description', 'is_builtin', 'updated_at'])
    return ci_type


def host_status_to_ci_status(status):
    mapping = {
        'online': 'active',
        'warning': 'active',
        'offline': 'offline',
    }
    return mapping.get(status or '', 'active')


def host_status_to_lifecycle_status(status):
    mapping = {
        'online': 'running',
        'warning': 'maintenance',
        'offline': 'offline',
    }
    return mapping.get(status or '', 'running')


def ci_status_to_host_status(status):
    mapping = {
        'active': 'online',
        'stopped': 'offline',
        'idle': 'warning',
        'offline': 'offline',
    }
    return mapping.get(status or '', 'online')


def _find_matching_host(hostname='', ip_address=''):
    from ops.models import Host

    hostname = (hostname or '').strip()
    ip_address = (ip_address or '').strip()
    queryset = Host.objects.all()
    if hostname:
        host = queryset.filter(hostname=hostname).order_by('id').first()
        if host:
            return host
    if ip_address:
        host = queryset.filter(ip_address=ip_address).order_by('id').first()
        if host:
            return host
    return None


def _find_mapped_host(config_item):
    from ops.models import Host

    mapping = CISourceMapping.objects.filter(ci=config_item, source_type=HOST_SOURCE_TYPE).order_by('id').first()
    if not mapping:
        return None
    try:
        return Host.objects.filter(pk=int(mapping.source_unique_id)).first()
    except (TypeError, ValueError):
        return None


def _matching_host_like_items(hostname='', ip_address='', exclude_pk=None):
    hostname = (hostname or '').strip()
    ip_address = (ip_address or '').strip()
    condition = Q()
    if hostname:
        condition |= Q(name=hostname)
    if ip_address:
        condition |= Q(attributes__ip_address=ip_address) | Q(attributes__ip=ip_address)
    if not condition:
        return ConfigItem.objects.none()
    queryset = ConfigItem.objects.select_related('ci_type').filter(condition)
    if exclude_pk:
        queryset = queryset.exclude(pk=exclude_pk)
    # 同名/同 IP 可能命中多个 CI，固定顺序避免每次同步改写不同资产。
    return [item for item in queryset.order_by('id') if is_host_like_ci(item)]


def _host_source_unique_id(host):
    return str(host.pk)


def _host_source_scope(host):
    return {
        'source_type': HOST_SOURCE_TYPE,
        'source_account': HOST_SOURCE_ACCOUNT,
        'source_region': HOST_SOURCE_REGION,
        'source_unique_id': _host_source_unique_id(host),
    }


def _find_config_item_for_host(host):
    if not host or not host.pk:
        return None
    mapping = CISourceMapping.objects.select_related('ci', 'ci__ci_type').filter(**_host_source_scope(host)).first()
    if mapping:
        return mapping.ci
    return None


def _sync_host_source_mapping(config_item, host):
    if not config_item or not host or not host.pk:
        return None

    raw_payload = {
        'hostname': host.hostname,
        'ip_address': host.ip_address,
        'business_line': host.business_line,
        'environment': host.environment,
        'admin_user': host.admin_user,
        'os_type': host.os_type,
        'status': host.status,
        'ssh_port': host.ssh_port,
    }
    mapping, _ = CISourceMapping.objects.update_or_create(
        **_host_source_scope(host),
        defaults={
            'ci': config_item,
            'last_seen_at': timezone.now(),
            'sync_status': 'success',
            'raw_payload': raw_payload,
        },
    )
    return mapping


def sync_host_to_config_item(host):
    if _sync_suppressed() or not host:
        return None

    config_item = _find_config_item_for_host(host)
    if config_item is None:
        matching_items = _matching_host_like_items(hostname=host.hostname, ip_address=host.ip_address)
        config_item = matching_items[0] if matching_items else None
    ci_type = ensure_host_ci_type()
    if config_item is not None and is_host_like_ci(config_item):
        # 已有资产可能是云主机/虚拟机，不能因为主机中心回写就降级成物理机。
        ci_type = config_item.ci_type

    attributes = dict((config_item.attributes or {}) if config_item else {})
    attribute_updates = {
        'asset_sn': attributes.get('asset_sn') or f'host-{host.pk}',
        'private_ip': host.ip_address,
        'ip_address': host.ip_address,
        'os_type': host.os_type,
        'description': host.description,
        'ops_owner': host.admin_user,
        'ssh_port': host.ssh_port,
        'source_type': HOST_SOURCE_TYPE,
        'source_account': HOST_SOURCE_ACCOUNT,
        'source_region': HOST_SOURCE_REGION,
        'source_unique_id': _host_source_unique_id(host),
        'source': attributes.get('source') or 'host_center',
        'sync_origin': 'host_center',
        'lifecycle_status': host_status_to_lifecycle_status(host.status),
    }
    # 空值不应覆盖 CI 上已人工维护的字段。
    for key, value in attribute_updates.items():
        if value not in (None, ''):
            attributes[key] = value
    attributes = {key: value for key, value in attributes.items() if value not in (None, '')}

    with suspend_cmdb_host_sync():
        if config_item is None:
            config_item = ConfigItem.objects.create(
                name=host.hostname,
                ci_type=ci_type,
                business_line=host.business_line,
                environment=host.environment or 'prod',
                admin_user=host.admin_user,
                status=host_status_to_ci_status(host.status),
                attributes=attributes,
            )
        else:
            config_item.name = host.hostname
            config_item.ci_type = ci_type
            config_item.business_line = host.business_line or config_item.business_line
            config_item.environment = host.environment or config_item.environment or 'prod'
            config_item.admin_user = host.admin_user or config_item.admin_user
            config_item.status = host_status_to_ci_status(host.status)
            config_item.attributes = attributes
            config_item.save()
        _sync_host_source_mapping(config_item, host)
    return config_item


def sync_config_item_to_host(config_item):
    if _sync_suppressed() or not config_item or not is_host_like_ci(config_item):
        return None

    attributes = config_item.attributes or {}
    ip_address = _attribute_text(
        attributes.get('ip_address')
        or attributes.get('private_ip')
        or attributes.get('ip')
    )
    if not ip_address:
        return None

    from ops.models import Host

    host = _find_mapped_host(config_item) or _find_matching_host(hostname=config_item.name, ip_address=ip_address)
    defaults = {
        'ip_address': ip_address,
        'business_line': config_item.business_line or '',
        'environment': config_item.environment or '',
        'admin_user': _attribute_text(config_item.admin_user or attributes.get('admin_user')),
        'os_type': _attribute_text(attributes.get('os_type')) or 'Linux',
        'description': _attribute_text(
            attributes.get('description') or attributes.get('specification')
        ),
        'status': ci_status_to_host_status(config_item.status),
    }

    with suspend_cmdb_host_sync():
        if host is None:
            host = Host.objects.create(hostname=config_item.name, **defaults)
        else:
            host.hostname = config_item.name
            for field, value in defaults.items():
                setattr(host, field, value)
            host.save()
    return host


def delete_config_item_for_host(host):
    if _sync_suppressed() or not host:
        return 0

    deleted = 0
    with suspend_cmdb_host_sync():
        mapped_item = _find_config_item_for_host(host)
        config_items = [mapped_item] if mapped_item else _matching_host_like_items(hostname=host.hostname, ip_address=host.ip_address)
        for config_item in config_items:
            if not config_item:
                continue
            config_item.delete()
            deleted += 1
    return deleted


def delete_host_for_config_item(config_item):
    if _sync_suppressed() or not config_item or not is_host_like_ci(config_item):
        return False

    attributes = config_item.attributes or {}
    ip_address = _attribute_text(attributes.get('ip_address') or attributes.get('ip'))
    host = _find_matching_host(hostname=config_item.name, ip_address=ip_address)
    if not host:
        return False

    remaining_items = _matching_host_like_items(hostname=config_item.name, ip_address=ip_address, exclude_pk=config_item.pk)
    if remaining_items:
        sync_config_item_to_host(remaining_items[0])
        return False

    with suspend_cmdb_host_sync():
        host.delete()
    return True
