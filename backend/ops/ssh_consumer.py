"""
WebSocket Consumer for SSH Shell (WebShell)
Uses paramiko to create an interactive SSH session and forwards I/O over WebSocket.
"""
import json
import threading
import logging
from urllib.parse import parse_qs

import paramiko
from channels.generic.websocket import WebsocketConsumer
from rbac.services import user_has_console_access

from eventwall.services import record_event
from .credentials import decrypt_password
from rbac.websocket import resolve_terminal_user
from . import ssh_known_hosts
from .webshell_guard import WebShellGuard, handle_guard_events, load_rules

logger = logging.getLogger(__name__)
SSH_TERMINAL_MAX_SECONDS = 3600
SSH_TERMINAL_IDLE_SECONDS = 900


class SSHConsumer(WebsocketConsumer):
    ssh_client = None
    ssh_channel = None
    _reading = False

    def connect(self):
        self.host_id = self.scope['url_route']['kwargs']['host_id']
        query = parse_qs(self.scope.get('query_string', b'').decode('utf-8', errors='replace'))
        user = resolve_terminal_user(
            ticket_key=query.get('ticket', [''])[0],
            legacy_token_key=query.get('token', [''])[0],
        )
        if not user or not user.is_active:
            self.close(code=4401)
            return
        if not user_has_console_access(user, ['ops.host.terminal']):
            self.close(code=4403)
            return

        self.user = user
        self.guard = WebShellGuard(load_rules())
        self.accept()

        # 获取 Host 信息
        from ops.models import Host
        try:
            host = Host.objects.get(pk=self.host_id)
        except Host.DoesNotExist:
            self.send(text_data=json.dumps({'type': 'error', 'message': '主机不存在'}))
            self.close()
            return
        self.host_name = host.hostname
        record_event(
            module='ops', category='security', action='webshell_connect',
            title=f'打开 WebShell：{host.hostname}',
            summary=f'用户 {self.user.username} 打开主机 {host.hostname} ({host.ip_address}) 终端',
            actor_username=self.user.username, resource_type='host',
            resource_id=host.pk, resource_name=host.hostname,
        )

        # 建立 SSH 连接
        try:
            self.ssh_client = paramiko.SSHClient()
            self.ssh_client.set_missing_host_key_policy(ssh_known_hosts.policy())
            self.ssh_client.connect(
                hostname=host.ip_address,
                port=host.ssh_port or 22,
                username=host.ssh_user or 'root',
                password=decrypt_password(host.ssh_password) or None,
                timeout=15,
            )
            self.ssh_channel = self.ssh_client.invoke_shell(
                term='xterm-256color',
                width=120,
                height=40,
            )
            self.ssh_channel.settimeout(0.0)

            # 启动读取线程
            self._reading = True
            self._read_thread = threading.Thread(target=self._read_ssh_output, daemon=True)
            self._read_thread.start()
            self._idle_timer = threading.Timer(SSH_TERMINAL_IDLE_SECONDS, self._expire_idle_session)
            self._idle_timer.daemon = True
            self._idle_timer.start()
            self._max_timer = threading.Timer(SSH_TERMINAL_MAX_SECONDS, self._expire_session)
            self._max_timer.daemon = True
            self._max_timer.start()

            self.send(text_data=json.dumps({
                'type': 'connected',
                'message': f'已连接到 {host.hostname} ({host.ip_address})',
            }))

        except Exception as e:
            logger.exception('SSH connection failed')
            self.send(text_data=json.dumps({
                'type': 'error',
                'message': f'SSH 连接失败: {str(e)}',
            }))
            self.close()

    def _expire_idle_session(self):
        if self._reading:
            self.send(text_data=json.dumps({'type': 'error', 'message': f'会话空闲超过 {SSH_TERMINAL_IDLE_SECONDS // 60} 分钟，已自动断开。'}))
            self.close(code=4000)

    def _expire_session(self):
        if self._reading:
            self.send(text_data=json.dumps({'type': 'error', 'message': f'会话已达到 {SSH_TERMINAL_MAX_SECONDS // 60} 分钟时限，请重新连接。'}))
            self.close(code=4000)

    def disconnect(self, close_code):
        self._reading = False
        for timer in (getattr(self, '_idle_timer', None), getattr(self, '_max_timer', None)):
            if timer:
                timer.cancel()
        if getattr(self, 'user', None) and getattr(self, 'host_name', ''):
            record_event(
                module='ops', category='security', action='webshell_disconnect',
                title=f'关闭 WebShell：{self.host_name}',
                actor_username=self.user.username, resource_type='host',
                resource_id=self.host_id, resource_name=self.host_name,
            )
        if self.ssh_channel:
            try:
                self.ssh_channel.close()
            except Exception:
                pass
        if self.ssh_client:
            try:
                self.ssh_client.close()
            except Exception:
                pass
        read_thread = getattr(self, '_read_thread', None)
        if read_thread and read_thread.is_alive():
            read_thread.join(timeout=1)

    def receive(self, text_data=None, bytes_data=None):
        """接收前端输入并发送到 SSH"""
        if text_data and self.ssh_channel:
            try:
                data = json.loads(text_data)
                if data.get('type') == 'input':
                    self._touch_activity()
                    forward, events = self.guard.process(data['data'])
                    if forward:
                        self.ssh_channel.send(forward)
                    if events:
                        handle_guard_events(
                            events, user=self.user, resource_type='host',
                            resource_id=self.host_id, resource_name=getattr(self, 'host_name', ''),
                            send_text=lambda text: self.send(text_data=json.dumps({'type': 'output', 'data': text})),
                        )
                elif data.get('type') == 'resize':
                    cols = data.get('cols', 120)
                    rows = data.get('rows', 40)
                    self.ssh_channel.resize_pty(width=cols, height=rows)
            except Exception as e:
                logger.error(f'Error processing input: {e}')

    def _touch_activity(self):
        """每次有输入就重置空闲计时。"""
        timer = getattr(self, '_idle_timer', None)
        if timer:
            timer.cancel()
        timer = threading.Timer(SSH_TERMINAL_IDLE_SECONDS, self._expire_idle_session)
        timer.daemon = True
        timer.start()
        self._idle_timer = timer

    def _read_ssh_output(self):
        """后台线程：持续读取 SSH 输出并发送到 WebSocket"""
        import time
        while self._reading:
            try:
                if self.ssh_channel and self.ssh_channel.recv_ready():
                    data = self.ssh_channel.recv(4096)
                    if data:
                        self.send(text_data=json.dumps({
                            'type': 'output',
                            'data': data.decode('utf-8', errors='replace'),
                        }))
                        continue
                    # recv() 返回空字节表示远端已关闭；不退出会留下常驻线程。
                    self._reading = False
                    self.close(code=1000)
                    break
                if self.ssh_channel and self.ssh_channel.exit_status_ready():
                    self._reading = False
                    self.close(code=1000)
                    break
                time.sleep(0.02)
            except Exception as e:
                if self._reading:
                    logger.error(f'SSH read error: {e}')
                    self.send(text_data=json.dumps({
                        'type': 'error',
                        'message': f'连接断开: {str(e)}',
                    }))
                break
