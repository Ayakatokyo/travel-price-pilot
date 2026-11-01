from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from opencli_probe import classify_result, collect, excluded_providers, make_command, normalize, refresh_index, sanitize


class OpenCliEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.search = {"kind": "hotel", "provider": "booking", "adults": 2, "rooms": 1}

    def test_fresh_checkout_uses_example_without_creating_private_config(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'trip.example.json').write_text(json.dumps({'excluded_providers': ['qunar', 'tongcheng']}))
            with patch('opencli_probe.ROOT', root):
                self.assertEqual(excluded_providers(), {'qunar', 'tongcheng'})
                self.assertFalse((root / 'trip.json').exists())
                (root / 'trip.json').write_text(json.dumps({'excluded_providers': ['tongcheng']}))
                self.assertEqual(excluded_providers(), {'tongcheng'})

    def test_excluded_provider_does_not_start_browser_or_create_run(self):
        with TemporaryDirectory() as directory, patch('opencli_probe.target_endpoint') as browser, patch('opencli_probe.subprocess.run') as process:
            root = Path(directory)
            (root / 'trip.json').write_text(json.dumps({'excluded_providers': ['qunar', 'tongcheng']}))
            with patch('opencli_probe.ROOT', root):
                for provider in ['qunar', 'tongcheng']:
                    for kind in ['hotel', 'flight']:
                        with self.subTest(provider=provider, kind=kind), self.assertRaisesRegex(ValueError, '已停止接入'):
                            collect({'provider': provider, 'kind': kind})
            browser.assert_not_called()
            process.assert_not_called()
            self.assertFalse((root / 'local/runs').exists())

    def test_result_index_keeps_excluded_history_out_of_current_totals(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'trip.json').write_text(json.dumps({'excluded_providers': ['qunar']}))
            for provider, kind in [('agoda', 'hotel'), ('qunar', 'flight')]:
                run = root / 'local/runs' / f'20261101-{provider}-{kind}'
                run.mkdir(parents=True)
                result = {'provider': provider, 'search': {'kind': kind}, 'status': 'discovery_only',
                          'quotes': [{'price': {'display_amount': '100'}}], 'reference_rows': []}
                (run / 'result.json').write_text(json.dumps(result))
            original = (run / 'result.json').read_bytes()
            with patch('opencli_probe.ROOT', root):
                refresh_index()
            report = (root / 'local/RESULTS.md').read_text()
            current, history = report.split('## 已停止平台的历史记录')
            self.assertIn('1 条酒店数字展示价、0 条机票数字展示价', current)
            self.assertIn('| agoda | hotel |', current)
            self.assertNotIn('| qunar |', current)
            self.assertIn('| qunar | flight | discovery_only | 1 | 1 |', history)
            self.assertEqual((run / 'result.json').read_bytes(), original)

    def test_homepage_redirect_is_not_no_availability(self):
        payload = {"ok": False, "error": {"code": "EMPTY_RESULT"}}
        page = {"host": "www.booking.com", "path": "/index.zh-cn.html"}
        self.assertEqual(classify_result(payload, 66, page, self.search), "query_redirected")

    def test_login_page_is_not_captcha_despite_verification_login_label(self):
        payload = {"ok": False, "error": {"code": "AUTH_REQUIRED", "message": "captcha"}}
        self.assertEqual(classify_result(payload, 77, {"login_required": True}, self.search), "needs_login")

    def test_actual_challenge_has_separate_status(self):
        self.assertEqual(classify_result({}, 77, {"verification_required": True}, self.search), "verification_required")

    def test_success_exit_code_does_not_hide_business_error(self):
        self.assertEqual(classify_result({"ok": False, "error": {"code": "TIMEOUT"}}, 0, {}, self.search), "timeout")

    def test_malformed_success_is_not_empty_inventory(self):
        for payload in [{"ok": True, "data": {}}, {"ok": True, "data": [None]}, [], None]:
            with self.subTest(payload=payload):
                self.assertEqual(classify_result(payload, 0, {}, self.search), "unexpected_response")

    def test_display_price_does_not_become_tax_inclusive_total(self):
        payload = {"ok": True, "data": [{"name": "Example", "price_amount": Decimal("1234.50"), "price_currency": "CNY"}]}
        result = normalize(payload, 0, {}, self.search, "2026-10-31T00:00:00Z")
        quote = result["quotes"][0]
        self.assertEqual(quote["price"]["display_amount"], "1234.50")
        self.assertIsNone(quote["total_for_requested_party"])
        self.assertIsNone(quote["taxes_included"])
        self.assertFalse(quote["comparable"])

    def test_missing_currency_and_amount_are_not_invented(self):
        result = normalize({"ok": True, "data": [{"name": "Example"}]}, 0, {}, self.search, "now")
        self.assertIsNone(result["quotes"][0]["currency"])
        self.assertEqual(result["quotes"][0]["price"]["state"], "missing")

    def test_hotel_party_support_is_explicit(self):
        result = normalize({"ok": True, "data": [{"name": "Example", "price": 500}]}, 0, {},
                           {**self.search, "provider": "ctrip"}, "now")
        self.assertFalse(result["quotes"][0]["party_parameter_supported"])

    def test_signed_links_and_account_fields_do_not_reach_evidence(self):
        output = sanitize({"url": "https://example.com/hotel?checkin=2027-01-08&sid=secret&token=private",
                           "email": "person@example.com", "Cookie": "secret", "note": "person@example.com"})
        self.assertEqual(output["url"], "https://example.com/hotel?checkin=2027-01-08")
        self.assertNotIn("email", output)
        self.assertNotIn("Cookie", output)
        self.assertEqual(output["note"], "[email]")

    def test_flight_command_carries_two_adults(self):
        command = make_command({"provider": "ctrip", "kind": "flight", "origin": "SHA", "destination": "SEL",
                                "date": "2027-01-08", "adults": 2, "limit": 5})
        self.assertIn("travel-price", command)
        self.assertEqual(command[command.index("--adults") + 1], "2")

    def test_trip_detailed_total_is_preserved_without_rounding_or_multiplication(self):
        row = {"name": "Example", "price": 159, "currency": "USD", "displayedStayTotal": "$346.82",
               "totalExplanation": "Total price: $347 incl. taxes & fees", "observedAdults": 2,
               "observedChildren": 0, "observedRooms": 1, "observedCheckIn": "20270108", "observedCheckOut": "20270110"}
        search = {**self.search, "provider": "trip", "check_in": "2027-01-08", "check_out": "2027-01-10"}
        result = normalize({"ok": True, "data": [row]}, 0, {}, search, "now")
        quote = result["quotes"][0]
        self.assertEqual(quote["displayed_stay_total"], "346.82")
        self.assertTrue(quote["observed_conditions_match"])
        self.assertFalse(quote["comparable"])

    def test_booking_extra_taxes_are_added_only_when_explicit(self):
        rows = [{"name": "A", "price_amount": 279, "price_currency": "USD", "taxesAndCharges": "+US$30税费及其他费用"},
                {"name": "B", "price_amount": 144, "price_currency": "USD", "taxesAndCharges": "含税费及其他费用"},
                {"name": "C", "price_amount": 144, "price_currency": "USD"}]
        result = normalize({"ok": True, "data": rows}, 0, {}, self.search, "now")
        self.assertEqual([q["displayed_stay_total"] for q in result["quotes"]], ["309", "144", None])

    def test_hotel_names_without_prices_do_not_count_as_priced_quotes(self):
        result = normalize({"ok": True, "data": [{"name": "Example", "price": None}]}, 0,
                           {"price_login_prompt": True}, {**self.search, "provider": "ctrip"}, "now")
        self.assertEqual(result["status"], "needs_login_for_prices")
        self.assertEqual(result["display_price_count"], 0)
        self.assertEqual(len(result["quotes"]), 1)

    def test_room_guest_count_mismatch_is_not_treated_as_requested_party(self):
        row = {"name": "Example Villa", "price": 184, "currency": "USD", "observedAdults": 4,
               "observedChildren": 0, "observedRooms": 1, "observedCheckIn": "20270108", "observedCheckOut": "20270110"}
        search = {**self.search, "provider": "trip", "check_in": "2027-01-08", "check_out": "2027-01-10"}
        result = normalize({"ok": True, "data": [row]}, 0, {}, search, "now")
        self.assertFalse(result["quotes"][0]["observed_conditions_match"])
        self.assertFalse(result["quotes"][0]["comparable"])

    def test_extended_missing_child_count_is_unknown_not_a_mismatch(self):
        search = {**self.search, "provider": "jalan", "check_in": "2027-01-12", "check_out": "2027-01-14"}
        row = {"schema": "hotel-observation-v1", "name": "Example", "price": "6460", "currency": "JPY",
               "conditionsVerified": True, "observedSearch": {"check_in": search["check_in"], "check_out": search["check_out"],
               "adults": 2, "rooms": 1, "children": None}}
        quote = normalize({"ok": True, "data": [row]}, 0, {}, search, "now")["quotes"][0]
        self.assertIsNone(quote["observed_conditions_match"])
        row["observedSearch"]["children"] = 0
        self.assertTrue(normalize({"ok": True, "data": [row]}, 0, {}, search, "now")["quotes"][0]["observed_conditions_match"])
        row["observedSearch"]["adults"] = 1
        self.assertFalse(normalize({"ok": True, "data": [row]}, 0, {}, search, "now")["quotes"][0]["observed_conditions_match"])

    def test_extended_starting_totals_keep_qualification_and_unknown_tax(self):
        row = {"schema": "hotel-observation-v1", "name": "Example", "price": "132.02", "currency": "USD",
               "priceState": "starting_from", "displayedStayTotal": "132.02", "promotionLabel": "Seasonal Sale Coupon"}
        quote = normalize({"ok": True, "data": [row]}, 0, {}, {**self.search, "provider": "rakuten"}, "now")["quotes"][0]
        self.assertEqual(quote["price"]["state"], "starting_from")
        self.assertEqual(quote["promotion_label"], "Seasonal Sale Coupon")
        self.assertIsNone(quote["listed_taxes_included"])
        self.assertIsNone(quote["total_for_requested_party"])
        self.assertFalse(quote["comparable"])

    def test_flight_tax_label_and_two_adults_do_not_establish_payable_party_total(self):
        search = {"kind": "flight", "provider": "tongcheng", "origin": "SHA", "destination": "SEL", "date": "2027-01-08", "adults": 2}
        row = {"schema": "flight-observation-v1", "flightNos": ["CZ6534", "CZ675"], "price": "797", "priceState": "starting_from",
               "currency": "CNY", "currencyVerified": False, "listedTaxesIncluded": True, "conditionsVerified": True,
               "partyParameterSupported": True, "observedSearch": {"origin": "SHA", "destination": "SEL", "date": search["date"], "adults": 2, "children": 0, "infants": 0}}
        quote = normalize({"ok": True, "data": [row]}, 0, {}, search, "now")["quotes"][0]
        self.assertTrue(quote["observed_conditions_match"])
        self.assertEqual(quote["price"]["display_amount"], "797")
        self.assertIsNone(quote["total_for_requested_party"])
        self.assertIsNone(quote["taxes_included"])
        self.assertFalse(quote["currency_verified"])
        row["observedSearch"]["adults"] = None
        self.assertIsNone(normalize({"ok": True, "data": [row]}, 0, {}, search, "now")["quotes"][0]["observed_conditions_match"])

    def test_only_known_public_tongcheng_search_payload_is_preserved_in_links(self):
        good = "https://www.ly.com/iflight/book1.html?para=SHA*SEL*2027-01-08**OW*2_0_0*Y%7CS%7CC%7CF&sid=secret"
        self.assertIn("para=SHA", sanitize(good))
        self.assertNotIn("secret", sanitize(good))
        self.assertNotIn("para=", sanitize("https://example.com/?para=private"))

    def test_expedia_per_person_fare_is_not_multiplied_into_a_payable_total(self):
        search = {"kind": "flight", "provider": "expedia", "origin": "SHA", "destination": "SEL", "date": "2027-01-08", "adults": 2}
        row = {"schema": "flight-observation-v1", "airline": "Example", "price": "166", "priceState": "starting_from",
               "priceBasis": "one_way_per_traveler_starting_fare", "priceLabel": "One way per traveler", "currency": "USD",
               "currencyVerified": True, "conditionsVerified": True, "partyParameterSupported": True,
               "observedSearch": {"origin": "SHA", "destination": "SEL", "date": search["date"], "adults": 2, "children": 0, "infants": 0}}
        quote = normalize({"ok": True, "data": [row]}, 0, {}, search, "now")["quotes"][0]
        self.assertTrue(quote["observed_conditions_match"])
        self.assertEqual(quote["price"]["display_amount"], "166")
        self.assertEqual(quote["price_basis"], "one_way_per_traveler_starting_fare")
        self.assertEqual(quote["price_label"], "One way per traveler")
        self.assertIsNone(quote["total_for_requested_party"])
        self.assertIsNone(quote["taxes_included"])

    def test_expedia_search_link_preserves_public_route_and_party_without_private_parameters(self):
        from urllib.parse import parse_qs, urlsplit, urlencode
        params = {"trip": "oneway", "mode": "search", "passengers": "adults:2,infantinlap:N", "options": "cabinclass:economy",
                  "leg1": "from:Shanghai, China (SHA-All Airports),to:Seoul, South Korea,departure:1/8/2027TANYT,fromType:METROCODE,toType:CITY",
                  "sid": "private", "token": "private"}
        url = "https://www.expedia.com/Flights-Search?" + urlencode(params)
        clean = parse_qs(urlsplit(sanitize(url)).query)
        self.assertEqual(clean["leg1"], [params["leg1"]])
        self.assertEqual(clean["passengers"], [params["passengers"]])
        self.assertNotIn("private", sanitize(url))
        self.assertNotIn("passengers=", sanitize(url.replace("www.expedia.com", "example.com")))
        self.assertNotIn("passengers=", sanitize("https://www.expedia.com/Flights-Search?passengers=private"))

    def test_mobile_flight_notice_is_retained_without_discarding_quotes_or_inventing_infants(self):
        search = {"kind": "flight", "provider": "qunar", "origin": "SHA", "destination": "SEL", "date": "2027-01-08", "adults": 2}
        row = {"schema": "flight-observation-v1", "price": "796", "currency": "CNY", "conditionsVerified": True,
               "priceBasis": "listed_per_traveler_tax_inclusive_fare", "listedTaxesIncluded": True,
               "observedSearch": {"origin": "SHA", "destination": "SEL", "date": search["date"], "adults": 2, "children": 0, "infants": None},
               "queryEvidence": {"service_notice": "服务调整通知：将于11月4日起停止提供"}}
        result = normalize({"ok": True, "data": [row, row]}, 0, {}, search, "now")
        self.assertEqual(result["display_price_count"], 2)
        self.assertEqual(result["limitations"].count(row["queryEvidence"]["service_notice"]), 1)
        self.assertIsNone(result["quotes"][0]["observed_conditions_match"])
        self.assertIsNone(result["quotes"][0]["total_for_requested_party"])


if __name__ == "__main__":
    unittest.main()
