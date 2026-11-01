#!/usr/bin/env python3
"""Collect reproducible travel observations; incomplete offers are not comparable."""

import argparse
import csv
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from browser_session import target_endpoint
from probe import classify_price, iso_date, positive_int

ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT / "node_modules/@jackwener/opencli"
CLI = PACKAGE / "dist/src/main.js"
EXTENSION = ROOT / "adapters/travel-price/index.mjs"
VERSION = "2.0.2"
EXTENDED_HOTELS = {"agoda", "qunar", "tongcheng", "fliggy", "expedia", "rakuten", "jalan"}
EXTENDED_FLIGHTS = {"qunar", "tongcheng", "fliggy", "expedia"}
SAFE_QUERY = {"city", "hotelid", "hotelId", "checkin", "checkout", "depdate", "adult", "child",
              "infant", "cabin", "ss", "group_adults", "group_children", "no_rooms",
              "selected_currency", "dcity", "acity", "ddate", "quantity", "curr", "locale",
              "dest_id", "dest_type", "triptype", "class", "checkIn", "checkOut", "adults", "rooms", "children", "currency",
              "startDate", "endDate", "regionId", "destination", "latLong", "chkin", "chkout", "rfrr", "room1",
              "checkinDate", "checkoutDate", "adultNum", "roomCount", "stayCount", "screenId", "kenCd", "lrgCd", "distCd",
              "checkInDate", "checkOutDate", "adultCount", "childCount", "roomNum", "inDate", "outDate", "cityId",
              "stayYear", "stayMonth", "stayDay", "roomCrack", "scVal", "crcyCd", "langCd",
              "child1Num", "child2Num", "child3Num", "child4Num", "child5Num", "d1", "d2",
              "startServiceDate", "endServiceDate", "numberOfUnits", "numberOfAdults_1", "fromDate", "toDate", "adultsNumber", "intl",
              "shid", "aNum_1", "cNum_1", "depCity", "arrCity", "depDate", "depCityName", "arrCityName", "tripType",
              "departureCity", "arrivalCity", "advanced", "goDate", "cabinType", "flightType"}
SUCCESS_STATES = {"discovery_only", "reference_data", "empty_response", "no_exact_prices"}


def excluded_providers():
    config_path = ROOT / "trip.json"
    if not config_path.is_file():
        config_path = ROOT / "trip.example.json"
    providers = json.loads(config_path.read_text(encoding="utf-8")).get("excluded_providers", [])
    if not isinstance(providers, list) or any(not isinstance(p, str) for p in providers):
        raise ValueError(f"{config_path.name} excluded_providers must be a list of provider names")
    return frozenset(providers)


def is_public_expedia_flight_param(parts, key, value):
    if parts.hostname != "www.expedia.com" or parts.path != "/Flights-Search":
        return False
    patterns = {"flight-type": r"on", "mode": r"search", "trip": r"oneway", "options": r"cabinclass:economy",
                "passengers": r"adults:[1-9],infantinlap:N",
                "leg1": r"from:Shanghai, China \(SHA-All Airports\),to:Seoul, South Korea,departure:\d{1,2}/\d{1,2}/\d{4}TANYT,fromType:METROCODE,toType:CITY"}
    return key in patterns and re.fullmatch(patterns[key], value) is not None


def sanitize(value):
    """Quote evidence is useful; account identifiers and session-bearing URLs are not."""
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()
                if not re.search(r"cookie|password|token|authorization|session|email|headers", k, re.I)}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, str):
        def clean_url(match):
            parts = urlsplit(match.group(0))
            query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k in SAFE_QUERY or is_public_expedia_flight_param(parts, k, v) or (
                k == "para" and parts.hostname == "www.ly.com" and parts.path == "/iflight/book1.html" and
                re.fullmatch(r"[A-Z]{3}\*[A-Z]{3}\*\d{4}-\d{2}-\d{2}\*\*OW\*[1-9]_0_0\*[A-Z|]+", v))])
            return urlunsplit((parts.scheme, parts.hostname or "", parts.path, query, ""))
        value = re.sub(r"https?://[^\s<>\"']+", clean_url, value)
        return re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", value)
    if isinstance(value, Decimal):
        return format(value, "f")
    return value


def classify_result(payload, returncode, page, search):
    if page.get("login_required"):
        return "needs_login"
    if page.get("verification_required"):
        return "verification_required"
    if search["provider"] == "booking" and search["kind"] == "hotel":
        if page.get("host") == "www.booking.com" and not page.get("path", "").startswith("/searchresults"):
            return "query_redirected"
    if not isinstance(payload, dict):
        return "unexpected_response"
    if payload.get("ok") is not True or returncode != 0:
        error = payload.get("error")
        code = error.get("code") if isinstance(error, dict) else None
        return {"AUTH_REQUIRED": "needs_login", "VERIFICATION_REQUIRED": "verification_required", "WEB_UNAVAILABLE": "web_search_unavailable", "UNVERIFIED_RESPONSE": "adapter_unverified", "TIMEOUT": "timeout",
                "RATE_LIMITED": "rate_limited", "EMPTY_RESULT": "empty_response"}.get(code, "provider_error")
    if not isinstance(payload.get("data"), list) or any(not isinstance(row, dict) for row in payload["data"]):
        return "unexpected_response"
    if not payload["data"]:
        return "empty_response"
    return "reference_data" if search["kind"] == "destination" else "discovery_only"


def normalize(payload, returncode, page, search, observed_at):
    status = classify_result(payload, returncode, page, search)
    result = {"provider": search["provider"], "source": "opencli", "cli_version": VERSION,
              "observed_at": observed_at, "search": search, "page": page, "status": status,
              "process_exit_code": returncode, "quotes": [], "reference_rows": [],
              "comparable_quote_count": 0, "display_price_count": 0,
              "limitations": ["展示金额尚未核实全程必付税费；不代表可支付总价。",
                              "本次结果只反映该网页会话，不保证覆盖 App、会员或优惠券价格。"]}
    if isinstance(payload, dict) and payload.get("error"):
        result["upstream_error"] = sanitize(payload["error"])
    if status == "reference_data":
        result["reference_rows"] = sanitize(payload["data"])
    if status != "discovery_only":
        return result
    for row in payload["data"]:
        provider = search["provider"]
        if row.get("schema") == "flight-observation-v1" and search["kind"] == "flight":
            result["quotes"].append(normalize_flight_observation(row, search))
            notice = (row.get("queryEvidence") or {}).get("service_notice")
            if isinstance(notice, str) and notice not in result["limitations"]:
                result["limitations"].append(sanitize(notice))
            continue
        if row.get("schema") == "hotel-observation-v1" and search["kind"] == "hotel":
            result["quotes"].append(normalize_hotel_observation(row, search))
            continue
        raw_price = row.get("price_amount") if provider == "booking" else row.get("price")
        currency = row.get("price_currency") if provider == "booking" else row.get("currency")
        if provider == "ctrip" and currency in ("¥", "￥"):
            currency = "CNY"
        quote = {"name": row.get("name"), "source_url": sanitize(row.get("url")),
                 "price": classify_price(raw_price), "currency": currency,
                 "currency_basis": "upstream adapter output; checkout not verified",
                 "total_for_requested_party": None, "taxes_included": None, "comparable": False}
        if search["kind"] == "hotel":
            quote.update({"provider_property_id": str(row["hotelId"]) if row.get("hotelId") is not None else row.get("slug"),
                          "address": row.get("address") or row.get("location"),
                          "recommended_room": row.get("recommended_room") or row.get("room"),
                          "price_basis": "listed_stay_amount" if provider == "booking" else "representative_room_display",
                          "party_parameter_supported": provider == "booking",
                          "missing_terms": ["同一物业及具体房型/床型匹配", "餐食", "取消政策", "全程必付总额"]})
            if provider != "booking":
                quote["missing_terms"].append("此上游酒店适配器未传入住人数和间数")
            if provider == "booking":
                taxes = row.get("taxesAndCharges") or ""
                quote["price_for_nights"] = row.get("priceForNights")
                quote["taxes_and_charges"] = taxes or None
                included = "含税费" in taxes or "Includes taxes" in taxes
                quote["listed_taxes_included"] = True if included else (False if taxes.startswith("+") else None)
                amount = quote["price"]["display_amount"]
                extra = re.fullmatch(r"\+(?:US\$|\$|USD\s*)([\d,]+(?:\.\d{1,2})?)(?:税费及其他费用| taxes and charges)", taxes) if currency == "USD" else None
                quote["displayed_stay_total"] = (amount if included else
                    format(Decimal(amount) + Decimal(extra.group(1).replace(",", "")), "f") if amount and extra else None)
            if provider == "trip":
                quote["recommended_room"] = row.get("roomName")
                quote["bed_description"] = row.get("bedDescription")
                quote["room_policy_summary"] = row.get("roomPolicies")
                quote["observed_conditions"] = {"adults": row.get("observedAdults"), "children": row.get("observedChildren"),
                                                "rooms": row.get("observedRooms"), "check_in": row.get("observedCheckIn"),
                                                "check_out": row.get("observedCheckOut")}
                quote["observed_conditions_match"] = (
                    row.get("observedAdults") == search.get("adults") and row.get("observedChildren") == 0 and
                    row.get("observedRooms") == search.get("rooms") and
                    row.get("observedCheckIn") == search.get("check_in", "").replace("-", "") and
                    row.get("observedCheckOut") == search.get("check_out", "").replace("-", ""))
                total_text = row.get("displayedStayTotal")
                # Currency comes from the quote, not an ambiguous dollar/yen glyph.
                numeric = re.fullmatch(r"(?:US\$|\$|USD\s*)?([\d,]+(?:\.\d{1,2})?)", total_text or "") if currency == "USD" else None
                quote["displayed_stay_total"] = format(Decimal(numeric.group(1).replace(",", "")), "f") if numeric else None
                quote["displayed_stay_total_raw"] = total_text
                quote["total_explanation"] = row.get("totalExplanation")
                quote["displayed_taxes_raw"] = row.get("displayedTaxes")
                quote["payment_label"] = row.get("paymentLabel")
                quote["listed_taxes_included"] = True if "incl. taxes & fees" in (row.get("totalExplanation") or "") else None
                quote["price_basis"] = "nightly_display_with_separate_stay_total"
        else:
            quote.update({"flight_no": row.get("flightNo"), "airline": row.get("airline"),
                          "departure_time": row.get("departureTime"), "arrival_time": row.get("arrivalTime"),
                          "departure_airport": row.get("departureAirport"), "arrival_airport": row.get("arrivalAirport"),
                          "cabin": row.get("cabin"), "price_basis": "displayed_fare",
                          "adults_sent": row.get("requestedAdults"),
                          "missing_terms": ["两人可支付总价与库存", "行李额", "退改规则", "各航段完整日期与时区"]})
            quote["collection_method"] = row.get("collectionMethod")
            quote["exhaustive"] = False
            if row.get("collectionMethod") == "rendered_cards_after_timeout":
                quote["price"]["state"] = "starting_from"
                quote["price_basis"] = "starting_fare_from_loaded_cards"
                quote["missing_terms"].append("接口捕获超时，改读当前加载的航班卡片；不代表完整航班列表")
        result["quotes"].append(sanitize(quote))
    result["display_price_count"] = sum(q["price"]["display_amount"] is not None for q in result["quotes"])
    if search["kind"] == "flight" and any(q.get("party_parameter_supported") is False for q in result["quotes"]):
        result["limitations"].append("该机票网页未提供成人数选择；请求中的 2 成人不能视为已执行的两人报价条件。")
    if any(q.get("currency_verified") is False for q in result["quotes"]):
        result["limitations"].append("标记为推定的 CNY 来自中文网页的元/¥展示，尚未取得明确的 ISO 币种字段。")
    if result["quotes"] and result["display_price_count"] == 0:
        result["status"] = "needs_login_for_prices" if page.get("price_login_prompt") else "no_exact_prices"
    return result


def normalize_hotel_observation(row, search):
    observed = row.get("observedSearch") or {}
    matches = None
    if row.get("conditionsVerified") and all(observed.get(k) is not None for k in ("check_in", "check_out", "adults", "rooms", "children")):
        matches = all(observed.get(k) == search.get(k) for k in ("check_in", "check_out", "adults", "rooms")) and observed.get("children") == 0
    total = classify_price(row.get("displayedStayTotal"))["display_amount"]
    price = classify_price(row.get("price"))
    if row.get("priceState") == "starting_from" and price["display_amount"] is not None:
        price["state"] = "starting_from"
    return sanitize({"name": row.get("name"), "provider_property_id": str(row.get("hotelId")) if row.get("hotelId") is not None else None,
                     "source_url": row.get("url"), "address": row.get("address"),
                     "price": price, "price_raw": row.get("priceRaw"), "currency": row.get("currency"),
                     "promotion_label": row.get("promotionLabel"), "base_price_raw": row.get("basePriceRaw"),
                     "currency_basis": (row.get("queryEvidence") or {}).get("currency_basis"), "price_basis": row.get("priceBasis"),
                     "price_label": row.get("priceLabel"), "displayed_stay_total": total,
                     "listed_taxes_included": row.get("listedTaxesIncluded"), "taxes_and_charges": row.get("taxesLabel"),
                     "recommended_room": row.get("room"), "room_policy_summary": row.get("policySummary"),
                     "observed_conditions": observed, "observed_conditions_match": matches, "query_evidence": row.get("queryEvidence"),
                     "party_parameter_supported": row.get("partyParameterSupported", False),
                     "collection_method": row.get("collectionMethod"), "exhaustive": False,
                     "total_for_requested_party": None, "taxes_included": None, "comparable": False,
                     "missing_terms": ["同一物业及具体房型/床型匹配", "餐食与退改政策", "最终可支付金额与所有必付费用"]})


def normalize_flight_observation(row, search):
    observed = row.get("observedSearch") or {}
    matches = None
    if row.get("conditionsVerified") and all(observed.get(k) is not None for k in ("origin", "destination", "date", "adults", "children", "infants")):
        matches = all(observed.get(k) == search.get(k) for k in ("origin", "destination", "date", "adults")) and observed["children"] == 0 and observed["infants"] == 0
    price = classify_price(row.get("price"))
    if row.get("priceState") == "starting_from" and price["display_amount"] is not None:
        price["state"] = "starting_from"
    numbers = row.get("flightNos") or []
    missing = ["两人可支付总价与库存", "具体舱位、行李及退改规则", "各航段完整日期与时区"]
    if not row.get("partyParameterSupported"):
        missing.append("网页未提供成人数选择；两人条件未验证")
    return sanitize({"name": " / ".join(numbers) or row.get("airline"), "flight_no": " / ".join(numbers) or None,
                     "flight_numbers": numbers, "airline": row.get("airline"), "source_url": row.get("url"),
                     "price": price, "price_raw": row.get("priceRaw"), "price_basis": row.get("priceBasis"), "price_label": row.get("priceLabel"),
                     "currency": row.get("currency"), "currency_verified": row.get("currencyVerified"),
                     "currency_basis": (row.get("queryEvidence") or {}).get("currency_basis"),
                     "listed_taxes_included": row.get("listedTaxesIncluded"), "taxes_and_charges": row.get("taxesLabel"),
                     "departure_time": row.get("departureTime"), "arrival_time": row.get("arrivalTime"),
                     "departure_airport": row.get("departureAirport"), "arrival_airport": row.get("arrivalAirport"),
                     "duration": row.get("duration"), "stopover_text": row.get("stopoverText"), "stock_hint": row.get("stockHint"),
                     "observed_conditions": observed, "observed_conditions_match": matches,
                     "query_evidence": row.get("queryEvidence"), "party_parameter_supported": row.get("partyParameterSupported"),
                     "collection_method": row.get("collectionMethod"), "exhaustive": False,
                     "total_for_requested_party": None, "taxes_included": None, "comparable": False, "missing_terms": missing})


def make_command(search):
    provider, kind = search["provider"], search["kind"]
    args = ["node", "--import", str(EXTENSION), str(CLI)]
    if kind == "destination":
        args += [provider, "search", search["query"]]
    elif kind == "hotel":
        if provider in EXTENDED_HOTELS:
            args += ["travel-price", provider + "-hotel", "--city", search["city"], "--adults", str(search["adults"]),
                     "--rooms", str(search["rooms"]), "--currency", search["currency"],
                     "--checkin", search["check_in"], "--checkout", search["check_out"]]
            if search.get("city_id"):
                args += ["--city-id", search["city_id"]]
            return args + ["--limit", str(search["limit"]), "-f", "json", "--site-session", "ephemeral", "--keep-tab", "true"]
        args += (["travel-price", "booking-hotel", search["city"], "--adults", str(search["adults"]),
                  "--rooms", str(search["rooms"]), "--currency", search["currency"]]
                 if provider == "booking" else (["travel-price", "trip-hotel", search["city_id"]]
                 if provider == "trip" else [provider, "hotel-search", search["city_id"]]))
        args += ["--checkin", search["check_in"], "--checkout", search["check_out"]]
        if provider == "booking" and search.get("city_id"):
            args += ["--city-id", search["city_id"]]
        if provider == "trip":
            args += ["--currency", search["currency"]]
    else:
        args += ["travel-price", provider + "-flight", search["origin"], search["destination"],
                 "--date", search["date"], "--adults", str(search["adults"])]
    args += ["--limit", str(search["limit"]), "-f", "json"]
    if kind != "destination":
        args += ["--site-session", "ephemeral", "--keep-tab", "true"]
    return args


def read_page_state(env):
    try:
        completed = subprocess.run(["node", str(ROOT / "browser_state.mjs")], cwd=ROOT,
                                   env=env, text=True, capture_output=True, timeout=12)
        if completed.returncode == 0:
            return json.loads(completed.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return {"observation_unavailable": True}


def write_report(directory, result):
    labels = {"needs_login": "需要登录", "verification_required": "需要人工验证", "query_redirected": "搜索跳转到其他页面",
              "web_search_unavailable": "网页查询不可用",
              "adapter_unverified": "报价提取尚未验证",
              "provider_error": "平台/适配器错误", "timeout": "超时", "unexpected_response": "响应格式异常",
              "discovery_only": "取得展示数据，尚不可直接比价", "reference_data": "取得目的地基础资料", "empty_response": "本次提取为空",
              "needs_login_for_prices": "酒店资料已取得，价格需要登录", "no_exact_prices": "已取得记录，但没有数字价格"}
    basis_labels = {"nightly_display": "每晚展示价", "listed_room_stay_total": "房型全程价", "starting_room_stay_amount": "房间全程起价",
                    "listed_stay_total": "全程展示价", "listed_stay_amount": "全程展示价", "starting_display_period_unverified": "起价，计价周期未核实",
                    "nightly_display_with_separate_stay_total": "每晚价，另列全程额", "representative_room_display": "代表房型展示价",
                    "starting_fare_from_loaded_cards": "已加载航班起价", "listed_flight_amount_party_basis_unverified": "机票展示价，按人/整单未核实",
                    "one_way_per_traveler_starting_fare": "单程每人起价",
                    "listed_per_traveler_tax_inclusive_fare": "每人含税展示价",
                    "displayed_fare": "机票展示价"}
    lines = [f"# {result['provider']} · {result['search']['kind']}", "",
             f"查询时间：{result['observed_at']}", "",
             f"结果：{labels.get(result['status'], result['status'])}。数字展示价格数：{result['display_price_count']}。可直接比价报价数：0。", "",
             "查询条件：", "```json", json.dumps(result["search"], ensure_ascii=False, indent=2), "```", "",
             "| 项目 | 列表展示金额 | 计价口径 | 页面全程金额 | 币种 | 优惠说明 | 人数/日期核对 | 比价状态 |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    for row in result["quotes"]:
        name = (row.get("name") or row.get("flight_no") or "未提供名称").replace("|", "\\|").replace("\n", " ")
        matching = row.get('observed_conditions_match')
        condition = '观测条件不符' if matching is False else ('已核对观测条件' if matching is True else '尚未完整核对')
        amount = row['price']['display_amount'] or row['price']['raw'] or '未提供'
        starting = row['price']['state'] == 'starting_from'
        amount = str(amount) + (' 起' if starting else '')
        total = str(row.get('displayed_stay_total') or '未提供') + (' 起' if starting and row.get('displayed_stay_total') else '')
        currency = (row['currency'] or '未核实') + ('（推定）' if row.get('currency_verified') is False else '')
        basis = basis_labels.get(row.get('price_basis'), row.get('price_basis') or '未核实')
        promotion = (row.get('promotion_label') or '—').replace('|', '\\|').replace('\n', ' ')
        lines.append(f"| {name} | {amount} | {basis} | {total} | {currency} | {promotion} | {condition} | 条件未齐 |")
    if result["reference_rows"]:
        lines += ["", "目的地资料：", "```json", json.dumps(result["reference_rows"], ensure_ascii=False, indent=2), "```"]
    lines += ["", "限制：", *[f"- {item}" for item in result["limitations"]], "",
              "失败或空响应不证明目的地无房/无票。酒店测试区间不代表已确定的行程。", ""]
    if result.get("upstream_error"):
        lines += ["平台返回/采集错误：", "```json", json.dumps(result["upstream_error"], ensure_ascii=False, indent=2), "```", ""]
    (directory / "report.md").write_text("\n".join(lines), encoding="utf-8")
    with (directory / "quotes.csv").open("w", newline="", encoding="utf-8-sig") as out:
        writer = csv.writer(out)
        writer.writerow(["provider", "name_or_flight", "display_amount", "price_state", "price_basis", "displayed_stay_total", "currency", "currency_verified", "promotion_label", "listed_taxes_included", "observed_conditions_match", "comparable", "observed_at", "source_url"])
        for row in result["quotes"]:
            writer.writerow([result["provider"], row.get("name") or row.get("flight_no"), row["price"]["display_amount"], row["price"]["state"], row.get("price_basis"),
                             row.get("displayed_stay_total"), row["currency"], row.get("currency_verified"), row.get("promotion_label"), row.get("listed_taxes_included"), row.get("observed_conditions_match"), False, result["observed_at"], row["source_url"]])


def collect(search):
    if search["provider"] in excluded_providers():
        raise ValueError(f"{search['provider']} 已停止接入，不再执行查询；历史数据保留。")
    if not CLI.is_file():
        raise RuntimeError("Run npm ci --ignore-scripts first")
    actual_version = json.loads((PACKAGE / "package.json").read_text())["version"]
    if actual_version != VERSION:
        raise RuntimeError("OpenCLI version differs from the validated pin")
    started = datetime.now(timezone.utc)
    directory = ROOT / "local/runs" / (started.strftime("%Y%m%dT%H%M%SZ") + "-" + search["provider"] + "-" + search["kind"] + "-" + uuid4().hex[:6])
    directory.mkdir(parents=True, mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCLI_")}
    command = make_command(search)
    payload = None
    page = {}
    returncode = 2
    try:
        if search["kind"] != "destination":
            env["OPENCLI_CDP_ENDPOINT"] = target_endpoint(search["provider"] + "-" + search["kind"] + "-query")
        completed = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
        returncode = completed.returncode
        try:
            payload = json.loads(completed.stdout, parse_float=Decimal)
        except ValueError:
            payload = {"ok": False, "error": {"code": "INVALID_JSON", "message": "OpenCLI stdout was not JSON"}}
    except subprocess.TimeoutExpired:
        payload = {"ok": False, "error": {"code": "TIMEOUT", "message": "Collection exceeded 60 seconds"}}
    except (OSError, RuntimeError):
        payload = {"ok": False, "error": {"code": "BROWSER_SETUP", "message": "Browser or executable setup failed"}}
    if search["kind"] != "destination" and env.get("OPENCLI_CDP_ENDPOINT"):
        page = read_page_state(env)
    result = normalize(payload, returncode, page, search, started.isoformat())
    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    result["provenance"] = {"package_lock_sha256": hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest(),
                            "project_adapter_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                                       for p in sorted(EXTENSION.parent.iterdir()) if p.suffix in (".js", ".mjs")},
                            "command": command}
    for name, value in [("raw.sanitized.json", payload), ("result.json", result)]:
        path = directory / name
        path.write_text(json.dumps(sanitize(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)
    write_report(directory, result)
    refresh_index()
    return result, directory


def refresh_index():
    excluded = excluded_providers()
    latest = {}
    for path in sorted((ROOT / "local/runs").glob("*/result.json")):
        value = json.loads(path.read_text())
        latest[(value["provider"], value["search"]["kind"])] = (path, value)
    active = {key: record for key, record in latest.items() if key[0] not in excluded}
    archived = {key: record for key, record in latest.items() if key[0] in excluded}
    totals = {kind: sum(q["price"]["display_amount"] is not None
                       for (provider, item_kind), (_, value) in active.items() if item_kind == kind
                       for q in value["quotes"]) for kind in ("hotel", "flight")}
    lines = ["# 旅行平台采集结果", "", "酒店通常验证 2027-01-08 至 01-10 首尔；日本平台另用大阪测试区间。各条记录的城市、日期和人数以报告内查询条件为准，均不代表已确定行程。",
             "机票查询目标：2027-01-08 上海 → 首尔，两位成人。各平台实际人数支持情况以报告为准；飞猪本轮未验证成人数。", "",
             f"当前范围各组最新采集记录合计：{totals['hotel']} 条酒店数字展示价、{totals['flight']} 条机票数字展示价。未去重，不代表当前实时价格或可支付总额。",
             "采集范围由 `../trip.json` 的 `excluded_providers` 控制；已停止平台仅保留历史记录，不参与上述数量。"]
    for title, records in [("当前采集范围", active), ("已停止平台的历史记录", archived)]:
        if not records:
            continue
        lines += ["", f"## {title}", "", "| 平台 | 类型 | 状态 | 记录数 | 数字展示价 | 结果 |", "| --- | --- | --- | --- | --- | --- |"]
        for (provider, kind), (path, value) in sorted(records.items()):
            count = len(value["quotes"]) + len(value["reference_rows"])
            priced = sum(q["price"]["display_amount"] is not None for q in value["quotes"])
            report = path.parent.relative_to(ROOT / "local") / "report.md"
            lines.append(f"| {provider} | {kind} | {value['status']} | {count} | {priced} | [查看记录]({report}) |")
    mismatches = [(provider, q['name']) for (provider, kind), (_, value) in latest.items() for q in value['quotes']
                  if q.get('observed_conditions_match') is False]
    if mismatches:
        lines += ["", "房间资料与查询人数/日期字段不一致的记录（保留证据，不用于同条件比价）：",
                  *[f"- {provider}：{name}" for provider, name in mismatches]]
    lines += ["", "金额保留原币种。酒店每晚价与全程金额分别记录；机票展示起价未乘人数。",
              "同一物业、房型、餐食、退改与支付条件尚未完成跨平台匹配，因此可直接比价报价数仍为 0。",
              "每次查询目录包含 `result.json`、`raw.sanitized.json`、`quotes.csv` 和 `report.md`。", ""]
    (ROOT / "local/RESULTS.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="kind", required=True)
    for kind in ["destination", "hotel", "flight"]:
        p = sub.add_parser(kind)
        providers = ["ctrip", "trip"] if kind == "destination" else (["ctrip", "trip", "booking", *sorted(EXTENDED_HOTELS)] if kind == "hotel" else ["ctrip", *sorted(EXTENDED_FLIGHTS)])
        providers = [provider for provider in providers if provider not in excluded_providers()]
        p.add_argument("--provider", choices=providers, required=True)
        p.add_argument("--limit", type=positive_int, default=10)
        if kind == "destination":
            p.add_argument("--query", required=True)
        elif kind == "hotel":
            p.add_argument("--city")
            p.add_argument("--city-id")
            p.add_argument("--check-in", type=iso_date, required=True)
            p.add_argument("--check-out", type=iso_date, required=True)
            p.add_argument("--adults", type=positive_int, default=2)
            p.add_argument("--rooms", type=positive_int, default=1)
            p.add_argument("--currency", default="CNY")
            p.add_argument("--test-window", action="store_true", help="日期只用于接入测试，并非确定行程")
        else:
            p.add_argument("--origin", required=True)
            p.add_argument("--destination", required=True)
            p.add_argument("--date", type=iso_date, required=True)
            p.add_argument("--adults", type=positive_int, default=2)
    args = parser.parse_args()
    if args.kind == "hotel":
        if args.check_in >= args.check_out:
            parser.error("退房日期必须晚于入住日期")
        if (args.provider in ({"booking"} | EXTENDED_HOTELS) and not args.city) or (args.provider in {"ctrip", "trip"} and not args.city_id):
            parser.error("酒店查询需要 --city；携程和 Trip.com 需要 --city-id")
    result, directory = collect(vars(args))
    print(json.dumps({"status": result["status"], "rows": len(result["quotes"]) + len(result["reference_rows"]),
                      "display_price_count": result["display_price_count"], "comparable_quote_count": 0, "directory": str(directory)}, ensure_ascii=False))
    return 0 if result["status"] in SUCCESS_STATES else 2


if __name__ == "__main__":
    sys.exit(main())
