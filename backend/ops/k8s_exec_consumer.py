import json
import logging
import threading
import time
from urllib.parse import parse_qs

from channels.generic.websocket import WebsocketConsumer
from kubernetes.stream import stream
from kubernetes.stream.ws_client import RESIZE_CHANNEL

from ops.models import K8sCluster
from ops.k8s_views import _get_k8s_client, _is_demo
from ops.k8s_shell import interactive_shell_command
from ops.webshell_guard import WebShellGuard, handle_guard_events, load_rules
from rbac.services import user_has_console_access, user_has_permissions
from rbac.k8s_access import can_access_k8s
from rbac.websocket import resolve_terminal_user

logger = logging.getLogger(__name__)


class K8sExecConsumer(WebsocketConsumer):
    channel_layer_alias = None
    exec_stream = None
    _reading = False
    _write_lock = None
    _demo_buffer = ''
    _demo_cwd = '/app'

    def connect(self):
        self.cluster_id = self.scope['url_route']['kwargs']['cluster_id']
        query = parse_qs(self.scope.get('query_string', b'').decode('utf-8'))
        ticket_key = query.get('ticket', [''])[0]
        legacy_token_key = query.get('token', [''])[0]
        self.pod_name = query.get('pod_name', [''])[0]
        self.namespace = query.get('namespace', ['default'])[0] or 'default'
        self.container = query.get('container', [''])[0]
        self.shell = query.get('shell', ['auto'])[0] or 'auto'

        user = resolve_terminal_user(ticket_key=ticket_key, legacy_token_key=legacy_token_key)
        if not user or not user.is_active:
            self.close(code=4401)
            return
        if not user_has_console_access(user, ['ops.k8s.exec']):
            self.close(code=4403)
            return
        if not self.pod_name:
            self.close(code=4400)
            return

        try:
            self.cluster = K8sCluster.objects.get(pk=self.cluster_id)
        except K8sCluster.DoesNotExist:
            self.close(code=4404)
            return

        self.user = user
        if not can_access_k8s(self.user, self.cluster_id, self.namespace, execute=True):
            self.close(code=4403)
            return
        self.guard = WebShellGuard(load_rules())
        self.accept()

        if _is_demo(self.cluster):
            self.send(text_data=json.dumps({
                'type': 'connected',
                'message': f'Connected to demo pod {self.pod_name} ({self.namespace})',
            }))
            self.send(text_data=json.dumps({
                'type': 'output',
                'data': (
                    f'Welcome to demo pod terminal: {self.pod_name}\r\n'
                    f'Namespace: {self.namespace}\r\n'
                    'Try commands: pwd, ls, env, kubectl get pods, clear, exit\r\n\r\n$ '
                ),
            }))
            return

        try:
            k8s = _get_k8s_client(self.cluster)
            v1 = k8s.CoreV1Api()
            kwargs = {
                'name': self.pod_name,
                'namespace': self.namespace,
                'command': interactive_shell_command(self.shell),
                'stderr': True,
                'stdin': True,
                'stdout': True,
                'tty': True,
                '_preload_content': False,
                # websocket 通道只接受标量超时（元组会触发 run_forever TypeError）。
                '_request_timeout': 20,
            }
            if self.container:
                kwargs['container'] = self.container

            self.exec_stream = stream(v1.connect_get_namespaced_pod_exec, **kwargs)
            # 写 stdin 与读线程的 update/close 会并发访问同一条 websocket，需要同一把锁。
            self._write_lock = threading.Lock()
            self._reading = True
            self.send(text_data=json.dumps({
                'type': 'connected',
                'message': f'Connected to {self.pod_name} ({self.namespace})',
            }))
            self._read_thread = threading.Thread(target=self._read_exec_output, daemon=True)
            self._read_thread.start()
        except Exception as exc:
            logger.exception('K8s exec connection failed')
            self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'K8s terminal connection failed: {str(exc)}',
            }))
            self.close()

    def disconnect(self, close_code):
        self._reading = False
        lock = self._write_lock
        if self.exec_stream:
            try:
                if lock is not None:
                    with lock:
                        self.exec_stream.close()
                else:
                    self.exec_stream.close()
            except Exception:
                pass
            self.exec_stream = None

    def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        msg_type = data.get('type')
        if _is_demo(self.cluster):
            if msg_type == 'input':
                self._handle_demo_input(data.get('data', ''))
            return

        if not self.exec_stream:
            return

        try:
            if msg_type == 'input':
                forward, events = self.guard.process(str(data.get('data', '')))
                if forward:
                    lock = self._write_lock
                    if lock is not None:
                        with lock:
                            self.exec_stream.write_stdin(forward)
                    else:
                        self.exec_stream.write_stdin(forward)
                if events:
                    handle_guard_events(
                        events, user=self.user, resource_type='k8s_pod',
                        resource_id=self.cluster_id,
                        resource_name=f'{self.namespace}/{self.pod_name}',
                        send_text=lambda text: self.send(text_data=json.dumps({'type': 'output', 'data': text})),
                    )
            elif msg_type == 'resize':
                cols = min(500, max(20, int(data.get('cols', 120) or 120)))
                rows = min(300, max(5, int(data.get('rows', 40) or 40)))
                lock = self._write_lock
                payload = json.dumps({'Width': cols, 'Height': rows})
                if lock is not None:
                    with lock:
                        self.exec_stream.write_channel(RESIZE_CHANNEL, payload)
                else:
                    self.exec_stream.write_channel(RESIZE_CHANNEL, payload)
        except Exception as exc:
            logger.error('K8s exec input error: %s', exc)

    def _read_exec_output(self):
        connection = self.exec_stream
        lock = self._write_lock
        while self._reading and connection and connection.is_open():
            try:
                if lock is not None:
                    with lock:
                        connection.update(timeout=1)
                else:
                    connection.update(timeout=1)
                output = ''
                if connection.peek_stdout():
                    output += connection.read_stdout()
                if connection.peek_stderr():
                    output += connection.read_stderr()
                if output:
                    self.send(text_data=json.dumps({
                        'type': 'output',
                        'data': output,
                    }))
                time.sleep(0.02)
            except Exception as exc:
                if self._reading:
                    logger.error('K8s exec read error: %s', exc)
                    self.send(text_data=json.dumps({
                        'type': 'error',
                        'message': f'Terminal disconnected: {str(exc)}',
                    }))
                break
        if self._reading:
            self._reading = False
            if connection:
                try:
                    if lock is not None:
                        with lock:
                            connection.close()
                    else:
                        connection.close()
                except Exception:
                    pass
            self.close()

    def _handle_demo_input(self, incoming):
        for char in incoming:
            if char in ('\r', '\n'):
                command = self._demo_buffer.strip()
                self._demo_buffer = ''
                self.send(text_data=json.dumps({'type': 'output', 'data': '\r\n'}))
                if command == 'clear':
                    self.send(text_data=json.dumps({'type': 'output', 'data': '\x1b[2J\x1b[H$ '}))
                    continue
                if command in ('exit', 'logout'):
                    self.send(text_data=json.dumps({'type': 'output', 'data': 'logout\r\n'}))
                    self.close()
                    return
                result = self._run_demo_command(command)
                suffix = '\r\n$ '
                self.send(text_data=json.dumps({'type': 'output', 'data': f'{result}{suffix}'}))
            elif char == '\x7f':
                if self._demo_buffer:
                    self._demo_buffer = self._demo_buffer[:-1]
                    self.send(text_data=json.dumps({'type': 'output', 'data': '\b \b'}))
            else:
                self._demo_buffer += char
                self.send(text_data=json.dumps({'type': 'output', 'data': char}))

    def _run_demo_command(self, command):
        if not command:
            return ''
        if command == 'pwd':
            return self._demo_cwd
        if command == 'ls':
            return 'app  config  logs  tmp'
        if command in ('env', 'printenv'):
            return 'HOSTNAME=demo-pod\nKUBERNETES_NAMESPACE=production\nAPP_ENV=demo'
        if command.startswith('cd '):
            target = command[3:].strip() or '/'
            self._demo_cwd = target if target.startswith('/') else f'/{target}'
            return ''
        if command == 'whoami':
            return 'app'
        if command == 'kubectl get pods':
            return (
                'NAME                           READY   STATUS    RESTARTS   AGE\n'
                'api-server-5f8b7c6d4-r9p2w     1/1     Running   1          3d\n'
                'nginx-deployment-7c5b4f9d8     1/1     Running   0          4d'
            )
        return f'sh: {command}: command not found'
