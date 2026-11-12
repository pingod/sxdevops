from django.db import models

from .crypto import decrypt_secret, encrypt_secret


class SnmpCredential(models.Model):
    VERSION_V2C = 'v2c'
    VERSION_V3 = 'v3'
    VERSION_CHOICES = [(VERSION_V2C, 'SNMPv2c'), (VERSION_V3, 'SNMPv3')]

    AUTH_PROTOCOL_CHOICES = [
        ('none', '无认证'), ('md5', 'MD5'), ('sha', 'SHA-1'),
        ('sha224', 'SHA-224'), ('sha256', 'SHA-256'), ('sha384', 'SHA-384'), ('sha512', 'SHA-512'),
    ]
    PRIV_PROTOCOL_CHOICES = [
        ('none', '无加密'), ('des', 'DES'), ('aes128', 'AES-128'),
        ('aes192', 'AES-192'), ('aes256', 'AES-256'),
    ]

    name = models.CharField('凭据名称', max_length=100, unique=True)
    version = models.CharField('SNMP 版本', max_length=8, choices=VERSION_CHOICES, default=VERSION_V2C)
    community_encrypted = models.TextField('Community 密文', blank=True, default='')
    v3_username = models.CharField('v3 用户名', max_length=64, blank=True, default='')
    v3_auth_protocol = models.CharField('v3 认证协议', max_length=16, choices=AUTH_PROTOCOL_CHOICES, default='none')
    v3_auth_key_encrypted = models.TextField('v3 认证密钥密文', blank=True, default='')
    v3_priv_protocol = models.CharField('v3 加密协议', max_length=16, choices=PRIV_PROTOCOL_CHOICES, default='none')
    v3_priv_key_encrypted = models.TextField('v3 加密密钥密文', blank=True, default='')
    description = models.CharField('描述', max_length=255, blank=True, default='')
    created_at = models.DateTimeField('创建时间', auto_now_add=True)
    updated_at = models.DateTimeField('更新时间', auto_now=True)

    class Meta:
        verbose_name = 'SNMP 凭据'
        verbose_name_plural = 'SNMP 凭据'
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.version})'

    @property
    def community(self):
        return decrypt_secret(self.community_encrypted) if self.community_encrypted else ''

    @community.setter
    def community(self, value):
        self.community_encrypted = encrypt_secret(value) if value else ''

    @property
    def v3_auth_key(self):
        return decrypt_secret(self.v3_auth_key_encrypted) if self.v3_auth_key_encrypted else ''

    @v3_auth_key.setter
    def v3_auth_key(self, value):
        self.v3_auth_key_encrypted = encrypt_secret(value) if value else ''

    @property
    def v3_priv_key(self):
        return decrypt_secret(self.v3_priv_key_encrypted) if self.v3_priv_key_encrypted else ''

    @v3_priv_key.setter
    def v3_priv_key(self, value):
        self.v3_priv_key_encrypted = encrypt_secret(value) if value else ''


class NetworkDevice(models.Model):
    TYPE_CHOICES = [
        ('switch', '交换机'), ('router', '路由器'), ('firewall', '防火墙'),
        ('load_balancer', '负载均衡'), ('wireless', '无线设备'), ('other', '其他'),
    ]
    VENDOR_CHOICES = [
        ('huawei', '华为'), ('h3c', '新华三'), ('cisco', '思科'), ('ruijie', '锐捷'),
        ('zte', '中兴'), ('juniper', 'Juniper'), ('fortinet', '飞塔'), ('linux', 'Linux'), ('other', '其他'),
    ]
    STATUS_UNKNOWN = 'unknown'
    STATUS_ONLINE = 'online'
    STATUS_OFFLINE = 'offline'
    STATUS_CHOICES = [(STATUS_UNKNOWN, '未探测'), (STATUS_ONLINE, '在线'), (STATUS_OFFLINE, '离线')]

    name = models.CharField('设备名称', max_length=100, unique=True)
    mgmt_ip = models.GenericIPAddressField('管理 IP')
    device_type = models.CharField('设备类型', max_length=20, choices=TYPE_CHOICES, default='switch')
    vendor = models.CharField('厂商', max_length=20, choices=VENDOR_CHOICES, default='other')
    model = models.CharField('型号', max_length=100, blank=True, default='')
    location = models.CharField('位置', max_length=200, blank=True, default='')
    description = models.CharField('描述', max_length=255, blank=True, default='')
    snmp_port = models.PositiveIntegerField('SNMP 端口', default=161)
    credential = models.ForeignKey(SnmpCredential, on_delete=models.PROTECT, related_name='devices', verbose_name='SNMP 凭据')
    enabled = models.BooleanField('启用采集', default=True)
    system_interval = models.PositiveIntegerField('系统采集间隔(秒)', default=300)
    interface_interval = models.PositiveIntegerField('接口采集间隔(秒)', default=60)
    status = models.CharField('在线状态', max_length=10, choices=STATUS_CHOICES, default=STATUS_UNKNOWN)
    last_error = models.TextField('最近错误', blank=True, default='')
    sys_descr = models.TextField('系统描述', blank=True, default='')
    sys_name = models.CharField('系统名称', max_length=200, blank=True, default='')
    sys_contact = models.CharField('联系人', max_length=200, blank=True, default='')
    sys_location = models.CharField('系统位置', max_length=200, blank=True, default='')
    sys_uptime_seconds = models.BigIntegerField('运行时长(秒)', null=True, blank=True)
    last_poll_at = models.DateTimeField('最近采集时间', null=True, blank=True)
    last_system_poll_at = models.DateTimeField('最近系统采集', null=True, blank=True)
    last_interface_poll_at = models.DateTimeField('最近接口采集', null=True, blank=True)
    created_at = models.DateTimeField('创建时间', auto_now_add=True)
    updated_at = models.DateTimeField('更新时间', auto_now=True)

    class Meta:
        verbose_name = '网络设备'
        verbose_name_plural = '网络设备'
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['mgmt_ip', 'snmp_port'], name='network_device_ip_port_unique'),
        ]

    def __str__(self):
        return f'{self.name} ({self.mgmt_ip})'


class NetworkInterface(models.Model):
    device = models.ForeignKey(NetworkDevice, on_delete=models.CASCADE, related_name='interfaces', verbose_name='设备')
    if_index = models.PositiveIntegerField('接口索引')
    name = models.CharField('接口名称', max_length=200, blank=True, default='')
    descr = models.TextField('接口描述', blank=True, default='')
    alias = models.CharField('接口别名', max_length=200, blank=True, default='')
    mac = models.CharField('MAC 地址', max_length=17, blank=True, default='')
    if_type = models.IntegerField('接口类型', null=True, blank=True)
    mtu = models.IntegerField('MTU', null=True, blank=True)
    admin_status = models.IntegerField('管理状态', default=0)
    oper_status = models.IntegerField('运行状态', default=0)
    speed_bps = models.BigIntegerField('接口速率(bps)', default=0)
    in_bps = models.FloatField('入向速率(bps)', default=0)
    out_bps = models.FloatField('出向速率(bps)', default=0)
    in_util = models.FloatField('入向利用率(%)', default=0)
    out_util = models.FloatField('出向利用率(%)', default=0)
    counter_bits = models.IntegerField('计数器位宽', default=64)
    last_in_octets = models.BigIntegerField('上次入向字节数', null=True, blank=True)
    last_out_octets = models.BigIntegerField('上次出向字节数', null=True, blank=True)
    last_in_errors = models.BigIntegerField('上次入向错包数', null=True, blank=True)
    last_out_errors = models.BigIntegerField('上次出向错包数', null=True, blank=True)
    last_counter_at = models.DateTimeField('上次计数时间', null=True, blank=True)
    last_seen_at = models.DateTimeField('最近发现时间', null=True, blank=True)

    class Meta:
        verbose_name = '网络接口'
        verbose_name_plural = '网络接口'
        ordering = ['device', 'if_index']
        constraints = [
            models.UniqueConstraint(fields=['device', 'if_index'], name='network_interface_device_index_unique'),
        ]

    def __str__(self):
        return f'{self.device.name}:{self.name or self.if_index}'


class InterfaceMetricSample(models.Model):
    interface = models.ForeignKey(NetworkInterface, on_delete=models.CASCADE, related_name='samples', verbose_name='接口')
    sampled_at = models.DateTimeField('采集时间', db_index=True)
    in_bps = models.FloatField('入向速率(bps)', default=0)
    out_bps = models.FloatField('出向速率(bps)', default=0)
    in_util = models.FloatField('入向利用率(%)', default=0)
    out_util = models.FloatField('出向利用率(%)', default=0)
    in_errors = models.BigIntegerField('入向错包增量', default=0)
    out_errors = models.BigIntegerField('出向错包增量', default=0)

    class Meta:
        verbose_name = '接口指标样本'
        verbose_name_plural = '接口指标样本'
        ordering = ['-sampled_at']
        indexes = [models.Index(fields=['interface', 'sampled_at'], name='net_ifsample_iface_time_idx')]


class DeviceMetricSample(models.Model):
    device = models.ForeignKey(NetworkDevice, on_delete=models.CASCADE, related_name='metric_samples', verbose_name='设备')
    sampled_at = models.DateTimeField('采集时间', db_index=True)
    cpu_pct = models.FloatField('CPU 使用率(%)', null=True, blank=True)
    mem_pct = models.FloatField('内存使用率(%)', null=True, blank=True)
    temperature = models.FloatField('温度(℃)', null=True, blank=True)
    uptime_seconds = models.BigIntegerField('运行时长(秒)', null=True, blank=True)

    class Meta:
        verbose_name = '设备指标样本'
        verbose_name_plural = '设备指标样本'
        ordering = ['-sampled_at']
        indexes = [models.Index(fields=['device', 'sampled_at'], name='net_devsample_dev_time_idx')]