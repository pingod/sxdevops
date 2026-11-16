from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


class NetworkSecretDecryptionError(Exception):
    pass


def _secret_fernet():
    # 与 CMDB 资产密码共用同一把平台级 Fernet 密钥，运维只需保管一份。
    raw_key = getattr(settings, 'CMDB_PASSWORD_ENCRYPTION_KEY', '')
    if isinstance(raw_key, str):
        raw_key = raw_key.strip().encode('utf-8')
    if not raw_key:
        raise ImproperlyConfigured('未配置 CMDB_PASSWORD_ENCRYPTION_KEY，无法保存或读取 SNMP 凭据。')
    try:
        return Fernet(raw_key)
    except (TypeError, ValueError) as exc:
        raise ImproperlyConfigured('CMDB_PASSWORD_ENCRYPTION_KEY 不是有效的 Fernet 密钥。') from exc


def encrypt_secret(plaintext):
    if plaintext in (None, ''):
        raise ValueError('凭据内容不能为空。')
    return _secret_fernet().encrypt(str(plaintext).encode('utf-8')).decode('utf-8')


def decrypt_secret(ciphertext):
    if not ciphertext:
        raise NetworkSecretDecryptionError('SNMP 凭据密文为空。')
    try:
        return _secret_fernet().decrypt(str(ciphertext).encode('utf-8')).decode('utf-8')
    except InvalidToken as exc:
        raise NetworkSecretDecryptionError('SNMP 凭据无法解密，请检查加密密钥是否正确。') from exc