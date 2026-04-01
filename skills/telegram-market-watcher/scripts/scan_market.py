#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

WORKSPACE = Path("/home/nguyenhungthinhctk34/.openclaw/clawdbot")
SESSION_DIR = WORKSPACE / "skills-data" / "telegram-market-watcher" / "sessions"

PRICE_RE = re.compile(r"(?P<amount>\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?P<unit>k|m|tr|₫|vnd)?", re.IGNORECASE)
STRICT_PRICE_PATTERNS = [
    re.compile(r"(?P<amount>\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?P<unit>k|m|tr)\b", re.IGNORECASE),
    re.compile(r"(?P<amount>\d{2,3}(?:[.,]\d{3})+)\s*(?:đ|₫|vnd)\b", re.IGNORECASE),
    re.compile(r"(?P<amount>\d{4,9})\s*(?:đ|₫|vnd)\b", re.IGNORECASE),
]
STOCK_RE = re.compile(
    r"(?:c[oò]n|available|stock|slot|slots?|sl|qty|quantity)\s*[:=-]?\s*(?P<count>\d+)|(?P<count2>\d+)\s*(?:slot|slots?|acc|accounts?)",
    re.IGNORECASE,
)
SOLD_OUT_RE = re.compile(r"h[eế]t h[aà]ng|sold\s*out|out\s*of\s*stock", re.IGNORECASE)
TIME_HINT_RE = re.compile(r"\b(?:ngày|day|days|tháng|month|months|năm|year|years|trial)\b", re.IGNORECASE)
PROMO_RE = re.compile(r"\b(?:grok|super\s*grok)\b", re.IGNORECASE)


@dataclass
class Offer:
    source_name: str
    target: str
    query: str
    item_label: str
    price_value: Optional[float]
    price_text: Optional[str]
    stock: Optional[int]
    sold_out: bool
    score: float
    note: str
    sample_text: str


def ensure_telethon() -> Tuple[Any, Any]:
    try:
        from telethon import TelegramClient  # type: ignore
        from telethon.errors import SessionPasswordNeededError  # type: ignore
    except ImportError as exc:
        raise SystemExit("Telethon is not installed. Run inside venv: .venv-telegram-market/bin/python -m pip install telethon") from exc
    return TelegramClient, SessionPasswordNeededError


def session_path(profile: str) -> Path:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    return SESSION_DIR / profile


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Telegram market watcher")
    sub = parser.add_subparsers(dest="command", required=True)

    auth = sub.add_parser("auth", help="Log into Telegram and save a reusable session")
    auth.add_argument("--api-id", type=int, required=True)
    auth.add_argument("--api-hash", required=True)
    auth.add_argument("--phone", required=True)
    auth.add_argument("--profile", default="default")

    whoami = sub.add_parser("whoami", help="Show current logged-in Telegram user")
    whoami.add_argument("--api-id", type=int)
    whoami.add_argument("--api-hash")
    whoami.add_argument("--profile", default="default")

    scan = sub.add_parser("scan", help="Send queries / read sources / rank offers")
    scan.add_argument("--api-id", type=int)
    scan.add_argument("--api-hash")
    scan.add_argument("--profile", default="default")
    scan.add_argument("--config", required=True)
    scan.add_argument("--json", action="store_true")

    discover = sub.add_parser("discover", help="Search joined dialogs for a keyword and rank likely offers")
    discover.add_argument("--api-id", type=int)
    discover.add_argument("--api-hash")
    discover.add_argument("--profile", default="default")
    discover.add_argument("--query", required=True)
    discover.add_argument("--needed-quantity", type=int, default=1)
    discover.add_argument("--dialog-limit", type=int, default=80)
    discover.add_argument("--messages-per-dialog", type=int, default=20)
    discover.add_argument("--top", type=int, default=5)
    discover.add_argument("--json", action="store_true")

    return parser.parse_args()


def load_config(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def env_or_arg(value: Optional[Any], env_name: str) -> Any:
    return value if value not in (None, "") else os.getenv(env_name)


def normalize_amount(raw: str, unit: Optional[str]) -> Optional[float]:
    text = raw.strip().lower().replace(",", "")
    try:
        value = float(text)
    except ValueError:
        return None
    if not unit:
        return value
    unit = unit.lower()
    if unit == "k":
        return value * 1000
    if unit in {"m", "tr"}:
        return value * 1_000_000
    return value


def extract_price(text: str) -> Tuple[Optional[float], Optional[str]]:
    best: Optional[Tuple[float, str]] = None
    for match in PRICE_RE.finditer(text):
        amount = match.group("amount")
        unit = match.group("unit")
        value = normalize_amount(amount, unit)
        if value is None:
            continue
        sample = match.group(0)
        if best is None or value < best[0]:
            best = (value, sample)
    return best if best else (None, None)


def extract_strict_prices(text: str) -> List[Tuple[float, str]]:
    matches: List[Tuple[float, str]] = []
    for pattern in STRICT_PRICE_PATTERNS:
        for match in pattern.finditer(text):
            amount = match.group("amount")
            unit = match.groupdict().get("unit")
            value = normalize_amount(amount, unit)
            if value is None or value < 1000:
                continue
            matches.append((value, match.group(0)))
    return matches


def extract_stock(text: str) -> Optional[int]:
    if SOLD_OUT_RE.search(text):
        return 0
    matches = STOCK_RE.search(text)
    if not matches:
        return None
    count = matches.group("count") or matches.group("count2")
    return int(count) if count else None


def score_offer(price_value: Optional[float], stock: Optional[int], sold_out: bool, needed_quantity: int, seller_bonus: int) -> float:
    if sold_out:
        return -1000 + seller_bonus
    score = float(seller_bonus)
    if price_value is not None and price_value > 0:
        score += max(0, 500_000 / price_value)
    if stock is not None:
        score += min(stock, 100)
        if stock >= needed_quantity:
            score += 50
        else:
            score -= 25
    return round(score, 2)


async def build_client(api_id: int, api_hash: str, profile: str):
    TelegramClient, _ = ensure_telethon()
    client = TelegramClient(str(session_path(profile)), api_id, api_hash)
    await client.connect()
    return client


async def auth_flow(api_id: int, api_hash: str, phone: str, profile: str) -> None:
    TelegramClient, SessionPasswordNeededError = ensure_telethon()
    client = TelegramClient(str(session_path(profile)), api_id, api_hash)
    await client.connect()
    try:
        if await client.is_user_authorized():
            me = await client.get_me()
            print(json.dumps({"ok": True, "alreadyAuthorized": True, "id": getattr(me, "id", None), "username": getattr(me, "username", None)}, ensure_ascii=False, indent=2))
            return
        await client.send_code_request(phone)
        code = input("Telegram login code: ").strip()
        try:
            await client.sign_in(phone=phone, code=code)
        except SessionPasswordNeededError:
            password = getpass.getpass("Telegram 2FA password: ")
            await client.sign_in(password=password)
        me = await client.get_me()
        print(json.dumps({"ok": True, "profile": profile, "sessionPath": str(session_path(profile)) + ".session", "id": getattr(me, "id", None), "username": getattr(me, "username", None), "phone": getattr(me, "phone", None)}, ensure_ascii=False, indent=2))
    finally:
        await client.disconnect()


async def whoami_flow(api_id: int, api_hash: str, profile: str) -> None:
    client = await build_client(api_id, api_hash, profile)
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run the auth command first.")
        me = await client.get_me()
        print(json.dumps({"ok": True, "profile": profile, "sessionPath": str(session_path(profile)) + ".session", "id": getattr(me, "id", None), "username": getattr(me, "username", None), "firstName": getattr(me, "first_name", None), "phone": getattr(me, "phone", None)}, ensure_ascii=False, indent=2))
    finally:
        await client.disconnect()


async def fetch_source_messages(client: Any, target: str, limit: int) -> List[Any]:
    entity = await client.get_entity(target)
    messages = []
    async for message in client.iter_messages(entity, limit=limit):
        messages.append(message)
    return messages


async def ask_source(client: Any, target: str, query: str, wait_seconds: int, limit: int) -> List[Any]:
    entity = await client.get_entity(target)
    await client.send_message(entity, query)
    await asyncio.sleep(wait_seconds)
    messages = []
    async for message in client.iter_messages(entity, limit=limit):
        messages.append(message)
    return messages


def choose_best_message_text(messages: List[Any], query: str) -> str:
    texts: List[str] = []
    for msg in messages:
        text = getattr(msg, "message", None)
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    if not texts:
        return ""
    for text in texts:
        if query.lower() not in text.lower():
            return text
    return texts[0]


async def scan_flow(api_id: int, api_hash: str, profile: str, config: Dict[str, Any], as_json: bool) -> None:
    client = await build_client(api_id, api_hash, profile)
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run auth first.")

        needed_quantity = int(config.get("needed_quantity", 1))
        wait_seconds = int(config.get("reply_wait_seconds", 12))
        messages_limit = int(config.get("messages_limit", 8))
        queries = list(config.get("queries", [])) or [f"Còn {config.get('product', 'item')} không? Giá bao nhiêu?"]
        sources = list(config.get("sources", []))
        scoring = dict(config.get("scoring", {}))
        seller_bonus_map = dict(scoring.get("seller_bonus", {}))

        offers: List[Offer] = []
        errors: List[Dict[str, str]] = []

        for source in sources:
            source_name = str(source.get("name") or source.get("target") or "unknown")
            target = str(source.get("target") or "")
            source_type = str(source.get("type") or "user")
            if not target:
                errors.append({"source": source_name, "error": "missing target"})
                continue

            try:
                if source_type in {"channel", "group"}:
                    messages = await fetch_source_messages(client, target, messages_limit)
                    query = "[passive-read]"
                else:
                    query = queries[0]
                    messages = await ask_source(client, target, query, wait_seconds, messages_limit)
            except Exception as exc:
                errors.append({"source": source_name, "error": str(exc)})
                continue

            sample_text = choose_best_message_text(messages, query)
            price_value, price_text = extract_price(sample_text)
            stock = extract_stock(sample_text)
            sold_out = stock == 0 or bool(SOLD_OUT_RE.search(sample_text))
            seller_bonus = int(seller_bonus_map.get(source_name, 0))
            score = score_offer(price_value, stock, sold_out, needed_quantity, seller_bonus)

            offers.append(
                Offer(
                    source_name=source_name,
                    target=target,
                    query=query,
                    item_label=str(config.get("product") or "item"),
                    price_value=price_value,
                    price_text=price_text,
                    stock=stock,
                    sold_out=sold_out,
                    score=score,
                    note=("sold out" if sold_out else "ok"),
                    sample_text=sample_text[:500],
                )
            )

        offers.sort(key=lambda item: item.score, reverse=True)
        payload = {
            "ok": True,
            "profile": profile,
            "product": config.get("product"),
            "neededQuantity": needed_quantity,
            "best": asdict(offers[0]) if offers else None,
            "offers": [asdict(item) for item in offers],
            "errors": errors,
        }

        if as_json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        print(f"Product: {config.get('product')}")
        print(f"Needed quantity: {needed_quantity}")
        print("Offers:")
        for offer in offers:
            price = f"{int(offer.price_value):,}" if offer.price_value else "?"
            stock = "?" if offer.stock is None else str(offer.stock)
            print(f"- {offer.source_name}: score={offer.score} price={price} stock={stock} note={offer.note}")
        if errors:
            print("Errors:")
            for err in errors:
                print(f"- {err['source']}: {err['error']}")
    finally:
        await client.disconnect()


async def discover_flow(api_id: int, api_hash: str, profile: str, query: str, needed_quantity: int, dialog_limit: int, messages_per_dialog: int, top: int, as_json: bool) -> None:
    client = await build_client(api_id, api_hash, profile)
    try:
        if not await client.is_user_authorized():
            raise SystemExit("Session is not authorized. Run auth first.")

        offers: List[Offer] = []
        async for dialog in client.iter_dialogs(limit=dialog_limit):
            try:
                found: List[Any] = []
                async for message in client.iter_messages(dialog.entity, search=query, limit=messages_per_dialog):
                    found.append(message)
                if not found:
                    continue
            except Exception:
                continue

            best_choice: Optional[Tuple[float, str, str]] = None
            for message in found:
                text = getattr(message, "message", None)
                if not isinstance(text, str) or not text.strip():
                    continue
                if not PROMO_RE.search(text):
                    continue
                prices = extract_strict_prices(text)
                if not prices:
                    continue
                price_value, price_text = min(prices, key=lambda item: item[0])
                note_parts: List[str] = []
                if TIME_HINT_RE.search(text):
                    note_parts.append("has term hint")
                if "chính chủ" in text.lower():
                    note_parts.append("owner-upgrade")
                best_choice = (price_value, price_text, text)
                break

            if not best_choice:
                continue

            price_value, price_text, sample_text = best_choice
            stock = extract_stock(sample_text)
            sold_out = stock == 0 or bool(SOLD_OUT_RE.search(sample_text))
            title = dialog.name or getattr(dialog.entity, "username", None) or str(dialog.id)
            offers.append(
                Offer(
                    source_name=title,
                    target=title,
                    query=query,
                    item_label=query,
                    price_value=price_value,
                    price_text=price_text,
                    stock=stock,
                    sold_out=sold_out,
                    score=score_offer(price_value, stock, sold_out, needed_quantity, 0),
                    note=("sold out" if sold_out else "ok"),
                    sample_text=sample_text[:500],
                )
            )

        deduped: List[Offer] = []
        seen = set()
        for offer in sorted(offers, key=lambda item: ((item.price_value or 10**18), -(item.stock or 0), item.source_name.lower())):
            key = (offer.source_name, offer.price_value, offer.sample_text)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(offer)

        payload = {
            "ok": True,
            "profile": profile,
            "query": query,
            "neededQuantity": needed_quantity,
            "offers": [asdict(item) for item in deduped[:top]],
            "count": len(deduped),
        }

        if as_json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return

        print(f"Query: {query}")
        print(f"Needed quantity: {needed_quantity}")
        print(f"Top {top} offers:")
        for offer in deduped[:top]:
            price = f"{int(offer.price_value):,}" if offer.price_value else "?"
            stock = "?" if offer.stock is None else str(offer.stock)
            print(f"- {offer.source_name}: price={price} stock={stock} note={offer.note}")
            print(f"  {offer.sample_text[:180]}")
        print(f"Total matches: {len(deduped)}")
    finally:
        await client.disconnect()


async def main() -> None:
    args = parse_args()
    api_id = env_or_arg(getattr(args, "api_id", None), "TELEGRAM_API_ID")
    api_hash = env_or_arg(getattr(args, "api_hash", None), "TELEGRAM_API_HASH")

    if args.command == "auth":
        await auth_flow(int(args.api_id), str(args.api_hash), str(args.phone), str(args.profile))
        return

    if not api_id or not api_hash:
        raise SystemExit("Missing api credentials. Pass --api-id/--api-hash or set TELEGRAM_API_ID / TELEGRAM_API_HASH.")

    if args.command == "whoami":
        await whoami_flow(int(api_id), str(api_hash), str(args.profile))
        return

    if args.command == "scan":
        config = load_config(str(args.config))
        await scan_flow(int(api_id), str(api_hash), str(args.profile), config, bool(args.json))
        return

    if args.command == "discover":
        await discover_flow(
            int(api_id),
            str(api_hash),
            str(args.profile),
            str(args.query),
            int(args.needed_quantity),
            int(args.dialog_limit),
            int(args.messages_per_dialog),
            int(args.top),
            bool(args.json),
        )
        return

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    asyncio.run(main())
