/**
 * MELODI SUNO GENERATOR — Cloudflare Worker
 * Runs on cron trigger: every 5 minutes
 * 
 * GOAL: Auto-generate songs for orders where prompt is ready
 * STEPS:
 * 1. Poll D1 for orders with status = 'prompt_ready'
 * 2. Call Suno API to generate song
 * 3. Poll Suno until audio is ready (max 5 min)
 * 4. Update D1 with preview URL
 * 5. Send preview to user via Telegram
 */

const SUNO_API_BASE = "https://studio-api.suno.ai";
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const MAX_POLL_ATTEMPTS = 24; // ~5 min at 12.5s intervals
const POLL_INTERVAL_MS = 12500;

const GENERATION_STEPS = {
  waiting: "waiting",
  in_progress: "in_progress", 
  complete: "complete",
  error: "error"
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Suno Worker running", { status: 200 });
    }

    const payload = await request.json().catch(() => ({}));

    // Called as cron trigger
    if (payload.cron === true) {
      await runGenerationCycle(env);
      return new Response("Cron cycle complete", { status: 200 });
    }

    // Called directly with order_ref
    const { order_ref } = payload;
    if (order_ref) {
      await processOrder(order_ref, env);
      return new Response("OK", { status: 200 });
    }

    return new Response("Unknown request", { status: 400 });
  }
};

// ═══════════════════════════════════════════════════
// MAIN GENERATION CYCLE
// ═══════════════════════════════════════════════════

async function runGenerationCycle(env) {
  // Find all orders with prompt ready
  let orders;
  try {
    const result = await env.DB.prepare(`
      SELECT id, order_ref, customer_id, suno_prompt, quality_score
      FROM orders
      WHERE status = 'prompt_ready'
      AND suno_prompt IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 5
    `).all();
    orders = result.results || [];
  } catch (error) {
    console.error("D1 query error:", error);
    return;
  }

  if (orders.length === 0) return;

  for (const order of orders) {
    await processOrder(order.order_ref, env);
    // Small delay between orders to avoid rate limiting
    await sleep(2000);
  }
}

// ═══════════════════════════════════════════════════
// SINGLE ORDER PROCESSOR
// ═══════════════════════════════════════════════════

async function processOrder(orderRef, env) {
  // Mark as generating
  await updateOrderStatus(orderRef, "generating", env);

  // Load full order
  const order = await loadOrder(orderRef, env);
  if (!order) {
    console.error(`Order not found: ${orderRef}`);
    return;
  }

  // Get customer Telegram ID
  const customer = await loadCustomer(order.customer_id, env);
  if (!customer) {
    console.error(`Customer not found for order: ${orderRef}`);
    return;
  }

  // Call Suno API
  let songData;
  try {
    songData = await generateSong(order.suno_prompt, env);
  } catch (error) {
    console.error(`Suno generation error for ${orderRef}:`, error);
    await updateOrderStatus(orderRef, "generation_failed", env);
    await notifyError(customer.telegram_id, orderRef, error.message, env);
    return;
  }

  // Poll for completion
  const pollResult = await pollForSong(songData.generation_id, env);

  if (pollResult.status === GENERATION_STEPS.error) {
    await updateOrderStatus(orderRef, "generation_failed", env);
    await notifyError(customer.telegram_id, orderRef, pollResult.error, env);
    return;
  }

  // Save preview URL to D1
  const previewUrl = pollResult.audio_url;
  await updateOrderWithPreview(orderRef, previewUrl, env);

  // Update status
  await updateOrderStatus(orderRef, "awaiting_payment", env);

  // Send preview to user
  await sendPreview(customer.telegram_id, orderRef, previewUrl, env);
}

// ═══════════════════════════════════════════════════
// SUNO API CALLS
// ═══════════════════════════════════════════════════

async function generateSong(prompt, env) {
  const response = await fetch(`${SUNO_API_BASE}/api/generation/v2/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUNO_API_KEY}`
    },
    body: JSON.stringify({
      prompt: prompt,
      make_instrumental: false,
      wait_for_model: false // We poll separately
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Suno API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return {
    generation_id: data.generation_id
  };
}

async function pollForSong(generationId, env) {
  const url = `${SUNO_API_BASE}/api/generation/v2/${generationId}`;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const resp = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${env.SUNO_API_KEY}`
        }
      });

      if (!resp.ok) {
        console.error(`Poll error: ${resp.status}`);
        continue;
      }

      const data = await resp.json();

      if (data.status === GENERATION_STEPS.complete) {
        return {
          status: GENERATION_STEPS.complete,
          audio_url: data.audio_url,
          video_url: data.video_url || null
        };
      }

      if (data.status === GENERATION_STEPS.error) {
        return {
          status: GENERATION_STEPS.error,
          error: data.error || "Unknown generation error"
        };
      }

      // still in_progress — continue polling
      console.log(`Generation ${generationId}: attempt ${attempt + 1}, status: ${data.status}`);

    } catch (error) {
      console.error(`Poll fetch error (attempt ${attempt}):`, error);
    }
  }

  return {
    status: GENERATION_STEPS.error,
    error: "Polling timed out after maximum attempts"
  };
}

// ═══════════════════════════════════════════════════
// D1 HELPERS
// ═══════════════════════════════════════════════════

async function loadOrder(orderRef, env) {
  const result = await env.DB.prepare(`
    SELECT * FROM orders WHERE order_ref = ?
  `).bind(orderRef).first();
  return result;
}

async function loadCustomer(customerId, env) {
  const result = await env.DB.prepare(`
    SELECT * FROM customers WHERE id = ?
  `).bind(customerId).first();
  return result;
}

async function updateOrderStatus(orderRef, status, env) {
  try {
    await env.DB.prepare(`
      UPDATE orders SET status = ?, updated_at = datetime('now')
      WHERE order_ref = ?
    `).bind(status, orderRef).run();
  } catch (error) {
    console.error("Status update error:", error);
  }
}

async function updateOrderWithPreview(orderRef, previewUrl, env) {
  try {
    await env.DB.prepare(`
      UPDATE orders SET 
        preview_file_key = ?,
        updated_at = datetime('now')
      WHERE order_ref = ?
    `).bind(previewUrl, orderRef).run();
  } catch (error) {
    console.error("Preview URL save error:", error);
  }
}

// ═══════════════════════════════════════════════════
// TELEGRAM NOTIFICATIONS
// ═══════════════════════════════════════════════════

async function sendPreview(chatId, orderRef, audioUrl, env) {
  const text = `✦ *Your song is ready* — ${orderRef}

Here's your 45-second preview. Listen and let me know if you'd like any changes.

_(Full HD version sent after payment — $15)_`;

  // Send text first
  await sendTelegramMessage(chatId, text, null, env);

  // Send audio file
  await sendTelegramAudio(chatId, audioUrl, env);

  // Follow-up with payment link prompt
  await sleep(3000);
  await sendPaymentPrompt(chatId, orderRef, env);
}

async function sendPaymentPrompt(chatId, orderRef, env) {
  const text = `If you're happy with the preview, unlock the full 3-minute HD version:

👉 [Pay $15 — Melodi ${orderRef}](https://buy.stripe.com/melodi/${orderRef})

Payment is processed securely via Stripe. Your card will only be charged if you approve.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✅ I'm Happy — Pay Now", callback_data: `pay_${orderRef}` }],
      [{ text: "🔄 Request Changes", callback_data: `revision_${orderRef}` }]
    ]
  };

  await sendTelegramMessage(chatId, text, keyboard, env);
}

async function notifyError(chatId, orderRef, errorMsg, env) {
  const text = `⚠️ *Generation issue* — ${orderRef}

Something went wrong generating your song. I've flagged this for review and will come back to you shortly.

Sorry for the delay ✦`;

  await sendTelegramMessage(chatId, text, null, env);
}

async function sendTelegramMessage(chatId, text, replyMarkup, env) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: false
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(`${TELEGRAM_API_BASE}${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function sendTelegramAudio(chatId, audioUrl, env) {
  const body = {
    chat_id: chatId,
    audio: audioUrl,
    parse_mode: "Markdown"
  };

  await fetch(`${TELEGRAM_API_BASE}${env.BOT_TOKEN}/sendAudio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

// ═══════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
