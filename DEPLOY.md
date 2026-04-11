# Melodi — Deploy Guide

## Prerequisites
- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account with Workers, D1, KV, R2 access

## Secrets to set BEFORE deploy

```bash
# Telegram bot token (from BotFather)
wrangler secret put BOT_TOKEN
# → paste: 8630193372:AAHq-DMmPFxySrftmy6ZK5E35EgvqRLcmio

# OpenRouter API key (for prompt enhancement)
wrangler secret put OPENROUTER_API_KEY
# → your OpenRouter key

# Stripe secret key (Atlas)
wrangler secret put STRIPE_SECRET_KEY
# → sk_live_... or sk_test_...

# Suno API credentials
wrangler secret put SUNO_API_TOKEN
# → your Suno API token
```

## Step 1 — D1 Schema
```bash
wrangler d1 execute melodi-orders --file=schema.sql --remote
```

## Step 2 — Deploy Worker
```bash
wrangler deploy
```

## Step 3 — Set Telegram Webhook
```bash
curl "https://api.telegram.org/bot8630193372:AAHq-DMmPFxySrftmy6ZK5E35EgvqRLcmio/setWebhook?url=https://melodi-bot.YOUR_SUBDOMAIN.workers.dev"
```

## Step 4 — Welcome Mini App (optional)
```bash
wrangler pages deploy . --project-name=melodi-welcome
```

---

## Architecture

```
Telegram User
     ↓
melodi-bot Worker (Cloudflare Workers)
     ├── KV: session state
     ├── D1: orders + customers
     └── R2: song file storage
     ↓
OpenRouter: prompt enhancement + quality scoring
     ↓
Suno API: song generation
     ↓
Stripe Atlas: $15 payment capture
     ↓
User receives preview → approves → pays → gets full MP3
```

## Auto-flow (Phase 2)

Cron trigger runs every 5 min:
1. Query D1 for `status = intake_complete`
2. Call OpenRouter → enhance prompt
3. Update D1 `suno_prompt`, `quality_score`
4. If quality_score ≥ 5 → call Suno API → poll → deliver preview
5. On approval → trigger Stripe payment → deliver full MP3

## Monthly Cost (MVP)

| Service | Free Tier | Cost at 100 orders |
|---|---|---|
| Workers | 100k/day | ~$0 |
| D1 | 5M rows/day | ~$0 |
| KV | 100k reads/day | ~$0 |
| R2 | 10GB | ~$0.15 |
| **Total** | | **~$0.15/mo** |
