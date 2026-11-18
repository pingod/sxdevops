"""CMDB 资产密码加解密（平台统一密钥，见 sxdevops.secrets）。"""
from django.core.exceptions import ImproperlyConfigured

from sxdevops import secrets as platform_secrets


class ConfigItemPasswordDecryptionError(Exception):
    pass


def encrypt_config_item_password(password):
    if password in (None, ''):
        raise ValueError('密码不能为空。')
    try:
        return platform_secrets.encrypt(str(password))
    except platform_secrets.SecretError as exc:
        raise ImproperlyConfigured(str(exc)) from exc


def decrypt_config_item_password(ciphertext):
    if not ciphertext:
        raise ConfigItemPasswordDecryptionError('资产密码密文为空。')
    # 密钥缺失按配置错误处理（视图返回 503），密文损坏按解密失败处理（视图返回 422）。
    try:
        platform_secrets.get_fernet()
    except platform_secrets.SecretError as exc:
        raise ImproperlyConfigured(str(exc)) from exc
    try:
        return platform_secrets.decrypt(str(ciphertext))
    except platform_secrets.SecretError as exc:
        raise ConfigItemPasswordDecryptionError('资产密码无法解密，请检查加密密钥是否正确。') from exc
