from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ops', '0065_inspection_models'),
    ]

    operations = [
        migrations.AlterField(
            model_name='logdatasource',
            name='provider',
            field=models.CharField(
                choices=[
                    ('loki', 'Loki'),
                    ('victorialogs', 'VictoriaLogs'),
                    ('elk', 'ELK / Elasticsearch'),
                    ('sls', '阿里云 SLS'),
                ],
                max_length=16,
                verbose_name='日志类型',
            ),
        ),
    ]