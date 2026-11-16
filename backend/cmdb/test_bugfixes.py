from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from .builtins import ensure_builtin_cmdb
from .models import CIResourceAuthorization, CISyncJob, CIType, ConfigItem, IPSubnet
from .serializers import CIResourceAuthorizationSerializer
from .sync import infer_ci_ip_address
from .views import _subnet_address_snapshot, _to_float


class BuiltinSyncJobPreservationTests(TestCase):
    def test_ensure_builtin_cmdb_keeps_operator_configuration(self):
        ensure_builtin_cmdb()
        job = CISyncJob.objects.filter(created_by='builtin').order_by('id').first()
        self.assertIsNotNone(job)
        job.config = {**(job.config or {}), 'cloud_account_id': 7, 'interval_minutes': 5}
        job.status = 'success'
        job.summary = {'created': 3}
        job.save()

        ensure_builtin_cmdb()

        job.refresh_from_db()
        self.assertEqual(job.config.get('cloud_account_id'), 7)
        self.assertEqual(job.config.get('interval_minutes'), 5)
        self.assertEqual(job.status, 'success')
        self.assertEqual(job.summary, {'created': 3})


class ResourceAuthorizationValidationTests(TestCase):
    def test_partial_update_cannot_clear_scope_of_manage_policy(self):
        policy = CIResourceAuthorization.objects.create(
            name='核心业务线管理',
            principal_type='user',
            principal='alice',
            permission='manage',
            business_line='core',
        )

        serializer = CIResourceAuthorizationSerializer(policy, data={'business_line': ''}, partial=True)

        self.assertFalse(serializer.is_valid())
        self.assertIn('管理授权至少需要限定业务线或资源模型', str(serializer.errors))


class CiAttributeParsingTests(TestCase):
    def test_infer_ip_accepts_non_string_values(self):
        self.assertEqual(infer_ci_ip_address({'ip_address': 12345}), '12345')
        # 数组值取第一个可读元素，避免把 "['10.0.0.1']" 当成 IP 地址。
        self.assertEqual(infer_ci_ip_address({'private_ip': ['10.0.0.1']}), '10.0.0.1')

    def test_to_float_ignores_free_form_cost_text(self):
        self.assertEqual(_to_float('1,200 CNY'), 0.0)
        self.assertEqual(_to_float('12.5'), 12.5)


class IpamScopeTests(TestCase):
    def test_subnet_snapshot_hides_out_of_scope_assets(self):
        user = get_user_model().objects.create_user(username='ipam-viewer', password='x')
        ci_type, _ = CIType.objects.get_or_create(code='CLOUD_SERVER', defaults={'name': '云主机(ECS)'})
        ConfigItem.objects.create(
            name='core-app',
            ci_type=ci_type,
            business_line='core',
            attributes={'ip_address': '10.10.0.11'},
        )
        ConfigItem.objects.create(
            name='finance-db',
            ci_type=ci_type,
            business_line='finance',
            attributes={'ip_address': '10.10.0.12'},
        )
        CIResourceAuthorization.objects.create(
            name='核心业务线可见',
            principal_type='user',
            principal=user.username,
            permission='view',
            business_line='core',
        )
        subnet = IPSubnet.objects.create(name='业务网段', cidr='10.10.0.0/24')

        rows, _ = _subnet_address_snapshot(subnet, user=user)

        linked_names = {name for row in rows for name in row['linked_ci_names']}
        self.assertIn('core-app', linked_names)
        self.assertNotIn('finance-db', linked_names)


class SyncStatusAndTextRegressionTests(SimpleTestCase):
    def test_ci_stopped_maps_to_offline_host(self):
        from .sync import ci_status_to_host_status

        self.assertEqual(ci_status_to_host_status('stopped'), 'offline')
        self.assertEqual(ci_status_to_host_status('active'), 'online')

    def test_attribute_text_ignores_mapping_and_unwraps_list(self):
        from .sync import _attribute_text

        self.assertEqual(_attribute_text(['10.0.0.1', '10.0.0.2']), '10.0.0.1')
        self.assertEqual(_attribute_text({'nested': 'value'}), '')
        self.assertEqual(_attribute_text(12345), '12345')


class CsvFormulaInjectionTests(SimpleTestCase):
    def test_formula_like_cells_are_prefixed(self):
        from .views import _csv_safe_cell

        self.assertEqual(_csv_safe_cell('=HYPERLINK("http://evil")'), "'=HYPERLINK(\"http://evil\")")
        self.assertEqual(_csv_safe_cell('normal'), 'normal')
        self.assertEqual(_csv_safe_cell(12), 12)


class ConfigItemStatusWhitelistTests(SimpleTestCase):
    def test_invalid_status_is_rejected(self):
        from .views import _normalize_config_item_status

        self.assertEqual(_normalize_config_item_status('active'), 'active')
        with self.assertRaises(Exception):
            _normalize_config_item_status('gone')


class SubnetDuplicateRegressionTests(TestCase):
    def test_equivalent_cidr_is_rejected_by_serializer(self):
        from .models import IPSubnet
        from .serializers import IPSubnetSerializer

        IPSubnet.objects.create(name='existing', cidr='10.0.0.0/24')
        serializer = IPSubnetSerializer(data={'name': 'duplicate', 'cidr': '10.0.0.5/24'})
        self.assertFalse(serializer.is_valid())
        self.assertIn('cidr', serializer.errors)
