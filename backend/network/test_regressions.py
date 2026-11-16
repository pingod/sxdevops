from types import SimpleNamespace

from django.test import SimpleTestCase

from .views import _parse_hours


class HoursParsingTests(SimpleTestCase):
    def make_request(self, hours):
        return SimpleNamespace(query_params={'hours': hours})

    def test_nan_falls_back_to_default(self):
        self.assertEqual(_parse_hours(self.make_request('nan')), 24)

    def test_infinity_falls_back_to_default(self):
        self.assertEqual(_parse_hours(self.make_request('inf')), 24)

    def test_normal_value_is_clamped(self):
        self.assertEqual(_parse_hours(self.make_request('6')), 6)
        self.assertEqual(_parse_hours(self.make_request('99999')), 720)
