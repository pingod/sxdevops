from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('aiops', '0029_rename_qwen_provider'),
    ]

    operations = [
        migrations.AlterField(
            model_name='aiopsmodelinvocation',
            name='purpose',
            field=models.CharField(
                choices=[
                    ('chat_planning', '聊天规划'),
                    ('answer_formatting', '回答整形'),
                    ('parameter_extraction', '参数抽取'),
                    ('model_probe', '模型探测'),
                    ('connection_test', '连接测试'),
                    ('modeling', '机房建模'),
                ],
                default='chat_planning',
                max_length=32,
                verbose_name='调用目的',
            ),
        ),
    ]
