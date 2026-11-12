"""SNMP 采集核心：系统健康 + 接口计数器，速率计算带回绕补偿与重置识别。

SNMP I/O 全异步；DB 持久化经 sync_to_async 走线程池。
注意不能用 thread_sensitive=True：Django ASGI 同步视图本身就跑在
单线程敏感执行器里，视图内 asyncio.run 再向同一执行器排队会死锁。
"""
import logging
import time

from asgiref.sync import sync_to_async
from django.utils import timezone

from eventwall.services import record_event

from . import oids
from .models import DeviceMetricSample, InterfaceMetricSample, NetworkDevice, NetworkInterface
from .snmp import SnmpError, format_mac, snmp_get, snmp_walk, target_from_device, walk_index

logger = logging.getLogger(__name__)

MIN_DELTA_SECONDS = 30
POLLER_ACTOR = {'actor_username': 'network-poller', 'actor_display': '网络采集器'}


def compute_counter_rate(prev, curr, elapsed_seconds, counter_bits=64, speed_bps=0):
    """计数器差分 → bps。不可信样本返回 None：间隔过短、计数器重置或回绕后速率超物理上限。"""
    if prev is None or curr is None or not elapsed_seconds or elapsed_seconds < MIN_DELTA_SECONDS:
        return None
    if curr >= prev:
        delta = curr - prev
    else:
        # 计数器回绕：补上 2^32/2^64；若是设备重置导致的小值，补偿后速率会超上限而被丢弃
        delta = (2 ** counter_bits - prev) + curr
    rate = delta * 8 / elapsed_seconds
    if speed_bps and rate > speed_bps * 2:
        return None
    return rate


def compute_counter_delta(prev, curr, counter_bits=64):
    """错包等纯计数差分（不乘 8），回绕补偿；重置返回 None。"""
    if prev is None or curr is None:
        return None
    if curr >= prev:
        return curr - prev
    delta = (2 ** counter_bits - prev) + curr
    if delta > 2 ** (counter_bits - 1):
        return None
    return delta


def detect_vendor(sys_descr: str) -> str:
    text = (sys_descr or '').lower()
    for vendor, hints in oids.VENDOR_SYSDESCR_HINTS:
        if any(hint in text for hint in hints):
            return vendor
    return ''


def _max_numeric(rows):
    values = [value for _, value in rows if isinstance(value, (int, float))]
    return max(values) if values else None


async def _collect_vendor_health(target, vendor):
    """按厂商候选 OID 采集 CPU/内存/温度；标量直接 GET，表 WALK 取最大值。"""
    mapping = oids.VENDOR_HEALTH_OIDS.get(vendor) or {}
    result = {'cpu_pct': None, 'mem_pct': None, 'temperature': None}
    scalar_oids = []
    for metric, candidates in mapping.items():
        for oid in candidates:
            if oid.endswith('.0'):
                scalar_oids.append((metric, oid))
                break
    if scalar_oids:
        values = await snmp_get(target, [oid for _, oid in scalar_oids])
        for metric, oid in scalar_oids:
            value = values.get(oid)
            if isinstance(value, (int, float)):
                if metric == 'cpu':
                    result['cpu_pct'] = float(value)
                elif metric == 'mem':
                    result['mem_pct'] = float(value)
    for metric, candidates in mapping.items():
        if metric in ('cpu', 'mem') and result[f'{metric}_pct'] is not None:
            continue
        for oid in candidates:
            if oid.endswith('.0'):
                continue
            rows = await snmp_walk(target, oid)
            value = _max_numeric(rows)
            if value is None:
                continue
            if metric == 'cpu':
                result['cpu_pct'] = float(value)
            elif metric == 'mem':
                if vendor == 'cisco':
                    free_rows = await snmp_walk(target, mapping['mem_free'][0])
                    free = _max_numeric(free_rows)
                    if free is not None and value + free > 0:
                        result['mem_pct'] = round(value / (value + free) * 100, 2)
                else:
                    result['mem_pct'] = float(value)
            elif metric == 'temp':
                result['temperature'] = float(value)
            break
    return result


async def _collect_generic_health(target):
    """HOST-RESOURCES-MIB 兜底：hrProcessorLoad 平均 + RAM 存储行利用率。"""
    result = {'cpu_pct': None, 'mem_pct': None, 'temperature': None}
    cpu_rows = await snmp_walk(target, oids.HR_PROCESSOR_LOAD_OID)
    cpu = _max_numeric(cpu_rows)
    if cpu is not None:
        values = [value for _, value in cpu_rows if isinstance(value, (int, float))]
        result['cpu_pct'] = round(sum(values) / len(values), 2)
    type_rows = dict(await snmp_walk(target, '1.3.6.1.2.1.25.2.3.1.2'))
    size_rows = dict(await snmp_walk(target, oids.HR_STORAGE_SIZE_OID))
    used_rows = dict(await snmp_walk(target, oids.HR_STORAGE_USED_OID))
    for full_oid, storage_type in type_rows.items():
        if str(storage_type) != oids.HR_STORAGE_TYPE_RAM:
            continue
        index = walk_index(full_oid, '1.3.6.1.2.1.25.2.3.1.2')
        size = size_rows.get(f'{oids.HR_STORAGE_SIZE_OID}.{index}')
        used = used_rows.get(f'{oids.HR_STORAGE_USED_OID}.{index}')
        if isinstance(size, (int, float)) and isinstance(used, (int, float)) and size > 0:
            result['mem_pct'] = round(used / size * 100, 2)
        break
    return result


def _persist_system(device_id, sys_values, health, uptime_seconds, error=''):
    device = NetworkDevice.objects.get(pk=device_id)
    now = timezone.now()
    previous_status = device.status
    device.last_system_poll_at = now
    device.last_poll_at = now
    if error:
        device.status = NetworkDevice.STATUS_OFFLINE
        device.last_error = error
    else:
        device.status = NetworkDevice.STATUS_ONLINE
        device.last_error = ''
        device.sys_descr = str(sys_values.get(oids.SYSTEM_OIDS['sys_descr']) or '')[:2000]
        device.sys_name = str(sys_values.get(oids.SYSTEM_OIDS['sys_name']) or '')[:200]
        device.sys_contact = str(sys_values.get(oids.SYSTEM_OIDS['sys_contact']) or '')[:200]
        device.sys_location = str(sys_values.get(oids.SYSTEM_OIDS['sys_location']) or '')[:200]
        device.sys_uptime_seconds = uptime_seconds
        if device.vendor == 'other':
            detected = detect_vendor(device.sys_descr)
            if detected:
                device.vendor = detected
    device.save()
    if not error:
        DeviceMetricSample.objects.create(
            device=device, sampled_at=now, uptime_seconds=uptime_seconds,
            cpu_pct=health.get('cpu_pct'), mem_pct=health.get('mem_pct'),
            temperature=health.get('temperature'),
        )
    if previous_status != device.status and previous_status != NetworkDevice.STATUS_UNKNOWN:
        online = device.status == NetworkDevice.STATUS_ONLINE
        record_event(
            module='network', category='monitor',
            action='device_online' if online else 'device_offline',
            title=f'网络设备{"恢复在线" if online else '离线'}：{device.name}',
            summary=f'{device.name} ({device.mgmt_ip}) {"SNMP 恢复响应" if online else f"SNMP 无响应：{error}"}',
            severity='info' if online else 'warning',
            resource_type='network_device', resource_id=device.pk, resource_name=device.name,
            **POLLER_ACTOR,
        )
    return device.status


async def collect_device_system(device, target=None):
    """采集系统组 + 厂商健康指标。返回 'online'/'offline'。"""
    target = target or await sync_to_async(target_from_device, thread_sensitive=False)(device)
    try:
        sys_values = await snmp_get(target, list(oids.SYSTEM_OIDS.values()))
    except SnmpError as exc:
        logger.warning('设备 %s 系统采集失败: %s', device.name, exc)
        return await sync_to_async(_persist_system, thread_sensitive=False)(device.pk, {}, {}, None, error=str(exc))
    uptime_ticks = sys_values.get(oids.SYSTEM_OIDS['sys_uptime'])
    uptime_seconds = int(uptime_ticks // 100) if isinstance(uptime_ticks, (int, float)) else None
    vendor = device.vendor if device.vendor != 'other' else detect_vendor(str(sys_values.get(oids.SYSTEM_OIDS['sys_descr']) or ''))
    health = {'cpu_pct': None, 'mem_pct': None, 'temperature': None}
    try:
        if vendor:
            health = await _collect_vendor_health(target, vendor)
        if health['cpu_pct'] is None and health['mem_pct'] is None:
            generic = await _collect_generic_health(target)
            for key, value in generic.items():
                if health[key] is None:
                    health[key] = value
    except SnmpError as exc:
        logger.info('设备 %s 健康指标采集失败（系统组已入库）: %s', device.name, exc)
    return await sync_to_async(_persist_system, thread_sensitive=False)(device.pk, sys_values, health, uptime_seconds)


def _build_interface_rows(x_table, if_table):
    """把 ifXTable/ifTable 的 WALK 结果按 ifIndex 合并成 {index: 字段字典}。"""
    rows = {}

    def merge(table, base_oid, field, transform=None):
        for full_oid, value in table.get(base_oid, []):
            index = walk_index(full_oid, base_oid)
            if not index:
                continue
            row = rows.setdefault(int(index), {'if_index': int(index)})
            row[field] = transform(value) if transform else value

    merge(if_table, oids.IF_TABLE_OIDS['if_descr'], 'descr', lambda v: str(v or '')[:500])
    merge(if_table, oids.IF_TABLE_OIDS['if_type'], 'if_type')
    merge(if_table, oids.IF_TABLE_OIDS['if_mtu'], 'mtu')
    merge(if_table, oids.IF_TABLE_OIDS['if_speed'], 'if_speed')
    merge(if_table, oids.IF_TABLE_OIDS['if_phys_address'], 'mac', format_mac)
    merge(if_table, oids.IF_TABLE_OIDS['if_admin_status'], 'admin_status')
    merge(if_table, oids.IF_TABLE_OIDS['if_oper_status'], 'oper_status')
    merge(if_table, oids.IF_TABLE_OIDS['if_in_octets'], 'in_octets32')
    merge(if_table, oids.IF_TABLE_OIDS['if_in_errors'], 'in_errors')
    merge(if_table, oids.IF_TABLE_OIDS['if_out_octets'], 'out_octets32')
    merge(if_table, oids.IF_TABLE_OIDS['if_out_errors'], 'out_errors')
    merge(x_table, oids.IF_X_TABLE_OIDS['if_name'], 'name', lambda v: str(v or '')[:200])
    merge(x_table, oids.IF_X_TABLE_OIDS['if_alias'], 'alias', lambda v: str(v or '')[:200])
    merge(x_table, oids.IF_X_TABLE_OIDS['if_hc_in_octets'], 'in_octets64')
    merge(x_table, oids.IF_X_TABLE_OIDS['if_hc_out_octets'], 'out_octets64')
    merge(x_table, oids.IF_X_TABLE_OIDS['if_high_speed'], 'high_speed')
    return rows


def _persist_interfaces(device_id, rows, uptime_regressed):
    device = NetworkDevice.objects.get(pk=device_id)
    now = timezone.now()
    seen_indexes = set()
    for row in rows.values():
        index = row['if_index']
        seen_indexes.add(index)
        hc_in, hc_out = row.get('in_octets64'), row.get('out_octets64')
        use_hc = isinstance(hc_in, int) and isinstance(hc_out, int)
        in_octets = hc_in if use_hc else row.get('in_octets32')
        out_octets = hc_out if use_hc else row.get('out_octets32')
        counter_bits = 64 if use_hc else 32
        high_speed = row.get('high_speed')
        if isinstance(high_speed, (int, float)) and high_speed > 0:
            speed_bps = int(high_speed) * 1_000_000
        else:
            speed_bps = int(row.get('if_speed') or 0)
        existing = NetworkInterface.objects.filter(device=device, if_index=index).first()
        previous_oper = existing.oper_status if existing else 0
        interface, _ = NetworkInterface.objects.update_or_create(
            device=device, if_index=index,
            defaults={
                'name': row.get('name') or row.get('descr') or f'if{index}',
                'descr': row.get('descr') or '',
                'alias': row.get('alias') or '',
                'mac': row.get('mac') or '',
                'if_type': row.get('if_type'),
                'mtu': row.get('mtu'),
                'admin_status': row.get('admin_status') or 0,
                'oper_status': row.get('oper_status') or 0,
                'speed_bps': speed_bps,
                'counter_bits': counter_bits,
                'last_seen_at': now,
            },
        )
        elapsed = (now - interface.last_counter_at).total_seconds() if interface.last_counter_at else None
        in_bps = out_bps = None
        if not uptime_regressed:
            in_bps = compute_counter_rate(interface.last_in_octets, in_octets, elapsed, counter_bits, speed_bps)
            out_bps = compute_counter_rate(interface.last_out_octets, out_octets, elapsed, counter_bits, speed_bps)
        in_errors = compute_counter_delta(interface.last_in_errors, row.get('in_errors'), 32)
        out_errors = compute_counter_delta(interface.last_out_errors, row.get('out_errors'), 32)
        interface.last_in_octets = in_octets
        interface.last_out_octets = out_octets
        interface.last_in_errors = row.get('in_errors')
        interface.last_out_errors = row.get('out_errors')
        interface.last_counter_at = now
        if in_bps is not None:
            interface.in_bps = round(in_bps, 2)
            interface.in_util = round(min(in_bps / speed_bps * 100, 100), 2) if speed_bps else 0
        if out_bps is not None:
            interface.out_bps = round(out_bps, 2)
            interface.out_util = round(min(out_bps / speed_bps * 100, 100), 2) if speed_bps else 0
        interface.save()
        if in_bps is not None and out_bps is not None:
            InterfaceMetricSample.objects.create(
                interface=interface, sampled_at=now,
                in_bps=interface.in_bps, out_bps=interface.out_bps,
                in_util=interface.in_util, out_util=interface.out_util,
                in_errors=in_errors or 0, out_errors=out_errors or 0,
            )
        newly_down = (
            interface.admin_status == oids.ADMIN_STATUS_UP
            and interface.oper_status == oids.OPER_STATUS_DOWN
            and previous_oper == oids.OPER_STATUS_UP
        )
        recovered = (
            interface.oper_status == oids.OPER_STATUS_UP
            and previous_oper == oids.OPER_STATUS_DOWN
        )
        if newly_down or recovered:
            record_event(
                module='network', category='monitor',
                action='interface_down' if newly_down else 'interface_up',
                title=f'接口{"中断" if newly_down else "恢复"}：{device.name} {interface.name}',
                summary=f'{device.name} ({device.mgmt_ip}) 接口 {interface.name} 运行状态 {"DOWN" if newly_down else "UP"}',
                severity='warning' if newly_down else 'info',
                resource_type='network_interface', resource_id=interface.pk,
                resource_name=f'{device.name}:{interface.name}',
                **POLLER_ACTOR,
            )
    if seen_indexes:
        device.interfaces.exclude(if_index__in=seen_indexes).delete()
    device.last_interface_poll_at = now
    device.last_poll_at = now
    device.save(update_fields=['last_interface_poll_at', 'last_poll_at', 'updated_at'])
    return len(seen_indexes)


async def collect_device_interfaces(device, target=None):
    """WALK ifXTable/ifTable，更新接口台账并计算速率。返回接口数量。"""
    target = target or await sync_to_async(target_from_device, thread_sensitive=False)(device)
    x_table, if_table = {}, {}
    for base_oid in oids.IF_X_TABLE_OIDS.values():
        x_table[base_oid] = await snmp_walk(target, base_oid)
    for base_oid in oids.IF_TABLE_OIDS.values():
        if_table[base_oid] = await snmp_walk(target, base_oid)
    rows = _build_interface_rows(x_table, if_table)
    uptime_regressed = False
    sys_uptime = await snmp_get(target, [oids.SYSTEM_OIDS['sys_uptime']])
    ticks = sys_uptime.get(oids.SYSTEM_OIDS['sys_uptime'])
    if isinstance(ticks, (int, float)) and device.sys_uptime_seconds and ticks // 100 < device.sys_uptime_seconds:
        uptime_regressed = True
    return await sync_to_async(_persist_interfaces, thread_sensitive=False)(device.pk, rows, uptime_regressed)