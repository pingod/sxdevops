"""CostRecord 增加 (ci, month, provider) 唯一约束，先删除历史重复行。"""
from django.db import migrations, models
from django.db.models import Count, Min


def dedupe(apps, schema_editor):
    CostRecord = apps.get_model('cmdb', 'CostRecord')
    duplicates = (
        CostRecord.objects.values('ci_id', 'month', 'provider')
        .annotate(keep=Min('id'), total=Count('id'))
        .filter(total__gt=1)
    )
    removed = 0
    for group in duplicates.iterator():
        stale = CostRecord.objects.filter(
            ci_id=group['ci_id'], month=group['month'], provider=group['provider'],
        ).exclude(pk=group['keep'])
        removed += stale.count()
        stale.delete()
    if removed:
        print(f'已删除 {removed} 条重复成本记录')


class Migration(migrations.Migration):

    dependencies = [
        ('cmdb', '0046_sync_we_integration_service_inventory'),
    ]

    operations = [
        migrations.RunPython(dedupe, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name='costrecord',
            constraint=models.UniqueConstraint(
                fields=('ci', 'month', 'provider'),
                name='cmdb_cost_record_unique_ci_month_provider',
            ),
        ),
    ]
