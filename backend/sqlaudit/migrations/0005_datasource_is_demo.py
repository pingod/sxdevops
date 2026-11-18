"""新增演示数据源标记，避免按名称推断演示行为。"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sqlaudit', '0004_encrypt_datasource_password'),
    ]

    operations = [
        migrations.AddField(
            model_name='datasource',
            name='is_demo',
            field=models.BooleanField(default=False, verbose_name='演示数据源'),
        ),
    ]
