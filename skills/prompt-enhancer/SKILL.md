# Melodi Prompt Enhancer

Enhances raw intake order data into a polished Suno prompt + quality score using OpenRouter.

---

## When to run

After `finalizeOrder()` in the bot-worker — when an order has `status = intake_complete`.

Triggered by:
- Cron check every 5 minutes for new `intake_complete` orders
- Or called directly from the worker after D1 write

---

## Inputs

```json
{
  "order_ref": "MLD-XXXXX",
  "recipient_name": "Fatima",
  "recipient_gender": "Female",
  "recipient_age_range": "25-34",
  "relationship": "Wife",
  "occasion": "Birthday",
  "genre": "Pop",
  "song_language": "Arabic-English Mix",
  "vocal_style": "Female Solo",
  "tempo": "Mid-tempo warm",
  "customer_story": "He proposed to her on a rooftop in Dubai...",
  "key_memory": "The rooftop in Dubai where he proposed",
  "inside_joke": "She always says 'ya raiti' when she's surprised"
}
```

---

## Process

### Step 1 — Build base prompt structure

Assemble a raw prompt from order fields:
- Genre + tempo → musical style
- Relationship + occasion → emotional register
- Story + key memory → narrative content
- Inside joke → cultural/layered reference
- Language → linguistic register for lyrics

### Step 2 — Call OpenRouter

Model: `anthropic/claude-sonnet-4-20250514` (or preferred)

System prompt:
```
You are the Melodi Prompt Engineer. Your job is to take raw order data and produce
a Suno music generation prompt that will result in a high-quality, emotionally
resonant song.

Rules:
- Write in English unless the song is primarily Arabic/Hindi (then keep prompt English)
- Include specific sensory details from the story
- Match genre+tempo exactly
- Keep prompt under 500 words
- Never fabricate names, dates, or specific facts not in the input
- Add emotional warmth without being cheesy
- Structure: [Style] [Mood] [Narrative] [Key lyric hooks] [Production notes]

Output JSON only:
{
  "enhanced_prompt": "...",
  "lyric_stucture": "verse / chorus / bridge structure guidance",
  "quality_score": 1-10,
  "warnings": ["any concerns about the prompt"]
}
```
### Step 3 — Store result

Write back to D1 `orders` table:
- `suno_prompt` = enhanced_prompt
- `quality_score` = score
- `status` = 'prompt_ready'
- `updated_at` = now

---

## Output

```json
{
  "order_ref": "MLD-XXXXX",
  "status": "prompt_ready",
  "enhanced_prompt": "...",
  "lyric_structure": "...",
  "quality_score": 8,
  "warnings": []
}
```

---

## Quality gates

- Score < 5 → flag for human review before generation
- Score 5-7 → proceed but note in order
- Score 8+ → auto-proceed to Suno generation

---

## Error handling

- OpenRouter timeout → retry once after 30s, then flag as `prompt_error`
- Invalid response → store raw prompt as fallback, flag warning
- D1 write failure → log error, retry via cron
