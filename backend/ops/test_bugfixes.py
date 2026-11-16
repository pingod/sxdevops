import json
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from .alerting import (
    apply_alert_suppression,
    apply_escalation_policy,
    dispatch_alert_notifications,
    match_matchers,
    upsert_alert,
)
from .k8s_views import _pod_is_abnormal
from .models import (
    Alert,
    AlertEscalationPolicy,
    AlertMuteRule,
    AlertNotificationChannel,
    AlertNotificationLog,
    AlertNotificationRule,
    GrafanaSetting,
)


def _make_alert(**overrides):
    defaults = {
        'title': 'CPU 使用率过高',
        'level': 'critical',
        'status': Alert.STATUS_ACTIVE,
        'source': 'prometheus',
        'source_type': Alert.SOURCE_PROMETHEUS,
        'message': 'cpu > 90%',
        'fingerprint': overrides.pop('fingerprint', 'fp-cpu-1'),
    }
    defaults.update(overrides)
    return Alert.objects.create(**defaults)


class MatcherRegexTests(TestCase):
    def test_invalid_regex_matcher_is_ignored_instead_of_crashing(self):
        alert = _make_alert()
        match = match_matchers(alert, [{'key': 'title', 'op': '=~', 'value': '['}])
        self.assertFalse(match)
        # 反向匹配写错正则时不能变成“全部命中”
        self.assertTrue(match_matchers(alert, [{'key': 'title', 'op': '!~', 'value': '['}]))


class NotificationProviderErrorTests(TestCase):
    def test_dingtalk_errcode_is_treated_as_failure(self):
        rule = AlertNotificationRule.objects.create(name='默认通知', is_enabled=True)
        channel = AlertNotificationChannel.objects.create(
            name='钉钉机器人',
            channel_type=AlertNotificationChannel.CHANNEL_DINGTALK,
            is_enabled=True,
            config={'webhook_url': 'https://oapi.dingtalk.com/robot/send?access_token=bad'},
        )
        rule.channels.add(channel)
        alert = _make_alert()

        class FakeResponse:
            status_code = 200
            text = '{"errcode":310000,"errmsg":"invalid access_token"}'

            def json(self):
                return json.loads(self.text)

        with patch('ops.alerting.requests.post', return_value=FakeResponse()):
            logs = dispatch_alert_notifications(alert, action='fire')

        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0].status, AlertNotificationLog.STATUS_ERROR)
        self.assertIn('310000', logs[0].error_message)


class EscalationSuppressionTests(TestCase):
    def test_muted_alert_does_not_escalate_or_notify(self):
        rule = AlertNotificationRule.objects.create(name='默认通知', is_enabled=True)
        channel = AlertNotificationChannel.objects.create(
            name='钉钉',
            channel_type=AlertNotificationChannel.CHANNEL_DINGTALK,
            is_enabled=True,
            config={'webhook_url': 'https://example.com/hook'},
        )
        rule.channels.add(channel)
        AlertEscalationPolicy.objects.create(
            name='立即升级',
            is_enabled=True,
            levels=[{'after_minutes': 0, 'channels': ['钉钉']}],
        )
        AlertMuteRule.objects.create(name='全量屏蔽', is_enabled=True, matchers=[])
        alert = _make_alert()

        with patch('ops.alerting.requests.post') as mocked_post:
            mocked_post.return_value.status_code = 200
            mocked_post.return_value.text = 'ok'
            upsert_alert(
                {
                    'title': alert.title,
                    'level': alert.level,
                    'status': Alert.STATUS_ACTIVE,
                    'source': alert.source,
                    'source_type': alert.source_type,
                    'message': alert.message,
                    'fingerprint': alert.fingerprint,
                }
            )
            refreshed = Alert.objects.get(pk=alert.pk)
            apply_alert_suppression(refreshed)
            escalated = apply_escalation_policy(refreshed)

        self.assertFalse(escalated)
        self.assertEqual(refreshed.status, Alert.STATUS_MUTED)
        self.assertEqual(refreshed.escalation_level, 0)
        mocked_post.assert_not_called()


class PodHealthTests(TestCase):
    def test_crashloop_pod_is_abnormal(self):
        pod = {'status': 'Running', 'containers': [{'name': 'app', 'ready': False}]}
        self.assertTrue(_pod_is_abnormal(pod['status'], pod))

    def test_ready_running_pod_is_normal(self):
        pod = {'status': 'Running', 'containers': [{'name': 'app', 'ready': True}]}
        self.assertFalse(_pod_is_abnormal(pod['status'], pod))


class GrafanaMetaTests(TestCase):
    def test_dashboard_without_panel_count_does_not_break_meta(self):
        GrafanaSetting.objects.create(
            name='default',
            enabled=True,
            url='https://grafana.example.com',
            dashboards=[{'key': 'custom-1', 'title': '自定义看板', 'path': '/d/custom-1'}],
        )
        from .observability_views import _grafana_meta

        meta = _grafana_meta()

        self.assertEqual(meta['dashboard_count'], 1)
        self.assertEqual(meta['panel_count'], 0)
