"""平台级凭据加解密工具。

所有 app 的敏感字段统一使用这里的 Fernet（密钥来自 settings.CMDB_PASSWORD_ENCRYPTION_KEY），
密文在库内带 `fernet:v1:` 前缀，便于区分历史明文与已加密值。
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

ENCRYPTED_PREFIX = 'fernet:v1:'
MISSING_KEY_MESSAGE = '未配置 CMDB_PASSWORD_ENCRYPTION_KEY，无法保存或读取凭据。'
INVALID_KEY_MESSAGE = 'CMDB_PASSWORD_ENCRYPTION_KEY 不是有效的 Fernet 密钥。'
DECRYPT_MESSAGE = '凭据无法解密，请检查 CMDB_PASSWORD_ENCRYPTION_KEY 是否正确。'


class SecretError(Exception):
    """密钥缺失或密文无法解密。"""


def _raw_key():
    raw_key = getattr(settings, 'CMDB_PASSWORD_ENCRYPTION_KEY', '')
    if isinstance(raw_key, str):
        raw_key = raw_key.strip().encode('utf-8')
    return raw_key


def get_fernet():
    raw_key = _raw_key()
    if not raw_key:
        raise SecretError(MISSING_KEY_MESSAGE)
    try:
        return Fernet(raw_key)
    except (TypeError, ValueError) as exc:
        raise ImproperlyConfigured(INVALID_KEY_MESSAGE) from exc


def legacy_fernet_from_secret_key(salt):
    """兼容历史实现：用 SHA256(SECRET_KEY + salt) 派生的密钥。"""
    seed = f'{settings.SECRET_KEY}:{salt}'.encode('utf-8')
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(seed).digest()))


def is_encrypted(value):
    return isinstance(value, str) and value.startswith(ENCRYPTED_PREFIX)


def encrypt(plaintext):
    """空值返回空串，其余返回带前缀的密文。"""
    if plaintext in (None, ''):
        return ''
    token = get_fernet().encrypt(str(plaintext).encode('utf-8')).decode('utf-8')
    return f'{ENCRYPTED_PREFIX}{token}'


def decrypt(value):
    """带前缀的密文解密；无前缀视为历史明文原样返回。"""
    if value in (None, ''):
        return ''
    text = str(value)
    if not is_encrypted(text):
        return text
    token = text[len(ENCRYPTED_PREFIX):]
    try:
        return get_fernet().decrypt(token.encode('utf-8')).decode('utf-8')
    except InvalidToken as exc:
        raise SecretError(DECRYPT_MESSAGE) from exc
