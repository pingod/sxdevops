"""三维机房项目库：上传校验、权限边界、文件下发与查看器托管。"""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from rbac.models import PermissionDefinition, Role
from rbac.services import ensure_builtin_rbac

from .models import TwinProject

User = get_user_model()


def room_project(name='机房-A', cabinets=2):
    objects = [
        {'id': 'wall-1', 'type': 'wall', 'x1': 0, 'y1': 0, 'x2': 6000, 'y2': 0, 'props': {'height': 3000}},
    ]
    for index in range(cabinets):
        objects.append({
            'id': f'cab-{index}', 'type': 'cabinet', 'x': 1000 + index * 600, 'y': 1000,
            'rotation': 0, 'props': {'h': 2000, 'w': 600, 'd': 1200, 'name': f'A{index + 1:02d}'},
        })
    return {'name': name, 'objects': objects, 'meta': {'surveyor': '', 'date': ''}}


def json_upload(payload, filename='room.json'):
    from django.core.files.uploadedfile import SimpleUploadedFile
    return SimpleUploadedFile(filename, json.dumps(payload, ensure_ascii=False).encode('utf-8'), content_type='application/json')


class TwinProjectApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()

    def setUp(self):
        self.user = User.objects.create_user(username='twin-viewer')
        self.manager = User.objects.create_user(username='twin-manager')
        self.viewer_client = APIClient()
        self.viewer_client.force_authenticate(self.user)
        self.manager_client = APIClient()
        self.manager_client.force_authenticate(self.manager)
        self.grant(self.user, 'datacenter.twin.view')
        self.grant(self.manager, 'datacenter.twin.view', 'datacenter.twin.manage')

    def grant(self, user, *codes):
        code = f'twin-{user.username}-{Role.objects.count()}'
        role = Role.objects.create(code=code, name=code)
        role.permissions.set(PermissionDefinition.objects.filter(code__in=codes))
        role.users.add(user)

    def upload(self, client=None, payload=None, **extra):
        client = client or self.manager_client
        return client.post(
            '/api/datacenter/twin/projects/',
            {'file': json_upload(payload or room_project())},
            format='multipart',
            **extra,
        )

    def test_viewer_role_can_list_but_not_upload(self):
        listed = self.viewer_client.get('/api/datacenter/twin/projects/')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.data['results'], [])
        blocked = self.upload(client=self.viewer_client)
        self.assertEqual(blocked.status_code, 403)
        self.assertIn('datacenter.twin.manage', blocked.data['detail'])

    def test_upload_stores_metadata_and_returns_project(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201, response.data)
        project = TwinProject.objects.get()
        self.assertEqual(project.name, '机房-A')
        self.assertEqual(project.project_name, '机房-A')
        self.assertEqual(project.object_count, 3)
        self.assertEqual(project.uploaded_by, 'twin-manager')
        self.assertGreater(project.size_bytes, 0)
        self.assertEqual(len(project.checksum), 64)
        self.assertEqual(json.loads(project.content)['objects'][1]['id'], 'cab-0')
        self.assertNotIn('content', response.data)
        self.assertEqual(EventRecord.objects.filter(action='upload_twin_project').count(), 1)

    def test_upload_name_can_be_overridden_and_falls_back_to_filename(self):
        payload = room_project(name='')
        response = self.manager_client.post(
            '/api/datacenter/twin/projects/',
            {'file': json_upload(payload, filename='信息港机房.json'), 'name': '信息港 403 房'},
            format='multipart',
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(TwinProject.objects.get().name, '信息港 403 房')
        TwinProject.objects.all().delete()
        response = self.manager_client.post(
            '/api/datacenter/twin/projects/',
            {'file': json_upload(payload, filename='信息港机房.json')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(TwinProject.objects.get().name, '信息港机房')

    def test_upload_rejects_invalid_payloads(self):
        cases = [
            ({'objects': []}, 'objects'),
            ({'objects': [{'type': 'cabinet'}]}, 'id'),
            ({'objects': [{'id': 'w', 'type': 'wall'}]}, 'cabinet'),
            ({'objects': [{'id': 'w', 'type': 'wall'}, {'id': 'w', 'type': 'wall'}]}, '重复'),
        ]
        for payload, marker in cases:
            with self.subTest(marker=marker):
                response = self.upload(payload=payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn(marker, json.dumps(response.data, ensure_ascii=False))
        response = self.manager_client.post(
            '/api/datacenter/twin/projects/',
            {'file': json_upload_text('not json')},
            format='multipart',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('JSON', json.dumps(response.data, ensure_ascii=False))

    def test_upload_rejects_duplicate_name_and_duplicate_content(self):
        self.assertEqual(self.upload().status_code, 201)
        same_name = self.upload(payload=room_project(name='机房-A', cabinets=1))
        self.assertEqual(same_name.status_code, 400)
        self.assertIn('已存在', json.dumps(same_name.data, ensure_ascii=False))
        same_content = self.manager_client.post(
            '/api/datacenter/twin/projects/',
            {'file': json_upload(room_project(name='机房-A')), 'name': '机房-B'},
            format='multipart',
        )
        self.assertEqual(same_content.status_code, 400)
        self.assertIn('完全相同', json.dumps(same_content.data, ensure_ascii=False))
        self.assertEqual(TwinProject.objects.count(), 1)

    def test_upload_rejects_oversize_file(self):
        with patch('datacenter.serializers.MAX_PROJECT_BYTES', 32):
            response = self.upload()
        self.assertEqual(response.status_code, 400)
        self.assertIn('上限', json.dumps(response.data, ensure_ascii=False))
        self.assertEqual(TwinProject.objects.count(), 0)

    def test_content_endpoint_serves_raw_json_to_viewer(self):
        self.upload()
        project = TwinProject.objects.get()
        response = self.viewer_client.get(f'/api/datacenter/twin/projects/{project.pk}/content/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'application/json; charset=utf-8')
        self.assertEqual(json.loads(response.content), json.loads(project.content))
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_delete_requires_manage_permission_and_audits(self):
        self.upload()
        project = TwinProject.objects.get()
        denied = self.viewer_client.delete(f'/api/datacenter/twin/projects/{project.pk}/')
        self.assertEqual(denied.status_code, 403)
        self.assertTrue(TwinProject.objects.filter(pk=project.pk).exists())
        removed = self.manager_client.delete(f'/api/datacenter/twin/projects/{project.pk}/')
        self.assertEqual(removed.status_code, 204)
        self.assertFalse(TwinProject.objects.exists())
        event = EventRecord.objects.get(action='delete_twin_project')
        self.assertEqual(event.resource_name, '机房-A')

    def test_viewer_status_reports_build_state(self):
        response = self.viewer_client.get('/api/datacenter/twin/status/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('viewer_built', response.data)
        self.assertEqual(response.data['viewer_path'], '/dc-viewer-app/')


class TwinViewerHostingTests(TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / 'index.html').write_text('<!doctype html><div id="cv3d"></div>', encoding='utf-8')
        (self.tmp / 'assets').mkdir()
        (self.tmp / 'assets' / 'main.js').write_text('console.log(1)', encoding='utf-8')
        self.patch = patch('datacenter.views.VIEWER_DIST_DIR', self.tmp)
        self.patch.start()
        self.client = APIClient()

    def tearDown(self):
        self.patch.stop()

    def test_index_is_served_without_auth_and_not_cached(self):
        response = self.client.get('/dc-viewer-app/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'cv3d', b''.join(response.streaming_content))
        self.assertIn('no-store', response['Cache-Control'])

    def test_hashed_assets_are_immutable_and_typed(self):
        response = self.client.get('/dc-viewer-app/assets/main.js')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'text/javascript')
        self.assertIn('immutable', response['Cache-Control'])

    def test_path_traversal_is_rejected(self):
        response = self.client.get('/dc-viewer-app/../backend/manage.py')
        self.assertEqual(response.status_code, 404)


def json_upload_text(text, filename='room.json'):
    from django.core.files.uploadedfile import SimpleUploadedFile
    return SimpleUploadedFile(filename, text.encode('utf-8'), content_type='application/json')
