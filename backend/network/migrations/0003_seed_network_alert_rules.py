from django.db import migrations

BUILTIN_RULES = [
    {'name': '设备 CPU 过高', 'target': 'device', 'metric': 'cpu_pct', 'operator': 'gt', 'threshold': 90, 'severity': 'critical', 'for_seconds': 120, 'description': 'CPU 使用率持续 2 分钟超过 90%。'},
    {'name': '设备内存过高', 'target': 'device', 'metric': 'mem_pct', 'operator': 'gt', 'threshold': 85, 'severity': 'warning', 'for_seconds': 120, 'description': '内存使用率持续 2 分钟超过 85%。'},
    {'name': '设备温度过高', 'target': 'device', 'metric': 'temperature', 'operator': 'gt', 'threshold': 60, 'severity': 'warning', 'for_seconds': 60, 'description': '设备温度持续 1 分钟超过 60℃。'},
    {'name': '设备离线', 'target': 'device', 'metric': 'offline', 'operator': 'gte', 'threshold': 1, 'severity': 'critical', 'for_seconds': 0, 'description': 'SNMP 无响应，设备判定离线立即告警。'},
    {'name': '接口入向利用率过高', 'target': 'interface', 'metric': 'in_util', 'operator': 'gt', 'threshold': 80, 'severity': 'warning', 'for_seconds': 120, 'description': '入向利用率持续 2 分钟超过 80%。'},
    {'name': '接口出向利用率过高', 'target': 'interface', 'metric': 'out_util', 'operator': 'gt', 'threshold': 80, 'severity': 'warning', 'for_seconds': 120, 'description': '出向利用率持续 2 分钟超过 80%。'},
    {'name': '接口入向错包激增', 'target': 'interface', 'metric': 'in_errors', 'operator': 'gt', 'threshold': 100, 'severity': 'warning', 'for_seconds': 0, 'description': '单次采集入向错包增量超过 100。'},
    {'name': '接口出向错包激增', 'target': 'interface', 'metric': 'out_errors', 'operator': 'gt', 'threshold': 100, 'severity': 'warning', 'for_seconds': 0, 'description': '单次采集出向错包增量超过 100。'},
    {'name': '接口中断', 'target': 'interface', 'metric': 'down', 'operator': 'gte', 'threshold': 1, 'severity': 'critical', 'for_seconds': 0, 'description': '管理状态 UP 的接口运行状态转为 DOWN。'},
]


def seed_rules(apps, schema_editor):
    rule_model = apps.get_model('network', 'NetworkAlertRule')
    for item in BUILTIN_RULES:
        rule_model.objects.update_or_create(name=item['name'], defaults={**item, 'enabled': True, 'is_builtin': True})


def unseed_rules(apps, schema_editor):
    rule_model = apps.get_model('network', 'NetworkAlertRule')
    rule_model.objects.filter(name__in=[item['name'] for item in BUILTIN_RULES], is_builtin=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('network', '0002_networkalertrule_networkalertstate'),
    ]

    operations = [
        migrations.RunPython(seed_rules, unseed_rules),
    ]