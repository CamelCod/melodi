---
name: melodi-intake-agent
description: >
  Runs the Melodi song order intake flow. Takes a raw customer story dump from
  Telegram and structures it into all required fields for the Suno prompt engine.
  Use this skill whenever a new order arrives and the intake form needs to be
  filled in Song Orders database. Also use when a customer's story is ambiguous
  and needs structured extraction before prompting.
---

# Melodi Intake Agent

Converts a raw Telegram message (story dump or multi-message thread) into a
fully structured song order row, ready to feed into the Prompt Engine.

---

## Inputs Required

The agent needs ONE of the following:
- A direct transcript of the customer's Telegram conversation
- A copy-paste of their story message(s)
- A voice note transcript

---

## Extraction Steps

### Step 1 — Scan for explicit fields

Look for anything the customer directly stated:
- Recipient name (any name mentioned as the person receiving the song)
- Occasion (birthday, anniversary, Eid, wedding, etc.)
- Event date or timeframe ("her birthday is next Friday")
- Genre preference (pop, Arabic, Khaleeji, etc.)
- Language preference

### Step 2 — Infer implicit fields

From cultural cues, names, and writing style:
- Sender's likely country / culture (name patterns, language used, occasion type)
- Recipient gender (from pronouns or name)
- Relationship (from how they describe the person)
- Emotional tone requested (the way they tell the story reveals the desired mood)

### Step 3 — Flag gaps

For any required field that cannot be extracted or inferred, output:
`MISSING: [field name] — suggest asking: "[exact question to send customer]"`

Required fields that must never be guessed:
- Recipient name
- Occasion
- Customer story (verbatim)

Fields that can be inferred with a note:
- Genre (infer from culture + occasion, flag as inferred)
- Language (infer from how they wrote to the bot, flag as inferred)
- Vocal style (infer from recipient gender, flag as inferred)

---

## Output Format

Produce a filled intake block exactly like this:

```
MELODI ORDER INTAKE
───────────────────
Recipient name:    [name]
Recipient gender:  [Male / Female / Other]
Recipient age:     [age range]
Relationship:      [relationship]

Occasion:          [occasion]
Event date:        [date or "not specified"]

Genre:             [genre] [INFERRED / STATED]
Song language:     [language] [INFERRED / STATED]
Vocal style:       [style] [INFERRED / STATED]
Tempo:             [tempo] [INFERRED / STATED]

Customer story:    [verbatim or lightly cleaned — never rewrite]
Key memory:        [single most specific detail extracted]
Inside joke:       [if any — or "None"]

GAPS TO FILL:
- [list any missing required fields and the question to ask]

READY TO PROMPT: [YES / NO — NO if any required field is missing]
```

---

## Rules

- Never rewrite the customer story — preserve their voice exactly
- Never fabricate specific details (names, places, dates) that weren't given
- If story is very short (under 30 words), flag as "THIN STORY — request more detail before prompting"
- If multiple occasions are mentioned, ask which one the song is for
- Cultural sensitivity: Gulf customers writing about mothers or fathers often have specific emotional registers — note this for the prompt engineer
