"""可观测性快照刷新调度器（独立进程，单实例抢锁）。"""
import time

from django.core.management.base import BaseCommand

from ops.observability_scheduler import refresh_once


class Command(BaseCommand):
    help = '按固定间隔刷新系统态势历史快照（多实例部署时由缓存锁保证只跑一次）'

    def add_arguments(self, parser):
        parser.add_argument('--interval', type=int, default=3600, help='轮询间隔秒数')
        parser.add_argument('--once', action='store_true', help='只刷新一次后退出')

    def handle(self, *args, **options):
        interval = max(int(options.get('interval') or 3600), 60)
        if options.get('once'):
            result = refresh_once()
            self.stdout.write(self.style.SUCCESS(f'刷新完成：{result}'))
            return
        self.stdout.write(self.style.SUCCESS(f'可观测性调度器已启动，间隔={interval}秒'))
        while True:
            refresh_once()
            time.sleep(interval)
