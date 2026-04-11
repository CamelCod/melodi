# Melodi x Make.com Integration Guide

## Overview

Make.com acts as the bridge between the Melodi Cloudflare Worker and Suno.com.
No official Suno API needed — Make.com's browser automation handles the web UI.

```
Melodi Worker  →  Make.com webhook  →  Suno.com (browser)  →  audio URL  →  Melodi Worker  →  Customer
```

---

## Make.com Scenario Setup

### Step 1 — Create a new Scenario

1. Log into Make.com → **Scenarios** → **Create a new scenario**
2. Add the first module: **Webhooks → Custom Webhook**
   - Click "Add" to create a webhook URL
   - Copy the webhook URL — you'll give it to the Melodi Worker
   - Webhook will listen for POST requests with:
     ```json
     {
       "order_ref": "MLD-XXXXX",
       "prompt": "...",
       "customer_telegram_id": "123456"
     }
     ```

### Step 2 — Suno.com Browser Automation

Add module: **Browser → Open Website**
- URL: `https://suno.com/create`
- Note: You must be logged into Suno.com in the Make.com browser first time

### Step 3 — Paste Prompt

Add module: **Browser → Click Element**
- Click the prompt input field on Suno.com

Add module: **Browser → Fill Input**
- Select the prompt textarea
- Value: `{{prompt}}` (from webhook data)

### Step 4 — Click Generate

Add module: **Browser → Click Element**
- Click the "Create" or "Generate" button

### Step 5 — Wait for Generation

Add module: **Browser → Watch for Element**
- Wait for selector: `.song-card` or the "Your songs are ready" banner
- Timeout: 300 seconds (5 min)

### Step 6 — Extract Audio URL

Add module: **Browser → Extract**
- Extract `audio_url` from the song card element
- Pattern: look for `<audio>` src or download link href

### Step 7 — Send URL back to Melodi Worker

Add module: **HTTP → Make a Request**
- URL: `https://melodi-bot.YOUR_SUBDOMAIN.workers.dev/webhook/suno`
- Method: POST
- Body:
  ```json
  {
    "order_ref": "{{order_ref}}",
    "audio_url": "{{audio_url}}"
  }
  ```

---

## Melodi Worker Webhook Handler

Add this endpoint to `bot-worker.js`:

```javascript
// POST /webhook/suno — receives audio URL from Make.com
if (url.pathname === "/webhook/suno") {
  return handleSunoWebhook(request, env);
}

async function handleSunoWebhook(request, env) {
  const { order_ref, audio_url } = await request.json();

  // Update D1 with preview URL
  await env.DB.prepare(`
    UPDATE orders SET
      preview_file_key = ?,
      status = 'preview_ready',
      updated_at = datetime('now')
    WHERE order_ref = ?
  `).bind(audio_url, order_ref).run();

  // Get customer telegram_id
  const order = await env.DB.prepare(`
    SELECT c.telegram_id, o.recipient_name FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE o.order_ref = ?
  `).bind(order_ref).first();

  if (order) {
    await sendMessage(order.telegram_id,
      `✦ *Preview ready* — ${order_ref}\n\nYour song for ${order.recipient_name} is ready! 🎵\n\n[🎵 Listen to Preview](${audio_url})\n\nPay $15 for the full 3-minute HD version → /pay`,
      null, env);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" }
  });
}
```

---

## Environment Variables Needed

```
MAKE_WEBHOOK_URL=https://hook.eu1.make.com/xxxxxxxxxxxxx
```

Set via: `wrangler secret put MAKE_WEBHOOK_URL`

---

## Triggering Generation from Worker

In `finalizeOrder()`, after OpenRouter enhancement:

```javascript
// Trigger Make.com to generate the song
const makePayload = {
  order_ref: orderRef,
  prompt: enhanced.prompt,
  customer_telegram_id: userId
};

await fetch(env.MAKE_WEBHOOK_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(makePayload)
});
```

---

## Make.com Browser Session Tips

1. **First run**: When Make.com opens Suno.com for the first time, you'll need to authenticate manually and grant cookies
2. **Stay logged in**: Suno session cookies in Make.com should persist — set session to "Keep cookie storage between runs"
3. **Avoid detection**: Add a 2-3 second delay between actions to avoid bot detection
4. **Generation time**: Suno takes 1-4 minutes. Set the "Watch for Element" timeout to 300s
5. **Multiple songs**: Suno sometimes generates 2 versions. Extract both audio URLs and send the first

---

## Importable Make.com Template

Download: `melodi-suno-scenario.json` (coming soon)

Or manually recreate using the steps above.

---

## Fallback if Browser Fails

If Suno.com UI changes or browser automation becomes unreliable:

1. Use Suno.com yourself on your phone/desktop
2. Get the audio URL
3. Manually paste it into the D1 database via `wrangler d1 execute`:
   ```bash
   wrangler d1 execute melodi-orders --command "UPDATE orders SET preview_file_key='https://...', status='preview_ready' WHERE order_ref='MLD-XXXXX'"
   ```
4. Worker will pick it up on next customer poll
