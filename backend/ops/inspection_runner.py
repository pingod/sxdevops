"""巡检执行器：目标解析、采集调度、评分、隐患聚合与报告生成。"""

import logging
import sys
import threading
import time
import traceback

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import close_old_connections, transaction
from django.utils import timezone

from .inspection_collectors import (
    SEVERITY_CRITICAL,
    SEVERITY_OK,
    SEVERITY_UNKNOWN,
    SEVERITY_WARNING,
    collect_host_results,
    collect_k8s_results,
    collect_middleware_results,
    host_target_key,
    k8s_target_key,
    middleware_target_key,
)
from .inspection_items import SEVERITY_RANK, builtin_item_map
from .models import (
    InspectionIssue,
    InspectionItem,
    InspectionPlan,
    InspectionResult,
    InspectionRun,
    K8sCluster,
    TaskResource,
)

logger = logging.getLogger(__name__)

HOST_ITEM_PREFIX = 'host.'
K8S_ITEM_PREFIX = 'k8s.'
MIDDLEWARE_ITEM_PREFIX = 'mw.'
STALE_RUN_SECONDS = 1800


def should_run_inspection_async():
    configured = getattr(settings, 'INSPECTION_RUN_ASYNC', None)
    if configured is not None:
        return configured
    return 'test' not in sys.argv


# ---------------------------------------------------------------- 目标解析

def _host_targets_from_scope(scope, user):
    from .host_tasks import resolve_host_source_refs
    from .task_resources import scope_task_resources

    host_scope = (scope or {}).get('host') or {}
    queryset = scope_task_resources(
        TaskResource.objects.select_related('environment__event_environment', 'system', 'cmdb_ci')
        .filter(resource_type=TaskResource.RESOURCE_HOST),
        user,
    )
    resource_ids = [int(item) for item in (host_scope.get('resource_ids') or []) if str(item).isdigit()]
    if resource_ids:
        queryset = queryset.filter(id__in=resource_ids)
    environment_ids = [int(item) for item in (host_scope.get('environment_ids') or []) if str(item).isdigit()]
    if environment_ids:
        queryset = queryset.filter(environment_id__in=environment_ids)
    system_ids = [int(item) for item in (host_scope.get('system_ids') or []) if str(item).isdigit()]
    if system_ids:
        queryset = queryset.filter(system_id__in=system_ids)
    refs = [{'source': 'task_resource', 'id': item} for item in queryset.order_by('name', 'id').values_list('id', flat=True)]
    return resolve_host_source_refs(refs) if refs else []


def _k8s_targets_from_scope(scope, user):
    from rbac.k8s_access import k8s_scope

    # 执行人失效时无法鉴权，K8s 与中间件目标全部跳过（主机目标仍可按资源底座执行）。
    if not user or not getattr(user, 'is_authenticated', False):
        return []
    k8s_scope_config = (scope or {}).get('k8s') or {}
    cluster_ids = [int(item) for item in (k8s_scope_config.get('cluster_ids') or []) if str(item).isdigit()]
    namespaces = [str(item).strip() for item in (k8s_scope_config.get('namespaces') or []) if str(item).strip()]
    if not cluster_ids:
        # 未选集群视为不巡检 K8s，避免空范围把全平台集群都拉进一次巡检。
        return []
    queryset = K8sCluster.objects.filter(id__in=cluster_ids)
    targets = []
    for cluster in queryset.order_by('name', 'id'):
        scope_info = k8s_scope(user, cluster.id)
        if scope_info is None:
            continue
        granted = [str(item).strip() for item in (scope_info.get('namespaces') or []) if str(item).strip()]
        if granted:
            selected = [item for item in namespaces if item in granted] if namespaces else granted
        else:
            selected = namespaces
        targets.append((cluster, selected))
    return targets


def _middleware_targets_from_scope(scope, user):
    from .task_resources import visible_cmdb_resources

    middleware_scope = (scope or {}).get('middleware') or {}
    type_codes = [str(item).strip().upper() for item in (middleware_scope.get('ci_type_codes') or []) if str(item).strip()]
    config_item_ids = [int(item) for item in (middleware_scope.get('config_item_ids') or []) if str(item).isdigit()]
    if not user or not getattr(user, 'is_authenticated', False):
        return []
    if not type_codes:
        return []
    queryset = visible_cmdb_resources(user).filter(ci_type__code__in=type_codes)
    if config_item_ids:
        queryset = queryset.filter(id__in=config_item_ids)
    return list(queryset.order_by('name', 'id'))


def resolve_plan_targets(plan, user=None):
    scope = (plan.scope or {}) if plan else {}
    return {
        'host': _host_targets_from_scope(scope, user),
        'k8s': _k8s_targets_from_scope(scope, user),
        'middleware': _middleware_targets_from_scope(scope, user),
    }


def _host_source_ref(host):
    if getattr(host, 'source', '') == 'task_resource':
        return {'source': 'task_resource', 'id': host.resource_id}
    return {'source': 'host', 'id': host.id}


def build_scope_snapshot(targets):
    return {
        'host': [
            {'source': _host_source_ref(host)['source'], 'id': _host_source_ref(host)['id'],
             'name': host.hostname, 'ip': host.ip_address or ''}
            for host in targets.get('host') or []
        ],
        'k8s': [
            {'cluster_id': cluster.id, 'name': cluster.name, 'namespaces': list(namespaces)}
            for cluster, namespaces in targets.get('k8s') or []
        ],
        'middleware': [
            {'config_item_id': item.id, 'name': item.name, 'ci_type_code': item.ci_type.code}
            for item in targets.get('middleware') or []
        ],
    }


def resolve_snapshot_targets(scope_snapshot):
    from .host_tasks import resolve_host_source_refs
    from cmdb.models import ConfigItem

    snapshot = scope_snapshot or {}
    host_refs = [
        {'source': item.get('source') or 'task_resource', 'id': item.get('id')}
        for item in (snapshot.get('host') or []) if item.get('id')
    ]
    cluster_map = {
        cluster.id: cluster
        for cluster in K8sCluster.objects.filter(id__in=[item.get('cluster_id') for item in (snapshot.get('k8s') or []) if item.get('cluster_id')])
    }
    k8s_targets = []
    for item in snapshot.get('k8s') or []:
        cluster = cluster_map.get(item.get('cluster_id'))
        if cluster:
            k8s_targets.append((cluster, [str(value).strip() for value in (item.get('namespaces') or []) if str(value).strip()]))
    config_item_ids = [item.get('config_item_id') for item in (snapshot.get('middleware') or []) if item.get('config_item_id')]
    middleware = list(
        ConfigItem.objects.select_related('ci_type').filter(id__in=config_item_ids).order_by('name', 'id')
    ) if config_item_ids else []
    return {
        'host': resolve_host_source_refs(host_refs) if host_refs else [],
        'k8s': k8s_targets,
        'middleware': middleware,
    }


# ---------------------------------------------------------------- 评分

def compute_run_score(results, weight_by_code):
    penalty = 0
    for item in results:
        severity = item.get('severity') if isinstance(item, dict) else getattr(item, 'severity', '')
        code = item.get('item_code') if isinstance(item, dict) else getattr(item, 'item_code', '')
        weight = int(weight_by_code.get(code, 0) or 0)
        if severity == SEVERITY_WARNING:
            penalty += weight
        elif severity == SEVERITY_CRITICAL:
            penalty += weight * 2
    return max(100 - penalty, 0)


# ---------------------------------------------------------------- 隐患

def _issue_title(result, item_name):
    value = (result.get('value') or '').strip()
    detail = (result.get('message') or '').strip()
    title = f'{result.get("target_name")} {item_name}'
    if value:
        title = f'{title} = {value}'
    return (title if len(title) <= 200 else title[:197] + '...') or (detail[:200] or item_name)


def upsert_issues(run, results):
    now = timezone.now()
    opened = updated = resolved = 0
    remediation_by_code = {
        item.code: item.remediation or ''
        for item in InspectionItem.objects.filter(code__in={item['item_code'] for item in results})
    }
    for result in results:
        dedupe_key = f'{result["target_type"]}:{result["target_key"]}:{result["item_code"]}'
        issue = InspectionIssue.objects.filter(dedupe_key=dedupe_key).first()
        if result['severity'] in (SEVERITY_WARNING, SEVERITY_CRITICAL):
            detail_parts = [
                f'当前值：{result.get("value") or "-"}',
                f'阈值：{result.get("threshold") or "-"}',
                f'说明：{result.get("message") or "-"}',
            ]
            if result.get('evidence'):
                detail_parts.append(f'证据：\n{result["evidence"]}')
            advice = remediation_by_code.get(result['item_code']) or ''
            defaults = {
                'item_name': result['item_name'],
                'category': result['category'],
                'target_type': result['target_type'],
                'target_key': result['target_key'],
                'target_name': result['target_name'],
                'target_ip': result.get('target_ip') or '',
                'title': _issue_title(result, result['item_name']),
                'detail': '\n'.join(detail_parts),
                'last_seen_at': now,
                'last_run': run,
            }
            if issue is None:
                InspectionIssue.objects.create(
                    dedupe_key=dedupe_key,
                    item_code=result['item_code'],
                    severity=result['severity'],
                    status=InspectionIssue.STATUS_OPEN,
                    first_seen_at=now,
                    occurrences=1,
                    first_run=run,
                    ai_advice=advice,
                    **defaults,
                )
                opened += 1
                continue
            # 已有隐患：只刷新观测字段，不覆盖人工状态、处理人与 AI 建议。
            for field, value in defaults.items():
                setattr(issue, field, value)
            issue.occurrences += 1
            if SEVERITY_RANK.get(result['severity'], 0) > SEVERITY_RANK.get(issue.severity, 0):
                issue.severity = result['severity']
            if not issue.ai_advice and advice:
                issue.ai_advice = advice
            if issue.status == InspectionIssue.STATUS_RESOLVED:
                issue.status = InspectionIssue.STATUS_OPEN
                issue.resolved_at = None
            issue.save()
            updated += 1
            continue
        if result['severity'] == SEVERITY_OK and issue is not None and issue.status in InspectionIssue.ACTIVE_STATUSES:
            issue.status = InspectionIssue.STATUS_RESOLVED
            issue.resolved_at = now
            issue.updated_by = 'system'
            issue.last_seen_at = now
            issue.last_run = run
            issue.save(update_fields=['status', 'resolved_at', 'updated_by', 'last_seen_at', 'last_run', 'updated_at'])
            resolved += 1
    return {'opened': opened, 'updated': updated, 'resolved': resolved}


# ---------------------------------------------------------------- 执行

def _enabled_item_codes(item_codes):
    requested = [str(code).strip() for code in (item_codes or []) if str(code).strip()]
    if not requested:
        return []
    items = list(InspectionItem.objects.filter(is_enabled=True, code__in=requested))
    order = {item.code: item.sort_order for item in items}
    return sorted({item.code for item in items}, key=lambda code: (order.get(code, 100), code))


def _weight_map(codes):
    return {item.code: int(item.weight or 0) for item in InspectionItem.objects.filter(code__in=codes)}


def _target_meta(target_type, target):
    if target_type == 'host':
        return {
            'target_type': 'host',
            'target_key': host_target_key(target),
            'target_id': str(target.resource_id if getattr(target, 'source', '') == 'task_resource' else target.id),
            'target_name': target.hostname,
            'target_ip': str(target.ip_address or ''),
        }
    if target_type == 'k8s':
        cluster, _namespaces = target
        return {
            'target_type': 'k8s',
            'target_key': k8s_target_key(cluster),
            'target_id': str(cluster.id),
            'target_name': cluster.name,
            'target_ip': '',
        }
    return {
        'target_type': 'middleware',
        'target_key': middleware_target_key(target),
        'target_id': str(target.id),
        'target_name': target.name,
        'target_ip': str((target.attributes or {}).get('endpoint') or ''),
    }


def _collect_for_target(target_type, target, codes):
    host_codes = [code for code in codes if code.startswith(HOST_ITEM_PREFIX)]
    k8s_codes = [code for code in codes if code.startswith(K8S_ITEM_PREFIX)]
    middleware_codes = [code for code in codes if code.startswith(MIDDLEWARE_ITEM_PREFIX)]
    if target_type == 'host':
        return collect_host_results(target, host_codes) if host_codes else []
    if target_type == 'k8s':
        cluster, namespaces = target
        return collect_k8s_results(cluster, namespaces, k8s_codes) if k8s_codes else []
    return collect_middleware_results(target, middleware_codes) if middleware_codes else []


def _target_codes(target_type, codes):
    prefix = {'host': HOST_ITEM_PREFIX, 'k8s': K8S_ITEM_PREFIX, 'middleware': MIDDLEWARE_ITEM_PREFIX}[target_type]
    return [code for code in codes if code.startswith(prefix)]


def _run_targets(run, codes):
    """逐目标顺序采集；单目标异常不影响后续目标。"""
    snapshot = run.scope_snapshot or {}
    actor = _actor_for_run(run)
    if snapshot:
        targets = resolve_snapshot_targets(snapshot)
    else:
        targets = resolve_plan_targets(run.plan, actor)
    run.scope_snapshot = build_scope_snapshot(targets)
    run.target_count = len(targets['host']) + len(targets['k8s']) + len(targets['middleware'])
    run.save(update_fields=['scope_snapshot', 'target_count'])
    if run.target_count == 0:
        return targets, []

    item_names = {item.code: item.name for item in InspectionItem.objects.filter(code__in=codes)}
    fallback_names = {code: definition['name'] for code, definition in builtin_item_map().items()}
    results = []
    for target_type, items in (('host', targets['host']), ('k8s', targets['k8s']), ('middleware', targets['middleware'])):
        for target in items:
            meta = _target_meta(target_type, target)
            target_codes = _target_codes(target_type, codes)
            if not target_codes:
                continue
            started = time.monotonic()
            try:
                collected = _collect_for_target(target_type, target, codes)
            except Exception as exc:
                collected = [{
                    'item_code': code, 'severity': SEVERITY_UNKNOWN, 'value': '', 'threshold': '',
                    'message': f'采集异常：{exc}', 'evidence': traceback.format_exc()[:2000], 'duration_ms': 0,
                } for code in target_codes]
            produced = {item['item_code'] for item in collected}
            for code in target_codes:
                if code not in produced:
                    collected.append({
                        'item_code': code, 'severity': SEVERITY_UNKNOWN, 'value': '', 'threshold': '',
                        'message': '采集项缺失', 'evidence': '', 'duration_ms': 0,
                    })
            elapsed = int((time.monotonic() - started) * 1000)
            for item in collected:
                if item['item_code'] not in target_codes:
                    continue
                results.append({
                    **meta,
                    'item_code': item['item_code'],
                    'item_name': item_names.get(item['item_code']) or fallback_names.get(item['item_code']) or item['item_code'],
                    'category': target_type,
                    'severity': item.get('severity') or SEVERITY_UNKNOWN,
                    'value': item.get('value') or '',
                    'threshold': item.get('threshold') or '',
                    'message': item.get('message') or '',
                    'evidence': item.get('evidence') or '',
                    'duration_ms': int(item.get('duration_ms') or 0) or elapsed,
                })
    return targets, results


def _actor_for_run(run):
    username = (run.created_by or '').strip()
    if not username:
        return None
    return get_user_model().objects.filter(username=username, is_active=True).first()


def _persist_results(run, results):
    InspectionResult.objects.bulk_create(
        [InspectionResult(run=run, **{key: value for key, value in item.items() if key != 'run'}) for item in results],
        batch_size=200,
    )


def _finish_run(run, results, codes):
    counts = {
        'ok': sum(1 for item in results if item['severity'] == SEVERITY_OK),
        'warning': sum(1 for item in results if item['severity'] == SEVERITY_WARNING),
        'critical': sum(1 for item in results if item['severity'] == SEVERITY_CRITICAL),
        'unknown': sum(1 for item in results if item['severity'] == SEVERITY_UNKNOWN),
    }
    run.ok_count = counts['ok']
    run.warning_count = counts['warning']
    run.critical_count = counts['critical']
    run.unknown_count = counts['unknown']
    run.score = compute_run_score(results, _weight_map(codes))
    if counts['critical']:
        status = InspectionRun.STATUS_CRITICAL
    elif counts['warning']:
        status = InspectionRun.STATUS_WARNING
    elif results and counts['ok'] == 0 and counts['unknown'] == len(results):
        status = InspectionRun.STATUS_FAILED
    else:
        status = InspectionRun.STATUS_SUCCESS
    run.status = status
    run.finished_at = timezone.now()
    if run.started_at:
        run.duration_ms = max(int((run.finished_at - run.started_at).total_seconds() * 1000), 0)
    snapshot = run.scope_snapshot or {}
    summary = (
        f'共 {len(snapshot.get("host") or [])} 台主机 / {len(snapshot.get("k8s") or [])} 个 K8s 集群 / '
        f'{len(snapshot.get("middleware") or [])} 个中间件实例，严重 {counts["critical"]}，'
        f'警告 {counts["warning"]}，得分 {run.score}'
    )
    run.summary = summary[:255]
    run.save(update_fields=[
        'ok_count', 'warning_count', 'critical_count', 'unknown_count', 'score',
        'status', 'finished_at', 'duration_ms', 'summary',
    ])


def _record_run_event(run, action, result, severity, title):
    from eventwall.services import record_event

    try:
        record_event(
            module='ops',
            category='execution',
            action=action,
            title=title,
            summary=run.summary or title,
            result=result,
            severity=severity,
            resource_type='inspection_run',
            resource_id=run.id,
            resource_name=run.plan_name or f'巡检 #{run.id}',
            metadata={
                'score': run.score,
                'critical_count': run.critical_count,
                'warning_count': run.warning_count,
                'target_count': run.target_count,
            },
        )
    except Exception:
        logger.exception('inspection run event failed: %s', run.id)


def _update_plan_after_run(run):
    plan = run.plan
    if not plan:
        return
    plan.last_run_at = run.finished_at or timezone.now()
    plan.last_status = run.status
    plan.total_run_count = (plan.total_run_count or 0) + 1
    if run.status == InspectionRun.STATUS_FAILED:
        plan.consecutive_failures = (plan.consecutive_failures or 0) + 1
        plan.last_error = (run.summary or '')[:255]
    else:
        plan.consecutive_failures = 0
        plan.last_error = ''
    if plan.schedule_type == InspectionPlan.SCHEDULE_TYPE_ONCE:
        plan.enabled = False
        plan.next_run_at = None
    else:
        from .inspection_schedules import compute_plan_next_run

        plan.next_run_at = compute_plan_next_run(plan) if plan.enabled else None
    plan.save(update_fields=[
        'last_run_at', 'last_status', 'total_run_count', 'consecutive_failures',
        'last_error', 'enabled', 'next_run_at', 'updated_at',
    ])


def execute_inspection_run(run):
    codes = _enabled_item_codes(run.item_codes or (run.plan.item_codes if run.plan else []))
    run.status = InspectionRun.STATUS_RUNNING
    run.started_at = timezone.now()
    run.item_codes = codes
    run.item_count = len(codes)
    run.save(update_fields=['status', 'started_at', 'item_codes', 'item_count'])
    if not codes:
        run.status = InspectionRun.STATUS_FAILED
        run.summary = '巡检计划未配置可用巡检项'
        run.score = 0
        run.finished_at = timezone.now()
        run.save(update_fields=['status', 'summary', 'score', 'finished_at'])
        _update_plan_after_run(run)
        _record_run_event(run, 'inspection_run_failed', 'failed', 'warning', f'巡检失败：{run.summary}')
        return run

    targets, results = _run_targets(run, codes)
    if run.target_count == 0:
        run.status = InspectionRun.STATUS_FAILED
        run.summary = '未匹配到可巡检目标'
        run.score = 0
        run.finished_at = timezone.now()
        run.duration_ms = max(int((run.finished_at - run.started_at).total_seconds() * 1000), 0)
        run.save(update_fields=['status', 'summary', 'score', 'finished_at', 'duration_ms'])
        _update_plan_after_run(run)
        _record_run_event(run, 'inspection_run_failed', 'failed', 'warning', '巡检失败：未匹配到可巡检目标')
        return run

    with transaction.atomic():
        _persist_results(run, results)
        _finish_run(run, results, codes)
        upsert_issues(run, results)
    _update_plan_after_run(run)
    event_result = 'success' if run.status in (InspectionRun.STATUS_SUCCESS, InspectionRun.STATUS_WARNING) else 'failed'
    event_severity = 'critical' if run.status == InspectionRun.STATUS_CRITICAL else (
        'warning' if run.status in (InspectionRun.STATUS_WARNING, InspectionRun.STATUS_FAILED) else 'info'
    )
    _record_run_event(run, 'inspection_run_finished', event_result, event_severity, f'巡检完成：{run.plan_name or run.id}')
    if run.plan and run.plan.ai_analysis_enabled:
        run_id = run.id
        transaction.on_commit(lambda: _enqueue_analysis(run_id))
    return run


def _enqueue_analysis(run_id):
    try:
        from aiops.inspection import enqueue_run_analysis

        enqueue_run_analysis(run_id)
    except Exception:
        logger.exception('inspection analysis enqueue failed: %s', run_id)


def _execute_thread(run_id):
    close_old_connections()
    try:
        run = InspectionRun.objects.filter(pk=run_id).first()
        if run:
            execute_inspection_run(run)
    except Exception:
        logger.exception('inspection run failed: %s', run_id)
        run = InspectionRun.objects.filter(pk=run_id).first()
        if run and run.status in (InspectionRun.STATUS_PENDING, InspectionRun.STATUS_RUNNING):
            run.status = InspectionRun.STATUS_FAILED
            run.summary = '执行异常，请查看后端日志'
            run.finished_at = timezone.now()
            run.save(update_fields=['status', 'summary', 'finished_at'])
    finally:
        close_old_connections()


def start_inspection_run(run_id):
    run = InspectionRun.objects.filter(pk=run_id).first()
    if not run:
        return None
    if not should_run_inspection_async():
        return execute_inspection_run(run)
    thread = threading.Thread(target=_execute_thread, args=(run_id,), name=f'inspection-run-{run_id}', daemon=True)
    thread.start()
    return run


def mark_stale_inspection_runs(max_running_seconds=STALE_RUN_SECONDS):
    threshold = timezone.now() - timezone.timedelta(seconds=max_running_seconds)
    stale = list(InspectionRun.objects.filter(status=InspectionRun.STATUS_RUNNING, started_at__lt=threshold)[:100])
    if not stale:
        return 0
    now = timezone.now()
    for run in stale:
        run.status = InspectionRun.STATUS_FAILED
        run.summary = '执行超时，已标记失败'
        run.finished_at = now
        run.save(update_fields=['status', 'summary', 'finished_at'])
    return len(stale)


# ---------------------------------------------------------------- 报告

def build_run_report_markdown(run):
    results = list(run.results.order_by('target_name', 'item_code'))
    grouped = {}
    for result in results:
        grouped.setdefault((result.target_name, result.target_ip), []).append(result)
    lines = [
        f'# 巡检报告 {run.plan_name or "巡检"} — {timezone.localtime(run.created_at):%Y-%m-%d %H:%M}',
        '',
        '| 项 | 值 |',
        '|---|---|',
        f'| 巡检编号 | {run.id} |',
        f'| 触发方式 | {run.get_trigger_source_display()} |',
        f'| 巡检范围 | {len((run.scope_snapshot or {}).get("host") or [])} 台主机 / '
        f'{len((run.scope_snapshot or {}).get("k8s") or [])} 个 K8s 集群 / '
        f'{len((run.scope_snapshot or {}).get("middleware") or [])} 个中间件实例 |',
        f'| 巡检项 | {run.item_count} |',
        f'| 综合得分 | {run.score}/100 |',
        f'| 结论 | {run.get_status_display()} |',
        '',
        '## 总览',
        f'严重 {run.critical_count} / 警告 {run.warning_count} / 正常 {run.ok_count} / 未知 {run.unknown_count}',
        '',
        '## 明细',
    ]
    if not grouped:
        lines.append('本次未采集到巡检结果。')
    remediation = {}
    for (name, ip), items in grouped.items():
        lines.append(f'### {name}（{ip or "-"}）')
        abnormal = [item for item in items if item.severity != SEVERITY_OK]
        if not abnormal:
            lines.append('全部正常')
        else:
            lines.append('| 巡检项 | 级别 | 当前值 | 阈值 | 说明 |')
            lines.append('|---|---|---|---|---|')
            for item in abnormal:
                lines.append(
                    f'| {item.item_name} | {item.get_severity_display()} | {item.value or "-"} | '
                    f'{item.threshold or "-"} | {(item.message or "-").replace("|", "/")} |'
                )
        lines.append('')
        for item in abnormal:
            code = item.item_code
            definition = builtin_item_map().get(code) or {}
            advice = definition.get('remediation') or ''
            if advice and code not in remediation:
                remediation[code] = advice
    lines.append('## 隐患')
    issues = list(InspectionIssue.objects.filter(last_run=run).order_by('-severity', '-occurrences')[:50])
    if issues:
        for issue in issues:
            lines.append(f'- [{issue.get_severity_display()}] {issue.title} — 出现 {issue.occurrences} 次')
    else:
        lines.append('本次未新增隐患')
    lines.append('')
    lines.append('## 建议')
    if remediation:
        for advice in dict.fromkeys(remediation.values()):
            lines.append(f'- {advice}')
    else:
        lines.append('- 保持当前基线')
    return '\n'.join(lines)
