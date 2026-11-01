#!/usr/bin/env python3
"""Read-only travel source probe. Discovery prices are never booking totals."""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
from datetime import date, datetime, timezone
from decimal import Decimal
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
VERSION = "1.0.16"
CLI = ROOT / ".vendor" / VERSION / "flyai-bundle.cjs"
REGISTRY = "https://registry.npmjs.org/@fly-ai/flyai-cli/" + VERSION


def classify_price(value):
    """Preserve missing, redacted, indicative and exact display prices separately."""
    if value is None or value == "":
        return {"raw": value, "state": "missing", "display_amount": None}
    if isinstance(value, bool):
        return {"raw": value, "state": "unrecognized", "display_amount": None}
    raw = str(value).strip()
    if re.search(r"[xX*＊×]", raw):
        state = "masked"
    elif any(s in raw for s in ("起", "约", "~", "～", "至", "以上", "以下")):
        state = "indicative"
    else:
        # Full match only: never extract 4 from ¥4xx or 500 from ¥500+税费.
        match = re.fullmatch(r"(?:[¥￥]\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s*元)?", raw)
        if match:
            amount = Decimal(match.group(1).replace(",", ""))
            return {"raw": value, "state": "exact_display", "display_amount": format(amount, "f")}
        state = "unrecognized"
    return {"raw": value, "state": state, "display_amount": None}


def normalize(payload, search, observed_at):
    kind = search["kind"]
    result = {
        "provider": "fliggy",
        "source": "official_flyai_cli",
        "cli_version": VERSION,
        "observed_at": observed_at,
        "search": search,
        "status": "provider_error",
        "provider_status": payload.get("status"),
        "provider_message": payload.get("message"),
        "trial_mode": True if "体验模式" in str(payload.get("systemMessage", "")) else None,
        "quotes": [],
        "comparable_quote_count": 0,
        "limitations": [
            "此 CLI 未提供旅客人数/酒店入住人数参数；返回数据不能视为两人可订报价。",
            "展示价格不等于包含税费及必要费用的最终总价。",
            "仅一次单平台查询；不代表全平台最低价。",
        ],
    }
    if payload.get("status") != 0:
        return result
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("itemList"), list):
        result["status"] = "unexpected_response"
        return result
    items = data["itemList"]
    if not items:
        result["status"] = "empty_response"
        result["limitations"].append("本次接口返回为空，不证明平台无房或无票。")
        return result
    for item in items:
        if not isinstance(item, dict):
            continue
        price = classify_price(item.get("price" if kind == "hotel" else "adultPrice"))
        quote = {
            "price": price,
            "currency": "CNY",
            "currency_basis": "FlyAI command reference; not independently checked at checkout",
            "total_for_requested_party": None,
            "taxes_included": None,
            "comparable": False,
        }
        if kind == "hotel":
            quote.update({
                "name": item.get("name"),
                "provider_property_id": str(item["shId"]) if item.get("shId") is not None else None,
                "address": item.get("address"),
                "missing_terms": ["指定人数可订性", "具体房型及床型", "早餐", "取消条件", "全程含税总价"],
            })
        else:
            segments = []
            for journey in item.get("journeys") or []:
                if not isinstance(journey, dict):
                    continue
                for segment in journey.get("segments") or []:
                    if isinstance(segment, dict):
                        segments.append({k: segment.get(k) for k in (
                            "depStationCode", "arrStationCode", "depDateTime", "arrDateTime",
                            "marketingTransportNo", "seatClassName",
                        )})
            quote.update({
                "segments": segments,
                "missing_terms": ["两人同价库存", "含税总价", "托运行李与手提行李", "退改规则"],
            })
        result["quotes"].append(quote)
    if not result["quotes"]:
        result["status"] = "unexpected_response"
    elif any(q["price"]["state"] == "exact_display" for q in result["quotes"]):
        result["status"] = "discovery_only"
    elif any(q["price"]["state"] == "masked" for q in result["quotes"]):
        result["status"] = "masked_prices"
    else:
        result["status"] = "no_exact_prices"
    return result


def fetch_bytes(url, limit):
    with urlopen(url, timeout=25) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError("下载内容超过预期大小。")
    return data


def setup():
    if CLI.is_file():
        return
    meta = json.loads(fetch_bytes(REGISTRY, 1_000_000))
    dist = meta["dist"]
    if not dist["tarball"].startswith("https://registry.npmjs.org/"):
        raise RuntimeError("包下载地址不属于官方 npm registry。")
    content = fetch_bytes(dist["tarball"], 10_000_000)
    expected = "sha512-" + base64.b64encode(hashlib.sha512(content).digest()).decode()
    if dist.get("integrity") != expected:
        raise RuntimeError("npm 包完整性校验失败。")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        member = archive.getmember("package/dist/flyai-bundle.cjs")
        if not member.isfile() or member.size > 10_000_000:
            raise RuntimeError("CLI 文件格式不符合预期。")
        bundle = archive.extractfile(member).read()
    CLI.parent.mkdir(parents=True, exist_ok=True)
    CLI.write_bytes(bundle)
    (CLI.parent / "provenance.json").write_text(json.dumps({
        "package": "@fly-ai/flyai-cli", "version": VERSION,
        "registry": REGISTRY, "integrity": expected,
        "bundle_sha256": hashlib.sha256(bundle).hexdigest(),
    }, indent=2), encoding="utf-8")


def iso_date(value):
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise argparse.ArgumentTypeError("日期格式应为 YYYY-MM-DD。") from exc


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("人数和间数必须大于零。")
    return number


def main():
    parser = argparse.ArgumentParser(description="个人旅行数据源验证；模糊价和条件不全报价不会进入比价。")
    sub = parser.add_subparsers(dest="kind", required=True)
    sub.add_parser("setup", help="下载固定版本官方 CLI 到本项目；校验 SHA-512；不执行安装脚本。")
    for kind in ("flight", "hotel"):
        p = sub.add_parser(kind)
        p.add_argument("--adults", type=positive_int, default=2)
        p.add_argument("--trial", action="store_true", help="忽略已有 FLYAI 环境变量，以体验模式调用。")
        p.add_argument("--output", type=Path)
        if kind == "flight":
            p.add_argument("--origin", required=True)
            p.add_argument("--destination", required=True)
            p.add_argument("--date", type=iso_date, required=True)
        else:
            p.add_argument("--city", required=True)
            p.add_argument("--check-in", type=iso_date, required=True)
            p.add_argument("--check-out", type=iso_date, required=True)
            p.add_argument("--rooms", type=positive_int, default=1)
            p.add_argument("--hotel-name")
    args = parser.parse_args()
    if args.kind == "setup":
        setup()
        print("已准备官方 FlyAI CLI " + VERSION + "，仅存于项目 .vendor 目录。")
        return 0
    if args.kind == "hotel" and args.check_out <= args.check_in:
        parser.error("退房日期必须晚于入住日期。")
    if not shutil.which("node"):
        parser.error("需要 Node.js 18 或更新版本。")
    setup()
    search = {k: v for k, v in vars(args).items() if k not in ("trial", "output")}
    if args.kind == "flight":
        command = ["search-flight", "--origin", args.origin, "--destination", args.destination,
                   "--dep-date", args.date, "--sort-type", "3"]
    else:
        command = ["search-hotel", "--dest-name", args.city, "--check-in-date", args.check_in,
                   "--check-out-date", args.check_out, "--sort", "price_asc"]
        if args.hotel_name:
            command += ["--key-words", args.hotel_name]
    env = {k: v for k, v in os.environ.items() if not (args.trial and k.startswith("FLYAI_"))}
    observed_at = datetime.now(timezone.utc).isoformat()
    try:
        completed = subprocess.run(["node", str(CLI), *command], capture_output=True,
                                   text=True, timeout=45, env=env)
        if completed.returncode:
            result = {"provider": "fliggy", "search": search, "observed_at": observed_at,
                      "status": "cli_error", "returncode": completed.returncode, "quotes": []}
        else:
            payload = json.loads(completed.stdout)
            if not isinstance(payload, dict):
                raise ValueError("Unexpected top-level response")
            result = normalize(payload, search, observed_at)
    except subprocess.TimeoutExpired:
        result = {"provider": "fliggy", "search": search, "observed_at": observed_at,
                  "status": "timeout", "quotes": []}
    except (ValueError, TypeError):
        result = {"provider": "fliggy", "search": search, "observed_at": observed_at,
                  "status": "unexpected_response", "quotes": []}
    result["trial_requested"] = args.trial
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Keep observations separate; existing evidence must not be silently replaced.
        with args.output.open("x", encoding="utf-8") as out:
            out.write(rendered + "\n")
        args.output.chmod(0o600)
    print(rendered)
    return 2 if result["status"] in ("provider_error", "cli_error", "timeout", "unexpected_response") else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # Never dump environment values, request headers, or upstream stderr.
        print("检查未完成（" + type(exc).__name__ + "）；请检查网络、输出路径或参数。", file=sys.stderr)
        sys.exit(2)
