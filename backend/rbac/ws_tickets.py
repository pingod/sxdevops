"""WebSocket 一次性短票据的签发与消费。"""
import secrets as random_secrets

from django.utils import timezone

from .models import WebSocketTicket


def issue_websocket_ticket(user, ttl_seconds=30):
    """签发一次性票据；顺手清理该用户已过期的旧票据。"""
    now = timezone.now()
    WebSocketTicket.objects.filter(user=user, expires_at__lt=now).delete()
    return WebSocketTicket.objects.create(
        key=random_secrets.token_urlsafe(32),
        user=user,
        expires_at=now + timezone.timedelta(seconds=max(int(ttl_seconds), 1)),
    )


def consume_websocket_ticket(ticket_key):
    """原子消费票据，返回用户；无效/已用/过期返回 None。"""
    if not ticket_key:
        return None
    now = timezone.now()
    claimed = WebSocketTicket.objects.filter(
        key=ticket_key,
        used_at__isnull=True,
        expires_at__gt=now,
    ).update(used_at=now)
    if not claimed:
        return None
    ticket = WebSocketTicket.objects.select_related('user').filter(key=ticket_key).first()
    if not ticket or not ticket.user.is_active:
        return None
    return ticket.user
