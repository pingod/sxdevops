"""机柜布设方案库：内容校验、权限边界、乐观锁与版本快照。"""
import json

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from rbac.models import PermissionDefinition, Role
from rbac.services import ensure_builtin_rbac

from .models import RackProject

User = get_user_model()


def device(device_id=1, **overrides):
    payload = {
        'id': device_id, 'cat': 'switch', 'name': f'交换机-{device_id}',
        'w': 6, 'hU': 1, 'col': 0, 'hole': 0,
    }
    payload.update(overrides)
    return payload


def project(rack='42U', devices=None, mode='U', custom=None):
    return {
        'rack': rack,
        'rackWidth': 600,
        'mode': mode,
        'devices': devices if devices is not None else [device()],
        'customDevices': custom or [],
    }


class RackProjectApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()

    def setUp(self):
        self.user = User.objects.create_user(username='rack-viewer')
        self.manager = User.objects.create_user(username='rack-manager')
        self.viewer_client = APIClient()
        self.viewer_client.force_authenticate(self.user)
        self.manager_client = APIClient()
        self.manager_client.force_authenticate(self.manager)
        self.grant(self.user, 'datacenter.rack.view')
        self.grant(self.manager, 'datacenter.rack.view', 'datacenter.rack.manage')

    def grant(self, user, *codes):
        code = f'rack-{user.username}-{Role.objects.count()}'
        role = Role.objects.create(code=code, name=code)
        role.permissions.set(PermissionDefinition.objects.filter(code__in=codes))
        role.users.add(user)

    def create(self, client=None, name='A01 机柜', body=None):
        return (client or self.manager_client).post(
            '/api/datacenter/rack/projects/',
            {'name': name, 'description': '一期', 'project': body if body is not None else project()},
            format='json',
        )

    def put(self, project_row, body, client=None, base_version=None, **extra):
        payload = {
            'project': body,
            'base_version': project_row.version if base_version is None else base_version,
            **extra,
        }
        return (client or self.manager_client).put(
            f'/api/datacenter/rack/projects/{project_row.pk}/', payload, format='json',
        )

    def test_viewer_can_list_but_cannot_create(self):
        listed = self.viewer_client.get('/api/datacenter/rack/projects/')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.data['results'], [])
        blocked = self.create(client=self.viewer_client)
        self.assertEqual(blocked.status_code, 403)
        self.assertIn('datacenter.rack.manage', blocked.data['detail'])

    def test_create_stores_stats_and_audits(self):
        response = self.create(body=project(devices=[
            device(1, hole=0, hU=2),
            device(2, hole=6, w=3, col=0, name='交换机-半宽'),
            device(3, hole=6, w=3, col=3, name='服务器-半宽'),
        ]))
        self.assertEqual(response.status_code, 201, response.data)
        row = RackProject.objects.get()
        self.assertEqual(row.name, 'A01 机柜')
        self.assertEqual(row.rack_kind, '42U')
        self.assertEqual(row.snap_mode, 'U')
        self.assertEqual(row.device_count, 3)
        self.assertEqual(row.used_u, 4)
        self.assertEqual(row.uploaded_by, 'rack-manager')
        self.assertEqual(len(row.checksum), 64)
        content = json.loads(row.content)
        self.assertEqual(content['deviceSeq'], 4)
        self.assertEqual(content['devices'][1]['col'], 0)
        self.assertNotIn('content', response.data)
        self.assertEqual(EventRecord.objects.filter(action='create_rack_project').count(), 1)

    def test_create_without_project_starts_empty(self):
        response = self.manager_client.post(
            '/api/datacenter/rack/projects/', {'name': '空机柜'}, format='json',
        )
        self.assertEqual(response.status_code, 201, response.data)
        row = RackProject.objects.get()
        self.assertEqual(row.device_count, 0)
        self.assertEqual(json.loads(row.content)['devices'], [])

    def test_create_accepts_rack_size_and_width(self):
        response = self.create(body=project(rack='24U', devices=[device(1, hole=60)]))
        self.assertEqual(response.status_code, 201, response.data)
        row = RackProject.objects.get()
        self.assertEqual(row.rack_kind, '24U')
        self.assertEqual(json.loads(row.content)['rackWidth'], 600)

    def test_create_rejects_invalid_geometry(self):
        cases = [
            (project(rack='48U'), '不支持的机柜规格'),
            (project(mode='free'), '卡位版式'),
            (project(devices=[device(1, w=4)]), '宽度'),
            (project(devices=[device(1, col=3)]), '横向格位'),
            (project(devices=[device(1, hU=1, hole=124)]), '顶边孔位'),
            (project(devices=[device(1, cat='spaceship')]), '类别'),
            (project(devices=[device(1, name='  ')]), '名称'),
            (project(devices=[device(1), device(1, name='重复')]), 'id 重复'),
            (project(devices=[device(1, hole=0), device(2, hole=0, name='压住')]), '重叠'),
            (project(custom=[{'id': 'c1', 'name': '自制', 'w': 5, 'hU': 1}]), '宽度'),
        ]
        for body, marker in cases:
            with self.subTest(marker=marker):
                response = self.create(body=body)
                self.assertEqual(response.status_code, 400, response.data)
                self.assertIn(marker, json.dumps(response.data, ensure_ascii=False))
        self.assertEqual(RackProject.objects.count(), 0)

    def test_create_rejects_duplicate_name(self):
        self.assertEqual(self.create().status_code, 201)
        second = self.create(name='a01 机柜')
        self.assertEqual(second.status_code, 400)
        self.assertIn('已存在', json.dumps(second.data, ensure_ascii=False))

    def test_content_endpoint_returns_raw_json(self):
        self.create()
        row = RackProject.objects.get()
        response = self.viewer_client.get(f'/api/datacenter/rack/projects/{row.pk}/content/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'application/json; charset=utf-8')
        self.assertEqual(json.loads(response.content), json.loads(row.content))
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_update_replaces_content_and_snapshots(self):
        self.create()
        row = RackProject.objects.get()
        original = row.content
        response = self.put(row, project(devices=[device(1, hole=0), device(2, hole=3)]))
        self.assertEqual(response.status_code, 200, response.data)
        row.refresh_from_db()
        self.assertEqual(row.device_count, 2)
        self.assertEqual(row.used_u, 2)
        self.assertEqual(row.version, 2)
        self.assertEqual(row.updated_by, 'rack-manager')
        self.assertEqual(row.snapshots.count(), 1)
        self.assertEqual(row.snapshots.get().content, original)
        self.assertEqual(EventRecord.objects.filter(action='update_rack_project').count(), 1)

    def test_update_with_unchanged_content_does_not_snapshot(self):
        self.create()
        row = RackProject.objects.get()
        response = self.put(row, project(), description='只改说明')
        self.assertEqual(response.status_code, 200, response.data)
        row.refresh_from_db()
        self.assertEqual(row.version, 2)
        self.assertEqual(row.description, '只改说明')
        self.assertEqual(row.snapshots.count(), 0)

    def test_update_rejects_stale_version(self):
        self.create()
        row = RackProject.objects.get()
        self.assertEqual(self.put(row, project(devices=[device(1, hole=3)])).status_code, 200)
        stale = self.put(row, project(devices=[device(1, hole=6)]))
        self.assertEqual(stale.status_code, 409, stale.data)
        self.assertEqual(stale.data['code'], 'version_conflict')
        self.assertEqual(stale.data['current_version'], 2)
        row.refresh_from_db()
        self.assertEqual(row.device_count, 1)

    def test_update_requires_base_version_and_manage_permission(self):
        self.create()
        row = RackProject.objects.get()
        missing = self.manager_client.put(
            f'/api/datacenter/rack/projects/{row.pk}/', {'project': project()}, format='json',
        )
        self.assertEqual(missing.status_code, 400)
        self.assertIn('base_version', json.dumps(missing.data, ensure_ascii=False))
        denied = self.put(row, project(), client=self.viewer_client)
        self.assertEqual(denied.status_code, 403)

    def test_update_missing_project_returns_404(self):
        response = self.manager_client.put(
            '/api/datacenter/rack/projects/999999/',
            {'base_version': 1, 'project': project()}, format='json',
        )
        self.assertEqual(response.status_code, 404)

    def test_rollback_missing_project_returns_404(self):
        response = self.manager_client.post(
            '/api/datacenter/rack/projects/999999/rollback/', {'version': 1}, format='json',
        )
        self.assertEqual(response.status_code, 404)

    def test_rollback_restores_content_as_new_version(self):
        self.create()
        row = RackProject.objects.get()
        original = json.loads(row.content)
        self.put(row, project(devices=[device(1, hole=3), device(2, hole=6)]))
        row.refresh_from_db()
        response = self.manager_client.post(
            f'/api/datacenter/rack/projects/{row.pk}/rollback/', {'version': 1}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        row.refresh_from_db()
        self.assertEqual(row.version, 3)
        self.assertEqual(json.loads(row.content), original)
        self.assertEqual(row.device_count, 1)
        self.assertEqual(
            sorted(row.snapshots.values_list('version', flat=True)), [1, 2],
        )

    def test_versions_endpoint_lists_snapshots(self):
        self.create()
        row = RackProject.objects.get()
        self.put(row, project(devices=[device(1, hole=6)]))
        listed = self.viewer_client.get(f'/api/datacenter/rack/projects/{row.pk}/versions/')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.data[0]['version'], 1)
        self.assertIn('used_u', listed.data[0])
        content = self.viewer_client.get(
            f'/api/datacenter/rack/projects/{row.pk}/versions/1/content/'
        )
        self.assertEqual(content.status_code, 200)
        self.assertEqual(json.loads(content.content), json.loads(row.snapshots.get().content))

    def test_patch_renames_without_bumping_version(self):
        self.create()
        row = RackProject.objects.get()
        content = row.content
        response = self.manager_client.patch(
            f'/api/datacenter/rack/projects/{row.pk}/',
            {'name': 'A01 机柜（二期）'}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        row.refresh_from_db()
        self.assertEqual(row.name, 'A01 机柜（二期）')
        self.assertEqual(row.version, 1)
        self.assertEqual(row.content, content)

    def test_delete_requires_manage_and_audits(self):
        self.create()
        row = RackProject.objects.get()
        denied = self.viewer_client.delete(f'/api/datacenter/rack/projects/{row.pk}/')
        self.assertEqual(denied.status_code, 403)
        removed = self.manager_client.delete(f'/api/datacenter/rack/projects/{row.pk}/')
        self.assertEqual(removed.status_code, 204)
        self.assertFalse(RackProject.objects.exists())
        self.assertEqual(EventRecord.objects.get(action='delete_rack_project').resource_name, 'A01 机柜')

    def test_list_supports_search_and_ordering(self):
        self.create(name='A01 机柜')
        self.create(name='B02 机柜', body=project(devices=[device(1, hole=0), device(2, hole=3)]))
        found = self.viewer_client.get('/api/datacenter/rack/projects/?search=B02')
        self.assertEqual([row['name'] for row in found.data['results']], ['B02 机柜'])
        ordered = self.viewer_client.get('/api/datacenter/rack/projects/?ordering=name')
        self.assertEqual([row['name'] for row in ordered.data['results']], ['A01 机柜', 'B02 机柜'])
        self.assertIn('used_u', ordered.data['results'][0])