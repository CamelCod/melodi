/**
 * OPENROUTER CLIENT — Melodi
 * Calls OpenRouter API to enhance Suno prompts + score quality
 * Chunked: one order per call, retry once on failure
 */

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

/**
 * Enhance a single order's intake data into a Suno-ready prompt
 * @param {Object} order - Full order object from D1
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<{enhanced_prompt, lyric_structure, quality_score, warnings}>}
 */
export async function enhancePrompt(order, apiKey) {
  const systemPrompt = `You are the Melodi Prompt Engineer. Your job is to take raw order data and produce a Suno music generation prompt that will result in a high-quality, emotionally resonant song.

Rules:
- Write in English unless the song is primarily Arabic/Hindi (then keep prompt English)
- Include specific sensory details from the story
- Match genre+tempo exactly
- Keep prompt under 500 words
- Never fabricate names, dates, or specific facts not in the input
- Add emotional warmth without being cheesy
- Structure: [Style] [Mood] [Narrative] [Key lyric hooks] [Production notes]
- If story is thin (<30 words), flag THIN_STORY warning

Output JSON only:
{
  "enhanced_prompt": "...",
  "lyric_structure": "verse / chorus / bridge structure guidance",
  "quality_score": 1-10,
  "warnings": ["any concerns"]
}`;

  const userPrompt = buildPromptFromOrder(order);

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
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();

  return parseEnhancementResponse(raw);
}

/**
 * Score an existing prompt for quality
 * @param {string} prompt - Suno prompt string
 * @param {string} apiKey
 * @returns {Promise<{score: number, issues: string[]}>}
 */
export async function scorePrompt(prompt, apiKey) {
  const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: "Score this Suno prompt 1-10 for quality. Return JSON: {\"score\": N, \"issues\": [\"...\"]}" },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 200
    })
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim();
  return parseScoreResponse(raw);
}

// ─── Internal helpers ─────────────────────────────────────────

function buildPromptFromOrder(order) {
  return `Order Ref: ${order.order_ref}

Recipient: ${order.recipient_name} (${order.recipient_gender || "?"}, ${order.recipient_age_range || "?"})
Relationship to sender: ${order.relationship}
Occasion: ${order.occasion}

Genre: ${order.genre}
Language: ${order.song_language}
Vocal style: ${order.vocal_style}
Tempo: ${order.tempo}

Customer's story:
${order.customer_story}

Key memory to include:
${order.key_memory}

Inside joke / cultural reference:
${order.inside_joke || "None"}`;
}

function parseEnhancementResponse(raw) {
  try {
    // Strip markdown code blocks if present
    const jsonStr = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    return {
      enhanced_prompt: parsed.enhanced_prompt || "",
      lyric_structure: parsed.lyric_structure || "",
      quality_score: Math.min(10, Math.max(1, parseInt(parsed.quality_score) || 5)),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    };
  } catch {
    return {
      enhanced_prompt: raw,
      lyric_structure: "verse / chorus / bridge",
      quality_score: 5,
      warnings: ["RAW_PARSE_FAILED — response could not be parsed as JSON"]
    };
  }
}

function parseScoreResponse(raw) {
  try {
    const jsonStr = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    return {
      score: Math.min(10, Math.max(1, parseInt(parsed.score) || 5)),
      issues: Array.isArray(parsed.issues) ? parsed.issues : []
    };
  } catch {
    return { score: 5, issues: ["Could not parse score response"] };
  }
}
