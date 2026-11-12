from rest_framework import serializers

from .models import DeviceMetricSample, InterfaceMetricSample, NetworkDevice, NetworkInterface, SnmpCredential


class SnmpCredentialSerializer(serializers.ModelSerializer):
    community = serializers.CharField(write_only=True, required=False, allow_blank=True, trim_whitespace=False)
    v3_auth_key = serializers.CharField(write_only=True, required=False, allow_blank=True, trim_whitespace=False)
    v3_priv_key = serializers.CharField(write_only=True, required=False, allow_blank=True, trim_whitespace=False)
    device_count = serializers.IntegerField(source='devices.count', read_only=True)

    class Meta:
        model = SnmpCredential
        fields = [
            'id', 'name', 'version', 'v3_username', 'v3_auth_protocol', 'v3_priv_protocol',
            'description', 'community', 'v3_auth_key', 'v3_priv_key',
            'device_count', 'created_at', 'updated_at',
        ]

    def validate(self, attrs):
        version = attrs.get('version') or (self.instance.version if self.instance else SnmpCredential.VERSION_V2C)
        creating = self.instance is None
        if version == SnmpCredential.VERSION_V2C:
            if creating and not attrs.get('community'):
                raise serializers.ValidationError({'community': 'SNMPv2c 凭据必须填写 Community。'})
            return attrs
        username = attrs.get('v3_username') or (self.instance.v3_username if self.instance else '')
        if not username:
            raise serializers.ValidationError({'v3_username': 'SNMPv3 凭据必须填写用户名。'})
        auth_protocol = attrs.get('v3_auth_protocol') or (self.instance.v3_auth_protocol if self.instance else 'none')
        priv_protocol = attrs.get('v3_priv_protocol') or (self.instance.v3_priv_protocol if self.instance else 'none')
        has_auth_key = bool(attrs.get('v3_auth_key')) or (self.instance and bool(self.instance.v3_auth_key_encrypted))
        has_priv_key = bool(attrs.get('v3_priv_key')) or (self.instance and bool(self.instance.v3_priv_key_encrypted))
        if auth_protocol != 'none' and not has_auth_key:
            raise serializers.ValidationError({'v3_auth_key': '启用认证协议后必须填写认证密钥。'})
        if priv_protocol != 'none':
            if auth_protocol == 'none':
                raise serializers.ValidationError({'v3_priv_protocol': '启用加密前必须先启用认证协议。'})
            if not has_priv_key:
                raise serializers.ValidationError({'v3_priv_key': '启用加密协议后必须填写加密密钥。'})
        return attrs

    def _pop_secrets(self, validated_data):
        return {field: validated_data.pop(field) for field in ('community', 'v3_auth_key', 'v3_priv_key') if field in validated_data}

    def create(self, validated_data):
        secrets = self._pop_secrets(validated_data)
        credential = SnmpCredential(**validated_data)
        for field, value in secrets.items():
            setattr(credential, field, value)
        credential.save()
        return credential

    def update(self, instance, validated_data):
        secrets = self._pop_secrets(validated_data)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        for field, value in secrets.items():
            if value:
                setattr(instance, field, value)
        instance.save()
        return instance


class NetworkDeviceSerializer(serializers.ModelSerializer):
    credential_name = serializers.CharField(source='credential.name', read_only=True)
    device_type_display = serializers.CharField(source='get_device_type_display', read_only=True)
    vendor_display = serializers.CharField(source='get_vendor_display', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)
    interface_count = serializers.IntegerField(source='interfaces.count', read_only=True)

    class Meta:
        model = NetworkDevice
        fields = [
            'id', 'name', 'mgmt_ip', 'device_type', 'device_type_display', 'vendor', 'vendor_display',
            'model', 'location', 'description', 'snmp_port', 'credential', 'credential_name',
            'enabled', 'system_interval', 'interface_interval',
            'status', 'status_display', 'last_error', 'sys_descr', 'sys_name', 'sys_contact', 'sys_location',
            'sys_uptime_seconds', 'interface_count',
            'last_poll_at', 'last_system_poll_at', 'last_interface_poll_at', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'status', 'last_error', 'sys_descr', 'sys_name', 'sys_contact', 'sys_location',
            'sys_uptime_seconds', 'last_poll_at', 'last_system_poll_at', 'last_interface_poll_at',
        ]

    def validate_system_interval(self, value):
        if value < 30:
            raise serializers.ValidationError('系统采集间隔不能小于 30 秒。')
        return value

    def validate_interface_interval(self, value):
        if value < 30:
            raise serializers.ValidationError('接口采集间隔不能小于 30 秒（计数器差分需要足够窗口）。')
        return value

    def validate_snmp_port(self, value):
        if not 1 <= value <= 65535:
            raise serializers.ValidationError('SNMP 端口必须在 1-65535 之间。')
        return value


class NetworkInterfaceSerializer(serializers.ModelSerializer):
    device_name = serializers.CharField(source='device.name', read_only=True)

    class Meta:
        model = NetworkInterface
        fields = [
            'id', 'device', 'device_name', 'if_index', 'name', 'descr', 'alias', 'mac',
            'if_type', 'mtu', 'admin_status', 'oper_status', 'speed_bps',
            'in_bps', 'out_bps', 'in_util', 'out_util', 'counter_bits', 'last_seen_at', 'last_counter_at',
        ]


class InterfaceMetricSampleSerializer(serializers.ModelSerializer):
    class Meta:
        model = InterfaceMetricSample
        fields = ['id', 'interface', 'sampled_at', 'in_bps', 'out_bps', 'in_util', 'out_util', 'in_errors', 'out_errors']


class DeviceMetricSampleSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeviceMetricSample
        fields = ['id', 'device', 'sampled_at', 'cpu_pct', 'mem_pct', 'temperature', 'uptime_seconds']