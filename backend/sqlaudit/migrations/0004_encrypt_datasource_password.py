"""数据源口令改为密文列，并把历史明文加密。"""
from django.db import migrations, models

from sxdevops import secrets as platform_secrets


def encrypt_existing(apps, schema_editor):
    DataSource = apps.get_model('sqlaudit', 'DataSource')
    converted = 0
    for row in DataSource.objects.exclude(password_encrypted='').exclude(password_encrypted=None).iterator():
        if platform_secrets.is_encrypted(row.password_encrypted):
            continue
        DataSource.objects.filter(pk=row.pk).update(
            password_encrypted=platform_secrets.encrypt(row.password_encrypted),
        )
        converted += 1
    if converted:
        print(f'已加密 {converted} 条数据源口令')


class Migration(migrations.Migration):

    dependencies = [
        ('sqlaudit', '0003_postgresql_datasource'),
    ]

    operations = [
        migrations.RenameField(
            model_name='datasource',
            old_name='password',
            new_name='password_encrypted',
        ),
        migrations.AlterField(
            model_name='datasource',
            name='password_encrypted',
            field=models.CharField(blank=True, default='', max_length=1024, verbose_name='密码密文'),
        ),
        migrations.RunPython(encrypt_existing, migrations.RunPython.noop),
    ]
