# telegram-market-watcher setup

## 1) What you need

For Telegram **user account** auth:
- `api_id`
- `api_hash`
- phone number
- login OTP
- 2FA password if enabled

Create `api_id` / `api_hash` at `https://my.telegram.org`.

## 2) Install dependency

```bash
python3 -m pip install telethon
```

If `pip` is missing, install it for your system first.

## 3) Session storage

This skill stores sessions under:

```text
/home/nguyenhungthinhctk34/.openclaw/clawdbot/skills-data/telegram-market-watcher/sessions/
```

Each profile gets its own `.session` file.

Examples:
- `default.session`
- `buying.session`
- `backup.session`

## 4) First-time login

```bash
python3 skills/telegram-market-watcher/scripts/scan_market.py auth \
  --api-id 123456 \
  --api-hash YOUR_API_HASH \
  --phone +84xxxxxxxxx \
  --profile default
```

The script will:
1. connect to Telegram
2. ask for OTP if needed
3. ask for 2FA password if needed
4. save the local session file

## 5) Verify session

```bash
python3 skills/telegram-market-watcher/scripts/scan_market.py whoami --profile default
```

## 6) Prepare config

Copy the example and edit it:

```bash
cp skills/telegram-market-watcher/assets/config.example.json /tmp/telegram-market.json
```

Fill in:
- `product`
- `needed_quantity`
- `queries`
- `sources`

## 7) Run scan

```bash
python3 skills/telegram-market-watcher/scripts/scan_market.py scan \
  --profile default \
  --config /tmp/telegram-market.json
```

## 8) Source types

### user
Direct seller account such as `@seller123`.

### bot
Telegram bot such as `@bestmarket_bot`.

### channel
Read-only or mostly read-only source. Good for passive price monitoring, not always good for active query/reply.

### group
Useful for offer discovery, but parsing can be noisy.

## 9) Parsing rules

The script extracts rough signals from replies/messages:
- price patterns like `100k`, `100,000`, `120k/slot`, `250k 1m`
- stock patterns like `còn 5`, `5 slot`, `available 3`, `sold out`

This is heuristic, not perfect. For messy sellers/bots, expect occasional manual review.

## 10) Current limitations

- does not handle button-driven or captcha-heavy bot flows robustly
- does not auto-buy
- does not guarantee every seller replies within the waiting window
- channel/group parsing may pull stale messages if the source is noisy

## 11) Recommended operating model

Start with:
- a small trusted seller list
- one or two consistent query templates
- short wait windows
- manual review before buying

Once the outputs look stable, add more sources and stronger scoring rules.
