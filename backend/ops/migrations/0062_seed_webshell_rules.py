from django.db import migrations

BUILTIN_RULES = [
    ('删除根目录', r'\brm\s+(?:-\w+\s+)*-[rfRF]\w*\s+/(?:\*|\s|$)', 'block', 'critical', 10, '拦截 rm -rf / 与 rm -rf /* 等根目录删除'),
    ('格式化磁盘', r'\bmkfs(?:\.\w+)?\b', 'block', 'critical', 20, '拦截 mkfs 系列格式化命令'),
    ('dd 写裸设备', r'\bdd\b[^|]*\bof=/dev/', 'block', 'critical', 30, '拦截 dd 向块设备写入'),
    ('重定向写裸设备', r'>\s*/dev/(?:sd|nvme|vd|hd)', 'block', 'critical', 40, '拦截重定向覆盖块设备'),
    ('Fork 炸弹', r':\(\)\s*\{[^}]*\}\s*;\s*:', 'block', 'critical', 50, '拦截经典 fork 炸弹'),
    ('关机重启', r'\b(?:shutdown|reboot|halt|poweroff)\b', 'warn', 'warning', 60, '关机/重启命令告警放行并审计'),
    ('清空防火墙', r'\biptables\b[^|]*\s-F\b', 'warn', 'warning', 70, 'iptables -F 清空规则告警'),
    ('根目录权限放开', r'\bchmod\b[^|]*\s777\s+/', 'warn', 'warning', 80, 'chmod 777 作用于根路径告警'),
    ('递归改属主根目录', r'\bchown\s+-R\b[^|]*\s/(?:\s|$)', 'warn', 'warning', 90, 'chown -R 作用于根路径告警'),
    ('清空命令历史', r'\bhistory\s+-c\b', 'audit', 'info', 100, 'history -c 仅记录审计'),
]


def seed_rules(apps, schema_editor):
    Rule = apps.get_model('ops', 'WebShellCommandRule')
    for name, pattern, action, severity, priority, description in BUILTIN_RULES:
        Rule.objects.update_or_create(
            name=name,
            defaults={
                'pattern': pattern, 'action': action, 'severity': severity,
                'priority': priority, 'description': description,
                'enabled': True, 'is_builtin': True,
            },
        )


def unseed_rules(apps, schema_editor):
    Rule = apps.get_model('ops', 'WebShellCommandRule')
    Rule.objects.filter(name__in=[item[0] for item in BUILTIN_RULES], is_builtin=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('ops', '0061_webshellcommandrule'),
    ]

    operations = [
        migrations.RunPython(seed_rules, unseed_rules),
    ]