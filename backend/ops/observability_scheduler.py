from __future__ import annotations

import logging
import os
import sys
import threading
import time
from datetime import timedelta

from django.utils import timezone

logger = logging.getLogger(__name__)

_scheduler_lock = threading.Lock()
_scheduler_started = False


def _seconds_until_next_hour():
    now = timezone.localtime()
    next_hour = (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))
    return max(1, int((next_hour - now).total_seconds()))


def scheduler_should_autostart():
    if os.environ.get('SXDEVOPS_OBSERVABILITY_SCHEDULER', '1') == '0':
        return False
    blocked = {'test', 'makemigrations', 'migrate', 'collectstatic', 'shell', 'check',
               'run_observability_scheduler'}
    if any(item in sys.argv for item in blocked):
        return False
    if os.environ.get('RUN_MAIN') == 'false':
        return False
    return True


SCHEDULER_LOCK_KEY = 'obs:scheduler:lock'


def refresh_once(actor='system-scheduler'):
    """执行一次快照刷新；抢不到分布式锁说明别的实例已经在跑本轮。"""
    from django.core.cache import cache

    lock_timeout = int(os.environ.get('SXDEVOPS_OBSERVABILITY_SCHEDULER_LOCK_SECONDS', '3555'))
    if not cache.add(SCHEDULER_LOCK_KEY, os.getpid(), timeout=max(lock_timeout, 60)):
        logger.debug('observability scheduler lock held elsewhere, skipping this round')
        return None
    try:
        from .observability_views import refresh_today_system_posture_history

        result = refresh_today_system_posture_history(force_refresh=True, actor=actor)
        logger.info('observability history scheduler refreshed today snapshot: %s', result)
        return result
    except Exception:
        logger.exception('observability history scheduler refresh failed')
        return None


def run_observability_history_scheduler_loop():
    logger.info('observability history scheduler loop started')
    startup_delay = int(os.environ.get('SXDEVOPS_OBSERVABILITY_SCHEDULER_START_DELAY', '15'))
    if startup_delay > 0:
        time.sleep(startup_delay)
    refresh_once()
    while True:
        time.sleep(_seconds_until_next_hour())
        refresh_once()


def start_observability_history_scheduler():
    global _scheduler_started
    if _scheduler_started or not scheduler_should_autostart():
        return False
    with _scheduler_lock:
        if _scheduler_started:
            return False
        thread = threading.Thread(
            target=run_observability_history_scheduler_loop,
            name='observability-history-scheduler',
            daemon=True,
        )
        thread.start()
        _scheduler_started = True
        logger.info('observability history scheduler thread started')
        return True
