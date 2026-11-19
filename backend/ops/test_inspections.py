from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from aiops.services import AIOpsModelCallError
from cmdb.models import CIType, ConfigItem
from ops.inspection_collectors import evaluate_threshold, parse_host_inspection_output
from ops.inspection_runner import compute_run_score, upsert_issues
from ops.models import InspectionIssue, InspectionItem, InspectionPlan, InspectionResult, InspectionRun
from rbac.models import Role
from rbac.services import ensure_builtin_rbac


class InspectionHelperTests(TestCase):
    def test_parse_host_inspection_output_keeps_worst_mount(self):
        raw = '\n'.join([
            '[sec:host.disk]',
            '/ 82',
            '/data 91',
            '[sec:host.memory]',
            '87.5',
            '[sec:host.swap]',
            '-',
            '[sec:host.unknown]',
            'ignored',
        ])
        parsed = parse_host_inspection_output(raw)
        self.assertEqual(parsed['host.disk'], ['/ 82', '/data 91'])
        self.assertEqual(parsed['host.swap'], ['-'])

        from ops.inspection_collectors import _build_host_results

        configs = {
            'host.disk': {'warning': 80, 'critical': 90, 'unit': '%', 'comparison': 'gte'},
            'host.memory': {'warning': 85, 'critical': 95, 'unit': '%', 'comparison': 'gte'},
            'host.swap': {'warning': 50, 'critical': 80, 'unit': '%', 'comparison': 'gte'},
        }
        results = {item['item_code']: item for item in _build_host_results(parsed, configs, 12)}
        self.assertEqual(results['host.disk']['severity'], 'critical')
        self.assertEqual(results['host.disk']['value'], '91%')
        self.assertIn('/data', results['host.disk']['message'])
        self.assertEqual(results['host.memory']['severity'], 'warning')
        self.assertEqual(results['host.swap']['severity'], 'unknown')

    def test_evaluate_threshold_boundaries(self):
        gte = {'warning': 80, 'critical': 90, 'comparison': 'gte'}
        self.assertEqual(evaluate_threshold('79.9', gte), 'ok')
        self.assertEqual(evaluate_threshold('80', gte), 'warning')
        self.assertEqual(evaluate_threshold('90', gte), 'critical')
        lte = {'warning': 20, 'critical': 10, 'comparison': 'lte'}
        self.assertEqual(evaluate_threshold('25', lte), 'ok')
        self.assertEqual(evaluate_threshold('20', lte), 'warning')
        self.assertEqual(evaluate_threshold('10', lte), 'critical')
        self.assertEqual(evaluate_threshold('no', {'comparison': 'eq', 'expect': 'no'}), 'critical')
        self.assertEqual(evaluate_threshold('yes', {'comparison': 'eq', 'expect': 'no'}), 'ok')
        self.assertEqual(evaluate_threshold('1', {'comparison': 'flag'}), 'warning')
        self.assertEqual(evaluate_threshold('0', {'comparison': 'flag'}), 'ok')
        self.assertEqual(evaluate_threshold('', gte), 'unknown')
        self.assertEqual(evaluate_threshold('not-a-number', gte), 'unknown')
        self.assertEqual(evaluate_threshold('80', {}), 'unknown')

    def test_compute_run_score_penalizes_warning_once_and_critical_twice(self):
        weights = {'host.memory': 10, 'host.disk': 10}
        results = [
            {'item_code': 'host.memory', 'severity': 'warning'},
            {'item_code': 'host.disk', 'severity': 'warning'},
            {'item_code': 'host.disk', 'severity': 'critical'},
        ]
        self.assertEqual(compute_run_score(results, weights), 60)
        self.assertEqual(compute_run_score([{'item_code': 'host.memory', 'severity': 'ok'}], weights), 100)
        heavy = [{'item_code': 'host.disk', 'severity': 'critical'} for _ in range(10)]
        self.assertEqual(compute_run_score(heavy, weights), 0)


class InspectionApiTests(TestCase):
    def setUp(self):
        ensure_builtin_rbac()
        self.client = APIClient()
        self.user = get_user_model().objects.create_user('inspection-admin', password='pass-12345')
        self.user.rbac_roles.add(Role.objects.get(code='ops-admin'))
        self.client.force_authenticate(user=self.user)
        self.plan = InspectionPlan.objects.create(
            name='演示巡检',
            enabled=True,
            scope={},
            item_codes=['host.disk', 'host.memory'],
            schedule_type=InspectionPlan.SCHEDULE_TYPE_MANUAL,
            created_by=self.user.username,
        )

    def _run_with(self, results):
        run = InspectionRun.objects.create(
            plan=self.plan, plan_name=self.plan.name, status=InspectionRun.STATUS_RUNNING,
            item_codes=self.plan.item_codes, created_by=self.user.username,
        )
        InspectionResult.objects.bulk_create([
            InspectionResult(run=run, **item) for item in results
        ])
        return run

    def _result(self, severity, item_code='host.disk', target_key='host:task_resource:1'):
        return {
            'target_type': 'host', 'target_key': target_key, 'target_name': 'web-01',
            'target_ip': '10.0.0.1', 'item_code': item_code, 'item_name': '磁盘使用率',
            'category': 'host', 'severity': severity, 'value': '91%', 'threshold': '≥90% 严重',
            'message': '最差挂载点 /data',
        }

    def test_issue_opens_then_resolves_and_ignored_stays(self):
        run = self._run_with([self._result('critical')])
        upsert_issues(run, [self._result('critical')])
        issue = InspectionIssue.objects.get(dedupe_key='host:host:task_resource:1:host.disk')
        self.assertEqual(issue.status, InspectionIssue.STATUS_OPEN)
        self.assertEqual(issue.occurrences, 1)

        second = self._run_with([self._result('critical')])
        upsert_issues(second, [self._result('critical')])
        issue.refresh_from_db()
        self.assertEqual(issue.occurrences, 2)
        self.assertEqual(issue.last_run_id, second.id)

        third = self._run_with([self._result('ok')])
        upsert_issues(third, [self._result('ok')])
        issue.refresh_from_db()
        self.assertEqual(issue.status, InspectionIssue.STATUS_RESOLVED)
        self.assertIsNotNone(issue.resolved_at)

        ignored = InspectionIssue.objects.create(
            dedupe_key='host:task_resource:9:host.disk', item_code='host.disk', item_name='磁盘使用率',
            category='host', target_type='host', target_key='host:task_resource:9', target_name='web-09',
            severity='warning', status=InspectionIssue.STATUS_IGNORED, title='已忽略隐患',
            first_seen_at=timezone.now(), last_seen_at=timezone.now(),
        )
        ok_result = {**self._result('ok'), 'target_key': 'host:task_resource:9', 'target_name': 'web-09'}
        upsert_issues(self._run_with([ok_result]), [ok_result])
        ignored.refresh_from_db()
        self.assertEqual(ignored.status, InspectionIssue.STATUS_IGNORED)

    def test_permissions_require_inspection_view(self):
        plain = get_user_model().objects.create_user('inspection-plain', password='pass-12345')
        self.client.force_authenticate(user=plain)
        self.assertEqual(self.client.get('/api/inspections/runs/').status_code, 403)
        self.client.force_authenticate(user=self.user)
        self.assertEqual(self.client.get('/api/inspections/runs/').status_code, 200)

    def test_middleware_without_credentials_produces_no_issue(self):
        ci_type, _ = CIType.objects.get_or_create(code='REDIS', defaults={'name': 'Redis'})
        config_item = ConfigItem.objects.create(name='redis-01', ci_type=ci_type, attributes={'endpoint': '10.0.0.9', 'port': '6379'})
        plan = InspectionPlan.objects.create(
            name='中间件巡检', enabled=True,
            scope={'middleware': {'ci_type_codes': ['REDIS'], 'config_item_ids': [config_item.id]}},
            item_codes=['mw.redis.memory'], schedule_type=InspectionPlan.SCHEDULE_TYPE_MANUAL,
            created_by=self.user.username,
        )
        with patch('ops.inspection_collectors.collect_middleware_results', return_value=[{
            'item_code': 'mw.redis.memory', 'severity': 'unknown', 'value': '', 'threshold': '',
            'message': '未配置登录凭据', 'evidence': '', 'duration_ms': 1,
        }]):
            response = self.client.post(f'/api/inspections/plans/{plan.id}/run_now/', {}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(InspectionIssue.objects.count(), 0)
        run = InspectionRun.objects.get(pk=response.data['run_id'])
        self.assertEqual(run.results.get(item_code='mw.redis.memory').severity, 'unknown')

    def test_plan_rejects_invalid_cron_expression(self):
        response = self.client.post('/api/inspections/plans/', {
            'name': 'Cron 巡检', 'item_codes': ['host.disk'], 'schedule_type': 'cron',
            'cron_expression': '99 * * * *',
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('Cron', str(response.data))

    def test_ai_failure_keeps_run_status(self):
        run = self._run_with([self._result('critical')])
        run.status = InspectionRun.STATUS_CRITICAL
        run.save(update_fields=['status'])
        from aiops.inspection import analyze_run

        provider = type('Provider', (), {'default_model': 'demo', 'is_enabled': True})()
        with patch('aiops.services.get_active_provider', return_value=provider), \
                patch('aiops.services._provider_is_ready', return_value=True), \
                patch('aiops.services._request_model_completion', side_effect=AIOpsModelCallError('boom')):
            with self.assertRaises(AIOpsModelCallError):
                analyze_run(run, user=self.user, force=True)
        run.refresh_from_db()
        self.assertEqual(run.ai_status, InspectionRun.AI_STATUS_FAILED)
        self.assertEqual(run.status, InspectionRun.STATUS_CRITICAL)
        self.assertIn('boom', run.ai_error)

    def test_overview_returns_contract_keys(self):
        response = self.client.get('/api/inspections/overview/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), {
            'today_runs', 'open_issues', 'critical_issues', 'avg_score_7d',
            'score_trend', 'severity_distribution', 'top_issues',
        })
        self.assertEqual(len(response.data['score_trend']), 7)

    def test_report_endpoint_returns_markdown(self):
        run = self._run_with([self._result('critical')])
        response = self.client.get(f'/api/inspections/runs/{run.id}/report/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('# 巡检报告', response.data['markdown'])
        self.assertEqual(response.data['filename'], f'inspection-{run.id}.md')

    def test_builtin_items_are_seeded(self):
        self.assertEqual(InspectionItem.objects.count(), 31)
