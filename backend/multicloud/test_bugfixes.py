from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from aiops.models import AIOpsChatSession
from sxdevops.pagination import StandardPagination

from .models import CloudCredential


class PartialUpdateTests(TestCase):
    def test_patch_does_not_require_full_payload(self):
        user = get_user_model().objects.create_superuser(username='patcher', password='x', email='')
        client = APIClient()
        client.force_authenticate(user=user)
        credential = CloudCredential.objects.create(provider='aliyun', name='生产账号', owner='old-owner')

        response = client.patch(f'/api/multicloud/credentials/{credential.pk}/', {'owner': 'new-owner'}, format='json')

        self.assertEqual(response.status_code, 200, getattr(response, 'data', None))
        credential.refresh_from_db()
        self.assertEqual(credential.owner, 'new-owner')
        self.assertEqual(credential.provider, 'aliyun')


class PaginationPageSizeTests(TestCase):
    def test_default_paginator_honours_page_size(self):
        self.assertEqual(StandardPagination.page_size_query_param, 'page_size')

    def test_page_size_query_returns_more_than_default_page(self):
        user = get_user_model().objects.create_superuser(username='pager', password='x', email='')
        AIOpsChatSession.objects.bulk_create([
            AIOpsChatSession(user=user, title=f'会话 {index}') for index in range(25)
        ])
        client = APIClient()
        client.force_authenticate(user=user)

        default_response = client.get('/api/aiops/sessions/')
        full_response = client.get('/api/aiops/sessions/?page_size=100')

        self.assertEqual(default_response.status_code, 200)
        self.assertEqual(full_response.status_code, 200)
        self.assertEqual(len(full_response.data['results']), 25)
        self.assertEqual(full_response.data['count'], 25)


class MaskedSecretRegressionTests(SimpleTestCase):
    def test_short_secret_is_fully_masked(self):
        from types import SimpleNamespace

        from .serializers import CloudCredentialSerializer

        serializer = CloudCredentialSerializer()
        self.assertEqual(serializer.get_masked_secret(SimpleNamespace(access_key_secret='abcd')), '********')
        self.assertEqual(serializer.get_masked_secret(SimpleNamespace(access_key_secret='abcdefghijkl')), 'ab******kl')
