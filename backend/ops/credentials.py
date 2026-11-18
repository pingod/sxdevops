"""SSH 主机口令的加解密封装。

Host / TaskResource / DockerHost / NginxEnvironment 四张表的 ssh_password 列存密文
（`fernet:v1:` 前缀），历史明文值读取时按原样返回，写入时统一加密。
"""
from sxdevops import secrets as platform_secrets


def encrypt_password(plaintext):
    if plaintext in (None, ''):
        return ''
    return platform_secrets.encrypt(str(plaintext))


def decrypt_password(value):
    if value in (None, ''):
        return ''
    return platform_secrets.decrypt(str(value))


def password_is_encrypted(value):
    return platform_secrets.is_encrypted(value)


def encrypt_existing_ssh_passwords():
    """把库里仍是明文的 SSH 口令就地加密，返回转换条数。"""
    from .models import DockerHost, Host, NginxEnvironment, TaskResource

    total = 0
    for model in (Host, TaskResource, DockerHost, NginxEnvironment):
        for row in model.objects.exclude(ssh_password='').only('id', 'ssh_password').iterator():
            if password_is_encrypted(row.ssh_password):
                continue
            model.objects.filter(pk=row.pk).update(ssh_password=encrypt_password(row.ssh_password))
            total += 1
    return total
