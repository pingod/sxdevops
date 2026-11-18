"""云账号 AK/SK 改为密文列，并把历史明文加密。"""
from django.db import migrations, models

from sxdevops import secrets as platform_secrets


def encrypt_existing(apps, schema_editor):
    CloudCredential = apps.get_model('multicloud', 'CloudCredential')
    converted = 0
    for row in CloudCredential.objects.exclude(access_key_secret_encrypted='').exclude(access_key_secret_encrypted=None).iterator():
        if platform_secrets.is_encrypted(row.access_key_secret_encrypted):
            continue
        CloudCredential.objects.filter(pk=row.pk).update(
            access_key_secret_encrypted=platform_secrets.encrypt(row.access_key_secret_encrypted),
        )
        converted += 1
    if converted:
        print(f'已加密 {converted} 条云账号 AK/SK')


class Migration(migrations.Migration):

    dependencies = [
        ('multicloud', '0004_cloudcredential_verify_ssl'),
    ]

    operations = [
        migrations.RenameField(
            model_name='cloudcredential',
            old_name='access_key_secret',
            new_name='access_key_secret_encrypted',
        ),
        migrations.AlterField(
            model_name='cloudcredential',
            name='access_key_secret_encrypted',
            field=models.CharField(blank=True, default='', max_length=512, verbose_name='Access Key Secret 密文'),
        ),
        migrations.RunPython(encrypt_existing, migrations.RunPython.noop),
    ]
