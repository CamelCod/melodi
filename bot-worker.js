/**
 * MELODI BOT — Cloudflare Worker
 * Algorithm-First Design (Disciplined Programmer Standard)
 *
 * GOAL: Handle all Telegram bot interactions for Melodi song concierge
 * INPUT: Telegram webhook POST requests
 * OUTPUT: Telegram API responses, D1 database writes, KV session state
 *
 * STEPS:
 * 1. Receive webhook from Telegram
 * 2. Parse message type (command / text / callback)
 * 3. Load session state from KV
 * 4. Route to correct handler based on session step
 * 5. Write response back to Telegram
 * 6. Save updated session to KV
 */

// ═══════════════════════════════════════════════════
// CONSTANTS — All magic values named and explained
// ═══════════════════════════════════════════════════

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

const SESSION_TTL_SECONDS = 86400; // 24 hours — sessions expire after one day

// Intake flow steps — each step maps to one question
const INTAKE_STEPS = [
  "start",
  "ask_recipient_name",
  "ask_recipient_gender",
  "ask_recipient_age",
  "ask_relationship",
  "ask_occasion",
  "ask_genre",
  "ask_song_language",
  "ask_vocal_style",
  "ask_tempo",
  "ask_story",
  "ask_key_memory",
  "ask_inside_joke",
  "confirm_intake",
  "awaiting_payment",
  "complete"
];

// Keyboard option arrays — all display as Telegram inline buttons
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
// MAIN WORKER ENTRY POINT
// ═══════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    // Only accept POST requests from Telegram
    if (request.method !== "POST") {
      return new Response("Melodi Bot is running", { status: 200 });
    }

    try {
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};

// ═══════════════════════════════════════════════════
// UPDATE ROUTER
// Algorithm: determine update type → route to handler
// ═══════════════════════════════════════════════════

async function handleUpdate(update, env) {
  // Step 1: Identify update type
  const hasMessage = update.message !== undefined;
  const hasCallback = update.callback_query !== undefined;

  if (hasMessage) {
    await handleMessage(update.message, env);
  } else if (hasCallback) {
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

  // Load or create session
  const session = await loadSession(userId, env);

  // Route by command or session step
  if (text.startsWith("/start")) {
    await handleStart(chatId, userId, message.from, session, env);
  } else if (text.startsWith("/help")) {
    await handleHelp(chatId, env);
  } else if (text.startsWith("/mysongs")) {
    await handleMySongs(chatId, userId, env);
  } else if (text.startsWith("/neworder")) {
    await startIntake(chatId, userId, session, env);
  } else {
    // Free text — handle based on current session step
    await handleTextInput(chatId, userId, text, session, env);
  }
}

// ═══════════════════════════════════════════════════
// /start — WELCOME SCREEN
// The most important message. Sets the entire tone.
// ═══════════════════════════════════════════════════

async function handleStart(chatId, userId, fromUser, session, env) {
  // Ensure customer exists in D1
  await upsertCustomer(userId, fromUser, env);

  const firstName = fromUser.first_name || "there";

  // The welcome message — cinematic, premium, story-first
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

Songs delivered in: 🇬🇧 English · 🌙 Arabic · 🇮🇳 Hindi · 🌐 Mixed

━━━━━━━━━━━━━━━━━━
Ready to make something unforgettable?`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✦ Create a Song", callback_data: "action_new_order" }],
      [{ text: "🎵 My Songs", callback_data: "action_my_songs" }, { text: "❓ How It Works", callback_data: "action_help" }]
    ]
  };

  await sendMessage(chatId, welcomeText, keyboard, env);
}

// ═══════════════════════════════════════════════════
// INTAKE FLOW — Step by step question sequence
// ═══════════════════════════════════════════════════

async function startIntake(chatId, userId, session, env) {
  // Reset session to fresh intake
  const freshSession = {
    step: "ask_recipient_name",
    order: {},
    started_at: new Date().toISOString()
  };
  await saveSession(userId, freshSession, env);

  const text = `✦ *Let's make a song*

First — who is this song for?

Tell me their *name* (just type it):`;

  await sendMessage(chatId, text, null, env);
}

async function handleTextInput(chatId, userId, text, session, env) {
  const step = session.step || "start";

  // Route text input to the correct step handler
  if (step === "ask_recipient_name") {
    session.order.recipient_name = text.trim();
    session.step = "ask_recipient_gender";
    await saveSession(userId, session, env);
    await askRecipientGender(chatId, text.trim(), env);
  } else if (step === "ask_story") {
    session.order.customer_story = text.trim();
    session.step = "ask_key_memory";
    await saveSession(userId, session, env);
    await askKeyMemory(chatId, env);
  } else if (step === "ask_key_memory") {
    session.order.key_memory = text.trim();
    session.step = "ask_inside_joke";
    await saveSession(userId, session, env);
    await askInsideJoke(chatId, env);
  } else if (step === "ask_inside_joke") {
    session.order.inside_joke = text.toLowerCase() === "none" ? "" : text.trim();
    session.step = "confirm_intake";
    await saveSession(userId, session, env);
    await showIntakeSummary(chatId, session.order, env);
  } else {
    // Unexpected text — gentle nudge
    await sendMessage(chatId, "Please use the buttons above to continue, or type /start to begin again.", null, env);
  }
}

// ═══════════════════════════════════════════════════
// CALLBACK HANDLER — Inline button responses
// ═══════════════════════════════════════════════════

async function handleCallback(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id.toString();
  const data = callbackQuery.data;
  const session = await loadSession(userId, env);

  // Acknowledge the button tap (removes loading spinner)
  await answerCallback(callbackQuery.id, env);

  // Route by callback prefix
  if (data === "action_new_order") {
    await startIntake(chatId, userId, session, env);
  } else if (data === "action_help") {
    await handleHelp(chatId, env);
  } else if (data === "action_my_songs") {
    await handleMySongs(chatId, userId, env);
  } else if (data.startsWith("gender_")) {
    await handleGenderSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("age_")) {
    await handleAgeSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("rel_")) {
    await handleRelationshipSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("occ_")) {
    await handleOccasionSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("genre_")) {
    await handleGenreSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("lang_")) {
    await handleLanguageSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("vocal_")) {
    await handleVocalSelection(chatId, userId, data, session, env);
  } else if (data.startsWith("tempo_")) {
    await handleTempoSelection(chatId, userId, data, session, env);
  } else if (data === "confirm_order") {
    await finalizeOrder(chatId, userId, session, env);
  } else if (data === "restart_order") {
    await startIntake(chatId, userId, session, env);
  }
}

// ═══════════════════════════════════════════════════
// STEP QUESTION SENDERS
// Each sends exactly one question with inline buttons
// ═══════════════════════════════════════════════════

async function askRecipientGender(chatId, recipientName, env) {
  const text = `Great — *${recipientName}*.

What is ${recipientName}'s gender?
_(This helps match the vocal style)_`;
  await sendMessage(chatId, text, { inline_keyboard: GENDER_OPTIONS }, env);
}

async function handleGenderSelection(chatId, userId, data, session, env) {
  const genderMap = { gender_male: "Male", gender_female: "Female", gender_other: "Other" };
  session.order.recipient_gender = genderMap[data] || "Other";
  session.step = "ask_recipient_age";
  await saveSession(userId, session, env);

  const text = `Got it. How old is ${session.order.recipient_name}?`;
  await sendMessage(chatId, text, { inline_keyboard: AGE_OPTIONS }, env);
}

async function handleAgeSelection(chatId, userId, data, session, env) {
  const ageMap = { age_u18: "Under 18", age_1824: "18–24", age_2534: "25–34", age_3544: "35–44", age_4554: "45–54", age_5564: "55–64", age_65plus: "65+" };
  session.order.recipient_age = ageMap[data] || "Unknown";
  session.step = "ask_relationship";
  await saveSession(userId, session, env);

  const text = `What is ${session.order.recipient_name} to you?`;
  await sendMessage(chatId, text, { inline_keyboard: RELATIONSHIP_OPTIONS }, env);
}

async function handleRelationshipSelection(chatId, userId, data, session, env) {
  const relLabel = data.replace("rel_", "").replace(/_/g, " ");
  session.order.relationship = relLabel.charAt(0).toUpperCase() + relLabel.slice(1);
  session.step = "ask_occasion";
  await saveSession(userId, session, env);

  const text = `What is the occasion?`;
  await sendMessage(chatId, text, { inline_keyboard: OCCASION_OPTIONS }, env);
}

async function handleOccasionSelection(chatId, userId, data, session, env) {
  const occMap = {
    occ_birthday: "Birthday", occ_anniversary: "Anniversary", occ_wedding: "Wedding",
    occ_graduation: "Graduation", occ_eid_fitr: "Eid Al Fitr", occ_eid_adha: "Eid Al Adha",
    occ_valentine: "Valentine's Day", occ_mothers: "Mother's Day", occ_fathers: "Father's Day",
    occ_newyear: "New Year", occ_baby: "New Baby", occ_thankyou: "Thank You",
    occ_justbecause: "Just Because", occ_other: "Other"
  };
  session.order.occasion = occMap[data] || "Other";
  session.step = "ask_genre";
  await saveSession(userId, session, env);

  const text = `What genre feels right for this song?`;
  await sendMessage(chatId, text, { inline_keyboard: GENRE_OPTIONS }, env);
}

async function handleGenreSelection(chatId, userId, data, session, env) {
  const genreMap = {
    genre_pop: "Pop", genre_ballad: "Emotional Ballad", genre_rnb: "R&B",
    genre_acoustic: "Acoustic", genre_khaleeji: "Khaleeji", genre_nabati: "Nabati",
    genre_classical: "Classical", genre_lofi: "Lo-fi", genre_jazz: "Jazz", genre_hiphop: "Hip-Hop"
  };
  session.order.genre = genreMap[data] || "Pop";
  session.step = "ask_song_language";
  await saveSession(userId, session, env);

  const text = `What language should the song be in?`;
  await sendMessage(chatId, text, { inline_keyboard: LANGUAGE_OPTIONS }, env);
}

async function handleLanguageSelection(chatId, userId, data, session, env) {
  const langMap = {
    lang_english: "English", lang_arabic: "Arabic", lang_hindi: "Hindi",
    lang_hinglish: "Hinglish", lang_arabicenglish: "Arabic-English Mix",
    lang_tagalog: "Tagalog", lang_urdu: "Urdu", lang_french: "French"
  };
  session.order.song_language = langMap[data] || "English";
  session.step = "ask_vocal_style";
  await saveSession(userId, session, env);

  const text = `What vocal style?`;
  await sendMessage(chatId, text, { inline_keyboard: VOCAL_OPTIONS }, env);
}

async function handleVocalSelection(chatId, userId, data, session, env) {
  const vocalMap = { vocal_female: "Female Solo", vocal_male: "Male Solo", vocal_duet: "Duet", vocal_none: "No Preference" };
  session.order.vocal_style = vocalMap[data] || "No Preference";
  session.step = "ask_tempo";
  await saveSession(userId, session, env);

  const text = `What's the mood?`;
  await sendMessage(chatId, text, { inline_keyboard: TEMPO_OPTIONS }, env);
}

async function handleTempoSelection(chatId, userId, data, session, env) {
  const tempoMap = { tempo_slow: "Slow and emotional", tempo_mid: "Mid-tempo warm", tempo_upbeat: "Upbeat and celebratory" };
  session.order.tempo = tempoMap[data] || "Mid-tempo warm";
  session.step = "ask_story";
  await saveSession(userId, session, env);

  const text = `Almost there ✦

Now the most important part.

*Tell me the story.*

What memory, moment, or feeling should this song capture? Be as specific as you can — a place, a trip, something they said, something you both remember. The more real the detail, the better the song.

_(Just type your answer — take your time)_`;
  await sendMessage(chatId, text, null, env);
}

async function askKeyMemory(chatId, env) {
  const text = `✦ *One more thing.*

What is the single most important detail — the one thing this song *must* include?

A specific moment, a name of a place, a phrase they always say — anything that makes this song unmistakably theirs.`;
  await sendMessage(chatId, text, null, env);
}

async function askInsideJoke(chatId, env) {
  const text = `Almost done.

Is there an inside joke, a cultural reference, or something only you two would understand that I should weave in?

_(Type it, or type *none* to skip)_`;
  await sendMessage(chatId, text, null, env);
}

// ═══════════════════════════════════════════════════
// INTAKE SUMMARY — Show everything before confirming
// ═══════════════════════════════════════════════════

async function showIntakeSummary(chatId, order, env) {
  const text = `✦ *Here's what I have*

*For:* ${order.recipient_name} (${order.recipient_gender || "—"}, ${order.recipient_age || "—"})
*Relationship:* ${order.relationship}
*Occasion:* ${order.occasion}
*Genre:* ${order.genre}
*Language:* ${order.song_language}
*Vocals:* ${order.vocal_style}
*Mood:* ${order.tempo}

*Their story:*
_${order.customer_story}_

*Key detail:*
_${order.key_memory}_

*Inside reference:*
_${order.inside_joke || "None"}_

━━━━━━━━━━━━━━━━━━
Ready to generate? I'll create a 45-second preview for free. You only pay $15 if you want the full 3-minute HD version.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✦ Yes — Generate My Song", callback_data: "confirm_order" }],
      [{ text: "✎ Start Over", callback_data: "restart_order" }]
    ]
  };

  await sendMessage(chatId, text, keyboard, env);
}

// ═══════════════════════════════════════════════════
// ORDER FINALISATION — Save to D1, notify operator
// ═══════════════════════════════════════════════════

async function finalizeOrder(chatId, userId, session, env) {
  // Generate unique order reference
  const orderRef = `MLD-${Date.now().toString(36).toUpperCase()}`;
  session.order.order_ref = orderRef;
  session.step = "awaiting_payment";
  await saveSession(userId, session, env);

  // Write order to D1
  try {
    await env.DB.prepare(`
      INSERT INTO orders (order_ref, customer_id, recipient_name, recipient_gender, recipient_age_range,
        relationship, occasion, genre, song_language, vocal_style, tempo,
        customer_story, key_memory, inside_joke, status)
      SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake_complete'
      FROM customers WHERE telegram_id = ?
    `).bind(
      orderRef, session.order.recipient_name, session.order.recipient_gender,
      session.order.recipient_age, session.order.relationship, session.order.occasion,
      session.order.genre, session.order.song_language, session.order.vocal_style,
      session.order.tempo, session.order.customer_story, session.order.key_memory,
      session.order.inside_joke || "", userId
    ).run();
  } catch (error) {
    console.error("D1 write error:", error);
  }

  const text = `✦ *Order received* — ${orderRef}

Your story is in. I'm generating the prompt now.

You'll receive a 45-second preview shortly.

*While you wait:* Join our community where people share the songs they've sent →
t.me/MelodiCommunity

━━━━━━━━━━━━━━━━━━
_Average preview delivery: under 4 minutes_`;

  await sendMessage(chatId, text, null, env);
}

// ═══════════════════════════════════════════════════
// HELP & MY SONGS
// ═══════════════════════════════════════════════════

async function handleHelp(chatId, env) {
  const text = `✦ *How Melodi works*

*Step 1 — You tell the story*
Answer a few questions about who the song is for and what memories to capture.

*Step 2 — I write the lyrics*
An AI songwriter crafts lyrics around your specific details — not templates.

*Step 3 — Human review*
I (your song concierge) personally review and approve every song before you hear it.

*Step 4 — You get a free preview*
A 45-second preview, no payment required.

*Step 5 — Unlock the full song*
Pay $15 to receive the full 3-minute HD MP3.

*Step 6 — I remind you next year*
So you never miss the moment again.

━━━━━━━━━━━━━━━━━━
Accepted: Stripe · PayPal
Languages: English · Arabic · Hindi · Hinglish · Urdu · Tagalog · French
Genres: Pop · R&B · Khaleeji · Nabati · Acoustic · Classical · Jazz · Lo-fi`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✦ Create a Song", callback_data: "action_new_order" }]
    ]
  };

  await sendMessage(chatId, text, keyboard, env);
}

async function handleMySongs(chatId, userId, env) {
  // Look up past orders from D1
  try {
    const result = await env.DB.prepare(`
      SELECT o.order_ref, o.recipient_name, o.occasion, o.status, o.delivered, o.created_at
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE c.telegram_id = ?
      ORDER BY o.created_at DESC
      LIMIT 5
    `).bind(userId).all();

    if (!result.results || result.results.length === 0) {
      await sendMessage(chatId, "You haven't created any songs yet.\n\nTap below to make your first one ✦", {
        inline_keyboard: [[{ text: "✦ Create a Song", callback_data: "action_new_order" }]]
      }, env);
      return;
    }

    let text = `✦ *Your Songs*\n\n`;
    for (const order of result.results) {
      const statusEmoji = order.delivered ? "✅" : order.status === "awaiting_payment" ? "💳" : "⏳";
      text += `${statusEmoji} *${order.order_ref}*\n`;
      text += `For ${order.recipient_name} · ${order.occasion}\n\n`;
    }

    await sendMessage(chatId, text, {
      inline_keyboard: [[{ text: "✦ Create Another Song", callback_data: "action_new_order" }]]
    }, env);
  } catch (error) {
    await sendMessage(chatId, "Couldn't load your songs right now. Try again in a moment.", null, env);
  }
}

// ═══════════════════════════════════════════════════
// D1 DATABASE HELPERS
// ═══════════════════════════════════════════════════

async function upsertCustomer(userId, fromUser, env) {
  try {
    await env.DB.prepare(`
      INSERT INTO customers (telegram_id, telegram_handle, full_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        telegram_handle = excluded.telegram_handle,
        updated_at = datetime('now')
    `).bind(
      userId,
      fromUser.username || "",
      `${fromUser.first_name || ""} ${fromUser.last_name || ""}`.trim()
    ).run();
  } catch (error) {
    console.error("Upsert customer error:", error);
  }
}

// ═══════════════════════════════════════════════════
// KV SESSION HELPERS
// Goal: persist multi-step conversation state
// ═══════════════════════════════════════════════════

async function loadSession(userId, env) {
  try {
    const raw = await env.SESSIONS.get(`session:${userId}`);
    return raw ? JSON.parse(raw) : { step: "start", order: {} };
  } catch {
    return { step: "start", order: {} };
  }
}

async function saveSession(userId, session, env) {
  try {
    await env.SESSIONS.put(
      `session:${userId}`,
      JSON.stringify(session),
      { expirationTtl: SESSION_TTL_SECONDS }
    );
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
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

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
