"""Interactive cluster shell backed by a short-lived, cluster-scoped kubeconfig."""
import json
import codecs
import logging
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from urllib.parse import parse_qs

try:
    import pty
except ImportError:
    pty = None

from channels.generic.websocket import WebsocketConsumer
from rest_framework.authtoken.models import Token

from ops.k8s_views import _is_demo, _prepare_kubeconfig
from ops.k8s_shell import interactive_shell_command
from ops.webshell_guard import WebShellGuard, handle_guard_events, load_rules
from ops.models import K8sCluster
from rbac.services import user_has_permissions
from rbac.k8s_access import can_access_k8s

logger = logging.getLogger(__name__)
K8S_CLUSTER_TERMINAL_MAX_SECONDS = 30 * 60


class K8sClusterTerminalConsumer(WebsocketConsumer):
    """Expose an interactive shell with only the selected cluster kubeconfig."""

    channel_layer_alias = None
    process = None
    master_fd = None
    temp_dir = None
    _reading = False

    def connect(self):
        self.cluster_id = self.scope['url_route']['kwargs']['cluster_id']
        token_key = parse_qs(self.scope.get('query_string', b'').decode('utf-8')).get('token', [''])[0]
        token = Token.objects.filter(key=token_key).select_related('user').first()
        if not token or not token.user.is_active:
            self.close(code=4401)
            return
        if not user_has_permissions(token.user, ['ops.k8s.terminal']):
            self.close(code=4403)
            return

        try:
            self.cluster = K8sCluster.objects.get(pk=self.cluster_id)
        except K8sCluster.DoesNotExist:
            self.close(code=4404)
            return

        if not can_access_k8s(token.user, self.cluster_id, shell=True):
            self.close(code=4403)
            return
        if _is_demo(self.cluster):
            # demo 集群没有真实 kubeconfig，起本地 shell 只会把应用主机暴露给用户。
            self.accept()
            self.send(text_data=json.dumps({
                'type': 'error',
                'message': '演示集群不提供真实终端；请连接已配置 kubeconfig 的集群。',
            }))
            self.close(code=4400)
            return
        self.user = token.user
        self.guard = WebShellGuard(load_rules())
        self.accept()
        try:
            self._start_shell()
        except Exception as exc:
            logger.exception('K8s cluster terminal connection failed for cluster %s', self.cluster_id)
            self.send(text_data=json.dumps({'type': 'error', 'message': f'集群终端连接失败: {exc}'}))
            self.close()

    def disconnect(self, close_code):
        self._reading = False
        if getattr(self, '_timeout_timer', None):
            self._timeout_timer.cancel()
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except OSError:
                self.process.terminate()
        if self.process:
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        if self.temp_dir:
            shutil.rmtree(self.temp_dir, ignore_errors=True)
            self.temp_dir = None

    def receive(self, text_data=None, bytes_data=None):
        if not text_data or self.master_fd is None:
            return
        try:
            payload = json.loads(text_data)
        except json.JSONDecodeError:
            return
        try:
            if payload.get('type') == 'input':
                forward, events = self.guard.process(str(payload.get('data', '')))
                if forward:
                    os.write(self.master_fd, forward.encode('utf-8'))
                if events:
                    handle_guard_events(
                        events, user=self.user, resource_type='k8s_cluster',
                        resource_id=self.cluster_id, resource_name=self.cluster.name,
                        send_text=lambda text: self.send(text_data=json.dumps({'type': 'output', 'data': text})),
                    )
            elif payload.get('type') == 'resize':
                self._resize(payload.get('cols', 120), payload.get('rows', 40))
        except (OSError, TypeError, ValueError):
            pass

    def _sandbox_ids(self):
        """终端进程要降到的非特权身份；拿不到就返回 None（例如本地非 root 开发）。"""
        if os.geteuid() != 0:
            return None
        try:
            import pwd

            entry = pwd.getpwnam('nobody')
            return entry.pw_uid, entry.pw_gid
        except (ImportError, KeyError):
            return 65534, 65534

    def _sandbox_preexec(self):
        uid_gid = getattr(self, '_sandbox_uid_gid', None)

        def apply():
            try:
                import resource

                limits = (
                    (resource.RLIMIT_NOFILE, 512),
                    (resource.RLIMIT_NPROC, 128),
                    (resource.RLIMIT_CPU, K8S_CLUSTER_TERMINAL_MAX_SECONDS + 60),
                    (resource.RLIMIT_FSIZE, 32 * 1024 * 1024),
                )
                for limit, value in limits:
                    try:
                        resource.setrlimit(limit, (value, value))
                    except (ValueError, OSError):
                        continue
            except ImportError:
                pass
            if uid_gid is not None:
                uid, gid = uid_gid
                try:
                    os.setgroups([])
                    os.setgid(gid)
                    os.setuid(uid)
                except OSError:
                    pass

        return apply

    def _start_shell(self):
        if pty is None:
            raise RuntimeError('当前运行环境不支持交互式终端')
        self.temp_dir = tempfile.mkdtemp(prefix='sxdevops-k8s-terminal-')
        kubeconfig_path = os.path.join(self.temp_dir, 'config')
        with open(kubeconfig_path, 'w', encoding='utf-8') as kubeconfig_file:
            kubeconfig_file.write(_prepare_kubeconfig(self.cluster) if not _is_demo(self.cluster) else '')
        os.chmod(kubeconfig_path, 0o600)
        self._sandbox_uid_gid = self._sandbox_ids()
        if self._sandbox_uid_gid is not None:
            # 目录与 kubeconfig 交给非特权用户，避免它只能读 root 的临时目录。
            uid, gid = self._sandbox_uid_gid
            os.chown(self.temp_dir, uid, gid)
            os.chown(kubeconfig_path, uid, gid)

        master_fd, slave_fd = pty.openpty()
        self.master_fd = master_fd
        env = {
            'HOME': self.temp_dir,
            'KUBECONFIG': kubeconfig_path,
            'LANG': 'C.UTF-8',
            'LC_ALL': 'C.UTF-8',
            'PATH': '/usr/local/bin:/usr/bin:/bin',
            'PS1': 'sx-k8s:\\w\\$ ',
            'TERM': 'xterm-256color',
            'HISTFILE': '/dev/null',
        }
        shell_command = interactive_shell_command(shutil.which('bash') or '/bin/sh')
        self.process = subprocess.Popen(
            [sys.executable, '-c', 'import os, sys, fcntl, termios; os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0); os.execv(sys.argv[1], sys.argv[1:])', *shell_command],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=self.temp_dir,
            env=env,
            close_fds=True,
            preexec_fn=self._sandbox_preexec(),
        )
        os.close(slave_fd)
        self._resize(120, 36)
        self._reading = True
        self._timeout_timer = threading.Timer(K8S_CLUSTER_TERMINAL_MAX_SECONDS, self._expire_session)
        self._timeout_timer.daemon = True
        self._timeout_timer.start()
        self.send(text_data=json.dumps({
            'type': 'connected',
            'message': f'已连接 {self.cluster.name}；当前 Shell 已绑定该集群的 kubeconfig。',
        }))
        threading.Thread(target=self._read_output, daemon=True).start()

    def _write_line(self, command):
        if self.master_fd is not None:
            os.write(self.master_fd, f'{command}\r'.encode('utf-8'))

    def _resize(self, cols, rows):
        import fcntl
        import struct
        import termios

        cols = min(500, max(20, int(cols or 120)))
        rows = min(300, max(5, int(rows or 36)))
        fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def _read_output(self):
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        while self._reading and self.master_fd is not None:
            try:
                ready, _, _ = select.select([self.master_fd], [], [], 0.5)
                if not ready:
                    continue
                chunk = os.read(self.master_fd, 4096)
                if not chunk:
                    break
                self.send(text_data=json.dumps({'type': 'output', 'data': decoder.decode(chunk)}))
            except OSError:
                break
            except Exception:
                logger.exception('K8s cluster terminal read error')
                break
        if self._reading:
            self._reading = False
            remaining = decoder.decode(b'', final=True)
            if remaining:
                self.send(text_data=json.dumps({'type': 'output', 'data': remaining}))
            self.close()

    def _expire_session(self):
        if self._reading:
            self.send(text_data=json.dumps({'type': 'error', 'message': '会话已达到 30 分钟时限，请重新连接。'}))
            self.close(code=4000)
