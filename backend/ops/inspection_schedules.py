"""巡检计划调度：与主机定时任务共用 Cron 计算，但独立进程扫描到期计划。"""

import logging
import time

from django.db import transaction
from django.utils import timezone

from .host_task_schedules import compute_next_run, preview_next_runs
from .models import InspectionPlan, InspectionRun

logger = logging.getLogger(__name__)

DEFAULT_POLL_SECONDS = 60


def compute_plan_next_run(plan, reference_time=None):
    if not plan or plan.schedule_type == InspectionPlan.SCHEDULE_TYPE_MANUAL:
        return None
    return compute_next_run(plan, reference_time=reference_time)


def preview_plan_next_runs(plan, count=5, reference_time=None):
    if not plan or plan.schedule_type == InspectionPlan.SCHEDULE_TYPE_MANUAL:
        return []
    return preview_next_runs(plan, count=count, reference_time=reference_time)


def refresh_plan_schedule(plan, reference_time=None):
    plan.next_run_at = compute_plan_next_run(plan, reference_time=reference_time) if plan.enabled else None
    return plan.next_run_at


def create_run_from_plan(plan, actor='', trigger_source=InspectionRun.TRIGGER_MANUAL, inline=False):
    """建 run 并把启动推迟到事务提交后，避免子线程读不到未提交的行。

    inline=True 供调度进程使用：调度器本身就是独立进程，同步执行可避免进程退出时线程被杀。
    """
    if not plan.enabled:
        return None, '计划已禁用'
    run = InspectionRun.objects.create(
        plan=plan,
        plan_name=plan.name,
        status=InspectionRun.STATUS_PENDING,
        trigger_source=trigger_source,
        item_codes=list(plan.item_codes or []),
        item_count=len(plan.item_codes or []),
        created_by=actor or '',
    )
    now = timezone.now()
    plan.last_run_at = now
    plan.total_run_count = (plan.total_run_count or 0) + 1
    if plan.schedule_type == InspectionPlan.SCHEDULE_TYPE_MANUAL:
        plan.next_run_at = None
    else:
        plan.next_run_at = compute_plan_next_run(plan, reference_time=now)
    plan.save(update_fields=['last_run_at', 'total_run_count', 'next_run_at', 'updated_at'])
    run_id = run.id
    from .inspection_runner import should_run_inspection_async

    if inline:
        transaction.on_commit(lambda: _run_inline(run_id))
    elif should_run_inspection_async():
        # 子线程用独立连接，必须等事务提交后才能看到这条 run。
        transaction.on_commit(lambda: _start_run(run_id))
    else:
        _start_run(run_id)
    return run, ''


def _run_inline(run_id):
    from .inspection_runner import execute_inspection_run

    run = InspectionRun.objects.filter(pk=run_id).first()
    if run:
        execute_inspection_run(run)


def _start_run(run_id):
    from .inspection_runner import start_inspection_run

    start_inspection_run(run_id)


def run_due_inspection_plans(limit=20, actor='system-scheduler'):
    now = timezone.now()
    due = list(
        InspectionPlan.objects.filter(
            enabled=True, next_run_at__isnull=False, next_run_at__lte=now,
        ).exclude(schedule_type=InspectionPlan.SCHEDULE_TYPE_MANUAL)
        .order_by('next_run_at', 'id')[:limit]
    )
    triggered, skipped = [], []
    for plan in due:
        run, error = create_run_from_plan(
            plan, actor=plan.created_by or actor, trigger_source=InspectionRun.TRIGGER_SCHEDULE, inline=True,
        )
        if run is None:
            skipped.append({'plan': plan.id, 'reason': error})
            if plan.schedule_type == InspectionPlan.SCHEDULE_TYPE_ONCE:
                plan.enabled = False
                plan.next_run_at = None
                plan.save(update_fields=['enabled', 'next_run_at', 'updated_at'])
            continue
        triggered.append({'plan': plan.id, 'run': run.id})
    return {'due_count': len(due), 'triggered': len(triggered), 'skipped': len(skipped), 'details': triggered}


def run_inspection_scheduler_loop(interval_seconds=None, limit=20, actor='system-scheduler'):
    interval = int(interval_seconds or DEFAULT_POLL_SECONDS)
    while True:
        try:
            run_due_inspection_plans(limit=limit, actor=actor)
        except Exception:
            logger.exception('inspection scheduler tick failed')
        time.sleep(max(interval, 5))
