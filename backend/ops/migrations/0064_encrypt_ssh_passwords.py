"""把四张表的 SSH 明文口令转成平台密钥密文（带 fernet:v1: 前缀）。"""
from django.db import migrations

from sxdevops import secrets as platform_secrets

TABLES = ['Host', 'TaskResource', 'DockerHost', 'NginxEnvironment']


def _encrypt_existing(apps, model_name):
    model = apps.get_model('ops', model_name)
    converted = 0
    for row in model.objects.exclude(ssh_password='').exclude(ssh_password=None).only('id', 'ssh_password').iterator():
        if platform_secrets.is_encrypted(row.ssh_password):
            continue
        model.objects.filter(pk=row.pk).update(ssh_password=platform_secrets.encrypt(row.ssh_password))
        converted += 1
    return converted


def forward(apps, schema_editor):
    total = 0
    for model_name in TABLES:
        total += _encrypt_existing(apps, model_name)
    if total:
        print(f'已加密 {total} 条 SSH 口令')


class Migration(migrations.Migration):

    dependencies = [
        ('ops', '0063_taskresourcegroup_env_name_unique'),
    ]

    operations = [
        migrations.RunPython(forward, migrations.RunPython.noop),
    ]
