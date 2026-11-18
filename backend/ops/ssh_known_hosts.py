"""SSH / Ansible 主机密钥校验（TOFU + 拒绝变更）。

首次连接记录到 known_hosts；已记录但密钥变更时抛 paramiko.BadHostKeyException，
避免中间人拿到主机口令。SXDEVOPS_SSH_STRICT_HOST_KEY=False 可临时退回 AutoAddPolicy。
"""
import logging
import os
import threading
from pathlib import Path

import paramiko
from django.conf import settings

logger = logging.getLogger(__name__)
_write_lock = threading.Lock()
_warned = False


def known_hosts_path():
    configured = getattr(settings, 'SXDEVOPS_SSH_KNOWN_HOSTS', '')
    if configured:
        return Path(configured)
    base_dir = getattr(settings, 'BASE_DIR', None) or Path.cwd()
    return Path(base_dir) / 'runtime' / 'known_hosts'


def _ensure_file(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        path.touch(mode=0o600, exist_ok=True)
    try:
        os.chmod(path, 0o600)
    except OSError:
        logger.warning('无法设置 known_hosts 权限: %s', path)
    return path


class KnownHostsRecorder(paramiko.MissingHostKeyPolicy):
    """首次见到的密钥写入 known_hosts；已记录但变更时拒绝连接。"""

    def missing_host_key(self, client, hostname, key):
        path = _ensure_file(known_hosts_path())
        host_keys = paramiko.HostKeys()
        try:
            host_keys.load(str(path))
        except (OSError, IOError):
            host_keys = paramiko.HostKeys()
        known = host_keys.lookup(hostname) or {}
        entry = known.get(key.get_name())
        if entry is not None:
            if entry != key:
                raise paramiko.BadHostKeyException(hostname, key, entry)
            return
        with _write_lock:
            with open(path, 'a', encoding='utf-8') as handle:
                handle.write(f'{hostname} {key.get_name()} {key.get_base64()}\n')
        host_keys.add(hostname, key.get_name(), key)
        client.get_host_keys().add(hostname, key.get_name(), key)
        logger.info('已记录主机密钥 host=%s type=%s', hostname, key.get_name())


def strict_enabled():
    return bool(getattr(settings, 'SXDEVOPS_SSH_STRICT_HOST_KEY', True))


def policy():
    global _warned
    if not strict_enabled():
        if not _warned:
            logger.warning('SXDEVOPS_SSH_STRICT_HOST_KEY=False：SSH 主机密钥校验已关闭')
            _warned = True
        return paramiko.AutoAddPolicy()
    return KnownHostsRecorder()


def common_args():
    """ansible 用的 ssh 参数。"""
    if not strict_enabled():
        return '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
    path = _ensure_file(known_hosts_path())
    return f'-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={path}'
