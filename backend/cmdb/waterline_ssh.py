"""SSH-based resource waterline collection for physical hosts and VMs.

Used by ``/api/cmdb/resource-metrics/refresh-current-page/`` when an asset has
no cloud source mapping (Aliyun/Huawei ECS, vSphere) but does have a login
credential and an SSH port. Runs one portable shell snippet and stores
cpu_usage / memory_usage / disk_usage snapshots.
"""
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal, InvalidOperation

import paramiko
from django.db import connection
from django.utils import timezone

from ops import ssh_known_hosts

from .models import CIResourceMetricSnapshot, ConfigItemPassword
from .passwords import decrypt_config_item_password

logger = logging.getLogger(__name__)

SSH_WATERLINE_CI_TYPES = {'IDC_SERVER', 'CLOUD_SERVER', 'VIRTUAL_MACHINE'}
DEFAULT_SSH_PORT = 22
SSH_TIMEOUT_SECONDS = 8
COMMAND_TIMEOUT_SECONDS = 20
METRIC_KEYS = {
    'CPU': 'cpu_usage',
    'MEM': 'memory_usage',
    'DISK': 'disk_usage',
}

COLLECT_COMMAND = r'''
OS=$(uname -s 2>/dev/null || echo unknown)
case "$OS" in
  Linux)
    read _ u n s i w irq sirq st _ < /proc/stat
    t1=$((u+n+s+i+w+irq+sirq+st)); i1=$((i+w))
    sleep 1
    read _ u n s i w irq sirq st _ < /proc/stat
    t2=$((u+n+s+i+w+irq+sirq+st)); i2=$((i+w))
    CPU=$(awk -v t1="$t1" -v i1="$i1" -v t2="$t2" -v i2="$i2" \
      'BEGIN { if (t2 > t1) printf "%.2f", 100 * (1 - (i2 - i1) / (t2 - t1)); else printf "0.00" }')
    MEM=$(free -b | awk '/^Mem:/ { if ($2 > 0) printf "%.2f", ($2 - $7) / $2 * 100; else printf "0.00" }')
    ;;
  Darwin)
    IDLE=$(top -l 1 -n 0 | sed -n 's/.*CPU usage:.*, \([0-9.]*\)% idle.*/\1/p' | head -1)
    CPU=$(awk -v i="$IDLE" 'BEGIN { if (i == "") i = 0; printf "%.2f", 100 - i }')
    TOTAL=$(sysctl -n hw.memsize)
    PAGESIZE=$(sysctl -n hw.pagesize)
    ACTIVE=$(vm_stat | awk '/Pages active/ { gsub(/\./, "", $3); print $3 }')
    WIRED=$(vm_stat | awk '/Pages wired down/ { gsub(/\./, "", $4); print $4 }')
    COMPRESSED=$(vm_stat | awk '/Pages occupied by compressor/ { gsub(/\./, "", $5); print $5 }')
    MEM=$(awk -v a="$ACTIVE" -v w="$WIRED" -v c="$COMPRESSED" -v p="$PAGESIZE" -v t="$TOTAL" \
      'BEGIN { if (t > 0) printf "%.2f", (a + w + c) * p / t * 100; else printf "0.00" }')
    ;;
  *)
    echo "WATERLINE_ERROR=unsupported-os:$OS" >&2
    exit 3
    ;;
esac
DISK=$(df -P / 2>/dev/null | awk 'NR==2 { gsub("%", "", $5); print $5 }')
echo "WATERLINE_CPU=$CPU"
echo "WATERLINE_MEM=$MEM"
echo "WATERLINE_DISK=$DISK"
'''


class WaterlineSSHError(Exception):
    pass


def _ssh_target(config_item):
    attributes = config_item.attributes or {}
    host = str(
        attributes.get('private_ip')
        or attributes.get('ip_address')
        or attributes.get('public_ip')
        or attributes.get('ip')
        or ''
    ).strip()
    if not host:
        raise WaterlineSSHError('资产未配置管理 IP')
    try:
        port = int(attributes.get('ssh_port') or DEFAULT_SSH_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_SSH_PORT
    if not 1 <= port <= 65535:
        port = DEFAULT_SSH_PORT
    credential = ConfigItemPassword.objects.filter(config_item=config_item).first()
    if credential is None:
        raise WaterlineSSHError('未配置登录凭据')
    username = (credential.username or '').strip()
    if not username:
        raise WaterlineSSHError('登录凭据缺少用户名')
    if not credential.password_ciphertext:
        raise WaterlineSSHError('登录凭据缺少密码')
    try:
        password = decrypt_config_item_password(credential.password_ciphertext)
    except Exception as exc:  # noqa: BLE001 - surface the credential error to the operator
        raise WaterlineSSHError(f'登录凭据解密失败：{exc}') from exc
    return host, port, username, password


def parse_waterline_output(output):
    values = {}
    for line in (output or '').splitlines():
        line = line.strip()
        if not line.startswith('WATERLINE_'):
            continue
        key, _, raw = line.partition('=')
        metric = METRIC_KEYS.get(key.removeprefix('WATERLINE_'))
        if not metric:
            continue
        try:
            value = Decimal(str(raw).strip()).quantize(Decimal('0.01'))
        except (InvalidOperation, ValueError):
            continue
        if value < 0:
            value = Decimal('0')
        elif value > 100:
            value = Decimal('100')
        values[metric] = value
    missing = [metric for metric in METRIC_KEYS.values() if metric not in values]
    if missing:
        raise WaterlineSSHError(f'采集输出缺少指标：{", ".join(missing)}')
    return values


def collect_ssh_waterline(config_item):
    """Collect one asset's waterline over SSH and persist snapshots."""
    ci_type_code = getattr(getattr(config_item, 'ci_type', None), 'code', '')
    if ci_type_code not in SSH_WATERLINE_CI_TYPES:
        raise WaterlineSSHError(f'资产类型 {ci_type_code or "unknown"} 不支持 SSH 水位采集')

    host, port, username, password = _ssh_target(config_item)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(ssh_known_hosts.policy())
    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=SSH_TIMEOUT_SECONDS,
            banner_timeout=SSH_TIMEOUT_SECONDS,
            auth_timeout=SSH_TIMEOUT_SECONDS,
            look_for_keys=False,
            allow_agent=False,
        )
        _, stdout, stderr = client.exec_command(COLLECT_COMMAND, timeout=COMMAND_TIMEOUT_SECONDS)
        output = stdout.read().decode('utf-8', 'replace')
        error = stderr.read().decode('utf-8', 'replace')
        exit_status = stdout.channel.recv_exit_status()
    except WaterlineSSHError:
        raise
    except Exception as exc:  # noqa: BLE001 - paramiko raises many transport errors
        raise WaterlineSSHError(f'SSH 连接失败：{exc}') from exc
    finally:
        client.close()

    if exit_status != 0:
        detail = (error or output).strip().splitlines()
        raise WaterlineSSHError(f'采集命令失败：{detail[-1][:200] if detail else exit_status}')

    metrics = parse_waterline_output(output)
    now = timezone.now()
    for metric, value in metrics.items():
        CIResourceMetricSnapshot.objects.create(
            ci=config_item,
            metric=metric,
            value=value,
            usage_percent=value,
            unit='%',
            collected_at=now,
            source='ssh',
        )
    return {
        'ci_id': config_item.id,
        'name': config_item.name,
        'metrics': {metric: str(value) for metric, value in metrics.items()},
    }


def collect_ssh_waterline_batch(config_items, max_workers=8):
    """Run SSH collection concurrently; returns (collected, skipped)."""
    items = list(config_items)
    if not items:
        return [], []

    def work(config_item):
        try:
            return config_item.id, config_item.name, collect_ssh_waterline(config_item), None
        except Exception as exc:  # noqa: BLE001 - reported per asset
            return config_item.id, config_item.name, None, str(exc)
        finally:
            connection.close()

    collected, skipped = [], []
    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, len(items)))) as executor:
        futures = [executor.submit(work, item) for item in items]
        for future in as_completed(futures):
            ci_id, name, result, error = future.result()
            if result is not None:
                collected.append(result)
            else:
                skipped.append({'ci_id': ci_id, 'name': name, 'reason': f'SSH 水位采集失败：{error}'})
    collected.sort(key=lambda item: item['ci_id'])
    skipped.sort(key=lambda item: item['ci_id'] or 0)
    return collected, skipped