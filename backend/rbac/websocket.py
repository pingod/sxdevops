"""Revalidate live terminal sessions, including idle connections and bulk DB changes."""
import asyncio
import logging
import re
import time
from contextlib import suppress
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.exceptions import StopConsumer
from django.conf import settings
from rest_framework.authtoken.models import Token

from .k8s_access import can_access_k8s
from .services import user_has_permissions
from .ws_tickets import consume_websocket_ticket

logger = logging.getLogger(__name__)
TERMINAL_PATH = re.compile(r'^/ws/(ssh|docker/exec|k8s/exec|k8s/terminal)/(\d+)/$')
PERMISSIONS = {
    'ssh': ['ops.host.terminal'],
    'docker/exec': ['ops.docker.view', 'ops.docker.exec'],
    'k8s/exec': ['ops.k8s.exec'],
    'k8s/terminal': ['ops.k8s.terminal'],
}
# 每帧都查库会让一次输入产生几十次权限查询；1 秒粒度已足够让权限变更及时生效。
INPUT_RECHECK_INTERVAL_SECONDS = 1.0


@database_sync_to_async
def terminal_access_code(token_key, kind, resource_id, namespace, user=None):
    if user is None:
        token = Token.objects.select_related('user').filter(key=token_key).first()
        if not token:
            return 4401
        user = token.user
    else:
        # 缓存的 user 对象可能已过期（被停用/删除），每次校验都要读最新状态。
        user = type(user).objects.filter(pk=user.pk).first()
        if user is None:
            return 4401
    if not user.is_active:
        return 4401
    if not user_has_permissions(user, PERMISSIONS[kind]):
        return 4403
    if kind.startswith('k8s/'):
        from ops.models import K8sCluster
        if not K8sCluster.objects.filter(pk=resource_id).exists():
            return 4404
        if not can_access_k8s(user, resource_id, namespace,
                              execute=kind == 'k8s/exec', shell=kind == 'k8s/terminal'):
            return 4403
    return None


@database_sync_to_async
def consume_ticket(ticket_key):
    return consume_websocket_ticket(ticket_key)


def resolve_terminal_user(ticket_key='', legacy_token_key=''):
    """同步版票据解析，供各 consumer 的 connect() 使用。"""
    if ticket_key:
        return consume_websocket_ticket(ticket_key)
    if legacy_token_key:
        logger.warning('WebSocket 使用旧 token 认证，请升级前端')
        token = Token.objects.select_related('user').filter(key=legacy_token_key).first()
        return token.user if token else None
    return None


class TerminalRevocationMiddleware:
    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        match = TERMINAL_PATH.fullmatch(scope.get('path', ''))
        if not match:
            return await self.application(scope, receive, send)
        kind, resource_id = match.groups()
        query = parse_qs(scope.get('query_string', b'').decode('utf-8', errors='replace'))
        ticket_key = query.get('ticket', [''])[0]
        # 旧 token 兼容：一个版本后删除（届时前端已全部改用 ticket）。
        legacy_token_key = query.get('token', [''])[0]
        namespace = query.get('namespace', ['default'])[0] or 'default'
        queue = asyncio.Queue()
        accepted = asyncio.Event()
        revoked = False
        user = None
        last_check_at = 0.0

        async def resolve_user():
            nonlocal user
            if user is not None:
                return user
            if ticket_key:
                user = await consume_ticket(ticket_key)
            return user

        async def check():
            try:
                if ticket_key:
                    # 票据只在首次校验时消费，之后复用同一用户继续做权限重校验。
                    resolved = await resolve_user()
                    if resolved is None:
                        return 4401
                    return await terminal_access_code(
                        '', kind, resource_id, namespace, user=resolved,
                    )
                # 旧 token 兼容路径保持原行为（一个版本后删除）。
                if legacy_token_key:
                    logger.warning('WebSocket 使用旧 token 认证，请升级前端')
                return await terminal_access_code(
                    legacy_token_key, kind, resource_id, namespace,
                )
            except Exception:
                logger.exception('Live terminal authorization check failed')
                return 4403

        async def revoke(code):
            nonlocal revoked
            if revoked:
                return
            revoked = True
            await send({'type': 'websocket.close', 'code': code})
            # Trigger consumer cleanup immediately, even without a client disconnect.
            await queue.put({'type': 'websocket.disconnect', 'code': code})

        async def guarded_send(message):
            if revoked:
                if message['type'] == 'websocket.accept':
                    raise StopConsumer()
                return
            if message['type'] == 'websocket.accept':
                code = await check()
                if code:
                    await revoke(code)
                    raise StopConsumer()
                accepted.set()
            await send(message)

        async def forward_input():
            nonlocal last_check_at
            while True:
                message = await receive()
                if message['type'] == 'websocket.receive':
                    now = time.monotonic()
                    if now - last_check_at >= INPUT_RECHECK_INTERVAL_SECONDS:
                        last_check_at = now
                        code = await check()
                        if code:
                            await revoke(code)
                            return
                await queue.put(message)
                if message['type'] == 'websocket.disconnect':
                    return

        async def watch():
            await accepted.wait()
            interval = max(0.01, min(float(settings.WEBSOCKET_AUTH_RECHECK_SECONDS), 30))
            while not revoked:
                await asyncio.sleep(interval)
                code = await check()
                if code:
                    await revoke(code)

        tasks = [asyncio.create_task(forward_input()), asyncio.create_task(watch())]
        try:
            await self.application(scope, queue.get, guarded_send)
        except StopConsumer:
            pass
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError):
                    await task
