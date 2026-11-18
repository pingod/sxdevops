"""补跑 SSH 口令加密：旧库升级或手工导入数据后使用。"""
from django.core.management.base import BaseCommand

from ops.credentials import encrypt_existing_ssh_passwords


class Command(BaseCommand):
    help = '把 ops 四张表中未加密的 SSH 口令转成平台密钥密文'

    def handle(self, *args, **options):
        count = encrypt_existing_ssh_passwords()
        self.stdout.write(self.style.SUCCESS(f'已加密 {count} 条'))
