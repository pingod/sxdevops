"""网络设备 SNMP 凭据加解密（与 CMDB 资产密码共用平台密钥）。"""
from django.core.exceptions import ImproperlyConfigured

from sxdevops import secrets as platform_secrets


class NetworkSecretDecryptionError(Exception):
    pass


def encrypt_secret(plaintext):
    if plaintext in (None, ''):
        raise ValueError('凭据内容不能为空。')
    try:
        return platform_secrets.encrypt(str(plaintext))
    except platform_secrets.SecretError as exc:
        raise ImproperlyConfigured(str(exc)) from exc


def decrypt_secret(ciphertext):
    if not ciphertext:
        raise NetworkSecretDecryptionError('SNMP 凭据密文为空。')
    try:
        platform_secrets.get_fernet()
    except platform_secrets.SecretError as exc:
        raise ImproperlyConfigured(str(exc)) from exc
    try:
        return platform_secrets.decrypt(str(ciphertext))
    except platform_secrets.SecretError as exc:
        raise NetworkSecretDecryptionError('SNMP 凭据无法解密，请检查加密密钥是否正确。') from exc
