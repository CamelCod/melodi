# Melodi Delivery Skill

Handles the full delivery flow: preview notification → payment → full song delivery.

---

## Flow

```
intake_complete
    ↓ OpenRouter
prompt_ready
    ↓ Suno auto-flow
preview_ready (preview URL stored in D1)
    ↓ Quality scorer
quality_passed / quality_failed
    ↓
customer notified [preview_ready message]
    ↓ customer approves
payment_intent captured
    ↓
full_song delivered (R2 → Telegram file)
    ↓
order marked complete
    ↓ annual cron
reminder sent next year
```

---

## Preview Notification

When `preview_ready`:
1. Fetch `preview_file_key` from D1
2. Send Telegram message with:
   - Preview audio file
   - "Pay $15 for full HD version" button
   - "Request regeneration" button

---

## Payment Capture

When customer taps "Pay":
1. Call `createPaymentIntent()` in stripe-atlas.js
2. Send Stripe payment page link
3. Customer pays → Stripe webhook fires `payment_intent.succeeded`
4. On webhook: capture PI, update D1 `payment_status = paid`
5. Deliver full song from R2

---

## Full Song Delivery

1. Fetch `full_file_key` from R2 (Suno generates full version after preview approved)
2. Send as Telegram audio file
3. Update D1: `delivered = 1`, `status = complete`
4. Send confirmation with next-year reminder note

---

## Regeneration Flow

If customer taps "Request Regeneration":
1. Set `status = regenerating`
2. Re-run prompt enhancer (with same order data, slightly modified temp)
3. Re-run Suno generation
4. Deliver new preview

---

## Annual Reminder (Phase 2 cron)

Cron: runs Jan 1 + 1 week before each occasion date
- Query: `SELECT * FROM orders WHERE delivered = 1 AND occasion_date NEAR`
- Send: "A year ago you sent a song to [name] for [occasion]..."
- CTA: "Send another this year? → /neworder"
