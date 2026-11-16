"""SNMP OID 注册表。

标准 OID 来自 RFC 1213 / RFC 2863 (IF-MIB)；厂商私有 OID 参考
NetMon-Agent-Platform 的 oid_registry.go（Go 实现）移植并核对。
"""

SYSTEM_OIDS = {
    'sys_descr': '1.3.6.1.2.1.1.1.0',
    'sys_object_id': '1.3.6.1.2.1.1.2.0',
    'sys_uptime': '1.3.6.1.2.1.1.3.0',
    'sys_contact': '1.3.6.1.2.1.1.4.0',
    'sys_name': '1.3.6.1.2.1.1.5.0',
    'sys_location': '1.3.6.1.2.1.1.6.0',
}

IF_NUMBER_OID = '1.3.6.1.2.1.2.1.0'

# ifTable (RFC 2863)：32 位计数器与基础属性，老设备兜底
IF_TABLE_OIDS = {
    'if_descr': '1.3.6.1.2.1.2.2.1.2',
    'if_type': '1.3.6.1.2.1.2.2.1.3',
    'if_mtu': '1.3.6.1.2.1.2.2.1.4',
    'if_speed': '1.3.6.1.2.1.2.2.1.5',
    'if_phys_address': '1.3.6.1.2.1.2.2.1.6',
    'if_admin_status': '1.3.6.1.2.1.2.2.1.7',
    'if_oper_status': '1.3.6.1.2.1.2.2.1.8',
    'if_in_octets': '1.3.6.1.2.1.2.2.1.10',
    'if_in_errors': '1.3.6.1.2.1.2.2.1.14',
    'if_out_octets': '1.3.6.1.2.1.2.2.1.16',
    'if_out_errors': '1.3.6.1.2.1.2.2.1.20',
}

# ifXTable：64 位 HC 计数器与高速率，优先使用
IF_X_TABLE_OIDS = {
    'if_name': '1.3.6.1.2.1.31.1.1.1.1',
    'if_hc_in_octets': '1.3.6.1.2.1.31.1.1.1.6',
    'if_hc_out_octets': '1.3.6.1.2.1.31.1.1.1.10',
    'if_high_speed': '1.3.6.1.2.1.31.1.1.1.15',
    'if_alias': '1.3.6.1.2.1.31.1.1.1.18',
}

# HOST-RESOURCES-MIB：通用 CPU/内存兜底（Linux/Windows/部分网络设备）
HR_PROCESSOR_LOAD_OID = '1.3.6.1.2.1.25.3.3.1.2'
HR_STORAGE_TABLE_OID = '1.3.6.1.2.1.25.2.3.1'
HR_STORAGE_DESCR_OID = '1.3.6.1.2.1.25.2.3.1.3'
HR_STORAGE_SIZE_OID = '1.3.6.1.2.1.25.2.3.1.5'
HR_STORAGE_USED_OID = '1.3.6.1.2.1.25.2.3.1.6'
HR_STORAGE_TYPE_RAM = '1.3.6.1.2.1.25.2.1.2'

# 厂商健康指标：cpu/mem 为百分比标量或表（表取最大值），temp 为表（取最大值，℃）
# 每项是候选 OID 列表，按顺序尝试，命中即停。
VENDOR_HEALTH_OIDS = {
    'huawei': {
        'cpu': [
            '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5',   # hwEntityCpuUsage（CE/新版 VRP）
            '1.3.6.1.4.1.2011.6.3.4.1.2.0',         # hwCpuDevUsage（S 系列老 VRP）
        ],
        'mem': [
            '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7',   # hwEntityMemUsage
            '1.3.6.1.4.1.2011.6.3.5.1.1.2.0',       # hwMemDevUsage
        ],
        'temp': ['1.3.6.1.4.1.2011.5.25.31.1.1.1.1.11', '1.3.6.1.4.1.2011.6.3.4.1.1.2'],
    },
    'h3c': {
        'cpu': ['1.3.6.1.4.1.25506.2.6.1.1.1.1.6'],   # hh3cEntityExtCpuUsage
        'mem': ['1.3.6.1.4.1.25506.2.6.1.1.1.1.8'],   # hh3cEntityExtMemUsage
        'temp': ['1.3.6.1.4.1.25506.2.6.1.1.1.1.12'],
    },
    'cisco': {
        'cpu': ['1.3.6.1.4.1.9.9.109.1.1.1.1.8'],     # cpmCPUTotal5minRev
        'mem': ['1.3.6.1.4.1.9.9.48.1.1.1.5'],        # ciscoMemoryPoolUsed（配合 Free 算百分比）
        'mem_free': ['1.3.6.1.4.1.9.9.48.1.1.1.6'],   # ciscoMemoryPoolFree
        'temp': ['1.3.6.1.4.1.9.9.13.1.3.1.3'],       # ciscoEnvMonTemperatureValue
    },
    'ruijie': {
        'cpu': ['1.3.6.1.4.1.4881.1.1.10.2.1.1.1.0'],
        'mem': ['1.3.6.1.4.1.4881.1.1.10.2.1.1.2.0'],
        'temp': ['1.3.6.1.4.1.4881.1.1.10.2.7.1.1.1.3'],
    },
    'zte': {
        'cpu': ['1.3.6.1.4.1.3902.3.3005.1.1.4.0'],
        'mem': ['1.3.6.1.4.1.3902.3.3005.1.1.5.0'],
        'temp': ['1.3.6.1.4.1.3902.3.3005.1.1.11.1.1.2'],
    },
    'juniper': {
        'cpu': ['1.3.6.1.4.1.2636.3.1.13.1.7'],       # jnxOperatingCPU（表，取 Routing Engine 最大值）
        'mem': ['1.3.6.1.4.1.2636.3.1.13.1.11'],      # jnxOperatingBuffer
        'temp': ['1.3.6.1.4.1.2636.3.1.13.1.8'],      # jnxOperatingTemp
    },
    'fortinet': {
        'cpu': ['1.3.6.1.4.1.12356.101.4.1.4.0'],     # fgSysCpuUsage
        'mem': ['1.3.6.1.4.1.12356.101.4.1.3.0'],     # fgSysMemUsage
        'temp': [],
    },
}

# sysDescr 关键字 → 厂商，用于未显式指定厂商时的自动识别
VENDOR_SYSDESCR_HINTS = [
    ('huawei', ('huawei', 'vrp', 'quidway')),
    ('h3c', ('h3c', 'comware', 'hp comware')),
    ('cisco', ('cisco', 'ios', 'nx-os')),
    ('ruijie', ('ruijie', 'rgos')),
    ('zte', ('zte', 'zxros')),
    ('juniper', ('juniper', 'junos')),
    ('fortinet', ('fortinet', 'fortigate', 'fortios')),
]

OPER_STATUS_UP = 1
OPER_STATUS_DOWN = 2
ADMIN_STATUS_UP = 1

COUNTER32_MAX = 2 ** 32
COUNTER64_MAX = 2 ** 64