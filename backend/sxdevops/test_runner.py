"""测试运行器：清理 PostgreSQL 上残留的测试库连接。

部分用例会启动后台线程或异步任务，它们在测试结束后仍持有数据库连接，
并在连接被终止后立即重连，导致 Django 删除测试库时报
“database is being accessed by other users”。

这里改用 PostgreSQL 13+ 的 DROP DATABASE ... WITH (FORCE)，
在销毁**测试库**时强制断开所有会话。测试库名按 Django 规则计算：
TEST["NAME"] 或 test_<主库名>。绝不能直接使用旧配置里的主库名。
非 PostgreSQL 数据库仍走 Django 默认流程。
"""
import logging

from django.test.runner import DiscoverRunner

logger = logging.getLogger(__name__)


def _test_database_name(connection, old_name):
    configured = (connection.settings_dict.get('TEST') or {}).get('NAME')
    if configured:
        return configured
    return f'test_{old_name}'


def _force_drop(connection, database_name):
    settings = connection.settings_dict
    import psycopg
    from psycopg import sql

    connection.close()
    with psycopg.connect(
        dbname='postgres',
        user=settings.get('USER') or None,
        password=settings.get('PASSWORD') or None,
        host=settings.get('HOST') or None,
        port=settings.get('PORT') or None,
        autocommit=True,
    ) as admin:
        admin.execute(
            sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(
                sql.Identifier(database_name)
            )
        )


class SxDevOpsTestRunner(DiscoverRunner):
    def teardown_databases(self, old_config, **kwargs):
        remaining = []
        for connection, old_name, destroy in old_config:
            if destroy and connection.vendor == 'postgresql':
                test_name = _test_database_name(connection, old_name)
                if not test_name or test_name == old_name:
                    remaining.append((connection, old_name, destroy))
                    continue
                try:
                    _force_drop(connection, test_name)
                    continue
                except Exception:
                    logger.warning(
                        'force drop failed for %s, falling back to Django teardown',
                        test_name,
                        exc_info=True,
                    )
            remaining.append((connection, old_name, destroy))
        return super().teardown_databases(remaining, **kwargs)