from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .builtins import ensure_builtin_cmdb
from .models import CIField, CIResourceMetricSnapshot, CIType, ConfigItem, ConfigItemPassword
from .waterline_ssh import WaterlineSSHError, collect_ssh_waterline, parse_waterline_output


def fake_ssh_client(output):
    client = MagicMock()
    stdout = MagicMock()
    stdout.read.return_value = output.encode()
    stdout.channel = MagicMock()
    stdout.channel.recv_exit_status.return_value = 0
    stderr = MagicMock()
    stderr.read.return_value = b''
    client.exec_command.return_value = (MagicMock(), stdout, stderr)
    return client


class SSHWaterlineCollectorTests(TestCase):
    def setUp(self):
        ensure_builtin_cmdb()
        self.ci = ConfigItem.objects.create(
            name='host-ssh',
            ci_type=CIType.objects.get(code='IDC_SERVER'),
            attributes={'private_ip': '10.0.0.5', 'ssh_port': 10086},
        )
        ConfigItemPassword.objects.create(config_item=self.ci, username='ops', password_ciphertext='cipher')

    @patch('cmdb.waterline_ssh.decrypt_config_item_password', return_value='secret')
    @patch('cmdb.waterline_ssh.paramiko.SSHClient')
    def test_collects_metrics_and_uses_configured_port(self, client_cls, _decrypt):
        client_cls.return_value = fake_ssh_client(
            'WATERLINE_CPU=12.5\nWATERLINE_MEM=43.25\nWATERLINE_DISK=51\n'
        )

        result = collect_ssh_waterline(self.ci)

        self.assertEqual(
            result['metrics'],
            {'cpu_usage': '12.50', 'memory_usage': '43.25', 'disk_usage': '51.00'},
        )
        connect = client_cls.return_value.connect.call_args.kwargs
        self.assertEqual(connect['hostname'], '10.0.0.5')
        self.assertEqual(connect['port'], 10086)
        self.assertEqual(connect['username'], 'ops')
        rows = CIResourceMetricSnapshot.objects.filter(ci=self.ci)
        self.assertEqual(rows.count(), 3)
        self.assertTrue(all(row.source == 'ssh' for row in rows))

    def test_parse_rejects_missing_metric(self):
        with self.assertRaises(WaterlineSSHError):
            parse_waterline_output('WATERLINE_CPU=1\nWATERLINE_MEM=2\n')

    @patch('cmdb.waterline_ssh.decrypt_config_item_password', return_value='secret')
    @patch('cmdb.waterline_ssh.paramiko.SSHClient')
    def test_command_failure_is_reported(self, client_cls, _decrypt):
        client = fake_ssh_client('')
        client.exec_command.return_value[1].channel.recv_exit_status.return_value = 3
        client.exec_command.return_value[2].read.return_value = b'WATERLINE_ERROR=unsupported-os'
        client_cls.return_value = client

        with self.assertRaises(WaterlineSSHError):
            collect_ssh_waterline(self.ci)


class SSHWaterlineRefreshEndpointTests(TestCase):
    def setUp(self):
        ensure_builtin_cmdb()
        self.client = APIClient()
        user = get_user_model().objects.create_superuser('cmdb-ssh', 'ssh@example.com', 'Passw0rd!')
        self.client.force_authenticate(user=user)
        self.ci = ConfigItem.objects.create(
            name='host-ssh-api',
            ci_type=CIType.objects.get(code='IDC_SERVER'),
            attributes={'private_ip': '10.0.0.6', 'ssh_port': 22},
        )

    @patch('cmdb.views.collect_ssh_waterline_batch')
    def test_refresh_endpoint_uses_ssh_fallback(self, batch):
        batch.return_value = ([{
            'ci_id': self.ci.id,
            'name': self.ci.name,
            'metrics': {'cpu_usage': '1.00', 'memory_usage': '2.00', 'disk_usage': '3.00'},
        }], [])

        response = self.client.post(
            '/api/cmdb/resource-metrics/refresh-current-page/',
            {'ci_ids': [self.ci.id]},
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['refreshed_count'], 1)
        self.assertEqual(payload['ssh_collected_count'], 1)
        self.assertEqual(payload['summary']['metric_snapshot'], 3)
        batch.assert_called_once()


class SSHBuiltinFieldTests(TestCase):
    def test_ssh_port_field_is_optional_builtin_for_compute_types(self):
        ensure_builtin_cmdb()
        for code in ('IDC_SERVER', 'CLOUD_SERVER', 'VIRTUAL_MACHINE'):
            field = CIField.objects.get(ci_type__code=code, code='ssh_port')
            self.assertFalse(field.required)
            self.assertTrue(field.is_builtin)
            self.assertEqual(field.field_type, 'integer')