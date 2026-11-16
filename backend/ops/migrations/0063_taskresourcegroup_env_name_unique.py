from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('ops', '0062_seed_webshell_rules'),
    ]

    operations = [
        migrations.AddConstraint(
            model_name='taskresourcegroup',
            constraint=models.UniqueConstraint(
                condition=models.Q(group_type='environment', parent__isnull=True),
                fields=('name',),
                name='uniq_ops_task_resource_group_env_name',
            ),
        ),
    ]
