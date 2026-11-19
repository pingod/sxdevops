"""巡检采集器：只读采集 + 阈值判定，任何异常都降级为 unknown，不向上抛。

采集函数签名固定：
    collect_host_results(target, item_codes)
    collect_k8s_results(cluster, namespaces, item_codes)
    collect_middleware_results(config_item, item_codes)

返回 list[dict]：{item_code, severity, value, threshold, message, evidence, duration_ms}
"""

import time
import traceback

from .inspection_items import (
    HOST_ITEM_CODES,
    K8S_ITEM_CODES,
    MIDDLEWARE_ITEM_CODES,
    builtin_item_map,
)
from .models import InspectionResult

SEVERITY_OK = 'ok'
SEVERITY_WARNING = 'warning'
SEVERITY_CRITICAL = 'critical'
SEVERITY_UNKNOWN = 'unknown'

SSH_CONNECT_TIMEOUT_SECONDS = 15
SSH_COMMAND_TIMEOUT_SECONDS = 30
MIDDLEWARE_SOCKET_TIMEOUT_SECONDS = 5

# 单次 SSH 执行、只读、无任何变量插值；每段以独占一行的 [sec:<code>] 开始。
HOST_INSPECTION_SCRIPT = r"""
echo "[sec:host.load]"
awk -v cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)" 'NR==1 { printf "%.2f %.2f\n", $1, $1/(cores>0?cores:1) }' /proc/loadavg 2>/dev/null
echo "[sec:host.cpu]"
top -bn1 2>/dev/null | grep -m1 -E 'Cpu\(s\)|%Cpu' | tr ',' '\n' | grep -m1 'id' | tr -dc '0-9.'
echo ""
echo "[sec:host.memory]"
free -k 2>/dev/null | awk '/^Mem:/ { printf "%.1f\n", $3/$2*100 }'
echo "[sec:host.swap]"
free -k 2>/dev/null | awk '/^Swap:/ { if ($2+0 == 0) print "-"; else printf "%.1f\n", $3/$2*100 }'
echo "[sec:host.disk]"
(df -P -x tmpfs -x devtmpfs 2>/dev/null || df -P 2>/dev/null) | awk 'NR>1 { for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+%$/) { sub("%","",$i); print $NF, $i; break } }'
echo "[sec:host.inode]"
(df -Pi -x tmpfs -x devtmpfs 2>/dev/null || df -Pi 2>/dev/null) | awk 'NR>1 { for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+%$/) { sub("%","",$i); print $NF, $i; break } }'
echo "[sec:host.clock]"
timedatectl show -p NTPSynchronized --value 2>/dev/null
echo "[sec:host.systemd_failed]"
systemctl --failed --no-legend 2>/dev/null | wc -l
echo "[sec:host.reboot_required]"
if [ -f /var/run/reboot-required ]; then echo 1; else echo 0; fi
echo "[sec:host.ssh_failed_login]"
journalctl -u sshd -u ssh --since -24h --no-pager 2>/dev/null | grep -c 'Failed password'
echo "[sec:host.exposed_port]"
ss -lntH 2>/dev/null | awk '$4 ~ /^(0\.0\.0\.0|\*|\[::\]|\[::ffff:0\.0\.0\.0\]):(3306|6379|27017|9200|11211|2375)$/ { print $0 }'
echo "[sec:host.log_error]"
journalctl -p err --since -24h --no-pager 2>/dev/null | wc -l
"""


def _to_float(value):
    """容忍带单位的数值（'91%'、'1.23'）；无法解析返回 None。"""
    text = str(value if value is not None else '').strip().replace(',', '')
    if not text:
        return None
    for suffix in ('%', '次', '个', '条', 'ms', 'MB', 'GB'):
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()
            break
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def evaluate_threshold(value, threshold_config):
    """把采集值与阈值配置判成 ok/warning/critical/unknown；不抛异常。"""
    config = threshold_config if isinstance(threshold_config, dict) else {}
    if not config:
        return SEVERITY_UNKNOWN
    comparison = str(config.get('comparison') or '').strip()
    if comparison == 'flag':
        return SEVERITY_WARNING if str(value).strip() == '1' else SEVERITY_OK
    if comparison == 'eq':
        expect = str(config.get('expect') or '').strip()
        if not expect or str(value).strip() == '':
            return SEVERITY_UNKNOWN
        return SEVERITY_CRITICAL if str(value).strip() == expect else SEVERITY_OK
    if comparison in ('gte', 'lte'):
        numeric = _to_float(value)
        if numeric is None:
            return SEVERITY_UNKNOWN
        critical = _to_float(config.get('critical'))
        warning = _to_float(config.get('warning'))
        if comparison == 'gte':
            if critical is not None and numeric >= critical:
                return SEVERITY_CRITICAL
            if warning is not None and numeric >= warning:
                return SEVERITY_WARNING
            return SEVERITY_OK
        if critical is not None and numeric <= critical:
            return SEVERITY_CRITICAL
        if warning is not None and numeric <= warning:
            return SEVERITY_WARNING
        return SEVERITY_OK
    return SEVERITY_UNKNOWN


def format_threshold(threshold_config):
    config = threshold_config if isinstance(threshold_config, dict) else {}
    comparison = str(config.get('comparison') or '').strip()
    unit = str(config.get('unit') or '')
    if comparison in ('gte', 'lte'):
        operator = '≥' if comparison == 'gte' else '≤'
        parts = []
        warning = config.get('warning')
        critical = config.get('critical')
        if warning is not None:
            parts.append(f'{operator}{warning}{unit} 警告')
        if critical is not None:
            parts.append(f'{operator}{critical}{unit} 严重')
        return ' / '.join(parts)
    if comparison == 'eq':
        return f'期望 {config.get("expect") or "-"}'
    if comparison == 'flag':
        return '命中即告警'
    return ''


def _threshold_configs(item_codes):
    """一次查询取回巡检项阈值；目录缺失时回落到内置定义。"""
    from .models import InspectionItem

    codes = list(item_codes)
    configs = {}
    for item in InspectionItem.objects.filter(code__in=codes):
        configs[item.code] = item.threshold_config or {}
    fallback = builtin_item_map()
    for code in codes:
        if code not in configs:
            configs[code] = (fallback.get(code) or {}).get('threshold_config') or {}
    return configs


def _result(item_code, severity, *, value='', threshold='', message='', evidence='', duration_ms=0):
    return {
        'item_code': item_code,
        'severity': severity,
        'value': str(value or ''),
        'threshold': str(threshold or ''),
        'message': str(message or '')[:255],
        'evidence': str(evidence or '')[:2000],
        'duration_ms': int(duration_ms or 0),
    }


def _unknown_results(item_codes, message, evidence=''):
    return [_result(code, SEVERITY_UNKNOWN, message=message, evidence=evidence) for code in item_codes]


# ---------------------------------------------------------------- 主机

def host_target_key(target):
    if getattr(target, 'source', '') == 'task_resource':
        return f'host:task_resource:{target.resource_id}'
    return f'host:host:{target.id}'


def k8s_target_key(cluster):
    return f'k8s:{cluster.id}'


def middleware_target_key(config_item):
    return f'mw:{config_item.ci_type.code}:{config_item.id}'


def parse_host_inspection_output(raw):
    """按独占一行的 [sec:<code>] 切分；未知分节丢弃。返回 {code: [line, ...]}。"""
    sections = {}
    current = None
    for line in str(raw or '').splitlines():
        stripped = line.strip()
        if stripped.startswith('[sec:') and stripped.endswith(']'):
            current = stripped[5:-1].strip()
            sections.setdefault(current, [])
            continue
        if current is None:
            continue
        sections[current].append(line.rstrip())
    return {code: [line for line in lines if line.strip()] for code, lines in sections.items()}


def _first_line(lines):
    return (lines or [''])[0].strip() if lines else ''


def _mount_usage(lines):
    rows = []
    for line in lines or []:
        parts = line.split()
        if len(parts) < 2:
            continue
        usage = _to_float(parts[-1])
        if usage is None:
            continue
        rows.append((parts[0], usage))
    return rows


def _build_host_results(parsed, configs, duration_ms):
    results = []

    def add(code, severity, **kwargs):
        results.append(_result(code, severity, threshold=format_threshold(configs.get(code)), duration_ms=duration_ms, **kwargs))

    def missing(code):
        add(code, SEVERITY_UNKNOWN, message='采集项缺失，请确认命令是否可用')

    # load
    lines = parsed.get('host.load')
    if lines:
        parts = lines[0].split()
        per_core = _to_float(parts[1]) if len(parts) > 1 else None
        if per_core is None:
            missing('host.load')
        else:
            add('host.load', evaluate_threshold(per_core, configs.get('host.load')),
                value=f'{per_core:.2f}',
                message=f'每核 load1 {per_core:.2f}（load1 {parts[0]}）',
                evidence='\n'.join(lines[:3]))
    else:
        missing('host.load')

    # cpu
    idle = _to_float(_first_line(parsed.get('host.cpu')))
    if idle is None:
        missing('host.cpu')
    else:
        add('host.cpu', evaluate_threshold(idle, configs.get('host.cpu')),
            value=f'{idle}%', message=f'CPU 空闲 {idle}%', evidence=_first_line(parsed.get('host.cpu')))

    # memory
    used = _to_float(_first_line(parsed.get('host.memory')))
    if used is None:
        missing('host.memory')
    else:
        add('host.memory', evaluate_threshold(used, configs.get('host.memory')),
            value=f'{used}%', message=f'内存使用率 {used}%', evidence=_first_line(parsed.get('host.memory')))

    # swap
    swap_raw = _first_line(parsed.get('host.swap'))
    if swap_raw in ('', '-'):
        add('host.swap', SEVERITY_UNKNOWN, value='', message='未启用 Swap')
    else:
        swap_used = _to_float(swap_raw)
        if swap_used is None:
            missing('host.swap')
        else:
            add('host.swap', evaluate_threshold(swap_used, configs.get('host.swap')),
                value=f'{swap_used}%', message=f'Swap 使用率 {swap_used}%', evidence=swap_raw)

    # disk / inode
    for code in ('host.disk', 'host.inode'):
        rows = _mount_usage(parsed.get(code))
        if not rows:
            missing(code)
            continue
        rows.sort(key=lambda item: item[1], reverse=True)
        mount, usage = rows[0]
        label = '磁盘' if code == 'host.disk' else 'Inode'
        add(code, evaluate_threshold(usage, configs.get(code)),
            value=f'{usage:g}%', message=f'最差挂载点 {mount} {label}使用率 {usage:g}%',
            evidence='\n'.join(f'{item[0]} {item[1]:g}%' for item in rows[:3]))

    # clock
    clock = _first_line(parsed.get('host.clock')).lower()
    if clock in ('yes', 'no'):
        add('host.clock', evaluate_threshold(clock, configs.get('host.clock')),
            value=clock, message='NTP 已同步' if clock == 'yes' else 'NTP 未同步', evidence=clock)
    else:
        missing('host.clock')

    # systemd failed
    failed = _to_float(_first_line(parsed.get('host.systemd_failed')))
    if failed is None:
        missing('host.systemd_failed')
    else:
        add('host.systemd_failed', evaluate_threshold(failed, configs.get('host.systemd_failed')),
            value=f'{failed:g}', message=f'{failed:g} 个服务单元失败', evidence=_first_line(parsed.get('host.systemd_failed')))

    # reboot required
    reboot = _first_line(parsed.get('host.reboot_required'))
    if reboot in ('0', '1'):
        add('host.reboot_required', evaluate_threshold(reboot, configs.get('host.reboot_required')),
            value=reboot, message='存在待重启标记' if reboot == '1' else '无待重启标记', evidence=reboot)
    else:
        missing('host.reboot_required')

    # ssh failed login
    ssh_failed = _to_float(_first_line(parsed.get('host.ssh_failed_login')))
    if ssh_failed is None:
        missing('host.ssh_failed_login')
    else:
        add('host.ssh_failed_login', evaluate_threshold(ssh_failed, configs.get('host.ssh_failed_login')),
            value=f'{ssh_failed:g}', message=f'24 小时失败登录 {ssh_failed:g} 次',
            evidence=_first_line(parsed.get('host.ssh_failed_login')))

    # exposed port（离散状态：命中即严重）
    exposed = parsed.get('host.exposed_port') or []
    if exposed:
        ports = sorted({line.split()[3] for line in exposed if len(line.split()) > 3})
        add('host.exposed_port', SEVERITY_CRITICAL, value='1',
            message=f'高危端口监听在全部网卡：{", ".join(ports)[:200]}',
            evidence='\n'.join(exposed[:10]))
    else:
        add('host.exposed_port', SEVERITY_OK, value='0', message='未发现高危端口对外监听')

    # error log
    errors = _to_float(_first_line(parsed.get('host.log_error')))
    if errors is None:
        missing('host.log_error')
    else:
        add('host.log_error', evaluate_threshold(errors, configs.get('host.log_error')),
            value=f'{errors:g}', message=f'24 小时错误日志 {errors:g} 条',
            evidence=_first_line(parsed.get('host.log_error')))
    return results


def collect_host_results(target, item_codes):
    codes = [code for code in item_codes if code in HOST_ITEM_CODES]
    if not codes:
        return []
    configs = _threshold_configs(codes)
    started = time.monotonic()
    from .host_tasks import execute_remote_command, open_ssh_client

    try:
        client = open_ssh_client(target, SSH_CONNECT_TIMEOUT_SECONDS)
    except Exception as exc:
        return _unknown_results(codes, f'SSH 连接失败：{exc}')
    try:
        output = execute_remote_command(client, HOST_INSPECTION_SCRIPT, SSH_COMMAND_TIMEOUT_SECONDS)[1]
    except Exception as exc:
        return _unknown_results(codes, f'巡检脚本执行失败：{exc}')
    finally:
        try:
            client.close()
        except Exception:
            pass
    duration_ms = int((time.monotonic() - started) * 1000)
    parsed = parse_host_inspection_output(output)
    try:
        results = _build_host_results(parsed, configs, duration_ms)
    except Exception:
        return _unknown_results(codes, '巡检输出解析失败', traceback.format_exc()[:2000])
    produced = {item['item_code'] for item in results}
    results.extend(_unknown_results([code for code in codes if code not in produced], '采集项缺失，请确认命令是否可用'))
    return [item for item in results if item['item_code'] in set(codes)]


# ---------------------------------------------------------------- K8s

def _k8s_condition_true(condition):
    return str(getattr(condition, 'status', '') or '').lower() == 'true'


def _k8s_container_restarts(pod):
    total = 0
    for status in (getattr(pod, 'status', None).container_statuses or []):
        total += int(getattr(status, 'restart_count', 0) or 0)
    return total


def _k8s_pod_ready(pod):
    status = getattr(pod, 'status', None)
    if str(getattr(status, 'phase', '') or '') not in ('Running', 'Succeeded'):
        return False
    statuses = status.container_statuses or []
    if not statuses:
        return True
    return all(bool(getattr(item, 'ready', False)) for item in statuses)


def _k8s_pod_list(core, namespaces):
    if namespaces:
        pods = []
        for namespace in namespaces:
            pods.extend(core.list_namespaced_pod(namespace).items or [])
        return pods
    return core.list_pod_for_all_namespaces().items or []


def _k8s_pvc_list(core, namespaces):
    if namespaces:
        claims = []
        for namespace in namespaces:
            claims.extend(core.list_namespaced_persistent_volume_claim(namespace).items or [])
        return claims
    return core.list_persistent_volume_claim_for_all_namespaces().items or []


def _k8s_workload_list(apps, namespaces):
    workloads = []
    for api, method in (
        ('list_deployment_for_all_namespaces', 'list_namespaced_deployment'),
        ('list_stateful_set_for_all_namespaces', 'list_namespaced_stateful_set'),
    ):
        if namespaces:
            for namespace in namespaces:
                workloads.extend(getattr(apps, method)(namespace).items or [])
        else:
            workloads.extend(getattr(apps, api)().items or [])
    return workloads


def collect_k8s_results(cluster, namespaces, item_codes):
    codes = [code for code in item_codes if code in K8S_ITEM_CODES]
    if not codes:
        return []
    configs = _threshold_configs(codes)
    namespaces = [str(item).strip() for item in (namespaces or []) if str(item).strip()]
    started = time.monotonic()
    from .k8s_views import _get_k8s_client

    try:
        k8s = _get_k8s_client(cluster)
    except Exception as exc:
        return _unknown_results(codes, f'K8s 客户端初始化失败：{exc}')
    try:
        core = k8s.CoreV1Api()
        apps = k8s.AppsV1Api()
        results = _build_k8s_results(k8s, core, apps, namespaces, codes, configs, started)
    except Exception as exc:
        return _unknown_results(codes, f'K8s 采集失败：{exc}', traceback.format_exc()[:2000])
    finally:
        try:
            k8s.ApiClient().close()
        except Exception:
            pass
    produced = {item['item_code'] for item in results}
    results.extend(_unknown_results([code for code in codes if code not in produced], '采集项缺失'))
    return results


def _build_k8s_results(k8s, core, apps, namespaces, codes, configs, started):
    results = []

    def add(code, severity, **kwargs):
        results.append(_result(
            code, severity, threshold=format_threshold(configs.get(code)),
            duration_ms=int((time.monotonic() - started) * 1000), **kwargs,
        ))

    def guarded(code, loader, builder):
        if code not in codes:
            return
        try:
            builder(loader())
        except Exception as exc:
            add(code, SEVERITY_UNKNOWN, message=f'采集失败：{exc}')

    def node_ready(nodes):
        bad = [node.metadata.name for node in nodes
               if not all(_k8s_condition_true(item) for item in (node.status.conditions or []) if getattr(item, 'type', '') == 'Ready')]
        add('k8s.node_ready', evaluate_threshold('1' if bad else '0', configs.get('k8s.node_ready')),
            value='1' if bad else '0',
            message=f'{len(bad)} 个节点 NotReady：{", ".join(bad[:5])}' if bad else '全部节点 Ready',
            evidence='\n'.join(bad[:10]))

    def node_pressure(nodes):
        pressed = []
        for node in nodes:
            for item in (node.status.conditions or []):
                if getattr(item, 'type', '') in ('MemoryPressure', 'DiskPressure', 'PIDPressure') and _k8s_condition_true(item):
                    pressed.append(f'{node.metadata.name}:{item.type}')
        add('k8s.node_pressure', evaluate_threshold('1' if pressed else '0', configs.get('k8s.node_pressure')),
            value='1' if pressed else '0',
            message=f'{len(pressed)} 个节点资源压力：{", ".join(pressed[:5])}' if pressed else '节点无资源压力',
            evidence='\n'.join(pressed[:10]))

    def pod_restarts(pods):
        total = sum(_k8s_container_restarts(pod) for pod in pods)
        add('k8s.pod_restarts', evaluate_threshold(total, configs.get('k8s.pod_restarts')),
            value=str(total), message=f'容器重启合计 {total} 次',
            evidence=f'Pod 总数 {len(pods)}')

    def pod_not_ready(pods):
        bad = [pod.metadata.name for pod in pods if not _k8s_pod_ready(pod)]
        add('k8s.pod_not_ready', evaluate_threshold(len(bad), configs.get('k8s.pod_not_ready')),
            value=str(len(bad)), message=f'{len(bad)} 个 Pod 未就绪：{", ".join(bad[:5])}' if bad else '全部 Pod 就绪',
            evidence='\n'.join(bad[:20]))

    def workload_available(workloads):
        short, dead = [], []
        for workload in workloads:
            replicas = int(getattr(workload.spec, 'replicas', 0) or 0)
            ready = int(getattr(workload.status, 'ready_replicas', 0) or 0)
            if replicas and ready < replicas:
                short.append(f'{workload.metadata.name} {ready}/{replicas}')
                if ready == 0:
                    dead.append(workload.metadata.name)
        if dead:
            severity = SEVERITY_CRITICAL
        elif short:
            severity = SEVERITY_WARNING
        else:
            severity = SEVERITY_OK
        add('k8s.workload_available', severity, value='0' if short else '1',
            message=f'{len(short)} 个工作负载副本不足：{", ".join(short[:5])}' if short else '工作负载副本满足期望',
            evidence='\n'.join(short[:20]))

    def capacity(_):
        from .k8s_capacity import build_cluster_capacity

        snapshot = build_cluster_capacity(k8s)
        resources = snapshot.get('resources') or {}
        if not (snapshot.get('metrics') or {}).get('available'):
            add('k8s.capacity', SEVERITY_UNKNOWN, value='', message='指标不可用，无法计算容量水位')
            return
        levels = []
        for name in ('cpu', 'memory'):
            resource = resources.get(name) or {}
            requests = resource.get('requests')
            allocatable = resource.get('allocatable')
            if requests is None or not allocatable:
                continue
            levels.append((name, round(float(requests) / float(allocatable) * 100, 1)))
        if not levels:
            add('k8s.capacity', SEVERITY_UNKNOWN, value='', message='缺少 requests/allocatable 数据')
            return
        worst = max(levels, key=lambda item: item[1])
        add('k8s.capacity', evaluate_threshold(worst[1], configs.get('k8s.capacity')),
            value=f'{worst[1]}%', message=f'{worst[0]} requests 水位 {worst[1]}%',
            evidence='\n'.join(f'{name} {value}%' for name, value in levels))

    def pvc_unbound(claims):
        bad = [f'{claim.metadata.namespace}/{claim.metadata.name}' for claim in claims
               if str(getattr(claim, 'status', None) and claim.status.phase or '') != 'Bound']
        add('k8s.pvc_unbound', evaluate_threshold(len(bad), configs.get('k8s.pvc_unbound')),
            value=str(len(bad)), message=f'{len(bad)} 个 PVC 未绑定：{", ".join(bad[:5])}' if bad else '全部 PVC 已绑定',
            evidence='\n'.join(bad[:20]))

    guarded('k8s.node_ready', lambda: core.list_node().items or [], node_ready)
    guarded('k8s.node_pressure', lambda: core.list_node().items or [], node_pressure)
    guarded('k8s.pod_restarts', lambda: _k8s_pod_list(core, namespaces), pod_restarts)
    guarded('k8s.pod_not_ready', lambda: _k8s_pod_list(core, namespaces), pod_not_ready)
    guarded('k8s.workload_available', lambda: _k8s_workload_list(apps, namespaces), workload_available)
    guarded('k8s.capacity', lambda: None, capacity)
    guarded('k8s.pvc_unbound', lambda: _k8s_pvc_list(core, namespaces), pvc_unbound)
    return results


# ---------------------------------------------------------------- 中间件

def _middleware_endpoint(config_item):
    attributes = config_item.attributes or {}
    host = ''
    for key in ('endpoint', 'host', 'ip_address', 'ip', 'private_ip'):
        value = str(attributes.get(key) or '').strip()
        if value:
            host = value
            break
    port = ''
    for key in ('port', 'service_port'):
        value = str(attributes.get(key) or '').strip()
        if value:
            port = value
            break
    scheme = str(attributes.get('scheme') or 'http').strip().lower() or 'http'
    return host, port, scheme


def _middleware_credentials(config_item):
    from cmdb.passwords import ConfigItemPasswordDecryptionError, decrypt_config_item_password

    credential = getattr(config_item, 'login_password', None)
    if not credential or not credential.password_ciphertext:
        return '', '', '未配置登录凭据'
    try:
        return credential.username or '', decrypt_config_item_password(credential.password_ciphertext), ''
    except ConfigItemPasswordDecryptionError as exc:
        return credential.username or '', '', f'凭据无法解密：{exc}'


def _previous_value(target_key, item_code):
    row = InspectionResult.objects.filter(target_key=target_key, item_code=item_code).order_by('-created_at', '-id').first()
    if not row:
        return None
    return _to_float(row.value)


def collect_middleware_results(config_item, item_codes):
    codes = [code for code in item_codes if code in MIDDLEWARE_ITEM_CODES]
    if not codes:
        return []
    ci_code = config_item.ci_type.code
    prefix = {'REDIS': 'mw.redis.', 'MYSQL': 'mw.mysql.', 'ELASTICSEARCH': 'mw.es.'}.get(ci_code, '')
    codes = [code for code in codes if prefix and code.startswith(prefix)]
    if not codes:
        return []
    configs = _threshold_configs(codes)
    host, port, scheme = _middleware_endpoint(config_item)
    if not host:
        return _unknown_results(codes, '未配置连接地址（attributes.endpoint）')
    username, password, credential_error = _middleware_credentials(config_item)
    if credential_error:
        return _unknown_results(codes, credential_error)
    started = time.monotonic()
    target_key = middleware_target_key(config_item)
    try:
        if ci_code == 'REDIS':
            results = _collect_redis(host, port, username, password, codes, configs, target_key, started)
        elif ci_code == 'MYSQL':
            results = _collect_mysql(host, port, username, password, codes, configs, target_key, started)
        else:
            results = _collect_es(host, port, scheme, username, password, codes, configs, started)
    except Exception as exc:
        return _unknown_results(codes, f'中间件采集失败：{exc}', traceback.format_exc()[:2000])
    produced = {item['item_code'] for item in results}
    results.extend(_unknown_results([code for code in codes if code not in produced], '采集项缺失'))
    return results


def _collect_redis(host, port, username, password, codes, configs, target_key, started):
    import redis

    client = redis.Redis(
        host=host, port=int(port or 6379), username=username or None, password=password or None,
        socket_timeout=MIDDLEWARE_SOCKET_TIMEOUT_SECONDS, socket_connect_timeout=MIDDLEWARE_SOCKET_TIMEOUT_SECONDS,
        decode_responses=True,
    )
    info = client.info()
    results = []

    def add(code, severity, **kwargs):
        results.append(_result(code, severity, threshold=format_threshold(configs.get(code)),
                               duration_ms=int((time.monotonic() - started) * 1000), **kwargs))

    if 'mw.redis.memory' in codes:
        used = _to_float(info.get('used_memory'))
        limit = _to_float(info.get('maxmemory'))
        if not limit:
            add('mw.redis.memory', SEVERITY_UNKNOWN, value='', message='未设置 maxmemory，无法计算内存使用率')
        else:
            ratio = round(used / limit * 100, 1)
            add('mw.redis.memory', evaluate_threshold(ratio, configs.get('mw.redis.memory')),
                value=f'{ratio}%', message=f'内存使用率 {ratio}%（{int(used)} / {int(limit)} 字节）')
    if 'mw.redis.hit_rate' in codes:
        hits = _to_float(info.get('keyspace_hits')) or 0
        misses = _to_float(info.get('keyspace_misses')) or 0
        if hits + misses <= 0:
            add('mw.redis.hit_rate', SEVERITY_UNKNOWN, value='', message='暂无读写计数，无法计算命中率')
        else:
            rate = round(hits / (hits + misses) * 100, 1)
            add('mw.redis.hit_rate', evaluate_threshold(rate, configs.get('mw.redis.hit_rate')),
                value=f'{rate}%', message=f'命中率 {rate}%（命中 {int(hits)} / 未命中 {int(misses)}）')
    if 'mw.redis.replication' in codes:
        role = str(info.get('role') or '')
        if role == 'slave':
            link = str(info.get('master_link_status') or '')
            bad = link != 'up'
            add('mw.redis.replication', SEVERITY_CRITICAL if bad else SEVERITY_OK,
                value='1' if bad else '0',
                message=f'副本链路 {link or "unknown"}' if bad else '副本链路正常',
                evidence=f'master_link_status={link}')
        elif role == 'master':
            slaves = int(_to_float(info.get('connected_slaves')) or 0)
            add('mw.redis.replication', SEVERITY_WARNING if slaves == 0 else SEVERITY_OK,
                value='1' if slaves == 0 else '0',
                message='主节点无已连接副本' if slaves == 0 else f'主节点副本 {slaves} 个',
                evidence=f'connected_slaves={slaves}')
        else:
            add('mw.redis.replication', SEVERITY_UNKNOWN, value='', message='未识别复制角色')
    if 'mw.redis.persistence' in codes:
        rdb = str(info.get('rdb_last_bgsave_status') or '')
        aof = str(info.get('aof_last_bgrewrite_status') or '')
        bad = [name for name, value in (('rdb_last_bgsave_status', rdb), ('aof_last_bgrewrite_status', aof)) if value and value != 'ok']
        add('mw.redis.persistence', SEVERITY_CRITICAL if bad else SEVERITY_OK,
            value='1' if bad else '0',
            message=f'持久化异常：{", ".join(bad)}' if bad else '持久化状态正常',
            evidence=f'rdb={rdb or "-"} aof={aof or "-"}')
    if 'mw.redis.evicted' in codes:
        current = _to_float(info.get('evicted_keys')) or 0
        previous = _previous_value(target_key, 'mw.redis.evicted')
        if previous is None:
            add('mw.redis.evicted', SEVERITY_UNKNOWN, value='0', message='首次采集，已建立基线')
        else:
            delta = max(current - previous, 0)
            add('mw.redis.evicted', evaluate_threshold(delta, configs.get('mw.redis.evicted')),
                value=f'{delta:g}', message=f'较上次巡检新增淘汰 {delta:g} 个 key',
                evidence=f'evicted_keys={int(current)} previous={int(previous)}')
    return results


def _collect_mysql(host, port, username, password, codes, configs, target_key, started):
    import pymysql

    connection = pymysql.connect(
        host=host, port=int(port or 3306), user=username or 'root', password=password or '',
        connect_timeout=MIDDLEWARE_SOCKET_TIMEOUT_SECONDS, read_timeout=10, charset='utf8mb4',
    )
    results = []

    def add(code, severity, **kwargs):
        results.append(_result(code, severity, threshold=format_threshold(configs.get(code)),
                               duration_ms=int((time.monotonic() - started) * 1000), **kwargs))

    def query(sql):
        with connection.cursor() as cursor:
            cursor.execute(sql)
            return cursor.fetchall()

    try:
        status = {row[0]: row[1] for row in query('SHOW GLOBAL STATUS')}
        variables = {row[0]: row[1] for row in query('SHOW GLOBAL VARIABLES')}
        if 'mw.mysql.connections' in codes:
            connected = _to_float(status.get('Threads_connected')) or 0
            limit = _to_float(variables.get('max_connections')) or 0
            if limit <= 0:
                add('mw.mysql.connections', SEVERITY_UNKNOWN, value='', message='无法读取 max_connections')
            else:
                ratio = round(connected / limit * 100, 1)
                add('mw.mysql.connections', evaluate_threshold(ratio, configs.get('mw.mysql.connections')),
                    value=f'{ratio}%', message=f'连接使用率 {ratio}%（{int(connected)} / {int(limit)}）')
        if 'mw.mysql.slow_query' in codes:
            current = _to_float(status.get('Slow_queries')) or 0
            previous = _previous_value(target_key, 'mw.mysql.slow_query')
            if previous is None:
                add('mw.mysql.slow_query', SEVERITY_UNKNOWN, value='0', message='首次采集，已建立基线')
            else:
                delta = max(current - previous, 0)
                add('mw.mysql.slow_query', evaluate_threshold(delta, configs.get('mw.mysql.slow_query')),
                    value=f'{delta:g}', message=f'较上次巡检新增慢查询 {delta:g} 条',
                    evidence=f'Slow_queries={int(current)} previous={int(previous)}')
        if 'mw.mysql.replication' in codes:
            rows = []
            for sql in ('SHOW SLAVE STATUS', 'SHOW REPLICA STATUS'):
                try:
                    rows = query(sql)
                except Exception:
                    rows = []
                if rows:
                    break
            if not rows:
                add('mw.mysql.replication', SEVERITY_OK, value='0', message='未配置主从复制')
            else:
                with connection.cursor() as cursor:
                    cursor.execute('SHOW SLAVE STATUS')
                    columns = [item[0] for item in cursor.description or []]
                detail = dict(zip(columns, rows[0])) if columns else {}
                io = str(detail.get('Slave_IO_Running') or detail.get('Replica_IO_Running') or '')
                sql_thread = str(detail.get('Slave_SQL_Running') or detail.get('Replica_SQL_Running') or '')
                lag = _to_float(detail.get('Seconds_Behind_Master'))
                broken = io.lower() != 'yes' or sql_thread.lower() != 'yes'
                if broken:
                    severity = SEVERITY_CRITICAL
                elif lag is not None and lag >= 60:
                    severity = SEVERITY_WARNING
                else:
                    severity = SEVERITY_OK
                add('mw.mysql.replication', severity, value='1' if broken else '0',
                    message=f'复制线程异常 IO={io or "-"} SQL={sql_thread or "-"}' if broken
                    else f'复制正常，延迟 {lag if lag is not None else "-"}s',
                    evidence=f'IO={io} SQL={sql_thread} lag={lag}')
        if 'mw.mysql.buffer_pool' in codes:
            requests_count = _to_float(status.get('Innodb_buffer_pool_read_requests')) or 0
            misses = _to_float(status.get('Innodb_buffer_pool_reads')) or 0
            if requests_count <= 0:
                add('mw.mysql.buffer_pool', SEVERITY_UNKNOWN, value='', message='暂无缓冲池读计数')
            else:
                rate = round((1 - misses / requests_count) * 100, 1)
                add('mw.mysql.buffer_pool', evaluate_threshold(rate, configs.get('mw.mysql.buffer_pool')),
                    value=f'{rate}%', message=f'缓冲池命中率 {rate}%',
                    evidence=f'read_requests={int(requests_count)} read_misses={int(misses)}')
    finally:
        connection.close()
    return results


def _collect_es(host, port, scheme, username, password, codes, configs, started):
    import requests

    base = f'{scheme}://{host}:{int(port or 9200)}'
    auth = (username, password) if username else None
    results = []

    def add(code, severity, **kwargs):
        results.append(_result(code, severity, threshold=format_threshold(configs.get(code)),
                               duration_ms=int((time.monotonic() - started) * 1000), **kwargs))

    if 'mw.es.health' in codes:
        response = requests.get(f'{base}/_cluster/health', timeout=MIDDLEWARE_SOCKET_TIMEOUT_SECONDS, auth=auth)
        response.raise_for_status()
        health = response.json()
        state = str(health.get('status') or '')
        severity = SEVERITY_CRITICAL if state == 'red' else SEVERITY_WARNING if state == 'yellow' else SEVERITY_OK
        if state not in ('green', 'yellow', 'red'):
            severity = SEVERITY_UNKNOWN
        add('mw.es.health', severity, value='1' if severity in (SEVERITY_WARNING, SEVERITY_CRITICAL) else '0',
            message=f'集群健康 {state or "unknown"}',
            evidence=f'status={state} unassigned_shards={health.get("unassigned_shards")}')
    if 'mw.es.unassigned' in codes:
        response = requests.get(f'{base}/_cluster/health', timeout=MIDDLEWARE_SOCKET_TIMEOUT_SECONDS, auth=auth)
        response.raise_for_status()
        unassigned = _to_float((response.json() or {}).get('unassigned_shards')) or 0
        add('mw.es.unassigned', evaluate_threshold(unassigned, configs.get('mw.es.unassigned')),
            value=f'{unassigned:g}', message=f'未分配分片 {unassigned:g} 个')
    if 'mw.es.heap' in codes:
        response = requests.get(f'{base}/_nodes/stats/jvm', timeout=MIDDLEWARE_SOCKET_TIMEOUT_SECONDS, auth=auth)
        response.raise_for_status()
        nodes = (response.json() or {}).get('nodes') or {}
        ratios = []
        for node in nodes.values():
            heap = ((node or {}).get('jvm') or {}).get('mem') or {}
            used = _to_float(heap.get('heap_used_in_bytes'))
            limit = _to_float(heap.get('heap_max_in_bytes'))
            if used is None or not limit:
                continue
            ratios.append(round(used / limit * 100, 1))
        if not ratios:
            add('mw.es.heap', SEVERITY_UNKNOWN, value='', message='未获取到 JVM 堆数据')
        else:
            worst = max(ratios)
            add('mw.es.heap', evaluate_threshold(worst, configs.get('mw.es.heap')),
                value=f'{worst}%', message=f'最高堆使用率 {worst}%（{len(ratios)} 个节点）')
    return results
