from django.core.management.base import BaseCommand

from ops.inspection_schedules import run_due_inspection_plans, run_inspection_scheduler_loop


class Command(BaseCommand):
    help = '运行巡检调度器，触发到点的巡检计划'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true', help='仅扫描一次到期巡检计划并立即退出')
        parser.add_argument('--interval', type=int, default=60, help='轮询间隔秒数，默认 60')
        parser.add_argument('--limit', type=int, default=20, help='单次扫描最多触发的计划数量')
        parser.add_argument('--actor', type=str, default='system-scheduler', help='调度器写入巡检记录时使用的触发人标识')

    def handle(self, *args, **options):
        once = options['once']
        interval = int(options.get('interval') or 60)
        limit = int(options.get('limit') or 20)
        actor = options.get('actor') or 'system-scheduler'

        if once:
            result = run_due_inspection_plans(limit=limit, actor=actor)
            self.stdout.write(self.style.SUCCESS(
                f"扫描完成：待执行 {result['due_count']}，触发 {result['triggered']}，跳过 {result['skipped']}"
            ))
            return

        self.stdout.write(self.style.SUCCESS(
            f'巡检调度器已启动，轮询间隔={interval}秒，单次上限={limit}'
        ))
        run_inspection_scheduler_loop(interval_seconds=interval, limit=limit, actor=actor)
