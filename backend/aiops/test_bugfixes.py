from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .models import AIOpsChatSession
from .services import _normalize_tool_arguments, _safe_int
from .views import _digits_to_int


class AuditIdParsingTests(TestCase):
    def test_oversized_digit_strings_are_rejected(self):
        self.assertIsNone(_digits_to_int('9' * 5000))
        self.assertEqual(_digits_to_int('42'), 42)
        self.assertIsNone(_digits_to_int('abc'))


class ToolArgumentNormalizationTests(TestCase):
    def test_numeric_tool_arguments_are_coerced(self):
        normalized = _normalize_tool_arguments({'limit': '5', 'duration_minutes': '30', 'query': 'x'})
        self.assertEqual(normalized['limit'], 5)
        self.assertEqual(normalized['duration_minutes'], 30)
        self.assertEqual(normalized['query'], 'x')

    def test_invalid_numeric_tool_argument_falls_back_to_default(self):
        self.assertEqual(_safe_int('abc', default=0), 0)
        self.assertEqual(_normalize_tool_arguments({'limit': 'abc'})['limit'], 0)


class RunbookSessionOwnershipTests(TestCase):
    def test_cannot_build_runbook_from_another_users_session(self):
        user_model = get_user_model()
        attacker = user_model.objects.create_superuser(username='attacker', password='x', email='')
        victim = user_model.objects.create_user(username='victim', password='x')
        session = AIOpsChatSession.objects.create(user=victim, title='生产故障复盘')
        client = APIClient()
        client.force_authenticate(user=attacker)

        response = client.post('/api/aiops/runbooks/from-session/', {'source_session': session.id}, format='json')

        self.assertEqual(response.status_code, 400)
        self.assertIn('来源会话不存在', str(response.data))
