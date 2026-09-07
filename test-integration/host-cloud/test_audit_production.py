import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('audit_production', pathlib.Path(__file__).with_name('audit-production.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class RuntimeAuditTests(unittest.TestCase):
    def test_report_groups_names_without_exposing_comparison_values(self):
        groups = audit.comparison_groups({'api': 'a' * 64, 'identity': 'b' * 64, 'billing': 'b' * 64})
        self.assertEqual(groups, [['api'], ['identity', 'billing']])
        self.assertNotIn('a' * 64, str(groups))

    def test_comparison_refuses_missing_or_malformed_observation(self):
        for value in ['', 'debug sensitive output', '0' * 63]:
            with self.assertRaises(audit.AuditError):
                audit.comparison_groups({'api': value})

    def test_kubernetes_failures_never_echo_child_output(self):
        result = subprocess.CompletedProcess([], 1, 'private stdout', 'private stderr')
        with patch.object(audit.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(audit.AuditError, 'raw output withheld') as error:
                audit.kubectl('exec', 'pod')
        self.assertNotIn('private', str(error.exception))

    def test_database_probes_are_read_only_and_do_not_select_key_digest(self):
        for code in [audit.database_code('nonce'), audit.key_state_code()]:
            self.assertIn('default_transaction_read_only=on', code)
            self.assertIn('statement_timeout=5000', code)
            self.assertNotIn('key_digest', code)


if __name__ == '__main__':
    unittest.main()
