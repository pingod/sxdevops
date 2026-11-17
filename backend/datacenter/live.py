"""机柜实时状态聚合：把 network 模块的 SNMP 采集结果折算成三维场景的颜色。

只做服务端聚合：绑定关系存在项目 JSON 的 `props.monitor.deviceIds`，取值口径
（最高接口利用率 + 在线状态优先级）只在这里实现一次，前端拿到的是最终状态。
"""
import json

from django.db.models import Max
from django.db.models.functions import Greatest
from django.utils import timezone

WARNING_UTIL = 80
CRITICAL_UTIL = 95

STATUS_ORDER = ('offline', 'critical', 'warning', 'unknown', 'online')


def _bound_devices(content):
    """从项目 JSON 里取出 {objectId: [deviceId]}，忽略未绑定的机柜。"""
    try:
        data = json.loads(content or '{}')
    except (TypeError, ValueError):
        return {}
    bound = {}
    for obj in data.get('objects') or []:
        if not isinstance(obj, dict) or obj.get('type') != 'cabinet':
            continue
        props = obj.get('props')
        monitor = props.get('monitor') if isinstance(props, dict) else None
        ids = monitor.get('deviceIds') if isinstance(monitor, dict) else None
        if not isinstance(ids, list) or not ids:
            continue
        valid = [i for i in ids if isinstance(i, int) and not isinstance(i, bool)]
        if valid:
            bound[obj.get('id')] = sorted(set(valid))
    return bound


def status_of(device_status, util):
    """单台设备的状态：离线压过利用率，未采集记为 unknown。"""
    if device_status == 'offline':
        return 'offline'
    if util is not None and util >= CRITICAL_UTIL:
        return 'critical'
    if util is not None and util >= WARNING_UTIL:
        return 'warning'
    if device_status != 'online':
        return 'unknown'
    return 'online'


def cabinet_status(statuses):
    """机柜状态：任一离线即离线，否则按最高严重度。"""
    if 'offline' in statuses:
        return 'offline'
    for level in ('critical', 'warning'):
        if level in statuses:
            return level
    if statuses and all(s == 'unknown' for s in statuses):
        return 'unknown'
    return 'online'


def build_live_payload(project):
    from network.models import NetworkDevice, NetworkInterface

    bound = _bound_devices(project.content)
    wanted = {device_id for ids in bound.values() for device_id in ids}
    if not wanted:
        return {
            'generated_at': timezone.now().isoformat(),
            'thresholds': {'warning': WARNING_UTIL, 'critical': CRITICAL_UTIL},
            'devices': [],
            'cabinets': {},
        }

    rows = NetworkDevice.objects.filter(id__in=wanted).values('id', 'name', 'status')
    util_by_device = dict(
        NetworkInterface.objects.filter(device_id__in=wanted)
        .values('device_id')
        .annotate(util=Max(Greatest('in_util', 'out_util')))
        .values_list('device_id', 'util')
    )

    devices = []
    status_by_device = {}
    util_device = {}
    for row in rows:
        util = util_by_device.get(row['id'])
        util = round(float(util), 2) if util is not None else None
        state = status_of(row['status'], util)
        status_by_device[row['id']] = state
        util_device[row['id']] = util
        devices.append({
            'id': row['id'], 'name': row['name'], 'status': state,
            'util': util, 'device_status': row['status'],
        })

    cabinets = {}
    for object_id, ids in bound.items():
        states = [status_by_device.get(i, 'unknown') for i in ids]
        utils = [util_device.get(i) for i in ids if util_device.get(i) is not None]
        cabinets[object_id] = {
            'status': cabinet_status(states),
            'util': round(max(utils), 2) if utils else None,
            'device_ids': ids,
        }

    return {
        'generated_at': timezone.now().isoformat(),
        'thresholds': {'warning': WARNING_UTIL, 'critical': CRITICAL_UTIL},
        'devices': devices,
        'cabinets': cabinets,
    }


def monitor_targets(limit=500):
    """设计器绑定下拉的候选项：只有名称/位置/在线状态，不含 IP 与凭据。"""
    from network.models import NetworkDevice

    return list(
        NetworkDevice.objects.order_by('name').values('id', 'name', 'location', 'status')[:limit]
    )
