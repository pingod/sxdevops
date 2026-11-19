"""巡检 AI 辅助：结果解读、隐患建议回填与巡检项推荐。

模型不可用时一律降级，不影响巡检本身的状态与结果。
"""

import json
import logging
import threading
import time

from django.db import close_old_connections
from django.utils import timezone

from ops.models import InspectionIssue, InspectionItem, InspectionRun

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = '你是 SRE 巡检报告解读助手。只依据给定巡检结果作答，不推测未采集的数据；输出一个 JSON object，不要 Markdown。'

NOT_CONFIGURED_MESSAGE = 'AIOps 未配置可用的模型提供商，请先在「智能体配置 → 模型提供商」中启用并测试'

MAX_ANALYSIS_RESULTS = 60
MAX_HISTORY_RUNS = 10

_RISK_LEVELS = ('ok', 'warning', 'critical')
_RISK_SEVERITIES = ('warning', 'critical')


class AIOpsInspectionNotConfigured(RuntimeError):
    """模型提供商不可用；API 层转成 400 提示。"""


def _services():
    from aiops import services

    return services


def _completion_content(services, completion):
    message = (((completion or {}).get('choices') or [{}])[0]).get('message') or {}
    return services._extract_message_content(message)


def build_run_analysis_prompt(run, results, issues):
    lines = [
        f'巡检计划：{run.plan_name or "-"}',
        f'执行时间：{timezone.localtime(run.created_at):%Y-%m-%d %H:%M}',
        f'结论状态：{run.get_status_display()}，综合得分：{run.score}/100',
        f'计数：严重 {run.critical_count} / 警告 {run.warning_count} / 正常 {run.ok_count} / 未知 {run.unknown_count}',
        f'巡检范围：{len((run.scope_snapshot or {}).get("host") or [])} 台主机 / '
        f'{len((run.scope_snapshot or {}).get("k8s") or [])} 个 K8s 集群 / '
        f'{len((run.scope_snapshot or {}).get("middleware") or [])} 个中间件实例',
        '',
        '巡检结果（按严重度排序，最多 %d 条）：' % MAX_ANALYSIS_RESULTS,
    ]
    for item in results:
        lines.append(
            f'- [{item.get_severity_display()}] {item.target_name}({item.target_ip or "-"}) '
            f'{item.item_code} {item.item_name}：当前值 {item.value or "-"}，阈值 {item.threshold or "-"}，说明 {item.message or "-"}'
        )
    if not results:
        lines.append('- 本次未采集到巡检结果')
    lines.append('')
    lines.append('本次打开或更新的隐患：')
    if issues:
        for issue in issues:
            lines.append(f'- [{issue.get_severity_display()}] {issue.title}，出现 {issue.occurrences} 次')
    else:
        lines.append('- 本次未新增隐患')
    history = list(
        InspectionRun.objects.filter(plan=run.plan).exclude(pk=run.pk).order_by('-created_at')[:MAX_HISTORY_RUNS]
        if run.plan_id else []
    )
    lines.append('')
    lines.append('同计划最近历史得分：')
    if history:
        lines.append(', '.join(f'{timezone.localtime(item.created_at):%m-%d}={item.score}' for item in history))
    else:
        lines.append('无历史基线')
    lines.append('')
    lines.append(
        '请输出 JSON：{"risk_level":"ok|warning|critical","summary":"一句话结论",'
        '"risks":[{"title":"","severity":"warning|critical","evidence":"引用具体主机/项/数值","advice":"可执行动作"}],'
        '"trend":"与历史相比的变化判断（无历史则写\\"无历史基线\\"）","next_actions":["责任人可执行的动作"]}'
    )
    return '\n'.join(lines)


def _normalize_payload(parsed):
    payload = parsed if isinstance(parsed, dict) else {}
    risk_level = str(payload.get('risk_level') or '').strip()
    summary = str(payload.get('summary') or '').strip()
    trend = str(payload.get('trend') or '').strip()
    risks = []
    for item in payload.get('risks') or []:
        if not isinstance(item, dict):
            continue
        severity = str(item.get('severity') or '').strip()
        if severity not in _RISK_SEVERITIES:
            continue
        risks.append({
            'title': str(item.get('title') or '')[:200],
            'severity': severity,
            'evidence': str(item.get('evidence') or '')[:500],
            'advice': str(item.get('advice') or '')[:1000],
        })
    next_actions = [str(item)[:300] for item in (payload.get('next_actions') or []) if str(item).strip()]
    return {
        'risk_level': risk_level if risk_level in _RISK_LEVELS else 'ok',
        'summary': summary,
        'risks': risks,
        'trend': trend,
        'next_actions': next_actions,
    }


def _backfill_issue_advice(run, risks):
    if not risks:
        return 0
    issues = list(InspectionIssue.objects.filter(last_run=run))
    if not issues:
        return 0
    updated = 0
    for issue in issues:
        for risk in risks:
            advice = risk.get('advice') or ''
            evidence = risk.get('evidence') or ''
            if not advice:
                continue
            if issue.item_code and issue.item_code in evidence:
                if issue.ai_advice != advice:
                    issue.ai_advice = advice
                    issue.save(update_fields=['ai_advice', 'updated_at'])
                    updated += 1
                break
    return updated


def analyze_run(run, user=None, force=False):
    services = _services()
    if not force and run.ai_status == InspectionRun.AI_STATUS_SUCCESS:
        return run.ai_payload or {}
    run.ai_status = InspectionRun.AI_STATUS_RUNNING
    run.ai_error = ''
    run.save(update_fields=['ai_status', 'ai_error'])
    provider = services.get_active_provider(services.get_agent_config())
    if not provider or not services._provider_is_ready(provider):
        run.ai_status = InspectionRun.AI_STATUS_FAILED
        run.ai_error = NOT_CONFIGURED_MESSAGE[:255]
        run.save(update_fields=['ai_status', 'ai_error'])
        raise AIOpsInspectionNotConfigured(NOT_CONFIGURED_MESSAGE)

    results = list(run.results.order_by('-severity', 'target_name', 'item_code')[:MAX_ANALYSIS_RESULTS])
    issues = list(InspectionIssue.objects.filter(last_run=run).order_by('-severity')[:20])
    prompt = build_run_analysis_prompt(run, results, issues)
    started = time.monotonic()
    try:
        completion = services._request_model_completion(
            provider,
            {
                'model': provider.default_model,
                'temperature': 0.2,
                'max_tokens': 1600,
                'messages': [
                    {'role': 'system', 'content': SYSTEM_PROMPT},
                    {'role': 'user', 'content': prompt},
                ],
            },
            purpose=services.AIOpsModelInvocation.PURPOSE_INSPECTION_ANALYSIS,
            user=user,
        )
        payload = _normalize_payload(services._parse_json_object_from_text(_completion_content(services, completion)))
    except Exception as exc:
        run.ai_status = InspectionRun.AI_STATUS_FAILED
        run.ai_error = str(exc)[:255]
        run.save(update_fields=['ai_status', 'ai_error'])
        logger.warning('inspection analysis failed: %s (%s ms)', run.id, int((time.monotonic() - started) * 1000))
        raise
    run.ai_status = InspectionRun.AI_STATUS_SUCCESS
    run.ai_summary = payload.get('summary', '')[:2000]
    run.ai_payload = payload
    run.ai_error = ''
    run.save(update_fields=['ai_status', 'ai_summary', 'ai_payload', 'ai_error'])
    _backfill_issue_advice(run, payload.get('risks') or [])
    return payload


def enqueue_run_analysis(run_id):
    thread = threading.Thread(target=_analysis_thread, args=(run_id,), name=f'inspection-analysis-{run_id}', daemon=True)
    thread.start()


def _analysis_thread(run_id):
    close_old_connections()
    try:
        run = InspectionRun.objects.filter(pk=run_id).first()
        if run:
            analyze_run(run)
    except AIOpsInspectionNotConfigured:
        pass
    except Exception:
        logger.exception('inspection analysis thread failed: %s', run_id)
    finally:
        close_old_connections()


def recommend_items(scope, goal='', user=None):
    services = _services()
    items = list(InspectionItem.objects.filter(is_enabled=True).order_by('sort_order', 'id'))
    fallback = {
        'items': [
            {'code': item.code, 'name': item.name, 'reason': '启用项目录中的默认巡检项'}
            for item in items
        ],
        'source': 'fallback',
    }
    provider = services.get_active_provider(services.get_agent_config())
    if not provider or not services._provider_is_ready(provider) or not items:
        return fallback
    catalog = [
        {'code': item.code, 'name': item.name, 'category': item.category, 'description': item.description}
        for item in items
    ]
    prompt = '\n'.join([
        f'巡检范围：{json.dumps(scope or {}, ensure_ascii=False)}',
        f'巡检目标：{goal or "通用日常巡检"}',
        f'候选巡检项：{json.dumps(catalog, ensure_ascii=False)}',
        '请从候选巡检项中挑选最相关的项（最多 12 个），只输出 JSON：{"items":[{"code":"","reason":""}]}',
        'code 必须来自候选列表，reason 用一句中文说明为什么选它。',
    ])
    try:
        completion = services._request_model_completion(
            provider,
            {
                'model': provider.default_model,
                'temperature': 0.2,
                'max_tokens': 800,
                'messages': [
                    {'role': 'system', 'content': '你是 SRE 巡检项推荐助手，只输出 JSON object，不要 Markdown。'},
                    {'role': 'user', 'content': prompt},
                ],
            },
            purpose=services.AIOpsModelInvocation.PURPOSE_INSPECTION_ANALYSIS,
            user=user,
        )
        parsed = services._parse_json_object_from_text(_completion_content(services, completion))
    except Exception:
        logger.warning('inspection item recommendation failed, falling back to catalog')
        return fallback
    known = {item.code: item for item in items}
    selected = []
    for entry in parsed.get('items') or []:
        if not isinstance(entry, dict):
            continue
        code = str(entry.get('code') or '').strip()
        if code not in known or code in {item['code'] for item in selected}:
            continue
        selected.append({
            'code': code,
            'name': known[code].name,
            'reason': str(entry.get('reason') or '')[:300],
        })
    if not selected:
        return fallback
    return {'items': selected, 'source': 'ai'}
