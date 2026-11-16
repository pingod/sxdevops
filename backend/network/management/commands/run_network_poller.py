import asyncio

from django.core.management.base import BaseCommand

from network.poller import DEFAULT_CONCURRENCY, DEFAULT_TICK_SECONDS, run_poller_loop


class Command(BaseCommand):
    help = '运行 SNMP 网络采集器，按设备间隔轮询系统健康与接口指标'

    def add_arguments(self, parser):
        parser.add_argument('--tick', type=int, default=DEFAULT_TICK_SECONDS, help='调度扫描间隔秒数')
        parser.add_argument('--concurrency', type=int, default=DEFAULT_CONCURRENCY, help='单轮最大并发采集设备数')
        parser.add_argument('--once', action='store_true', help='仅采集一轮到期设备后退出')

    def handle(self, *args, **options):
        asyncio.run(run_poller_loop(
            tick_seconds=max(options['tick'], 1),
            concurrency=max(options['concurrency'], 1),
            once=options['once'],
        ))