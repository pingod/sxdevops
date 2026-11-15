"""网络监控测试：凭据加密、速率算法、采集持久化、RBAC API、审计与保留清理。"""
import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock, patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from eventwall.models import EventRecord
from ops.models import Alert
from rbac.models import Role
from rbac.services import ensure_builtin_rbac

from . import oids
from .alerting import evaluate_device_alerts, evaluate_interface_alerts
from .collector import (
    collect_device_interfaces,
    collect_device_system,
    compute_counter_delta,
    compute_counter_rate,
    detect_vendor,
)
from .crypto import NetworkSecretDecryptionError, decrypt_secret, encrypt_secret
from .models import DeviceMetricSample, InterfaceMetricSample, NetworkAlertRule, NetworkAlertState, NetworkDevice, NetworkInterface, SnmpCredential
from .poller import prune_expired_samples, select_due_devices
from .snmp import SnmpError

User = get_user_model()
TEST_KEY = Fernet.generate_key().decode('utf-8')


def make_credential(name='public-cred', version='v2c', community='public'):
    credential = SnmpCredential(name=name, version=version)
    if version == 'v2c':
        credential.community = community
    else:
        credential.v3_username = 'monitor'
        credential.v3_auth_protocol = 'sha256'
        credential.v3_auth_key = 'auth-secret-123'
        credential.v3_priv_protocol = 'aes128'
        credential.v3_priv_key = 'priv-secret-123'
    credential.save()
    return credential


def make_device(name='core-sw-01', ip='10.0.0.1', credential=None, **kwargs):
    return NetworkDevice.objects.create(
        name=name, mgmt_ip=ip, credential=credential or make_credential(name=f'cred-{name}'), **kwargs,
    )


@override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=TEST_KEY)
class CryptoTests(TestCase):
    def test_secret_roundtrip(self):
        ciphertext = encrypt_secret('public')
        self.assertNotEqual(ciphertext, 'public')
        self.assertEqual(decrypt_secret(ciphertext), 'public')

    def test_decrypt_with_wrong_key_raises(self):
        ciphertext = encrypt_secret('public')
        with override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=Fernet.generate_key().decode('utf-8')):
            with self.assertRaises(NetworkSecretDecryptionError):
                decrypt_secret(ciphertext)

    def test_missing_key_raises_improperly_configured(self):
        with override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=''):
            with self.assertRaises(ImproperlyConfigured):
                encrypt_secret('public')

    def test_credential_properties_encrypt_at_rest(self):
        credential = make_credential(version='v3')
        credential.refresh_from_db()
        self.assertNotIn('auth-secret-123', credential.v3_auth_key_encrypted)
        self.assertEqual(credential.v3_auth_key, 'auth-secret-123')
        self.assertEqual(credential.v3_priv_key, 'priv-secret-123')


class RateComputationTests(SimpleTestCase):
    def test_normal_delta(self):
        self.assertEqual(compute_counter_rate(1000, 13000, 60), 1600.0)

    def test_short_interval_returns_none(self):
        self.assertIsNone(compute_counter_rate(1000, 13000, 10))

    def test_missing_snapshot_returns_none(self):
        self.assertIsNone(compute_counter_rate(None, 13000, 60))

    def test_counter32_wrap_compensated(self):
        prev = 2 ** 32 - 1000
        curr = 1000
        rate = compute_counter_rate(prev, curr, 60, counter_bits=32, speed_bps=1_000_000_000)
        self.assertEqual(rate, 2000 * 8 / 60)

    def test_counter64_wrap_compensated(self):
        prev = 2 ** 64 - 8000
        curr = 2000
        rate = compute_counter_rate(prev, curr, 60, counter_bits=64, speed_bps=10_000_000_000)
        self.assertEqual(rate, 10000 * 8 / 60)

    def test_counter_reset_returns_none(self):
        # 重置后补偿速率 286Mbps 远超 10Mbps 物理口上限 → 识别为重置
        self.assertIsNone(compute_counter_rate(2 ** 31, 100, 60, counter_bits=32, speed_bps=10_000_000))

    def test_rate_above_physical_cap_returns_none(self):
        self.assertIsNone(compute_counter_rate(0, 10 ** 12, 60, speed_bps=1_000_000_000))

    def test_counter_delta_wrap(self):
        self.assertEqual(compute_counter_delta(2 ** 32 - 10, 5, 32), 15)

    def test_counter_delta_reset_returns_none(self):
        self.assertIsNone(compute_counter_delta(2 ** 31, 5, 32))

    def test_vendor_detection(self):
        self.assertEqual(detect_vendor('Huawei Versatile Routing Platform Software VRP'), 'huawei')
        self.assertEqual(detect_vendor('H3C Comware Platform Software'), 'h3c')
        self.assertEqual(detect_vendor('Cisco IOS Software, C2960'), 'cisco')
        self.assertEqual(detect_vendor('Linux server 6.1'), '')


def walk_rows(base_oid, values_by_index):
    return [(f'{base_oid}.{index}', value) for index, value in values_by_index.items()]


def fake_if_walks(in_octets=1000, out_octets=2000, oper_status=1, hc=True):
    """构造一台 2 接口设备的 WALK 结果。"""
    x_table = {
        oids.IF_X_TABLE_OIDS['if_name']: walk_rows(oids.IF_X_TABLE_OIDS['if_name'], {1: 'GE0/0/1', 2: 'GE0/0/2'}),
        oids.IF_X_TABLE_OIDS['if_alias']: walk_rows(oids.IF_X_TABLE_OIDS['if_alias'], {1: 'uplink', 2: ''}),
        oids.IF_X_TABLE_OIDS['if_high_speed']: walk_rows(oids.IF_X_TABLE_OIDS['if_high_speed'], {1: 1000, 2: 1000}),
        oids.IF_X_TABLE_OIDS['if_hc_in_octets']: walk_rows(oids.IF_X_TABLE_OIDS['if_hc_in_octets'], {1: in_octets, 2: 0}) if hc else [],
        oids.IF_X_TABLE_OIDS['if_hc_out_octets']: walk_rows(oids.IF_X_TABLE_OIDS['if_hc_out_octets'], {1: out_octets, 2: 0}) if hc else [],
    }
    if_table = {
        oids.IF_TABLE_OIDS['if_descr']: walk_rows(oids.IF_TABLE_OIDS['if_descr'], {1: 'GigabitEthernet0/0/1', 2: 'GigabitEthernet0/0/2'}),
        oids.IF_TABLE_OIDS['if_type']: walk_rows(oids.IF_TABLE_OIDS['if_type'], {1: 6, 2: 6}),
        oids.IF_TABLE_OIDS['if_mtu']: walk_rows(oids.IF_TABLE_OIDS['if_mtu'], {1: 1500, 2: 1500}),
        oids.IF_TABLE_OIDS['if_speed']: walk_rows(oids.IF_TABLE_OIDS['if_speed'], {1: 1_000_000_000, 2: 1_000_000_000}),
        oids.IF_TABLE_OIDS['if_phys_address']: walk_rows(oids.IF_TABLE_OIDS['if_phys_address'], {1: b'\x00\x11\x22\x33\x44\x55', 2: b''}),
        oids.IF_TABLE_OIDS['if_admin_status']: walk_rows(oids.IF_TABLE_OIDS['if_admin_status'], {1: 1, 2: 1}),
        oids.IF_TABLE_OIDS['if_oper_status']: walk_rows(oids.IF_TABLE_OIDS['if_oper_status'], {1: oper_status, 2: 1}),
        oids.IF_TABLE_OIDS['if_in_octets']: walk_rows(oids.IF_TABLE_OIDS['if_in_octets'], {1: in_octets, 2: 0}),
        oids.IF_TABLE_OIDS['if_in_errors']: walk_rows(oids.IF_TABLE_OIDS['if_in_errors'], {1: 0, 2: 0}),
        oids.IF_TABLE_OIDS['if_out_octets']: walk_rows(oids.IF_TABLE_OIDS['if_out_octets'], {1: out_octets, 2: 0}),
        oids.IF_TABLE_OIDS['if_out_errors']: walk_rows(oids.IF_TABLE_OIDS['if_out_errors'], {1: 0, 2: 0}),
    }

    async def _walk(target, base_oid, engine=None):
        if base_oid in x_table:
            return x_table[base_oid]
        return if_table.get(base_oid, [])

    return _walk


@override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=TEST_KEY)
class CollectorTests(TransactionTestCase):
    def setUp(self):
        self.device = make_device(vendor='huawei')

    def test_system_collect_marks_online_and_writes_sample(self):
        sys_values = {
            oids.SYSTEM_OIDS['sys_descr']: 'Huawei VRP V8',
            oids.SYSTEM_OIDS['sys_name']: 'core-sw-01',
            oids.SYSTEM_OIDS['sys_uptime']: 360000,
            oids.SYSTEM_OIDS['sys_contact']: '',
            oids.SYSTEM_OIDS['sys_location']: '',
        }
        health_values = {
            '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5.1': 23,
            '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7.1': 41,
            '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.11.1': 38,
        }

        async def _walk(target, base_oid, engine=None):
            return [(oid, value) for oid, value in health_values.items() if oid.startswith(base_oid + '.')]

        with patch('network.collector.snmp_get', new=AsyncMock(return_value=sys_values)), \
                patch('network.collector.snmp_walk', new=AsyncMock(side_effect=_walk)):
            status = asyncio.run(collect_device_system(self.device))
        self.assertEqual(status, 'online')
        self.device.refresh_from_db()
        self.assertEqual(self.device.sys_name, 'core-sw-01')
        self.assertEqual(self.device.sys_uptime_seconds, 3600)
        sample = DeviceMetricSample.objects.get(device=self.device)
        self.assertEqual(sample.cpu_pct, 23)
        self.assertEqual(sample.mem_pct, 41)
        self.assertEqual(sample.temperature, 38)

    def test_system_collect_failure_marks_offline_and_records_event(self):
        self.device.status = NetworkDevice.STATUS_ONLINE
        self.device.save()
        with patch('network.collector.snmp_get', new=AsyncMock(side_effect=SnmpError('timeout'))):
            status = asyncio.run(collect_device_system(self.device))
        self.assertEqual(status, 'offline')
        self.device.refresh_from_db()
        self.assertIn('timeout', self.device.last_error)
        event = EventRecord.objects.get(module='network', action='device_offline')
        self.assertEqual(event.resource_name, self.device.name)
        self.assertEqual(event.severity, 'warning')

    def test_interface_collect_two_rounds_computes_rate(self):
        walk_v1 = fake_if_walks(in_octets=1000, out_octets=2000)
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=walk_v1)), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 100000})):
            count = asyncio.run(collect_device_interfaces(self.device))
        self.assertEqual(count, 2)
        self.assertEqual(InterfaceMetricSample.objects.count(), 0)
        interface = NetworkInterface.objects.get(device=self.device, if_index=1)
        self.assertEqual(interface.name, 'GE0/0/1')
        self.assertEqual(interface.speed_bps, 1_000_000_000)
        self.assertEqual(interface.mac, '00:11:22:33:44:55')
        self.assertEqual(interface.counter_bits, 64)

        interface.last_counter_at = timezone.now() - timedelta(seconds=60)
        interface.save(update_fields=['last_counter_at'])
        walk_v2 = fake_if_walks(in_octets=1000 + 750000, out_octets=2000 + 1500000)
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=walk_v2)), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 106000})):
            asyncio.run(collect_device_interfaces(self.device))
        sample = InterfaceMetricSample.objects.get(interface__if_index=1)
        self.assertAlmostEqual(sample.in_bps, 100000.0, delta=1000)
        self.assertAlmostEqual(sample.out_bps, 200000.0, delta=2000)
        self.assertAlmostEqual(sample.in_util, 0.01, delta=0.001)

    def test_interface_down_transition_records_event(self):
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks(oper_status=1))), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 100000})):
            asyncio.run(collect_device_interfaces(self.device))
        self.assertFalse(EventRecord.objects.filter(action='interface_down').exists())
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks(oper_status=2))), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 106000})):
            asyncio.run(collect_device_interfaces(self.device))
        event = EventRecord.objects.get(action='interface_down')
        self.assertIn('GE0/0/1', event.resource_name)
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks(oper_status=1))), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 112000})):
            asyncio.run(collect_device_interfaces(self.device))
        self.assertTrue(EventRecord.objects.filter(action='interface_up').exists())

    def test_uptime_regression_skips_rate_but_refreshes_snapshot(self):
        self.device.sys_uptime_seconds = 99999
        self.device.save()
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks())), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 100000})):
            asyncio.run(collect_device_interfaces(self.device))
        interface = NetworkInterface.objects.get(device=self.device, if_index=1)
        interface.last_counter_at = timezone.now() - timedelta(seconds=60)
        interface.save(update_fields=['last_counter_at'])
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks(in_octets=999999))), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 5000})):
            asyncio.run(collect_device_interfaces(self.device))
        self.assertEqual(InterfaceMetricSample.objects.count(), 0)
        interface.refresh_from_db()
        self.assertEqual(interface.last_in_octets, 999999)

    def test_stale_interfaces_removed_after_full_walk(self):
        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks())), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 100000})):
            asyncio.run(collect_device_interfaces(self.device))
        self.assertEqual(self.device.interfaces.count(), 2)
        walk = fake_if_walks()

        async def _walk_one_interface(target, base_oid, engine=None):
            rows = await walk(target, base_oid)
            return [(oid, value) for oid, value in rows if not oid.endswith('.2')]

        with patch('network.collector.snmp_walk', new=AsyncMock(side_effect=_walk_one_interface)), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 106000})):
            asyncio.run(collect_device_interfaces(self.device))
        self.assertEqual(self.device.interfaces.count(), 1)

    def test_interface_collect_reuses_single_engine(self):
        with patch('network.collector.create_engine', return_value=object()) as mock_create, \
                patch('network.collector.close_engine') as mock_close, \
                patch('network.collector.snmp_walk', new=AsyncMock(side_effect=fake_if_walks())), \
                patch('network.collector.snmp_get', new=AsyncMock(return_value={oids.SYSTEM_OIDS['sys_uptime']: 100000})):
            asyncio.run(collect_device_interfaces(self.device))
        self.assertEqual(mock_create.call_count, 1)
        self.assertEqual(mock_close.call_count, 1)

    def test_system_collect_reuses_single_engine(self):
        sys_values = {oid: 'x' for oid in oids.SYSTEM_OIDS.values()}
        sys_values[oids.SYSTEM_OIDS['sys_uptime']] = 100000
        with patch('network.collector.create_engine', return_value=object()) as mock_create, \
                patch('network.collector.close_engine') as mock_close, \
                patch('network.collector.snmp_get', new=AsyncMock(return_value=sys_values)), \
                patch('network.collector.snmp_walk', new=AsyncMock(return_value=[])):
            asyncio.run(collect_device_system(self.device))
        self.assertEqual(mock_create.call_count, 1)
        self.assertEqual(mock_close.call_count, 1)


@override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=TEST_KEY)
class PollerTests(TestCase):
    def test_due_selection_respects_intervals(self):
        now = timezone.now()
        fresh = make_device(name='fresh', ip='10.0.0.1')
        fresh.last_system_poll_at = now
        fresh.last_interface_poll_at = now
        fresh.save()
        stale = make_device(name='stale', ip='10.0.0.2', system_interval=300, interface_interval=60)
        stale.last_system_poll_at = now - timedelta(seconds=301)
        stale.last_interface_poll_at = now - timedelta(seconds=30)
        stale.save()
        due = {device.name: (system, interface) for device, system, interface in select_due_devices(now)}
        self.assertNotIn('fresh', due)
        self.assertEqual(due['stale'], (True, False))

    def test_disabled_device_not_due(self):
        make_device(enabled=False)
        self.assertEqual(select_due_devices(), [])

    def test_prune_expired_samples(self):
        device = make_device()
        interface = NetworkInterface.objects.create(device=device, if_index=1)
        old = timezone.now() - timedelta(days=31)
        InterfaceMetricSample.objects.create(interface=interface, sampled_at=old)
        InterfaceMetricSample.objects.create(interface=interface, sampled_at=timezone.now())
        DeviceMetricSample.objects.create(device=device, sampled_at=old)
        deleted = prune_expired_samples(retention_days=30)
        self.assertEqual(deleted, 2)
        self.assertEqual(InterfaceMetricSample.objects.count(), 1)
        self.assertEqual(DeviceMetricSample.objects.count(), 0)


@override_settings(CMDB_PASSWORD_ENCRYPTION_KEY=TEST_KEY)
class ApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()
        cls.admin = User.objects.create_superuser(username='net-admin', password='x')
        cls.viewer = User.objects.create_user(username='net-viewer', password='x')
        cls.viewer.rbac_roles.add(Role.objects.get(code='read-only'))
        cls.noperm = User.objects.create_user(username='net-noperm', password='x')
        cls.credential = make_credential()
        cls.device = make_device(credential=cls.credential)

    def client_as(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_credential_create_encrypts_and_never_serializes_secret(self):
        response = self.client_as(self.admin).post('/api/network/credentials/', {
            'name': 'new-cred', 'version': 'v2c', 'community': 'secret-community',
        }, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertNotIn('community', response.data)
        self.assertNotIn('secret-community', str(response.data))
        credential = SnmpCredential.objects.get(name='new-cred')
        self.assertNotEqual(credential.community_encrypted, 'secret-community')
        self.assertEqual(credential.community, 'secret-community')
        self.assertTrue(EventRecord.objects.filter(module='network', action='create_credential').exists())

    def test_credential_update_blank_secret_keeps_existing(self):
        response = self.client_as(self.admin).patch(
            f'/api/network/credentials/{self.credential.pk}/', {'description': 'updated', 'community': ''}, format='json',
        )
        self.assertEqual(response.status_code, 200)
        self.credential.refresh_from_db()
        self.assertEqual(self.credential.community, 'public')
        self.assertEqual(self.credential.description, 'updated')

    def test_credential_v3_priv_requires_auth(self):
        response = self.client_as(self.admin).post('/api/network/credentials/', {
            'name': 'bad-v3', 'version': 'v3', 'v3_username': 'monitor',
            'v3_auth_protocol': 'none', 'v3_priv_protocol': 'aes128', 'v3_priv_key': 'x',
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_credential_switch_v3_to_v2c_requires_community(self):
        credential = make_credential(name='v3-switch', version='v3')
        response = self.client_as(self.admin).patch(
            f'/api/network/credentials/{credential.pk}/', {'version': 'v2c'}, format='json',
        )
        self.assertEqual(response.status_code, 400)
        response = self.client_as(self.admin).patch(
            f'/api/network/credentials/{credential.pk}/', {'version': 'v2c', 'community': 'public'}, format='json',
        )
        self.assertEqual(response.status_code, 200)
        credential.refresh_from_db()
        self.assertEqual(credential.version, 'v2c')
        self.assertEqual(credential.community, 'public')

    def test_credential_delete_blocked_when_referenced(self):
        response = self.client_as(self.admin).delete(f'/api/network/credentials/{self.credential.pk}/')
        self.assertEqual(response.status_code, 400)
        self.assertTrue(SnmpCredential.objects.filter(pk=self.credential.pk).exists())

    def test_device_create_and_audit(self):
        response = self.client_as(self.admin).post('/api/network/devices/', {
            'name': 'access-sw-01', 'mgmt_ip': '10.0.0.2', 'device_type': 'switch',
            'vendor': 'h3c', 'credential': self.credential.pk,
        }, format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['status'], 'unknown')
        event = EventRecord.objects.get(module='network', action='create_device')
        self.assertEqual(event.resource_name, 'access-sw-01')

    def test_device_interval_floor(self):
        response = self.client_as(self.admin).post('/api/network/devices/', {
            'name': 'fast', 'mgmt_ip': '10.0.0.3', 'credential': self.credential.pk, 'interface_interval': 5,
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_permission_matrix(self):
        self.assertEqual(self.client_as(self.noperm).get('/api/network/devices/').status_code, 403)
        self.assertEqual(self.client_as(self.noperm).get('/api/network/overview/').status_code, 403)
        self.assertEqual(self.client_as(self.viewer).get('/api/network/devices/').status_code, 200)
        self.assertEqual(self.client_as(self.viewer).get('/api/network/overview/').status_code, 200)
        response = self.client_as(self.viewer).post('/api/network/devices/', {
            'name': 'x', 'mgmt_ip': '10.0.0.9', 'credential': self.credential.pk,
        }, format='json')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client_as(self.viewer).post(f'/api/network/devices/{self.device.pk}/poll/').status_code, 403)

    def test_device_test_action_reports_reachability(self):
        sys_values = {
            oids.SYSTEM_OIDS['sys_descr']: 'H3C Comware S6520',
            oids.SYSTEM_OIDS['sys_name']: 'access-sw',
            oids.SYSTEM_OIDS['sys_uptime']: 720000,
        }
        with patch('network.views.snmp_get', new=AsyncMock(return_value=sys_values)):
            response = self.client_as(self.admin).post(f'/api/network/devices/{self.device.pk}/test/')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['reachable'])
        self.assertEqual(response.data['vendor_hint'], 'h3c')
        self.assertEqual(response.data['sys_uptime_seconds'], 7200)
        with patch('network.views.snmp_get', new=AsyncMock(side_effect=SnmpError('timeout'))):
            response = self.client_as(self.admin).post(f'/api/network/devices/{self.device.pk}/test/')
        self.assertFalse(response.data['reachable'])
        self.assertTrue(EventRecord.objects.filter(action='test_device', result='failed').exists())

    def test_device_poll_action_runs_collectors(self):
        with patch('network.views.collect_device_system', new=AsyncMock(return_value='online')), \
                patch('network.views.collect_device_interfaces', new=AsyncMock(return_value=24)):
            response = self.client_as(self.admin).post(f'/api/network/devices/{self.device.pk}/poll/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['interface_count'], 24)
        self.assertTrue(EventRecord.objects.filter(action='poll_device').exists())

    def test_interface_metrics_raw_and_bucketed(self):
        interface = NetworkInterface.objects.create(device=self.device, if_index=1, name='GE0/0/1')
        now = timezone.now()
        for minute in range(90):
            InterfaceMetricSample.objects.create(
                interface=interface, sampled_at=now - timedelta(minutes=minute),
                in_bps=1000 + minute, out_bps=2000, in_util=1, out_util=2,
            )
        response = self.client_as(self.viewer).get(f'/api/network/interfaces/{interface.pk}/metrics/?hours=1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data['series']), 60)
        self.assertIn('in_bps', response.data['series'][0])
        response = self.client_as(self.viewer).get(f'/api/network/interfaces/{interface.pk}/metrics/?hours=6')
        self.assertEqual(response.status_code, 200)
        first = response.data['series'][0]
        self.assertIn('in_bps_avg', first)
        self.assertIn('in_bps_max', first)

    def test_overview_payload(self):
        self.device.status = NetworkDevice.STATUS_ONLINE
        self.device.save()
        NetworkInterface.objects.create(device=self.device, if_index=1, name='uplink', oper_status=1, speed_bps=10**9, in_util=42, out_util=10, in_bps=4.2e8, out_bps=1e8)
        NetworkInterface.objects.create(device=self.device, if_index=2, name='down', oper_status=2)
        response = self.client_as(self.viewer).get('/api/network/overview/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['devices']['online'], 1)
        self.assertEqual(response.data['interfaces']['up'], 1)
        self.assertEqual(response.data['interfaces']['down'], 1)
        self.assertEqual(response.data['top_utilization'][0]['name'], 'uplink')
        self.assertEqual(response.data['traffic']['in_bps'], 4.2e8)


class AlertEngineTests(TestCase):
    def setUp(self):
        self.credential = make_credential(name='alert-cred')
        self.device = make_device(name='alert-sw', ip='10.0.0.9', credential=self.credential)
        NetworkAlertRule.objects.all().delete()

    def make_rule(self, **kwargs):
        defaults = {'name': 'r', 'target': 'device', 'metric': 'cpu_pct', 'operator': 'gt', 'threshold': 90, 'severity': 'critical', 'for_seconds': 0}
        defaults.update(kwargs)
        return NetworkAlertRule.objects.create(**defaults)

    def test_immediate_fire_creates_alert_and_event(self):
        self.make_rule(name='cpu')
        evaluate_device_alerts(self.device, {'cpu_pct': 95})
        alert = Alert.objects.get(source='network-snmp')
        self.assertEqual(alert.status, Alert.STATUS_ACTIVE)
        self.assertEqual(alert.level, 'critical')
        self.assertEqual(alert.metric_name, 'cpu_pct')
        state = NetworkAlertState.objects.get()
        self.assertTrue(state.fired)
        self.assertEqual(state.alert_id, alert.pk)
        self.assertTrue(EventRecord.objects.filter(module='network', action='alert_firing').exists())

    def test_below_threshold_no_alert(self):
        self.make_rule(name='cpu')
        evaluate_device_alerts(self.device, {'cpu_pct': 50})
        self.assertFalse(Alert.objects.exists())
        self.assertFalse(NetworkAlertState.objects.exists())

    def test_for_seconds_pending_then_fire(self):
        self.make_rule(name='cpu', for_seconds=120)
        evaluate_device_alerts(self.device, {'cpu_pct': 95})
        self.assertFalse(Alert.objects.exists())
        state = NetworkAlertState.objects.get()
        self.assertFalse(state.fired)
        state.first_breach_at = timezone.now() - timedelta(seconds=130)
        state.save()
        evaluate_device_alerts(self.device, {'cpu_pct': 96})
        self.assertTrue(Alert.objects.filter(status=Alert.STATUS_ACTIVE).exists())
        state.refresh_from_db()
        self.assertTrue(state.fired)

    def test_resolve_clears_state_and_alert(self):
        self.make_rule(name='cpu')
        evaluate_device_alerts(self.device, {'cpu_pct': 95})
        evaluate_device_alerts(self.device, {'cpu_pct': 50})
        alert = Alert.objects.get(source='network-snmp')
        self.assertEqual(alert.status, Alert.STATUS_RESOLVED)
        self.assertIsNotNone(alert.ends_at)
        self.assertFalse(NetworkAlertState.objects.exists())
        self.assertTrue(EventRecord.objects.filter(action='alert_resolved').exists())

    def test_dedup_single_alert_tracks_peak(self):
        self.make_rule(name='cpu')
        evaluate_device_alerts(self.device, {'cpu_pct': 95})
        evaluate_device_alerts(self.device, {'cpu_pct': 97})
        self.assertEqual(Alert.objects.count(), 1)
        alert = Alert.objects.get()
        self.assertEqual(alert.occurrence_count, 1)
        self.assertEqual(EventRecord.objects.filter(action='alert_firing').count(), 1)
        self.assertEqual(NetworkAlertState.objects.get().peak_value, 97)

    def test_refire_after_resolve_reactivates(self):
        self.make_rule(name='cpu')
        evaluate_device_alerts(self.device, {'cpu_pct': 95})
        evaluate_device_alerts(self.device, {'cpu_pct': 50})
        evaluate_device_alerts(self.device, {'cpu_pct': 99})
        alert = Alert.objects.get()
        self.assertEqual(alert.status, Alert.STATUS_ACTIVE)
        self.assertEqual(alert.occurrence_count, 3)
        self.assertEqual(EventRecord.objects.filter(action='alert_firing').count(), 2)

    def test_device_scope_limits_rule(self):
        other = make_device(name='other-sw', ip='10.0.0.10', credential=self.credential)
        self.make_rule(name='cpu', device=self.device)
        evaluate_device_alerts(other, {'cpu_pct': 99})
        self.assertFalse(Alert.objects.exists())
        evaluate_device_alerts(self.device, {'cpu_pct': 99})
        self.assertEqual(Alert.objects.count(), 1)

    def test_missing_value_resolves_fired_alert(self):
        self.make_rule(name='cpu')
        evaluate_device_alerts(self.device, {'cpu_pct': 95})
        evaluate_device_alerts(self.device, {})
        self.assertEqual(Alert.objects.get().status, Alert.STATUS_RESOLVED)

    def test_offline_metric_fires_on_status(self):
        self.make_rule(name='offline', metric='offline', operator='gte', threshold=1)
        self.device.status = NetworkDevice.STATUS_OFFLINE
        self.device.save()
        evaluate_device_alerts(self.device, {})
        alert = Alert.objects.get()
        self.assertEqual(alert.metric_name, 'offline')
        self.assertEqual(alert.status, Alert.STATUS_ACTIVE)

    def test_interface_util_fire(self):
        self.make_rule(name='util', target='interface', metric='in_util', threshold=80, severity='warning')
        interface = NetworkInterface.objects.create(device=self.device, if_index=1, name='GE0/0/1', in_util=90)
        evaluate_interface_alerts(interface)
        alert = Alert.objects.get()
        self.assertEqual(alert.resource_type, 'network_interface')
        self.assertEqual(alert.level, 'warning')
        self.assertEqual(alert.status, Alert.STATUS_ACTIVE)

    def test_interface_down_fire(self):
        self.make_rule(name='down', target='interface', metric='down', operator='gte', threshold=1)
        interface = NetworkInterface.objects.create(device=self.device, if_index=1, name='GE0/0/1', admin_status=1, oper_status=2)
        evaluate_interface_alerts(interface)
        self.assertTrue(Alert.objects.filter(metric_name='down', status=Alert.STATUS_ACTIVE).exists())

    def test_interface_errors_use_sample_delta(self):
        self.make_rule(name='err', target='interface', metric='in_errors', threshold=100, severity='warning')
        interface = NetworkInterface.objects.create(device=self.device, if_index=1, name='GE0/0/1')
        sample = InterfaceMetricSample.objects.create(interface=interface, sampled_at=timezone.now(), in_errors=200)
        evaluate_interface_alerts(interface, sample)
        self.assertTrue(Alert.objects.filter(metric_name='in_errors', status=Alert.STATUS_ACTIVE).exists())


class AlertApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        ensure_builtin_rbac()
        cls.admin = User.objects.create_superuser(username='alert-admin', password='x')
        cls.viewer = User.objects.create_user(username='alert-viewer', password='x')
        cls.viewer.rbac_roles.add(Role.objects.get(code='read-only'))
        cls.noperm = User.objects.create_user(username='alert-noperm', password='x')
        cls.credential = make_credential(name='alert-api-cred')
        cls.device = make_device(name='alert-api-sw', ip='10.0.0.20', credential=cls.credential)

    def client_as(self, user):
        client = APIClient()
        client.force_authenticate(user=user)
        return client

    def test_rule_crud_and_audit(self):
        client = self.client_as(self.admin)
        response = client.post('/api/network/alert-rules/', {
            'name': 'CPU 高', 'target': 'device', 'metric': 'cpu_pct', 'operator': 'gt',
            'threshold': 90, 'severity': 'critical', 'for_seconds': 60,
        }, format='json')
        self.assertEqual(response.status_code, 201)
        rule_id = response.data['id']
        self.assertTrue(EventRecord.objects.filter(action='create_alert_rule').exists())
        response = client.patch(f'/api/network/alert-rules/{rule_id}/', {'threshold': 95}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['threshold'], 95)
        response = client.delete(f'/api/network/alert-rules/{rule_id}/')
        self.assertEqual(response.status_code, 204)
        self.assertFalse(NetworkAlertRule.objects.filter(pk=rule_id).exists())

    def test_rule_metric_must_match_target(self):
        response = self.client_as(self.admin).post('/api/network/alert-rules/', {
            'name': 'bad', 'target': 'device', 'metric': 'in_util', 'threshold': 80,
        }, format='json')
        self.assertEqual(response.status_code, 400)

    def test_builtin_rule_cannot_delete(self):
        rule = NetworkAlertRule.objects.create(name='builtin-x', target='device', metric='cpu_pct', threshold=90, is_builtin=True)
        response = self.client_as(self.admin).delete(f'/api/network/alert-rules/{rule.pk}/')
        self.assertEqual(response.status_code, 400)
        self.assertTrue(NetworkAlertRule.objects.filter(pk=rule.pk).exists())

    def test_viewer_can_list_but_not_create(self):
        self.assertEqual(self.client_as(self.viewer).get('/api/network/alert-rules/').status_code, 200)
        response = self.client_as(self.viewer).post('/api/network/alert-rules/', {
            'name': 'nope', 'target': 'device', 'metric': 'cpu_pct', 'threshold': 90,
        }, format='json')
        self.assertEqual(response.status_code, 403)

    def test_noperm_forbidden(self):
        self.assertEqual(self.client_as(self.noperm).get('/api/network/alert-rules/').status_code, 403)
        self.assertEqual(self.client_as(self.noperm).get('/api/network/alerts/').status_code, 403)

    def test_alert_list_and_acknowledge(self):
        alert = Alert.objects.create(
            title='网络告警：CPU 高', level='critical', status=Alert.STATUS_ACTIVE,
            source='network-snmp', source_type=Alert.SOURCE_GENERIC, message='x',
            resource_type='network_device', resource='alert-api-sw', metric_name='cpu_pct',
        )
        response = self.client_as(self.viewer).get('/api/network/alerts/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)
        response = self.client_as(self.admin).post(f'/api/network/alerts/{alert.pk}/acknowledge/')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['is_acknowledged'])
        alert.refresh_from_db()
        self.assertEqual(alert.acknowledged_by, 'alert-admin')

    def test_alert_list_excludes_other_sources(self):
        Alert.objects.create(title='other', level='info', status=Alert.STATUS_ACTIVE, source='prometheus', message='x')
        response = self.client_as(self.viewer).get('/api/network/alerts/')
        self.assertEqual(response.data['count'], 0)

    def test_overview_includes_alert_summary(self):
        Alert.objects.create(title='网络告警：CPU 高', level='critical', status=Alert.STATUS_ACTIVE, source='network-snmp', message='x')
        response = self.client_as(self.viewer).get('/api/network/overview/')
        self.assertEqual(response.data['alerts']['active'], 1)
        self.assertEqual(response.data['alerts']['critical'], 1)
        self.assertEqual(len(response.data['recent_alerts']), 1)