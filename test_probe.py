import unittest

from probe import classify_price, normalize


class PriceEvidenceTests(unittest.TestCase):
    def test_masked_amount_is_not_a_numeric_price(self):
        for value in ("¥4xx", "¥5XX", "￥6**"):
            with self.subTest(value=value):
                result = classify_price(value)
                self.assertEqual(result["state"], "masked")
                self.assertIsNone(result["display_amount"])

    def test_missing_is_distinct_from_zero(self):
        self.assertEqual(classify_price(None)["state"], "missing")
        self.assertEqual(classify_price("¥0")["display_amount"], "0")

    def test_exact_decimal_is_preserved(self):
        self.assertEqual(classify_price("￥1,234.50")["display_amount"], "1234.50")

    def test_indicative_price_is_not_a_total(self):
        for value in ("¥500起", "约500元", "¥500~800", "500+税费", "-50", True):
            with self.subTest(value=value):
                self.assertIsNone(classify_price(value)["display_amount"])

    def test_real_trial_shape_stays_ineligible(self):
        data = {"status": 0, "message": "success", "systemMessage": "当前为体验模式",
                "data": {"itemList": [{"name": "测试酒店", "price": "¥4xx", "shId": "90071992547409999"}]}}
        result = normalize(data, {"kind": "hotel", "adults": 2}, "2026-10-31T08:00:00Z")
        self.assertEqual(result["status"], "masked_prices")
        self.assertEqual(result["comparable_quote_count"], 0)
        self.assertTrue(result["trial_mode"])
        self.assertEqual(result["quotes"][0]["provider_property_id"], "90071992547409999")

    def test_exact_display_is_not_assumed_to_include_tax_or_two_seats(self):
        data = {"status": 0, "data": {"itemList": [{"adultPrice": "¥400.00", "journeys": []}]}}
        result = normalize(data, {"kind": "flight", "adults": 2}, "2026-10-31T08:00:00Z")
        self.assertEqual(result["status"], "discovery_only")
        self.assertEqual(result["quotes"][0]["price"]["display_amount"], "400.00")
        self.assertIsNone(result["quotes"][0]["total_for_requested_party"])
        self.assertIsNone(result["quotes"][0]["taxes_included"])
        self.assertFalse(result["quotes"][0]["comparable"])

    def test_application_error_is_not_no_availability(self):
        result = normalize({"status": 1, "message": "搜索机票低价行业失败", "data": None},
                           {"kind": "flight"}, "2026-10-31T08:00:00Z")
        self.assertEqual(result["status"], "provider_error")
        self.assertEqual(result["quotes"], [])
        self.assertIsNone(result["trial_mode"])

    def test_empty_response_is_explicit(self):
        result = normalize({"status": 0, "data": {"itemList": []}},
                           {"kind": "hotel"}, "2026-10-31T08:00:00Z")
        self.assertEqual(result["status"], "empty_response")

    def test_malformed_success_is_not_treated_as_no_rooms(self):
        for data in (None, [], {}, {"itemList": "bad"}, {"itemList": [None]}):
            with self.subTest(data=data):
                result = normalize({"status": 0, "data": data}, {"kind": "hotel"}, "2026-10-31T08:00:00Z")
                self.assertEqual(result["status"], "unexpected_response")


if __name__ == "__main__":
    unittest.main()
