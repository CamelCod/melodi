/**
 * MELODI BOT — Cloudflare Worker (v2)
 * Integrates: Telegram webhook, D1, KV, OpenRouter enhancement, Stripe Atlas
 *
 * Changes from v1:
 * - finalizeOrder() calls OpenRouter → enhances prompt before saving to D1
 * - Status transitions: intake_complete → prompt_ready (instead of awaiting_payment)
 * - Payment flow separated to /pay command + Stripe webhook endpoint
 */

// ═══════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";
const SESSION_TTL_SECONDS = 86400;

// Quality gate thresholds
const QUALITY_THRESHOLD_AUTO = 8;
const QUALITY_THRESHOLD_WARN = 5;

// Intake steps
const INTAKE_STEPS = [
  "start", "ask_recipient_name", "ask_recipient_gender", "ask_recipient_age",
  "ask_relationship", "ask_occasion", "ask_genre", "ask_song_language",
  "ask_vocal_style", "ask_tempo", "ask_story", "ask_key_memory",
  "ask_inside_joke", "confirm_intake", "awaiting_payment", "complete"
];

// ═══════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Telegram webhook
    if (request.method === "POST") {
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error("Worker error:", error);
        return new Response("Error", { status: 500 });
      }
    }

    // Stripe webhook endpoint
    if (url.pathname === "/webhook/stripe") {
      return handleStripeWebhook(request, env);
    }

    // Health check
    return new Response("Melodi Bot v2 is running", { status: 200 });
  }
};

// ═══════════════════════════════════════════════════
// UPDATE ROUTER
// ═══════════════════════════════════════════════════

async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, env);
  }
}

// ═══════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();
  const text = message.text || "";

  const session = await loadSession(userId, env);

  if (text.startsWith("/start")) {
    await handleStart(chatId, userId, message.from, env);
  } else if (text.startsWith("/help")) {
    await handleHelp(chatId, env);
  } else if (text.startsWith("/mysongs")) {
    await handleMySongs(chatId, userId, env);
  } else if (text.startsWith("/neworder")) {
    await startIntake(chatId, userId, env);
  } else if (text.startsWith("/pay")) {
    await handlePayCommand(chatId, userId, env);
  } else {
    await handleTextInput(chatId, userId, text, session, env);
  }
}

// ═══════════════════════════════════════════════════
// CALLBACK HANDLER
// ═══════════════════════════════════════════════════

async function handleCallback(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;
  const session = await loadSession(userId, env);

  await answerCallback(callbackQuery.id, env);

  if (data === "action_new_order") await startIntake(chatId, userId, env);
  else if (data === "action_help") await handleHelp(chatId, env);
  else if (data === "action_my_songs") await handleMySongs(chatId, userId, env);
  else if (data.startsWith("gender_")) await handleGenderSelection(chatId, userId, data, env);
  else if (data.startsWith("age_")) await handleAgeSelection(chatId, userId, data, env);
  else if (data.startsWith("rel_")) await handleRelationshipSelection(chatId, userId, data, env);
  else if (data.startsWith("occ_")) await handleOccasionSelection(chatId, userId, data, env);
  else if (data.startsWith("genre_")) await handleGenreSelection(chatId, userId, data, env);
  else if (data.startsWith("lang_")) await handleLanguageSelection(chatId, userId, data, env);
  else if (data.startsWith("vocal_")) await handleVocalSelection(chatId, userId, data, env);
  else if (data.startsWith("tempo_")) await handleTempoSelection(chatId, userId, data, env);
  else if (data === "confirm_order") await finalizeOrder(chatId, userId, session, env);
  else if (data === "restart_order") await startIntake(chatId, userId, env);
}

// ═══════════════════════════════════════════════════
// INTAKE FLOW
// ═══════════════════════════════════════════════════

async function startIntake(chatId, userId, env) {
  await saveSession(userId, { step: "ask_recipient_name", order: {}, started_at: new Date().toISOString() }, env);
  await sendMessage(chatId, `✦ *Let's make a song*\n\nFirst — who is this song for?\n\nTell me their *name* (just type it):`, null, env);
}

async function handleTextInput(chatId, userId, text, session, env) {
  const step = session.step || "start";

  if (step === "ask_recipient_name") {
    session.order.recipient_name = text.trim();
    session.step = "ask_recipient_gender";
    await saveSession(userId, session, env);
    await askRecipientGender(chatId, text.trim(), env);
  } else if (step === "ask_story") {
    session.order.customer_story = text.trim();
    session.step = "ask_key_memory";
    await saveSession(userId, session, env);
    await sendMessage(chatId, `✦ *One more thing.*\n\nWhat is the single most important detail — the one thing this song *must* include?\n\nA specific moment, a name of a place, a phrase they always say — anything that makes this song unmistakably theirs.`, null, env);
  } else if (step === "ask_key_memory") {
    session.order.key_memory = text.trim();
    session.step = "ask_inside_joke";
    await saveSession(userId, session, env);
    await sendMessage(chatId, `Almost done.\n\nIs there an inside joke, a cultural reference, or something only you two would understand that I should weave in?\n\n_(Type it, or type *none* to skip)_`, null, env);
  } else if (step === "ask_inside_joke") {
    session.order.inside_joke = text.toLowerCase() === "none" ? "" : text.trim();
    session.step = "confirm_intake";
    await saveSession(userId, session, env);
    await showIntakeSummary(chatId, session.order, env);
  } else {
    await sendMessage(chatId, "Please use the buttons above to continue, or type /start to begin again.", null, env);
  }
}

// ═══════════════════════════════════════════════════
// ORDER FINALISATION — v2: OpenRouter enhancement
// ═══════════════════════════════════════════════════

async function finalizeOrder(chatId, userId, session, env) {
  const orderRef = `MLD-${Date.now().toString(36).toUpperCase()}`;
  const order = session.order;
  order.order_ref = orderRef;

  // Persist customer if new
  await upsertCustomer(userId, { username: session.telegram_handle || "" }, env);

  // Write order to D1 (status = new, enhanced shortly)
  try {
    await env.DB.prepare(`
      INSERT INTO orders (order_ref, customer_id, recipient_name, recipient_gender, recipient_age_range,
        relationship, occasion, genre, song_language, vocal_style, tempo,
        customer_story, key_memory, inside_joke, status)
      SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake_complete'
      FROM customers WHERE telegram_id = ?
    `).bind(
      orderRef, order.recipient_name, order.recipient_gender || "", order.recipient_age || "",
      order.relationship || "", order.occasion || "", order.genre || "", order.song_language || "",
      order.vocal_style || "", order.tempo || "", order.customer_story || "", order.key_memory || "",
      order.inside_joke || "", userId
    ).run();
  } catch (error) {
    console.error("D1 write error:", error);
    await sendMessage(chatId, "Something went wrong saving your order. Try /neworder again.", null, env);
    return;
  }

  // ── Call OpenRouter to enhance the prompt ──
  await sendMessage(chatId, `✦ *Order received* — ${orderRef}\n\nCreating your personalized song prompt...`, null, env);

  try {
    const enhanced = await enhancePromptViaOpenRouter(order, env.OPENROUTER_API_KEY);

    // Update D1 with enhanced prompt + quality score
    await env.DB.prepare(`
      UPDATE orders SET
        suno_prompt = ?,
        quality_score = ?,
        status = 'prompt_ready',
        updated_at = datetime('now')
      WHERE order_ref = ?
    `).bind(
      enhanced.prompt,
      enhanced.quality_score,
      orderRef
    ).run();

    const qualityNote = enhanced.quality_score >= QUALITY_THRESHOLD_AUTO
      ? "✅ Prompt looks great — queued for generation."
      : enhanced.quality_score >= QUALITY_THRESHOLD_WARN
        ? "⚠️ Prompt generated — will review manually before creating your song."
        : "🔧 Prompt needs adjustment — our team will review it shortly.";

    await sendMessage(chatId,
      `✦ *Prompt crafted* — ${orderRef}\n\n${qualityNote}\n\nYou'll receive a preview within 4 minutes.\n\nQuestions? Reply here anytime.`, null, env);

  } catch (error) {
    console.error("OpenRouter error:", error);
    // Fallback: save with status still intake_complete for manual retry
    await sendMessage(chatId,
      `✦ *Order received* — ${orderRef}\n\nI've saved your story. Due to high demand, your preview may take a few extra minutes. You'll be notified as soon as it's ready.\n\nThank you for your patience ✦`, null, env);
  }

  // Clear session
  await saveSession(userId, { step: "complete", order: {}, started_at: null }, env);
}

// ─── OpenRouter Enhancement ──────────────────────────────────

async function enhancePromptViaOpenRouter(order, apiKey) {
  const systemPrompt = `You are the Melodi Prompt Engineer. Take raw order data and produce a Suno music generation prompt.

Rules:
- Write prompt in English (unless song is primarily Arabic/Hindi — then keep prompt English)
- Include specific sensory details from the story
- Match genre+tempo exactly
- Keep under 500 words
- Never fabricate names, dates, or facts not in input
- Add emotional warmth without being cheesy
- Structure: [Style] [Mood] [Narrative] [Key lyric hooks] [Production notes]

Return JSON only:
{
  "prompt": "...",
  "quality_score": 1-10,
  "warnings": []
}`;

  const userPrompt = [
    `Recipient: ${order.recipient_name} (${order.recipient_gender || "?"}, ${order.recipient_age || "?"})`,
    `Relationship: ${order.relationship || "?"}`,
    `Occasion: ${order.occasion || "?"}`,
    `Genre: ${order.genre || "Pop"} | Language: ${order.song_language || "English"}`,
    `Vocal: ${order.vocal_style || "No preference"} | Tempo: ${order.tempo || "Mid-tempo"}`,
    ``,
    `Story: ${order.customer_story || ""}`,
    `Key memory: ${order.key_memory || ""}`,
    `Inside joke/ref: ${order.inside_joke || "None"}`
  ].join("\n");

  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://melodi-bot.workers.dev",
      "X-Title": "Melodi Song Concierge"
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 800
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
  const parsed = JSON.parse(raw.replace(/^```json\n?/, "").replace(/\n?```$/, ""));

  return {
    prompt: parsed.prompt || buildFallbackPrompt(order),
    quality_score: Math.min(10, Math.max(1, parseInt(parsed.quality_score) || 5)),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  };
}

function buildFallbackPrompt(order) {
  return `${order.genre || "Pop"} song, ${order.tempo || "mid-tempo warm"}, ${order.song_language || "English"}. For ${order.recipient_name} on ${order.occasion || "a special occasion"}. ${order.customer_story || ""} ${order.key_memory || ""}`;
}

// ═══════════════════════════════════════════════════
// STRIPE WEBHOOK HANDLER
// ═══════════════════════════════════════════════════

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  const payload = await request.text();

  // TODO: Verify webhook signature with env.STRIPE_WEBHOOK_SECRET
  // const event = stripe.webhooks.constructEvent(payload, sig, env.STRIPE_WEBHOOK_SECRET);

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    const orderRef = pi.metadata?.order_ref;
    if (orderRef) {
      // Capture (auth hold succeeded → now charge)
      await env.DB.prepare(`
        UPDATE orders SET payment_status = 'paid', amount_paid = 15.00, status = 'delivered', delivered = 1, updated_at = datetime('now')
        WHERE order_ref = ?
      `).bind(orderRef).run();

      // Notify customer
      const customer = await env.DB.prepare(`SELECT c.telegram_id FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.order_ref = ?`).bind(orderRef).first();
      if (customer?.telegram_id) {
        await sendMessage(customer.telegram_id,
          `✦ *Payment confirmed* — ${orderRef}\n\nYour full HD song is on its way!\n\nYou'll receive it shortly. Thank you for choosing Melodi ✦`, null, env);
      }
    }
  }

  return new Response("OK", { status: 200 });
}

// ═══════════════════════════════════════════════════
// /pay COMMAND — initiate Stripe payment
// ═══════════════════════════════════════════════════

async function handlePayCommand(chatId, userId, env) {
  // Find latest unpaid order for this user
  const order = await env.DB.prepare(`
    SELECT o.order_ref FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE c.telegram_id = ? AND o.payment_status = 'unpaid'
    ORDER BY o.created_at DESC LIMIT 1
  `).bind(userId).first();

  if (!order) {
    await sendMessage(chatId, "No pending payment found. Create a song first with /neworder", null, env);
    return;
  }

  // Create PaymentIntent (auth hold)
  try {
    const pi = await createPaymentIntent(order.order_ref, env);
    const clientSecret = pi.client_secret;

    await sendMessage(chatId,
      `💳 *Payment for ${order.order_ref}*\n\nTap below to securely pay $15 for your full HD song.\n\n[💳 Pay $15](https://buy.stripe.com/melodi/${order.order_ref})`,
      null, env);
  } catch (error) {
    await sendMessage(chatId, "Payment setup failed. Contact support @MelodiSupport.", null, env);
  }
}

async function createPaymentIntent(orderRef, env) {
  const response = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(env.STRIPE_SECRET_KEY)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      amount: "1500",
      currency: "usd",
      capture_method: "manual",
      description: `Melodi Song — ${orderRef}`,
      metadata: { order_ref: orderRef, product: "melodi_full_song" }
    })
  });
  if (!response.ok) throw new Error(`Stripe error ${response.status}`);
  return await response.json();
}

// ═══════════════════════════════════════════════════
// KEYBOARD OPTION ARRAYS (inline buttons)
// ═══════════════════════════════════════════════════

const GENDER_OPTIONS = [
  [{ text: "👨 Male", callback_data: "gender_male" }, { text: "👩 Female", callback_data: "gender_female" }],
  [{ text: "✨ Other", callback_data: "gender_other" }]
];

const AGE_OPTIONS = [
  [{ text: "Under 18", callback_data: "age_u18" }, { text: "18–24", callback_data: "age_1824" }],
  [{ text: "25–34", callback_data: "age_2534" }, { text: "35–44", callback_data: "age_3544" }],
  [{ text: "45–54", callback_data: "age_4554" }, { text: "55–64", callback_data: "age_5564" }],
  [{ text: "65+", callback_data: "age_65plus" }]
];

const RELATIONSHIP_OPTIONS = [
  [{ text: "👩 Mother", callback_data: "rel_mother" }, { text: "👨 Father", callback_data: "rel_father" }],
  [{ text: "💍 Wife", callback_data: "rel_wife" }, { text: "💍 Husband", callback_data: "rel_husband" }],
  [{ text: "❤️ Girlfriend", callback_data: "rel_girlfriend" }, { text: "❤️ Boyfriend", callback_data: "rel_boyfriend" }],
  [{ text: "👧 Daughter", callback_data: "rel_daughter" }, { text: "👦 Son", callback_data: "rel_son" }],
  [{ text: "👯 Sister", callback_data: "rel_sister" }, { text: "🤝 Brother", callback_data: "rel_brother" }],
  [{ text: "👵 Grandmother", callback_data: "rel_grandmother" }, { text: "👴 Grandfather", callback_data: "rel_grandfather" }],
  [{ text: "👫 Friend", callback_data: "rel_friend" }, { text: "💼 Colleague", callback_data: "rel_colleague" }],
  [{ text: "✨ Other", callback_data: "rel_other" }]
];

const OCCASION_OPTIONS = [
  [{ text: "🎂 Birthday", callback_data: "occ_birthday" }, { text: "💕 Anniversary", callback_data: "occ_anniversary" }],
  [{ text: "💒 Wedding", callback_data: "occ_wedding" }, { text: "🎓 Graduation", callback_data: "occ_graduation" }],
  [{ text: "🌙 Eid Al Fitr", callback_data: "occ_eid_fitr" }, { text: "🌙 Eid Al Adha", callback_data: "occ_eid_adha" }],
  [{ text: "💝 Valentine's Day", callback_data: "occ_valentine" }, { text: "🌸 Mother's Day", callback_data: "occ_mothers" }],
  [{ text: "👔 Father's Day", callback_data: "occ_fathers" }, { text: "🎊 New Year", callback_data: "occ_newyear" }],
  [{ text: "👶 New Baby", callback_data: "occ_baby" }, { text: "🙏 Thank You", callback_data: "occ_thankyou" }],
  [{ text: "💌 Just Because", callback_data: "occ_justbecause" }, { text: "✨ Other", callback_data: "occ_other" }]
];

const GENRE_OPTIONS = [
  [{ text: "🎵 Pop", callback_data: "genre_pop" }, { text: "💜 Emotional Ballad", callback_data: "genre_ballad" }],
  [{ text: "🎷 R&B", callback_data: "genre_rnb" }, { text: "🎸 Acoustic", callback_data: "genre_acoustic" }],
  [{ text: "🌴 Khaleeji", callback_data: "genre_khaleeji" }, { text: "🎤 Nabati", callback_data: "genre_nabati" }],
  [{ text: "🎹 Classical", callback_data: "genre_classical" }, { text: "🌙 Lo-fi", callback_data: "genre_lofi" }],
  [{ text: "🎺 Jazz", callback_data: "genre_jazz" }, { text: "🔥 Hip-Hop", callback_data: "genre_hiphop" }]
];

const LANGUAGE_OPTIONS = [
  [{ text: "🇬🇧 English", callback_data: "lang_english" }, { text: "🌙 Arabic", callback_data: "lang_arabic" }],
  [{ text: "🇮🇳 Hindi", callback_data: "lang_hindi" }, { text: "✨ Hinglish", callback_data: "lang_hinglish" }],
  [{ text: "🌐 Arabic-English Mix", callback_data: "lang_arabicenglish" }, { text: "🇵🇭 Tagalog", callback_data: "lang_tagalog" }],
  [{ text: "🇵🇰 Urdu", callback_data: "lang_urdu" }, { text: "🇫🇷 French", callback_data: "lang_french" }]
];

const VOCAL_OPTIONS = [
  [{ text: "👩‍🎤 Female Voice", callback_data: "vocal_female" }, { text: "👨‍🎤 Male Voice", callback_data: "vocal_male" }],
  [{ text: "🎭 Duet", callback_data: "vocal_duet" }, { text: "🎵 No Preference", callback_data: "vocal_none" }]
];

const TEMPO_OPTIONS = [
  [{ text: "🌊 Slow & Emotional", callback_data: "tempo_slow" }],
  [{ text: "🌅 Mid-tempo & Warm", callback_data: "tempo_mid" }],
  [{ text: "🎉 Upbeat & Celebratory", callback_data: "tempo_upbeat" }]
];

// ═══════════════════════════════════════════════════
// STEP HANDLERS
// ═══════════════════════════════════════════════════

async function handleGenderSelection(chatId, userId, data, env) {
  const session = await loadSession(userId, env);
  session.order.recipient_gender = { gender_male: "Male", gender_female: "Female", gender_other: "Other" }[data] || "Other";
  session.step = "ask_recipient_age";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `Got it. How old is ${session.order.recipient_name}?`, { inline_keyboard: AGE_OPTIONS }, env);
}

async function handleAgeSelection(chatId, userId, data, env) {
  const ageMap = { age_u18: "Under 18", age_1824: "18–24", age_2534: "25–34", age_3544: "35–44", age_4554: "45–54", age_5564: "55–64", age_65plus: "65+" };
  const session = await loadSession(userId, env);
  session.order.recipient_age = ageMap[data] || "Unknown";
  session.step = "ask_relationship";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `What is ${session.order.recipient_name} to you?`, { inline_keyboard: RELATIONSHIP_OPTIONS }, env);
}

async function handleRelationshipSelection(chatId, userId, data, env) {
  const rel = data.replace("rel_", "").replace(/_/g, " ");
  const session = await loadSession(userId, env);
  session.order.relationship = rel.charAt(0).toUpperCase() + rel.slice(1);
  session.step = "ask_occasion";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `What is the occasion?`, { inline_keyboard: OCCASION_OPTIONS }, env);
}

async function handleOccasionSelection(chatId, userId, data, env) {
  const occMap = { occ_birthday: "Birthday", occ_anniversary: "Anniversary", occ_wedding: "Wedding", occ_graduation: "Graduation", occ_eid_fitr: "Eid Al Fitr", occ_eid_adha: "Eid Al Adha", occ_valentine: "Valentine's Day", occ_mothers: "Mother's Day", occ_fathers: "Father's Day", occ_newyear: "New Year", occ_baby: "New Baby", occ_thankyou: "Thank You", occ_justbecause: "Just Because", occ_other: "Other" };
  const session = await loadSession(userId, env);
  session.order.occasion = occMap[data] || "Other";
  session.step = "ask_genre";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `What genre feels right for this song?`, { inline_keyboard: GENRE_OPTIONS }, env);
}

async function handleGenreSelection(chatId, userId, data, env) {
  const genreMap = { genre_pop: "Pop", genre_ballad: "Emotional Ballad", genre_rnb: "R&B", genre_acoustic: "Acoustic", genre_khaleeji: "Khaleeji", genre_nabati: "Nabati", genre_classical: "Classical", genre_lofi: "Lo-fi", genre_jazz: "Jazz", genre_hiphop: "Hip-Hop" };
  const session = await loadSession(userId, env);
  session.order.genre = genreMap[data] || "Pop";
  session.step = "ask_song_language";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `What language should the song be in?`, { inline_keyboard: LANGUAGE_OPTIONS }, env);
}

async function handleLanguageSelection(chatId, userId, data, env) {
  const langMap = { lang_english: "English", lang_arabic: "Arabic", lang_hindi: "Hindi", lang_hinglish: "Hinglish", lang_arabicenglish: "Arabic-English Mix", lang_tagalog: "Tagalog", lang_urdu: "Urdu", lang_french: "French" };
  const session = await loadSession(userId, env);
  session.order.song_language = langMap[data] || "English";
  session.step = "ask_vocal_style";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `What vocal style?`, { inline_keyboard: VOCAL_OPTIONS }, env);
}

async function handleVocalSelection(chatId, userId, data, env) {
  const vocalMap = { vocal_female: "Female Solo", vocal_male: "Male Solo", vocal_duet: "Duet", vocal_none: "No Preference" };
  const session = await loadSession(userId, env);
  session.order.vocal_style = vocalMap[data] || "No Preference";
  session.step = "ask_tempo";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `What's the mood?`, { inline_keyboard: TEMPO_OPTIONS }, env);
}

async function handleTempoSelection(chatId, userId, data, env) {
  const tempoMap = { tempo_slow: "Slow and emotional", tempo_mid: "Mid-tempo warm", tempo_upbeat: "Upbeat and celebratory" };
  const session = await loadSession(userId, env);
  session.order.tempo = tempoMap[data] || "Mid-tempo warm";
  session.step = "ask_story";
  await saveSession(userId, session, env);
  await sendMessage(chatId, `Almost there ✦\n\nNow the most important part.\n\n*Tell me the story.*\n\nWhat memory, moment, or feeling should this song capture? Be as specific as you can — a place, a trip, something they said, something you both remember.\n\n_(Just type your answer — take your time)_`, null, env);
}

async function askRecipientGender(chatId, recipientName, env) {
  await sendMessage(chatId, `Great — *${recipientName}*.\n\nWhat is ${recipientName}'s gender?\n_(This helps match the vocal style)`, { inline_keyboard: GENDER_OPTIONS }, env);
}

async function showIntakeSummary(chatId, order, env) {
  const text = `✦ *Here's what I have*\n\n*For:* ${order.recipient_name} (${order.recipient_gender || "—"}, ${order.recipient_age || "—"})\n*Relationship:* ${order.relationship}\n*Occasion:* ${order.occasion}\n*Genre:* ${order.genre}\n*Language:* ${order.song_language}\n*Vocals:* ${order.vocal_style}\n*Mood:* ${order.tempo}\n\n*Their story:* ${order.customer_story}\n\n*Key detail:* ${order.key_memory}\n\n*Inside reference:* ${order.inside_joke || "None"}\n\n━━━━━━━━━━━━━━━━━━\nReady to generate? I'll create a 45-second preview for free. You only pay $15 if you want the full 3-minute HD version.`;

  await sendMessage(chatId, text, {
    inline_keyboard: [
      [{ text: "✦ Yes — Generate My Song", callback_data: "confirm_order" }],
      [{ text: "✎ Start Over", callback_data: "restart_order" }]
    ]
  }, env);
}

// ═══════════════════════════════════════════════════
// /start — WELCOME
// ═══════════════════════════════════════════════════

async function handleStart(chatId, userId, fromUser, env) {
  await upsertCustomer(userId, fromUser, env);
  const firstName = fromUser.first_name || "there";

  const welcomeText = `✦ *Welcome to Melodi* ✦

Hello ${firstName}.

I turn your memories into music.

Not generic songs — *your* song. Built around the specific moment, the inside joke, the trip you took, the thing only you two remember.

━━━━━━━━━━━━━━━━━━
*How it works*

🎙 You tell me the story
🧠 I write the lyrics and style
🎵 We generate a real song with voice and instruments
👂 You approve before anything is sent
💳 You pay $15 only for the full HD version
━━━━━━━━━━━━━━━━━━

*Perfect for:*
Birthdays · Anniversaries · Eid · Weddings
Mother's Day · Graduations · Just Because

━━━━━━━━━━━━━━━━━━
Ready to make something unforgettable?`;

  await sendMessage(chatId, welcomeText, {
    inline_keyboard: [
      [{ text: "✦ Create a Song", callback_data: "action_new_order" }],
      [{ text: "🎵 My Songs", callback_data: "action_my_songs" }, { text: "❓ How It Works", callback_data: "action_help" }]
    ]
  }, env);
}

// ═══════════════════════════════════════════════════
// HELP & MY SONGS
// ═══════════════════════════════════════════════════

async function handleHelp(chatId, env) {
  await sendMessage(chatId, `✦ *How Melodi works*

*Step 1 — You tell the story*
Answer a few questions about who the song is for.

*Step 2 — I write the lyrics*
AI crafts lyrics around your specific details — not templates.

*Step 3 — You get a free preview*
A 45-second preview, no payment required.

*Step 4 — Unlock the full song*
Pay $15 to receive the full 3-minute HD MP3.

━━━━━━━━━━━━━━━━━━
Accepted: Stripe
Languages: English · Arabic · Hindi · Hinglish · Urdu · Tagalog · French
Genres: Pop · R&B · Khaleeji · Nabati · Acoustic · Classical · Jazz · Lo-fi`,
    { inline_keyboard: [[{ text: "✦ Create a Song", callback_data: "action_new_order" }]] }, env);
}

async function handleMySongs(chatId, userId, env) {
  try {
    const result = await env.DB.prepare(`
      SELECT o.order_ref, o.recipient_name, o.occasion, o.status, o.delivered, o.created_at
      FROM orders o JOIN customers c ON o.customer_id = c.id
      WHERE c.telegram_id = ? ORDER BY o.created_at DESC LIMIT 5
    `).bind(userId).all();

    if (!result.results || result.results.length === 0) {
      await sendMessage(chatId, "You haven't created any songs yet.\n\nTap below to make your first one ✦", {
        inline_keyboard: [[{ text: "✦ Create a Song", callback_data: "action_new_order" }]]
      }, env);
      return;
    }

    let text = "✦ *Your Songs*\n\n";
    for (const order of result.results) {
      const statusEmoji = order.delivered ? "✅" : order.status === "awaiting_payment" ? "💳" : "⏳";
      text += `${statusEmoji} *${order.order_ref}* — ${order.recipient_name} · ${order.occasion}\n`;
    }

    await sendMessage(chatId, text, {
      inline_keyboard: [[{ text: "✦ Create Another Song", callback_data: "action_new_order" }]]
    }, env);
  } catch (error) {
    await sendMessage(chatId, "Couldn't load your songs right now. Try again in a moment.", null, env);
  }
}

// ═══════════════════════════════════════════════════
// DB + SESSION HELPERS
// ═══════════════════════════════════════════════════

async function upsertCustomer(userId, fromUser, env) {
  try {
    await env.DB.prepare(`
      INSERT INTO customers (telegram_id, telegram_handle, full_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        telegram_handle = excluded.telegram_handle,
        updated_at = datetime('now')
    `).bind(userId, fromUser.username || "",
      `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim()
    ).run();
  } catch (error) {
    console.error("Upsert customer error:", error);
  }
}

async function loadSession(userId, env) {
  try {
    const raw = await env.SESSIONS.get(`session:${userId}`);
    return raw ? JSON.parse(raw) :    { step: "start", order: {} };
  } catch {
    return { step: "start", order: {} };
  }
}

async function saveSession(userId, session, env) {
  try {
    await env.SESSIONS.put(`session:${userId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
  } catch (error) {
    console.error("Session save error:", error);
  }
}

// ═══════════════════════════════════════════════════
// TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════

async function sendMessage(chatId, text, replyMarkup, env) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(`${TELEGRAM_API_BASE}${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function answerCallback(callbackQueryId, env) {
  await fetch(`${TELEGRAM_API_BASE}${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}
