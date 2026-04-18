# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Melodi is a Telegram bot that turns personal stories into AI-generated custom songs. Users complete a 13-step intake questionnaire → Claude enhances the prompt → Suno generates a preview → user approves → pays $15 → receives the full MP3.

## Commands

```bash
# Deploy the bot worker
wrangler deploy

# Local development
wrangler dev

# Set required secrets before first deploy
wrangler secret put BOT_TOKEN
wrangler secret put OPENROUTER_API_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put SUNO_API_TOKEN

# Apply/migrate database schema
wrangler d1 execute melodi-orders --file=schema.sql --remote

# Inspect DB (primary debugging mechanism — no test suite exists)
wrangler d1 execute melodi-orders --command "SELECT * FROM orders ORDER BY created_at DESC LIMIT 5"
```

There is no automated test suite. Validation is done manually via Telegram + D1 inspection.

## Architecture

### Workers (Cloudflare)

| File | Role |
|------|------|
| `workers/bot-worker.js` | Main Telegram webhook handler. Manages the 13-step intake flow, routes commands and inline-button callbacks, reads/writes KV session state. |
| `workers/suno-worker.js` | Cron-triggered (every 5 min). Picks up orders with `status = 'prompt_ready'`, calls Suno API, polls for completion (max 5 min), writes preview URL to D1, notifies customer via Telegram. |
| `workers/openrouter-client.js` | Calls Claude Sonnet 4 via OpenRouter to enhance raw intake data into a Suno-optimized prompt and produce a quality score (1–10). |
| `workers/stripe-atlas.js` | Creates Stripe PaymentIntents (auth-only, manual capture at $15). Captures on customer approval; auto-voids after 7 days. |
| `mcp/melodi-mcp.js` | MCP tool registry exposing `enhance_prompt`, `score_quality`, `extract_intake`, and `generate_lyrics` to AI assistants. |

### Infrastructure bindings (`wrangler.toml`)

- **KV `SESSIONS`** — per-user session state, 24h TTL
- **D1 `melodi-orders`** — SQLite database (orders, customers, prompt_iterations, metrics_weekly)
- **R2 `SONGS`** — audio file storage

### Data flow

```
Telegram → bot-worker → KV (session) + D1 (order)
                      → openrouter-client (prompt enhancement + quality score)
                      → [cron] suno-worker → Suno API → R2 + D1
                      → stripe-atlas (PaymentIntent)
                      → Telegram (delivery)
```

## Key Conventions

### Order lifecycle (`status` column)
```
new → intake_complete → prompt_ready → generating → preview_ready → awaiting_payment → payment_intent_created → complete
```

### Quality gating
- Score < 5: flag for human review, do not auto-deliver
- Score 5–7: proceed with note
- Score ≥ 8: auto-proceed

### Naming
- Order refs: `MLD-XXXXX` (5-char alphanumeric)
- DB columns: `snake_case`
- JS variables: `camelCase`
- Telegram callback data: `prefix_value` (e.g. `gender_male`, `occ_birthday`)

### Code style
Each worker opens with an Algorithm-First comment block:
```javascript
/**
 * MELODI BOT — Cloudflare Worker
 * GOAL: ...
 * INPUT: ...
 * OUTPUT: ...
 * STEPS: 1. ... 2. ... 3. ...
 */
```

## Skill Docs

Domain rules are codified in these files — read them before modifying the relevant flow:

- `SKILL-intake-agent.md` — intake structuring rules
- `skills/prompt-enhancer/SKILL.md` — prompt engineering process
- `skills/quality-scorer/SKILL.md` — quality gate evaluation
- `skills/delivery/SKILL.md` — preview → payment → delivery flow
