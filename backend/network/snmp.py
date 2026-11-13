"""pysnmp 7 asyncio 客户端封装：v2c/v3 GET 与 WALK，值类型归一化。"""
import logging
from dataclasses import dataclass

from pysnmp.hlapi.v3arch import asyncio as snmp_api
from pysnmp.proto.rfc1902 import Counter32, Counter64, Gauge32, Integer32, TimeTicks, Unsigned32
from pysnmp.smi.rfc1902 import ObjectIdentity, ObjectType

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 5
DEFAULT_RETRIES = 2
BULK_MAX_REPETITIONS = 25

_INT_TYPES = (Counter32, Counter64, Gauge32, Integer32, TimeTicks, Unsigned32)

_AUTH_PROTOCOLS = {
    'md5': snmp_api.usmHMACMD5AuthProtocol,
    'sha': snmp_api.usmHMACSHAAuthProtocol,
    'sha224': snmp_api.usmHMAC128SHA224AuthProtocol,
    'sha256': snmp_api.usmHMAC192SHA256AuthProtocol,
    'sha384': snmp_api.usmHMAC256SHA384AuthProtocol,
    'sha512': snmp_api.usmHMAC384SHA512AuthProtocol,
}
_PRIV_PROTOCOLS = {
    'des': snmp_api.usmDESPrivProtocol,
    'aes128': snmp_api.usmAesCfb128Protocol,
    'aes192': snmp_api.usmAesCfb192Protocol,
    'aes256': snmp_api.usmAesCfb256Protocol,
}


class SnmpError(Exception):
    pass


@dataclass
class SnmpTarget:
    host: str
    port: int = 161
    version: str = 'v2c'
    community: str = ''
    v3_username: str = ''
    v3_auth_protocol: str = 'none'
    v3_auth_key: str = ''
    v3_priv_protocol: str = 'none'
    v3_priv_key: str = ''
    timeout: int = DEFAULT_TIMEOUT
    retries: int = DEFAULT_RETRIES


def target_from_device(device, timeout=DEFAULT_TIMEOUT, retries=DEFAULT_RETRIES) -> SnmpTarget:
    credential = device.credential
    return SnmpTarget(
        host=device.mgmt_ip,
        port=device.snmp_port,
        version=credential.version,
        community=credential.community,
        v3_username=credential.v3_username,
        v3_auth_protocol=credential.v3_auth_protocol,
        v3_auth_key=credential.v3_auth_key,
        v3_priv_protocol=credential.v3_priv_protocol,
        v3_priv_key=credential.v3_priv_key,
        timeout=timeout,
        retries=retries,
    )


def _auth_data(target: SnmpTarget):
    if target.version == 'v3':
        auth_protocol = _AUTH_PROTOCOLS.get(target.v3_auth_protocol)
        priv_protocol = _PRIV_PROTOCOLS.get(target.v3_priv_protocol)
        return snmp_api.UsmUserData(
            target.v3_username,
            authKey=target.v3_auth_key or None,
            privKey=target.v3_priv_key or None,
            authProtocol=auth_protocol or snmp_api.usmNoAuthProtocol,
            privProtocol=priv_protocol or snmp_api.usmNoPrivProtocol,
        )
    return snmp_api.CommunityData(target.community, mpModel=1)


def _normalize(value):
    if isinstance(value, _INT_TYPES):
        return int(value)
    if hasattr(value, 'asOctets'):
        raw = value.asOctets()
        try:
            return raw.decode('utf-8')
        except UnicodeDecodeError:
            return raw
    return str(value)


def _check_error(error_indication, error_status, error_index):
    if error_indication:
        raise SnmpError(str(error_indication))
    if error_status:
        raise SnmpError(f'SNMP 错误 {error_status.prettyPrint()} @ {error_index}')


async def snmp_get(target: SnmpTarget, oids, engine=None) -> dict:
    """单次 GET 多个标量 OID，返回 {oid: 值}；不存在/无此对象的 OID 值为 None。

    传入 engine 可复用同一引擎（一次设备采集共用，v3 引擎发现只做一次）；
    不传则自建自毁，兼容单次调用场景。
    """
    own_engine = engine is None
    engine = engine or snmp_api.SnmpEngine()
    try:
        transport = await snmp_api.UdpTransportTarget.create(
            (target.host, target.port), timeout=target.timeout, retries=target.retries,
        )
        var_binds_types = [ObjectType(ObjectIdentity(oid)) for oid in oids]
        error_indication, error_status, error_index, var_binds = await snmp_api.get_cmd(
            engine, _auth_data(target), transport, snmp_api.ContextData(),
            *var_binds_types, lookupMib=False,
        )
        _check_error(error_indication, error_status, error_index)
        result = {}
        for oid, value in var_binds:
            key = str(oid)
            if value is None or value.__class__.__name__ in ('NoSuchObject', 'NoSuchInstance', 'EndOfMibView'):
                result[key] = None
            else:
                result[key] = _normalize(value)
        return result
    finally:
        if own_engine:
            engine.close_dispatcher()


async def snmp_walk(target: SnmpTarget, base_oid: str, engine=None) -> list:
    """WALK 一棵子树，返回 [(完整 OID 字符串, 值)]；v2c/v3 用 GETBULK。"""
    own_engine = engine is None
    engine = engine or snmp_api.SnmpEngine()
    rows = []
    try:
        transport = await snmp_api.UdpTransportTarget.create(
            (target.host, target.port), timeout=target.timeout, retries=target.retries,
        )
        async for error_indication, error_status, error_index, var_binds in snmp_api.bulk_walk_cmd(
            engine, _auth_data(target), transport, snmp_api.ContextData(),
            0, BULK_MAX_REPETITIONS, ObjectType(ObjectIdentity(base_oid)),
            lexicographicMode=False, lookupMib=False,
        ):
            _check_error(error_indication, error_status, error_index)
            for oid, value in var_binds:
                rows.append((str(oid), _normalize(value)))
        return rows
    finally:
        if own_engine:
            engine.close_dispatcher()


def create_engine():
    """为一次设备采集创建可复用的 SNMP 引擎。"""
    return snmp_api.SnmpEngine()


def close_engine(engine):
    engine.close_dispatcher()


def walk_index(full_oid: str, base_oid: str) -> str:
    """从完整 OID 中截取表索引部分（可能多级，如 '1' 或 '1.2'）。"""
    prefix = base_oid.rstrip('.') + '.'
    return full_oid[len(prefix):] if full_oid.startswith(prefix) else ''


def format_mac(value) -> str:
    if isinstance(value, bytes):
        return ':'.join(f'{byte:02x}' for byte in value)
    return str(value or '')