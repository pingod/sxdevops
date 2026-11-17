"""三维机房项目库：上传校验、权限边界、文件下发与查看器托管。"""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from network.models import NetworkDevice, NetworkInterface, SnmpCredential
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


    def test_update_replaces_content_and_audits(self):
        self.upload()
        project = TwinProject.objects.get()
        payload = room_project(name='机房-A', cabinets=3)
        payload['meta']['roomHeight'] = 3200
        response = self.manager_client.put(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'project': payload, 'description': '一期改版', 'base_version': 1},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        project.refresh_from_db()
        self.assertEqual(project.object_count, 4)
        self.assertEqual(project.description, '一期改版')
        self.assertEqual(project.version, 2)
        self.assertEqual(project.updated_by, 'twin-manager')
        self.assertEqual(json.loads(project.content)['meta']['roomHeight'], 3200)
        self.assertEqual(EventRecord.objects.filter(action='update_twin_project').count(), 1)
        self.assertIn('v2', EventRecord.objects.get(action='update_twin_project').summary)

    def test_update_requires_manage_permission(self):
        self.upload()
        project = TwinProject.objects.get()
        response = self.viewer_client.put(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'project': room_project(name='机房-A', cabinets=3), 'base_version': 1},
            format='json',
        )
        self.assertEqual(response.status_code, 403)
        project.refresh_from_db()
        self.assertEqual(project.object_count, 3)

    def test_update_rejects_invalid_project_and_name_collision(self):
        self.upload()
        other = TwinProject.objects.create(
            name='机房-B', content='{"objects":[]}', object_count=0, size_bytes=2, checksum='x',
        )
        project = TwinProject.objects.get(name='机房-A')
        bad = self.manager_client.put(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'project': {'objects': [{'id': 'w', 'type': 'wall'}]}, 'base_version': 1},
            format='json',
        )
        self.assertEqual(bad.status_code, 400)
        clash = self.manager_client.put(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'name': '机房-B', 'project': room_project(name='机房-A', cabinets=4), 'base_version': 1},
            format='json',
        )
        self.assertEqual(clash.status_code, 400)
        self.assertIn('已存在', json.dumps(clash.data, ensure_ascii=False))
        self.assertEqual(TwinProject.objects.get(pk=other.pk).name, '机房-B')

    def put_project(self, project, payload, client=None, base_version=1, **extra):
        body = {'project': payload, 'base_version': base_version, **extra}
        return (client or self.manager_client).put(
            f'/api/datacenter/twin/projects/{project.pk}/', body, format='json',
        )

    def test_update_rejects_stale_base_version(self):
        self.upload()
        project = TwinProject.objects.get()
        first = self.put_project(project, room_project(cabinets=3))
        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(first.data['version'], 2)
        stale = self.put_project(project, room_project(cabinets=4))
        self.assertEqual(stale.status_code, 409, stale.data)
        self.assertEqual(stale.data['code'], 'version_conflict')
        self.assertEqual(stale.data['current_version'], 2)
        self.assertEqual(stale.data['updated_by'], 'twin-manager')
        project.refresh_from_db()
        self.assertEqual(project.object_count, 4)

    def test_update_requires_base_version(self):
        self.upload()
        project = TwinProject.objects.get()
        response = self.manager_client.put(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'project': room_project(cabinets=3)}, format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('base_version', json.dumps(response.data, ensure_ascii=False))
        project.refresh_from_db()
        self.assertEqual(project.version, 1)

    def test_update_writes_snapshot_of_previous_content(self):
        self.upload()
        project = TwinProject.objects.get()
        original = project.content
        self.put_project(project, room_project(cabinets=3))
        project.refresh_from_db()
        self.assertEqual(project.snapshots.count(), 1)
        snapshot = project.snapshots.get()
        self.assertEqual(snapshot.version, 1)
        self.assertEqual(snapshot.content, original)
        self.assertEqual(snapshot.created_by, 'twin-manager')
        listed = self.viewer_client.get(f'/api/datacenter/twin/projects/{project.pk}/versions/')
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([row['version'] for row in listed.data], [1])
        content = self.viewer_client.get(
            f'/api/datacenter/twin/projects/{project.pk}/versions/1/content/'
        )
        self.assertEqual(content.status_code, 200)
        self.assertEqual(json.loads(content.content), json.loads(original))
        self.assertNotEqual(json.loads(original), json.loads(project.content))

    def test_unchanged_content_does_not_snapshot(self):
        self.upload()
        project = TwinProject.objects.get()
        self.put_project(project, room_project(), description='仅改说明')
        project.refresh_from_db()
        self.assertEqual(project.version, 2)
        self.assertEqual(project.snapshots.count(), 0)

    def test_snapshots_pruned_to_thirty(self):
        self.upload()
        project = TwinProject.objects.get()
        for index in range(31):
            response = self.put_project(project, room_project(cabinets=3 + index), base_version=index + 1)
            self.assertEqual(response.status_code, 200, response.data)
        project.refresh_from_db()
        self.assertEqual(project.version, 32)
        self.assertEqual(project.snapshots.count(), 30)
        versions = list(project.snapshots.order_by('-version').values_list('version', flat=True))
        self.assertEqual(versions[0], 31)
        self.assertEqual(versions[-1], 2)

    def test_rollback_restores_content_as_new_version(self):
        self.upload()
        project = TwinProject.objects.get()
        original = json.loads(project.content)
        self.put_project(project, room_project(cabinets=3))
        project.refresh_from_db()
        self.assertEqual(project.object_count, 4)
        response = self.manager_client.post(
            f'/api/datacenter/twin/projects/{project.pk}/rollback/', {'version': 1}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        project.refresh_from_db()
        self.assertEqual(project.version, 3)
        self.assertEqual(json.loads(project.content), original)
        self.assertEqual(project.object_count, 3)
        # 回滚前的内容也留快照，回滚本身可再回滚。
        self.assertEqual(
            sorted(project.snapshots.values_list('version', flat=True)), [1, 2],
        )
        self.assertEqual(EventRecord.objects.filter(action='rollback_twin_project').count(), 1)

    def test_rollback_rejects_unknown_version(self):
        self.upload()
        project = TwinProject.objects.get()
        response = self.manager_client.post(
            f'/api/datacenter/twin/projects/{project.pk}/rollback/', {'version': 7}, format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('不存在', json.dumps(response.data, ensure_ascii=False))

    def test_patch_renames_without_bumping_version(self):
        self.upload()
        project = TwinProject.objects.get()
        content = project.content
        response = self.manager_client.patch(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'name': '机房-A 二期', 'description': '改名不改内容'}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        project.refresh_from_db()
        self.assertEqual(project.name, '机房-A 二期')
        self.assertEqual(project.description, '改名不改内容')
        self.assertEqual(project.version, 1)
        self.assertEqual(project.content, content)
        self.assertEqual(project.snapshots.count(), 0)
        self.assertEqual(EventRecord.objects.filter(action='rename_twin_project').count(), 1)

    def test_patch_rejects_duplicate_and_blank_name(self):
        self.upload()
        TwinProject.objects.create(
            name='机房-B', content='{"objects":[]}', object_count=0, size_bytes=2, checksum='x',
        )
        project = TwinProject.objects.get(name='机房-A')
        clash = self.manager_client.patch(
            f'/api/datacenter/twin/projects/{project.pk}/', {'name': '机房-B'}, format='json',
        )
        self.assertEqual(clash.status_code, 400)
        self.assertIn('已存在', json.dumps(clash.data, ensure_ascii=False))
        blank = self.manager_client.patch(
            f'/api/datacenter/twin/projects/{project.pk}/', {'name': '   '}, format='json',
        )
        self.assertEqual(blank.status_code, 400)
        self.assertEqual(TwinProject.objects.get(pk=project.pk).name, '机房-A')

    def test_update_rejects_unsupported_type_and_bad_numbers(self):
        self.upload()
        project = TwinProject.objects.get()
        cases = [
            ({'objects': [{'id': 'c', 'type': 'cabinet', 'x': 0, 'y': 0},
                          {'id': 'x', 'type': 'spaceship'}]}, '不受支持'),
            ({'objects': [{'id': 'c', 'type': 'cabinet', 'x': 10 ** 7, 'y': 0}]}, '不能大于'),
            ({'objects': [{'id': 'c', 'type': 'cabinet', 'x': 'left', 'y': 0}]}, '必须是数字'),
            ({'objects': [{'id': 'c', 'type': 'cabinet', 'x': 0, 'y': 0, 'props': {'w': 0}}]}, '不能小于'),
        ]
        for payload, marker in cases:
            with self.subTest(marker=marker):
                response = self.put_project(project, payload)
                self.assertEqual(response.status_code, 400, response.data)
                self.assertIn(marker, json.dumps(response.data, ensure_ascii=False))

    def test_update_rejects_bad_openings(self):
        self.upload()
        project = TwinProject.objects.get()
        wall = {'id': 'wall-1', 'type': 'wall', 'x1': 0, 'y1': 0, 'x2': 1000, 'y2': 0, 'props': {'height': 3000}}
        cab = {'id': 'cab-0', 'type': 'cabinet', 'x': 100, 'y': 100, 'props': {'w': 600, 'd': 1200, 'h': 2000}}
        cases = [
            ([wall, cab, {'id': 'd1', 'type': 'door', 'wallId': 'nope', 't': 0.5, 'props': {'width': 900}}], '所属墙'),
            ([wall, cab, {'id': 'd1', 'type': 'door', 'wallId': 'wall-1', 't': 0.05, 'props': {'width': 900}}], '沿墙位置'),
            ([wall, cab, {'id': 'd1', 'type': 'window', 'wallId': 'wall-1', 't': 0.5, 'props': {'width': 4000}}], '超过所属墙长度'),
            ([wall, cab, {'id': 'b1', 'type': 'beam', 'col1': 'col-x', 'x1': 0, 'y1': 0, 'x2': 1000, 'y2': 0}], '立柱'),
        ]
        for objects, marker in cases:
            with self.subTest(marker=marker):
                response = self.put_project(project, {'name': '机房-A', 'objects': objects})
                self.assertEqual(response.status_code, 400, response.data)
                self.assertIn(marker, json.dumps(response.data, ensure_ascii=False))

    def test_update_rejects_oversized_projects(self):
        self.upload()
        project = TwinProject.objects.get()
        payload = room_project()
        payload['objects'].extend([
            {'id': f'extra-{i}', 'type': 'vent', 'x': i, 'y': 0, 'props': {'w': 600, 'd': 600}}
            for i in range(4)
        ])
        with patch('datacenter.serializers.MAX_OBJECTS', 3):
            response = self.put_project(project, payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn('上限', json.dumps(response.data, ensure_ascii=False))

    def test_list_supports_search_and_ordering(self):
        self.upload()
        self.manager_client.post(
            '/api/datacenter/twin/projects/',
            {'file': json_upload(room_project(name='机房-B', cabinets=3))},
            format='multipart',
        )
        found = self.viewer_client.get('/api/datacenter/twin/projects/?search=机房-B')
        self.assertEqual(found.status_code, 200)
        self.assertEqual([row['name'] for row in found.data['results']], ['机房-B'])
        ordered = self.viewer_client.get('/api/datacenter/twin/projects/?ordering=name')
        self.assertEqual(ordered.status_code, 200)
        self.assertEqual([row['name'] for row in ordered.data['results']], ['机房-A', '机房-B'])
        self.assertIn('version', ordered.data['results'][0])
        self.assertIn('updated_by', ordered.data['results'][0])


@override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=Fernet.generate_key().decode('utf-8'))
class TwinLiveStatusTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()

    def setUp(self):
        self.user = User.objects.create_user(username='twin-live-viewer')
        self.grant(self.user, 'datacenter.twin.view')
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        credential = SnmpCredential(name='live-cred', version='v2c')
        credential.community = 'public'
        credential.save()
        self.online = NetworkDevice.objects.create(
            name='live-sw-online', mgmt_ip='10.9.0.1', credential=credential, status='online',
        )
        self.offline = NetworkDevice.objects.create(
            name='live-sw-offline', mgmt_ip='10.9.0.2', credential=credential, status='offline',
        )
        NetworkInterface.objects.create(device=self.online, if_index=1, name='Gi0/1', in_util=85, out_util=0)
        NetworkInterface.objects.create(device=self.offline, if_index=1, name='Gi0/1', in_util=99, out_util=99)
        NetworkInterface.objects.create(device=self.online, if_index=2, name='Gi0/2', in_util=10, out_util=20)
        self.project = TwinProject.objects.create(
            name='机房-Live', content=json.dumps(self.project_payload(), ensure_ascii=False),
            object_count=4, size_bytes=1, checksum='live', version=1,
        )

    def grant(self, user, *codes):
        code = f'twin-{user.username}-{Role.objects.count()}'
        role = Role.objects.create(code=code, name=code)
        role.permissions.set(PermissionDefinition.objects.filter(code__in=codes))
        role.users.add(user)

    def project_payload(self):
        return {
            'name': '机房-Live',
            'meta': {'roomHeight': 3000, 'floorHeight': 400},
            'objects': [
                {'id': 'wall-1', 'type': 'wall', 'x1': 0, 'y1': 0, 'x2': 6000, 'y2': 0,
                 'props': {'height': 3000}},
                {'id': 'cab-online', 'type': 'cabinet', 'x': 1000, 'y': 1000,
                 'props': {'w': 600, 'd': 1200, 'h': 2000, 'monitor': {'deviceIds': [self.online.pk]}}},
                {'id': 'cab-offline', 'type': 'cabinet', 'x': 2000, 'y': 1000,
                 'props': {'w': 600, 'd': 1200, 'h': 2000,
                           'monitor': {'deviceIds': [self.offline.pk, self.online.pk]}}},
                {'id': 'cab-unbound', 'type': 'cabinet', 'x': 3000, 'y': 1000,
                 'props': {'w': 600, 'd': 1200, 'h': 2000}},
            ],
        }

    def live(self):
        response = self.client.get(f'/api/datacenter/twin/projects/{self.project.pk}/live/')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def test_live_reports_cabinet_states(self):
        data = self.live()
        self.assertEqual(data['thresholds'], {'warning': 80, 'critical': 95})
        self.assertEqual(data['cabinets']['cab-online']['status'], 'warning')
        self.assertEqual(data['cabinets']['cab-online']['util'], 85)
        # 任一绑定设备离线即离线，哪怕另一台利用率很高。
        self.assertEqual(data['cabinets']['cab-offline']['status'], 'offline')
        self.assertNotIn('cab-unbound', data['cabinets'])
        names = {device['name'] for device in data['devices']}
        self.assertEqual(names, {'live-sw-online', 'live-sw-offline'})

    def test_live_marks_never_polled_device_unknown(self):
        self.online.status = 'unknown'
        self.online.save(update_fields=['status'])
        for item in NetworkInterface.objects.filter(device=self.online):
            item.in_util = 0
            item.out_util = 0
            item.save(update_fields=['in_util', 'out_util'])
        data = self.live()
        self.assertEqual(data['cabinets']['cab-online']['status'], 'unknown')

    def test_live_is_empty_without_bindings(self):
        self.project.content = json.dumps({
            'name': '机房-Live',
            'objects': [{'id': 'cab-1', 'type': 'cabinet', 'x': 0, 'y': 0, 'props': {'w': 600, 'd': 1200, 'h': 2000}}],
        }, ensure_ascii=False)
        self.project.save()
        data = self.live()
        self.assertEqual(data['cabinets'], {})
        self.assertEqual(data['devices'], [])

    def test_live_requires_view_permission(self):
        outsider = User.objects.create_user(username='twin-outsider')
        client = APIClient()
        client.force_authenticate(outsider)
        response = client.get(f'/api/datacenter/twin/projects/{self.project.pk}/live/')
        self.assertEqual(response.status_code, 403)

    def test_monitor_targets_expose_only_safe_fields(self):
        response = self.client.get('/api/datacenter/twin/monitor-targets/')
        self.assertEqual(response.status_code, 200)
        item = response.data['items'][0]
        self.assertEqual(set(item), {'id', 'name', 'location', 'status'})
        self.assertNotIn('10.9.0.1', json.dumps(response.data))

    def test_upload_rejects_unknown_monitor_binding(self):
        payload = self.project_payload()
        payload['objects'][1]['props']['monitor'] = {'deviceIds': [999999]}
        project = TwinProject.objects.create(
            name='机房-坏绑定', content='{"objects":[]}', object_count=0, size_bytes=2, checksum='bad',
        )
        manager = User.objects.create_user(username='twin-live-manager')
        self.grant(manager, 'datacenter.twin.view', 'datacenter.twin.manage')
        client = APIClient()
        client.force_authenticate(manager)
        response = client.put(
            f'/api/datacenter/twin/projects/{project.pk}/',
            {'project': payload, 'base_version': 1}, format='json',
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('监控绑定', json.dumps(response.data, ensure_ascii=False))


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
