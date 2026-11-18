"""MCP 鉴权配置改为密文列，并把历史明文加密。"""
import json

from django.db import migrations, models

from sxdevops import secrets as platform_secrets


def encrypt_existing(apps, schema_editor):
    AIOpsMCPServer = apps.get_model('aiops', 'AIOpsMCPServer')
    converted = 0
    for row in AIOpsMCPServer.objects.exclude(auth_config_encrypted='').exclude(auth_config_encrypted=None).iterator():
        raw = row.auth_config_encrypted
        if platform_secrets.is_encrypted(raw):
            continue
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            value = {}
        if not value:
            AIOpsMCPServer.objects.filter(pk=row.pk).update(auth_config_encrypted='')
            continue
        AIOpsMCPServer.objects.filter(pk=row.pk).update(
            auth_config_encrypted=platform_secrets.encrypt(json.dumps(value, ensure_ascii=False)),
        )
        converted += 1
    if converted:
        print(f'已加密 {converted} 条 MCP 鉴权配置')


class Migration(migrations.Migration):

    dependencies = [
        ('aiops', '0030_aiopsmodelinvocation_modeling_purpose'),
    ]

    operations = [
        migrations.RenameField(
            model_name='aiopsmcpserver',
            old_name='auth_config',
            new_name='auth_config_encrypted',
        ),
        migrations.AlterField(
            model_name='aiopsmcpserver',
            name='auth_config_encrypted',
            field=models.TextField(blank=True, default='', verbose_name='鉴权配置密文'),
        ),
        migrations.RunPython(encrypt_existing, migrations.RunPython.noop),
    ]
