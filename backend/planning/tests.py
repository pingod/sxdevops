"""规划模块接缝测试：配置发现、RBAC 反代、审计、状态、静态托管、进程监管。"""
import os
import signal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import requests
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from rest_framework.authtoken.models import Token
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from rbac.models import PermissionDefinition, Role
from rbac.services import ensure_builtin_rbac

from .config import EngineConfig, ensure_database, load_config
from .supervisor import EngineSupervisor

User = get_user_model()


def make_cfg(**overrides) -> EngineConfig:
    defaults = dict(
        enabled=True, root=Path('/tmp/planning'), engine_dir=Path('/tmp/planning/backend'),
        python='/usr/bin/python3', port=18001, db_path=Path('/tmp/planning/idcbox.db'),
        static_dir=None, error='',
    )
    defaults.update(overrides)
    return EngineConfig(**defaults)


def fake_upstream(status_code=200, body=b'{"ok": true}', content_type='application/json'):
    upstream = Mock()
    upstream.status_code = status_code
    upstream.headers = {'Content-Type': content_type}
    upstream.iter_content = lambda chunk_size: iter([body])
    return upstream


class ConfigTests(TestCase):
    def test_disabled_skips_discovery(self):
        with patch.dict(os.environ, {'PLANNING_ENABLED': 'false'}):
            cfg = load_config()
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.error, '')
        self.assertFalse(cfg.ready)

    def test_missing_engine_source_reports_error(self):
        with patch.dict(os.environ, {'PLANNING_ENABLED': 'true', 'PLANNING_ROOT': '/nonexistent-planning'}):
            cfg = load_config()
        self.assertTrue(cfg.enabled)
        self.assertIn('未找到规划引擎源码', cfg.error)

    def test_env_python_override(self):
        with patch.dict(os.environ, {'PLANNING_PYTHON': '/custom/python', 'PLANNING_PORT': '18099'}):
            cfg = load_config()
        self.assertEqual(cfg.python, '/custom/python')
        self.assertEqual(cfg.port, 18099)

    def test_remote_url_skips_local_discovery(self):
        with patch.dict(os.environ, {'PLANNING_ENGINE_URL': 'http://planning-engine:18001/',
                                     'PLANNING_ROOT': '/nonexistent-planning'}):
            cfg = load_config()
        self.assertEqual(cfg.error, '')
        self.assertEqual(cfg.base_url, 'http://planning-engine:18001')
        self.assertTrue(cfg.ready)
        self.assertIsNone(cfg.python)

    def test_bind_defaults_to_loopback_and_env_overrides(self):
        self.assertEqual(make_cfg().bind, '127.0.0.1')
        with patch.dict(os.environ, {'PLANNING_BIND': '0.0.0.0'}):
            cfg = load_config()
        self.assertEqual(cfg.bind, '0.0.0.0')

    def test_ensure_database_seeds_once(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'data').mkdir()
            (root / 'data' / 'idcbox.db').write_bytes(b'seed-v1')
            db_path = root / 'runtime' / 'idcbox.db'
            cfg = make_cfg(root=root, db_path=db_path)
            ensure_database(cfg)
            self.assertEqual(db_path.read_bytes(), b'seed-v1')
            db_path.write_bytes(b'user-edited')
            ensure_database(cfg)
            self.assertEqual(db_path.read_bytes(), b'user-edited')


class ProxyTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()
        cls.viewer = User.objects.create_user(username='planning-viewer')
        cls.editor = User.objects.create_user(username='planning-editor')
        cls.nobody = User.objects.create_user(username='planning-nobody')
        view_perm = PermissionDefinition.objects.get(code='datacenter.planning.view')
        manage_perm = PermissionDefinition.objects.get(code='datacenter.planning.manage')
        viewer_role = Role.objects.create(code='planning-viewer-role', name='规划查看')
        viewer_role.permissions.set([view_perm])
        viewer_role.users.add(cls.viewer)
        editor_role = Role.objects.create(code='planning-editor-role', name='规划编辑')
        editor_role.permissions.set([view_perm, manage_perm])
        editor_role.users.add(cls.editor)

    def setUp(self):
        self.cfg = make_cfg()
        patcher = patch('planning.views.load_config', return_value=self.cfg)
        patcher.start()
        self.addCleanup(patcher.stop)

    def client_for(self, user):
        client = APIClient()
        token, _ = Token.objects.get_or_create(user=user)
        client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')
        return client

    def test_anonymous_is_rejected(self):
        response = APIClient().get('/api/planning/api/meta')
        self.assertIn(response.status_code, (401, 403))

    def test_account_without_permission_is_rejected(self):
        with patch('planning.views.requests.request') as upstream:
            response = self.client_for(self.nobody).get('/api/planning/api/meta')
        self.assertEqual(response.status_code, 403)
        upstream.assert_not_called()

    def test_viewer_can_read_and_query_string_is_forwarded(self):
        with patch('planning.views.requests.request', return_value=fake_upstream()) as upstream:
            response = self.client_for(self.viewer).get('/api/planning/api/cables?limit=50&channel=2')
        self.assertEqual(response.status_code, 200)
        args, kwargs = upstream.call_args
        self.assertEqual(args[0], 'GET')
        self.assertEqual(args[1], 'http://127.0.0.1:18001/api/cables')
        # 查询串解析成键值对传给 requests，避免把原始串当不透明参数导致重复编码。
        self.assertEqual(kwargs['params'], [('limit', '50'), ('channel', '2')])
        self.assertNotIn('Authorization', kwargs['headers'])

    def test_viewer_cannot_write(self):
        with patch('planning.views.requests.request') as upstream:
            response = self.client_for(self.viewer).put(
                '/api/planning/api/projects/演示/intent', {'doc': {}}, format='json')
        self.assertEqual(response.status_code, 403)
        upstream.assert_not_called()

    def test_editor_save_intent_is_audited(self):
        with patch('planning.views.requests.request', return_value=fake_upstream()):
            response = self.client_for(self.editor).put(
                '/api/planning/api/projects/演示/intent', {'doc': {'racks': []}}, format='json')
        self.assertEqual(response.status_code, 200)
        event = EventRecord.objects.get(action='save_intent')
        self.assertEqual(event.module, 'planning')
        self.assertEqual(event.resource_name, '演示')
        self.assertEqual(event.result, EventRecord.RESULT_SUCCESS)

    def test_failed_persisting_write_is_audited_as_failed(self):
        with patch('planning.views.requests.request', return_value=fake_upstream(status_code=422, body=b'{"detail":"bad"}')):
            response = self.client_for(self.editor).post('/api/planning/api/projects', {'name': ''}, format='json')
        self.assertEqual(response.status_code, 422)
        event = EventRecord.objects.get(action='create_project')
        self.assertEqual(event.result, EventRecord.RESULT_FAILED)

    def test_compute_post_is_not_audited(self):
        with patch('planning.views.requests.request', return_value=fake_upstream()):
            response = self.client_for(self.editor).post(
                '/api/planning/api/intent/check', {'doc': {}}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(EventRecord.objects.filter(module='planning').exists())

    def test_non_api_path_is_not_proxied(self):
        with patch('planning.views.requests.request') as upstream:
            response = self.client_for(self.editor).get('/api/planning/web/index.html')
        self.assertEqual(response.status_code, 404)
        upstream.assert_not_called()

    def test_engine_down_returns_503(self):
        with patch('planning.views.requests.request', side_effect=requests.ConnectionError('refused')):
            response = self.client_for(self.viewer).get('/api/planning/api/meta')
        self.assertEqual(response.status_code, 503)
        self.assertIn('规划引擎不可用', response.data['detail'])

    def test_disabled_module_returns_503(self):
        with patch('planning.views.load_config', return_value=make_cfg(enabled=False)):
            response = self.client_for(self.editor).get('/api/planning/api/meta')
        self.assertEqual(response.status_code, 503)

    def test_download_headers_are_preserved(self):
        upstream = fake_upstream(body=b'a\tb', content_type='text/plain; charset=utf-8')
        upstream.headers['Content-Disposition'] = "attachment; filename*=UTF-8''labels.txt"
        with patch('planning.views.requests.request', return_value=upstream):
            response = self.client_for(self.viewer).get('/api/planning/api/labels?format=text')
        self.assertEqual(response.status_code, 200)
        self.assertIn('labels.txt', response['Content-Disposition'])


class StatusTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()
        cls.viewer = User.objects.create_user(username='status-viewer')
        role = Role.objects.create(code='status-viewer-role', name='状态查看')
        role.permissions.set(PermissionDefinition.objects.filter(code='datacenter.planning.view'))
        role.users.add(cls.viewer)

    def test_status_requires_permission(self):
        client = APIClient()
        user = User.objects.create_user(username='status-nobody')
        token, _ = Token.objects.get_or_create(user=user)
        client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')
        self.assertEqual(client.get('/api/planning-status').status_code, 403)

    def test_status_reports_up_when_health_ok(self):
        client = APIClient()
        token, _ = Token.objects.get_or_create(user=self.viewer)
        client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')
        with patch('planning.views.load_config', return_value=make_cfg()), \
                patch('planning.views.probe_health', return_value=(True, '')):
            response = client.get('/api/planning-status')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['state'], 'up')
        self.assertTrue(response.data['engine_reachable'])

    def test_status_reports_down_with_reason(self):
        client = APIClient()
        token, _ = Token.objects.get_or_create(user=self.viewer)
        client.credentials(HTTP_AUTHORIZATION=f'Token {token.key}')
        with patch('planning.views.load_config', return_value=make_cfg()), \
                patch('planning.views.probe_health', return_value=(False, '连接被拒绝')):
            response = client.get('/api/planning-status')
        self.assertEqual(response.data['state'], 'down')
        self.assertIn('连接被拒绝', response.data['error'])


class StaticTests(TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dist = Path(self.tmp.name)
        (self.dist / 'assets').mkdir()
        (self.dist / 'index.html').write_text('<html>planning</html>', encoding='utf-8')
        (self.dist / 'assets' / 'app.js').write_text('console.log(1)', encoding='utf-8')
        patcher = patch('planning.views.load_config', return_value=make_cfg(static_dir=self.dist))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.factory = RequestFactory()

    def test_index_is_frameable_same_origin_only(self):
        from .views import planning_app
        response = planning_app(self.factory.get('/planning-app/'), path='')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Security-Policy'], "frame-ancestors 'self'")

    def test_assets_get_immutable_cache(self):
        from .views import planning_app
        response = planning_app(self.factory.get('/planning-app/assets/app.js'), path='assets/app.js')
        self.assertEqual(response.status_code, 200)
        self.assertIn('immutable', response['Cache-Control'])

    def test_path_traversal_is_rejected(self):
        from django.http import Http404
        from .views import planning_app
        with self.assertRaises(Http404):
            planning_app(self.factory.get('/planning-app/x'), path='../secret.txt')

    def test_missing_asset_with_extension_is_404(self):
        from django.http import Http404
        from .views import planning_app
        with self.assertRaises(Http404):
            planning_app(self.factory.get('/planning-app/assets/missing.js'), path='assets/missing.js')

    def test_spa_route_falls_back_to_index(self):
        from .views import planning_app
        response = planning_app(self.factory.get('/planning-app/cables'), path='cables')
        self.assertEqual(response.status_code, 200)

    def test_unbuilt_dist_returns_503_with_instructions(self):
        from .views import planning_app
        with patch('planning.views.load_config', return_value=make_cfg(static_dir=self.dist / 'missing')):
            response = planning_app(self.factory.get('/planning-app/'), path='')
        self.assertEqual(response.status_code, 503)
        self.assertIn('pnpm build', response.content.decode('utf-8'))


class SupervisorTests(TestCase):
    def test_engine_env_strips_polluted_python_paths(self):
        supervisor = EngineSupervisor(make_cfg())
        with patch.dict(os.environ, {'PYTHONHOME': '/bad', 'PYTHONPATH': '/bad', 'IDCBOX_DB': '/old'}):
            env = supervisor._engine_env()
        self.assertNotIn('PYTHONHOME', env)
        self.assertNotIn('PYTHONPATH', env)
        self.assertEqual(env['IDCBOX_DB'], '/tmp/planning/idcbox.db')

    def test_restart_backoff_doubles_and_caps(self):
        supervisor = EngineSupervisor(make_cfg())
        supervisor._stop = Mock()
        supervisor._stop.is_set.side_effect = [False] * 8 + [True]
        with patch.object(supervisor, '_run_once', return_value='崩溃'), \
                patch('planning.supervisor.ensure_database'):
            supervisor.run()
        waits = [call.args[0] for call in supervisor._stop.wait.call_args_list]
        self.assertEqual(waits, [1, 2, 4, 8])
        self.assertEqual(supervisor.state, 'stopped')

    def test_stop_sends_sigint_then_kills_on_timeout(self):
        import subprocess
        supervisor = EngineSupervisor(make_cfg())
        proc = Mock()
        proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired(cmd='uvicorn', timeout=5), None]
        supervisor._proc = proc
        supervisor.stop()
        proc.send_signal.assert_called_once_with(signal.SIGINT)
        proc.kill.assert_called_once()

    def test_wait_ready_fails_fast_when_process_dies(self):
        supervisor = EngineSupervisor(make_cfg())
        proc = Mock()
        proc.poll.return_value = 1
        proc.returncode = 1
        err = supervisor._wait_ready(proc)
        self.assertIn('提前退出', err)

    def test_health_watch_kills_after_consecutive_failures(self):
        supervisor = EngineSupervisor(make_cfg())
        supervisor._stop = Mock()
        supervisor._stop.is_set.return_value = False
        proc = Mock()
        proc.poll.return_value = None
        with patch('planning.supervisor.probe_health', return_value=(False, '假死')), \
                patch('planning.supervisor.HEALTH_INTERVAL', 0):
            supervisor._health_watch(proc)
        proc.kill.assert_called_once()

    def test_run_once_binds_configured_address(self):
        supervisor = EngineSupervisor(make_cfg(bind='0.0.0.0'))
        proc = Mock()
        proc.wait.return_value = 0
        proc.stdout = iter([])
        with patch('planning.supervisor.subprocess.Popen', return_value=proc) as popen, \
                patch.object(supervisor, '_wait_ready', return_value=''), \
                patch.object(supervisor, '_health_watch'):
            err = supervisor._run_once()
        self.assertEqual(err, '')
        cmd = popen.call_args.args[0]
        self.assertEqual(cmd[cmd.index('--host') + 1], '0.0.0.0')

    def test_command_refuses_to_supervise_remote_engine(self):
        from django.core.management import call_command
        with patch('planning.management.commands.planning_engine.load_config',
                   return_value=make_cfg(remote_url='http://planning-engine:18001')):
            with self.assertRaises(SystemExit):
                call_command('planning_engine')