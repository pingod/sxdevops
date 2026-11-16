from types import SimpleNamespace

from django.test import SimpleTestCase

from . import db_executor, sql_checker


class MysqlReadOnlyGuardTests(SimpleTestCase):
    datasource = SimpleNamespace(db_type='mysql')

    def assert_rejected(self, sql):
        self.assertIsNotNone(db_executor.validate_query_content(self.datasource, sql), sql)

    def test_comment_between_tokens_cannot_bypass_guard(self):
        self.assert_rejected("SELECT * FROM t INTO/**/OUTFILE '/tmp/pwn.php'")
        self.assert_rejected("SELECT LOAD_FILE/**/('/etc/passwd')")
        self.assert_rejected('SELECT * FROM t FOR/**/UPDATE')

    def test_plain_select_is_allowed(self):
        self.assertIsNone(db_executor.validate_query_content(self.datasource, 'SELECT id FROM t WHERE id = 1'))


class DmlStatementTypeTests(SimpleTestCase):
    def test_ddl_in_dml_ticket_is_flagged(self):
        results = sql_checker.check_sql('ALTER TABLE t DROP COLUMN c', 'DML', 'mysql')
        self.assertTrue(any(item.level == 'error' for item in results))

    def test_normal_dml_has_no_error(self):
        results = sql_checker.check_sql('UPDATE t SET c = 1 WHERE id = 1', 'DML', 'mysql')
        self.assertFalse(any(item.level == 'error' for item in results))


class InactiveDatasourceTests(SimpleTestCase):
    def test_inactive_datasource_cannot_execute(self):
        datasource = SimpleNamespace(is_active=False, db_type='mysql')
        success, affected, duration, log = db_executor.execute_sql(datasource, 'app', 'UPDATE t SET c=1')
        self.assertFalse(success)
        self.assertIn('停用', log)
