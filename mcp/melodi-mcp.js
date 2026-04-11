/**
 * MELODI MCP SERVER
 * Provides AI tool access to the Cloudflare Worker
 * Runs as a separate long-lived process, worker calls it via fetch
 *
 * Tools:
 * - enhance_prompt    → OpenRouter prompt enhancement
 * - score_quality     → Quality gate evaluation
 * - extract_intake     → Structured extraction from raw Telegram message
 * - generate_lyrics    → Lyric drafting from story
 */

import { enhancePrompt, scorePrompt } from "../workers/openrouter-client.js";

const MCP_TOOLS = {
  enhance_prompt: {
    description: "Enhance a raw intake order into a Suno-ready music prompt",
    inputSchema: {
      type: "object",
      properties: {
        order_ref: { type: "string" },
        recipient_name: { type: "string" },
        recipient_gender: { type: "string" },
        recipient_age_range: { type: "string" },
        relationship: { type: "string" },
        occasion: { type: "string" },
        genre: { type: "string" },
        song_language: { type: "string" },
        vocal_style: { type: "string" },
        tempo: { type: "string" },
        customer_story: { type: "string" },
        key_memory: { type: "string" },
        inside_joke: { type: "string" }
      },
      required: ["order_ref", "recipient_name", "occasion", "customer_story"]
    }
  },

  score_quality: {
    description: "Score a generated Suno prompt for quality before generation",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" }
      },
      required: ["prompt"]
    }
  },

  extract_intake: {
    description: "Extract structured order fields from a raw Telegram message or story dump",
    inputSchema: {
      type: "object",
      properties: {
        raw_message: { type: "string" },
        existing_fields: { type: "object" }
      },
      required: ["raw_message"]
    }
  },

  generate_lyrics: {
    description: "Draft song lyrics from an enhanced prompt and story",
    inputSchema: {
      type: "object",
      properties: {
        enhanced_prompt: { type: "string" },
        song_language: { type: "string" },
        genre: { type: "string" },
        customer_story: { type: "string" },
        recipient_name: { type: "string" }
      },
      required: ["enhanced_prompt", "customer_story"]
    }
  }
};

// ─── MCP Request Handler ──────────────────────────────────────

export async function handleMcpRequest(toolName, params, apiKey) {
  switch (toolName) {
    case "enhance_prompt": {
      const result = await enhancePrompt(params, apiKey);
      return { success: true, data: result };
    }

    case "score_quality": {
      const result = await scorePrompt(params.prompt, apiKey);
      return { success: true, data: result };
    }

    case "extract_intake": {
      const result = await extractIntake(params.raw_message, params.existing_fields, apiKey);
      return { success: true, data: result };
    }

    case "generate_lyrics": {
      const result = await generateLyrics(params, apiKey);
      return { success: true, data: result };
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

// ─── Tool Implementations ─────────────────────────────────────

async function extractIntake(rawMessage, existingFields = {}, apiKey) {
  // Use OpenRouter to structure a raw Telegram message into order fields
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-20250514",
      messages: [
        {
          role: "system",
          content: `You are a Melodi intake extraction agent. Extract structured order fields from raw customer messages.
Return JSON only:
{
  "recipient_name": "...",
  "recipient_gender": "Male|Female|Other|UNKNOWN",
  "recipient_age_range": "18-24|25-34|35-44|45-54|55-64|65+|UNKNOWN",
  "relationship": "...",
  "occasion": "...",
  "genre": "...",
  "song_language": "...",
  "vocal_style": "...",
  "tempo": "...",
  "customer_story": "...",
  "key_memory": "...",
  "inside_joke": "...",
  "confidence": 0.0-1.0,
  "gaps": ["field: reason"]
}`
        },
        {
          role: "user",
          content: `Existing known fields:\n${JSON.stringify(existingFields, null, 2)}\n\nRaw customer message:\n${rawMessage}`
        }
      ],
      temperature: 0.3,
      max_tokens: 600
    })
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
  const parsed = JSON.parse(raw.replace(/^```json\n?/, "").replace(/\n?```$/, ""));
  return parsed;
}

async function generateLyrics(params, apiKey) {
  const { enhanced_prompt, song_language, genre, customer_story, recipient_name } = params;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-20250514",
      messages: [
        {
          role: "system",
          content: `You are a Melodi lyricist. Write original song lyrics for a personalized song.
Rules:
- Write in ${song_language || "English"}
- Match genre: ${genre || "Pop"}
- The song is a gift for ${recipient_name || "someone special"}
- Weave in details from the customer's story naturally
- Include verse, chorus, bridge structure markers
- Keep it emotionally warm, not cheesy
- Maximum 500 words
- Do not copy any existing song lyrics`
        },
        {
          role: "user",
          content: `Customer story:\n${customer_story}\n\nEnhanced prompt:\n${enhanced_prompt}`
        }
      ],
      temperature: 0.8,
      max_tokens: 1000
    })
  });

  const data = await response.json();
  return {
    lyrics: data.choices?.[0]?.message?.content?.trim() || "",
    word_count: (data.choices?.[0]?.message?.content?.trim() || "").split(/\s+/).length
  };
}

// ─── Tool Registry ───────────────────────────────────────────

export function getToolManifest() {
  return {
    name: "melodi-mcp",
    version: "1.0.0",
    tools: MCP_TOOLS
  };
}
