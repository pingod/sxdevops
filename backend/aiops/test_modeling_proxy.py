from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from rbac.models import Role
from rbac.services import ensure_builtin_rbac

from .models import AIOpsModelProvider
from .services import AIOpsModelCallError


class AIOpsModelingProxyTests(TestCase):
    def setUp(self):
        ensure_builtin_rbac()
        self.user = get_user_model().objects.create_user(username='modeling-admin', password='test-password')
        self.user.rbac_roles.add(Role.objects.get(code='platform-admin'))
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.provider = AIOpsModelProvider.objects.create(
            name='modeling-provider', base_url='http://model.local/v1', default_model='model-x',
        )

    def test_requires_chat_permission(self):
        user = get_user_model().objects.create_user(username='no-chat', password='test-password')
        client = APIClient()
        client.force_authenticate(user)
        response = client.post('/api/aiops/modeling/chat/', {'messages': [{'role': 'user', 'content': 'hi'}]}, format='json')
        self.assertEqual(response.status_code, 403)

    def test_proxy_returns_model_response_and_writes_audit(self):
        data = {
            'choices': [{'message': {'content': '{"reply":"ok"}'}}],
            'usage': {'total_tokens': 3},
            '_meta': {'resolved_model': 'model-x'},
        }
        with mock.patch('aiops.views.run_modeling_chat', return_value=(self.provider, data)):
            response = self.client.post(
                '/api/aiops/modeling/chat/',
                {'messages': [{'role': 'user', 'content': '建一个机房'}], 'response_format': {'type': 'json_object'}},
                format='json',
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['choices'][0]['message']['content'], '{"reply":"ok"}')
        event = EventRecord.objects.filter(module='aiops', action='modeling_chat').first()
        self.assertIsNotNone(event)
        self.assertEqual(event.metadata.get('purpose'), 'ai_modeling')
        self.assertEqual(event.metadata.get('provider'), 'modeling-provider')
        self.assertEqual(event.metadata.get('usage', {}).get('total'), 3)

    def test_proxy_failure_is_audited_as_failed(self):
        with mock.patch('aiops.views.run_modeling_chat', side_effect=AIOpsModelCallError('模型未配置')):
            response = self.client.post(
                '/api/aiops/modeling/chat/',
                {'messages': [{'role': 'user', 'content': 'hi'}]},
                format='json',
            )
        self.assertEqual(response.status_code, 503)
        self.assertIn('模型未配置', response.data['detail'])
        event = EventRecord.objects.filter(module='aiops', action='modeling_chat').first()
        self.assertIsNotNone(event)
        self.assertEqual(event.result, EventRecord.RESULT_FAILED)
