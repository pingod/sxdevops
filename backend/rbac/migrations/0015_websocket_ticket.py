"""WebSocket 一次性短票据模型。"""
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('rbac', '0014_repository_snapshot'),
    ]

    operations = [
        migrations.CreateModel(
            name='WebSocketTicket',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(db_index=True, max_length=64, unique=True, verbose_name='票据')),
                ('expires_at', models.DateTimeField(verbose_name='过期时间')),
                ('used_at', models.DateTimeField(blank=True, null=True, verbose_name='使用时间')),
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='创建时间')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='ws_tickets', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'WebSocket 票据',
                'verbose_name_plural': 'WebSocket 票据',
                'ordering': ['-created_at'],
            },
        ),
    ]
