/**
 * SUNO AUTO-FLOW — Melodi
 * Handles: generate → poll → store preview URL
 * Designed to run as a Cloudflare Worker cron job or called post-intake
 *
 * Flow:
 * 1. Check for orders with status = 'prompt_ready'
 * 2. Call Suno API to generate
 * 3. Poll until complete (max 5 min)
 * 4. Store preview_url in D1
 * 5. Notify user via Telegram
 */

const SUNO_API_BASE = "https://api.suno.ai";
const POLL_INTERVAL_MS = 15000; // 15 seconds
const MAX_WAIT_MS = 300000;     // 5 minutes
const MAX_RETRIES = 20;

export async function runSunoAutoFlow(env) {
  // 1. Fetch orders needing generation
  const orders = await env.DB.prepare(`
    SELECT * FROM orders
    WHERE status = 'prompt_ready'
    ORDER BY created_at ASC
    LIMIT 10
  `).all();

  if (!orders.results || orders.results.length === 0) {
    return { generated: 0, pending: 0 };
  }

  const results = [];
  for (const order of orders.results) {
    const result = await processOrder(order, env);
    results.push(result);
  }

  return {
    generated: results.filter(r => r.status === "delivered").length,
    failed: results.filter(r => r.status === "error").length
  };
}

async function processOrder(order, env) {
  try {
    // Update status
    await env.DB.prepare(`UPDATE orders SET status = 'generating' WHERE id = ?`).bind(order.id).run();

    // Call Suno API
    const sunoResponse = await generateSunoSong(order, env.SUNO_API_TOKEN);
    const clipId = sunoResponse.audio_id || sunoResponse.id;

    if (!clipId) {
      throw new Error("No audio_id returned from Suno");
    }

    // Poll for completion
    const previewUrl = await pollForCompletion(clipId, env.SUNO_API_TOKEN);

    // Store result
    await env.DB.prepare(`
      UPDATE orders SET
        status = 'preview_ready',
        preview_file_key = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(previewUrl, order.id).run();

    // Notify customer
    await sendTelegramMessage(
      order.customer_id,
      `✦ *Preview ready* — ${order.order_ref}\n\nYour song for ${order.recipient_name} is ready. Tap below to listen 👇\n\n[🎵 Listen to Preview](${previewUrl})\n\n*Next:* Pay $15 for the full 3-minute HD version →`,
      buildPaymentKeyboard(order.order_ref),
      env
    );

    return { order_ref: order.order_ref, status: "delivered", preview_url: previewUrl };

  } catch (error) {
    await env.DB.prepare(`
      UPDATE orders SET status = 'generation_failed', issue_notes = ? WHERE id = ?
    `).bind(error.message, order.id).run();

    return { order_ref: order.order_ref, status: "error", error: error.message };
  }
}

async function generateSunoSong(order, apiToken) {
  const response = await fetch(`${SUNO_API_BASE}/api/generate/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: order.suno_prompt || buildFallbackPrompt(order),
      title: `${order.recipient_name} — ${order.order_ref}`,
      tags: [order.genre, order.song_language, order.occasion].filter(Boolean).join(","),
      instrumental: false
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Suno API error ${response.status}: ${err}`);
  }

  return await response.json();
}

async function pollForCompletion(clipId, apiToken) {
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const status = await fetch(`${SUNO_API_BASE}/api/get/?id=${clipId}`, {
      headers: { "Authorization": `Bearer ${apiToken}` }
    }).then(r => r.json());

    if (status.status === "complete" && status.audio_url) {
      return status.audio_url;
    }

    if (status.status === "failed") {
      throw new Error(`Suno generation failed: ${status.error || "unknown"}`);
    }
  }

  throw new Error("Suno polling timed out after 5 minutes");
}

async function sendTelegramMessage(chatId, text, replyMarkup, env) {
  const body = {
    chat_id: chatId,
    text,
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

function buildFallbackPrompt(order) {
  return `${order.genre || "Pop"} song, ${order.tempo || "mid-tempo"}, ${order.song_language || "English"}. For ${order.recipient_name} on ${order.occasion}. ${order.customer_story} ${order.key_memory}`;
}

function buildPaymentKeyboard(orderRef) {
  return {
    inline_keyboard: [
      [{ text: "💳 Pay $15 for Full Version", url: `https://buy.stripe.com/melodi/${orderRef}` }],
      [{ text: "🔄 Request Regeneration", callback_data: `regen_${orderRef}` }]
    ]
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
