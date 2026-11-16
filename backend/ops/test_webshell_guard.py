"""WebShell 高危命令拦截测试：按键流还原、规则判定、审计、API 权限与消费者集成。"""
import json
from unittest.mock import Mock

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from rbac.models import Role
from rbac.services import ensure_builtin_rbac

from .models import WebShellCommandRule
from .webshell_guard import WebShellGuard, load_rules

User = get_user_model()


def make_guard(action='block', pattern=r'\brm\s+(?:-\w+\s+)*-[rfRF]\w*\s+/(?:\*|\s|$)'):
    rule = WebShellCommandRule(name='test-rule', pattern=pattern, action=action, severity='critical')
    import re
    return WebShellGuard([(rule, re.compile(pattern))]), rule


class GuardLogicTests(SimpleTestCase):
    def test_block_rm_rf_root_withholds_enter(self):
        guard, rule = make_guard('block')
        forward, events = guard.process('rm -rf /\r')
        self.assertNotIn('\r', forward)
        self.assertIn('\x15', forward)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['action'], 'block')
        self.assertEqual(events[0]['command'], 'rm -rf /')

    def test_block_rm_rf_root_glob(self):
        guard, _ = make_guard('block')
        _, events = guard.process('rm -rf /*\r')
        self.assertEqual(events[0]['action'], 'block')

    def test_warn_shutdown_forwards_enter(self):
        guard, _ = make_guard('warn', r'\b(?:shutdown|reboot)\b')
        forward, events = guard.process('shutdown -h now\r')
        self.assertIn('\r', forward)
        self.assertEqual(events[0]['action'], 'warn')

    def test_audit_history_forwards_enter(self):
        guard, _ = make_guard('audit', r'\bhistory\s+-c\b')
        forward, events = guard.process('history -c\r')
        self.assertIn('\r', forward)
        self.assertEqual(events[0]['action'], 'audit')

    def test_safe_command_no_event(self):
        guard, _ = make_guard('block')
        forward, events = guard.process('ls -la /\r')
        self.assertIn('\r', forward)
        self.assertEqual(events, [])

    def test_backspace_edits_buffer(self):
        guard, _ = make_guard('block')
        guard.process('rm -rf /')
        guard.process('\x7f')
        _, events = guard.process('\r')
        self.assertEqual(events, [])

    def test_ctrl_c_clears_buffer(self):
        guard, _ = make_guard('block')
        guard.process('rm -rf /')
        guard.process('\x03')
        _, events = guard.process('\r')
        self.assertEqual(events, [])

    def test_escape_sequences_not_buffered(self):
        guard, _ = make_guard('block')
        guard.process('\x1b[A')
        _, events = guard.process('ls\r')
        self.assertEqual(events, [])

    def test_command_split_across_packets(self):
        guard, _ = make_guard('block')
        guard.process('rm -rf ')
        _, events = guard.process('/\r')
        self.assertEqual(events[0]['action'], 'block')

    def test_empty_enter_no_event(self):
        guard, _ = make_guard('block')
        _, events = guard.process('\r')
        self.assertEqual(events, [])


class RuleLoadingTests(TestCase):
    def test_builtin_rules_seeded(self):
        self.assertEqual(WebShellCommandRule.objects.filter(is_builtin=True).count(), 10)

    def test_load_rules_skips_invalid_regex(self):
        WebShellCommandRule.objects.create(name='bad', pattern='[invalid', action='block')
        rules = load_rules()
        self.assertTrue(all(rule.name != 'bad' for rule, _ in rules))

    def test_load_rules_only_enabled(self):
        WebShellCommandRule.objects.filter(name='删除根目录').update(enabled=False)
        rules = load_rules()
        self.assertTrue(all(rule.name != '删除根目录' for rule, _ in rules))


class ApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()
        cls.admin = User.objects.create_superuser(username='ws-admin', password='x')
        cls.auditor = User.objects.create_user(username='ws-auditor', password='x')
        cls.auditor.rbac_roles.add(Role.objects.get(code='security-auditor'))
        cls.noperm = User.objects.create_user(username='ws-noperm', password='x')

    def client_as(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_permission_matrix(self):
        self.assertEqual(self.client_as(self.noperm).get('/api/webshell-rules/').status_code, 403)
        self.assertEqual(self.client_as(self.auditor).get('/api/webshell-rules/').status_code, 200)
        response = self.client_as(self.auditor).post('/api/webshell-rules/', {
            'name': 'x', 'pattern': 'ls', 'action': 'block',
        }, format='json')
        self.assertEqual(response.status_code, 403)

    def test_create_rule_and_audit(self):
        response = self.client_as(self.admin).post('/api/webshell-rules/', {
            'name': '自定义拦截', 'pattern': r'\bdanger\b', 'action': 'block', 'severity': 'warning',
        }, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertTrue(EventRecord.objects.filter(action='webshell_rule_create', resource_name='自定义拦截').exists())

    def test_invalid_regex_rejected(self):
        response = self.client_as(self.admin).post('/api/webshell-rules/', {
            'name': 'bad', 'pattern': '[invalid', 'action': 'block',
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_builtin_rule_cannot_delete(self):
        rule = WebShellCommandRule.objects.get(name='删除根目录')
        response = self.client_as(self.admin).delete(f'/api/webshell-rules/{rule.pk}/')
        self.assertEqual(response.status_code, 400)
        self.assertTrue(WebShellCommandRule.objects.filter(pk=rule.pk).exists())

    def test_builtin_rule_can_disable(self):
        rule = WebShellCommandRule.objects.get(name='删除根目录')
        response = self.client_as(self.admin).patch(f'/api/webshell-rules/{rule.pk}/', {'enabled': False}, format='json')
        self.assertEqual(response.status_code, 200)
        rule.refresh_from_db()
        self.assertFalse(rule.enabled)

    def test_test_action_matches_block_rule(self):
        response = self.client_as(self.auditor).post('/api/webshell-rules/test/', {'command': 'rm -rf /'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['matched'])
        self.assertEqual(response.data['rule']['action'], 'block')

    def test_test_action_safe_command(self):
        response = self.client_as(self.auditor).post('/api/webshell-rules/test/', {'command': 'ls -la'}, format='json')
        self.assertFalse(response.data['matched'])


class SSHConsumerGuardTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()
        cls.user = User.objects.create_superuser(username='ws-ssh', password='x')

    def _consumer(self):
        from .ssh_consumer import SSHConsumer
        consumer = SSHConsumer()
        consumer.user = self.user
        consumer.host_id = 1
        consumer.host_name = 'test-host'
        consumer.guard = WebShellGuard(load_rules())
        consumer.ssh_channel = Mock()
        consumer.send = Mock()
        return consumer

    def test_blocked_command_not_executed_and_audited(self):
        consumer = self._consumer()
        consumer.receive(text_data=json.dumps({'type': 'input', 'data': 'rm -rf /\r'}))
        sent = ''.join(call.args[0] for call in consumer.ssh_channel.send.call_args_list)
        self.assertNotIn('\r', sent)
        self.assertIn('\x15', sent)
        event = EventRecord.objects.get(action='webshell_block')
        self.assertEqual(event.resource_name, 'test-host')
        self.assertEqual(event.actor_username, 'ws-ssh')
        self.assertIn('安全拦截', json.loads(consumer.send.call_args.kwargs['text_data'])['data'])

    def test_safe_command_forwarded(self):
        consumer = self._consumer()
        consumer.receive(text_data=json.dumps({'type': 'input', 'data': 'uptime\r'}))
        sent = ''.join(call.args[0] for call in consumer.ssh_channel.send.call_args_list)
        self.assertIn('\r', sent)
        self.assertFalse(EventRecord.objects.filter(action='webshell_block').exists())

    def test_warn_command_forwarded_and_audited(self):
        consumer = self._consumer()
        consumer.receive(text_data=json.dumps({'type': 'input', 'data': 'reboot\r'}))
        sent = ''.join(call.args[0] for call in consumer.ssh_channel.send.call_args_list)
        self.assertIn('\r', sent)
        self.assertTrue(EventRecord.objects.filter(action='webshell_warn').exists())