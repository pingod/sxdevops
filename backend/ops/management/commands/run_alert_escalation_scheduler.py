"""告警升级调度器：扫描到期未升级的告警并外发升级通知。"""
import logging
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from ops.alerting import escalate_due_alerts

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = '周期扫描需要升级的告警并发送升级通知'

    def add_arguments(self, parser):
        parser.add_argument('--interval', type=int, default=60, help='轮询间隔秒数')
        parser.add_argument('--limit', type=int, default=200, help='单轮最多处理的告警数')
        parser.add_argument('--once', action='store_true', help='只扫描一次后退出')

    def handle(self, *args, **options):
        interval = max(int(options.get('interval') or 60), 5)
        limit = max(int(options.get('limit') or 200), 1)
        if options.get('once'):
            escalated = escalate_due_alerts(limit=limit)
            self.stdout.write(self.style.SUCCESS(f'升级完成：{escalated} 条告警'))
            return
        self.stdout.write(self.style.SUCCESS(f'告警升级调度器已启动，间隔={interval}秒'))
        while True:
            close_old_connections()
            try:
                escalate_due_alerts(limit=limit)
            except Exception:
                logger.exception('alert escalation scheduler tick failed')
            time.sleep(interval)
