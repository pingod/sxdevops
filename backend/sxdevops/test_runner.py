"""测试运行器：清理 PostgreSQL 上残留的测试库连接。

部分用例会启动后台线程或异步任务，它们在测试结束后仍持有数据库连接，
导致 Django 删除测试库时报 “database is being accessed by other users”。
这里只在测试库销毁前终止这些会话，不影响业务逻辑。
"""
import logging

from django.db import connections
from django.test.runner import DiscoverRunner

logger = logging.getLogger(__name__)


class SxDevOpsTestRunner(DiscoverRunner):
    def teardown_databases(self, old_config, **kwargs):
        for connection, old_name, destroy in old_config:
            if not destroy or connection.vendor != 'postgresql':
                continue
            settings = connection.settings_dict
            connection.close()
            try:
                import psycopg

                with psycopg.connect(
                    dbname='postgres',
                    user=settings.get('USER') or None,
                    password=settings.get('PASSWORD') or None,
                    host=settings.get('HOST') or None,
                    port=settings.get('PORT') or None,
                    autocommit=True,
                ) as admin:
                    admin.execute(
                        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity '
                        'WHERE datname = %s AND pid <> pg_backend_pid()',
                        (old_name,),
                    )
            except Exception:
                logger.warning('failed to terminate lingering connections for %s', old_name, exc_info=True)
        return super().teardown_databases(old_config, **kwargs)