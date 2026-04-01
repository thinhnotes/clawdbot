---
name: telegram-market-watcher
description: Monitor Telegram sellers, bots, groups, and channels with a Telegram user account session; send search queries, collect offers, compare price/stock, and rank the best current option. Use when the user wants to scan multiple Telegram sources before buying and keep a reusable logged-in user session.
---

# telegram-market-watcher

Use this skill when the user wants to monitor or compare offers from multiple Telegram sellers/bots/channels using a **Telegram user account** instead of a bot token.

This skill is for:
- searching several Telegram sources for the same product/account
- checking which seller still has stock
- comparing prices and minimum quantities
- keeping a reusable local Telegram user session
- producing a short ranked buying recommendation

This skill is **not** for automatic checkout by default. Start with read/search/compare only unless the user explicitly asks for automation.

## When to use

Use when the user says things like:
- “check which Telegram seller still has stock”
- “compare prices from these Telegram bots/channels”
- “search again and find the best current deal”
- “keep my Telegram user logged in and reuse the session”

## Auth model

Prefer a **Telegram user account session**.

Do **not** start with a Telegram bot token unless the user explicitly wants their own bot. Bot tokens are usually not enough for marketplace-style discovery because they cannot behave like a normal user account across other bots/groups/channels.

Required credentials for user auth:
- `api_id`
- `api_hash`
- phone number
- login code (OTP)
- 2FA password if enabled

Get `api_id` and `api_hash` from:
- `https://my.telegram.org`
- Login → API Development Tools → create an app

The reusable session is stored locally after first login.

## Files in this skill

- `scripts/scan_market.py` — auth, session check, scan, compare
- `assets/config.example.json` — example config for sellers, queries, and scoring
- `references/setup.md` — setup and data model details

Read `references/setup.md` when you need the exact setup steps or config semantics.

## Default workflow

1. Confirm the product/account type the user wants to buy.
2. Confirm the target quantity.
3. Collect the list of Telegram sources:
   - bots
   - sellers/users
   - groups
   - channels
4. Ensure user-session auth is available.
5. If needed, run interactive login:
   - `python3 scripts/scan_market.py auth --api-id <id> --api-hash <hash> --phone <phone> --profile default`
6. Confirm the session is reusable:
   - `python3 scripts/scan_market.py whoami --profile default`
7. Prepare a config file from `assets/config.example.json`.
8. Run a scan:
   - `python3 scripts/scan_market.py scan --profile default --config /path/to/config.json`
9. Summarize:
   - cheapest valid offer
   - best offer that satisfies required quantity
   - any sources that timed out or returned unclear stock

## Output expectations

Keep the final answer compact and decision-friendly.

Prefer a table or bullets with:
- source
- item label
- unit price or package price
- stock / quantity clues
- score / ranking
- short note

Then end with a recommendation like:
- cheapest overall
- best match for requested quantity
- which sources need manual follow-up

## Safety / care

- Treat Telegram login credentials and session files as secrets.
- Do not publish session files or OTPs.
- Do not auto-purchase unless the user clearly asks.
- Avoid message spam; send one well-formed query per source, then wait.
- If a bot requires buttons/captcha/custom flows, report that manual handling is needed.

## Common commands

Auth:
- `python3 scripts/scan_market.py auth --api-id <id> --api-hash <hash> --phone <phone> --profile default`

Check session:
- `python3 scripts/scan_market.py whoami --profile default`

Scan market:
- `python3 scripts/scan_market.py scan --profile default --config assets/config.example.json`

## Notes

- This skill uses Telethon in Python.
- If Telethon is missing, install it with `python3 -m pip install telethon`.
- Session files are stored under the workspace at `skills-data/telegram-market-watcher/sessions/`.
- Start with the compare-only workflow. Only add buy automation in a later iteration if the user really wants it.
