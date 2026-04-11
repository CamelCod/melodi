# Melodi Quality Scorer

Evaluates generated song outputs against hard quality gates. Runs after Suno generation before delivery.

---

## When to run

After Suno delivers a preview URL, before notifying the customer.

Triggered by:
- `suno-client.js` after `preview_url` is stored in D1
- Cron job reviewing all `preview_ready` orders

---

## Quality Gates

| Score | Action |
|---|---|
| 8–10 | ✅ Auto-deliver to customer |
| 5–7 | ⚠️ Deliver but flag for review |
| < 5 | ❌ Flag for regeneration + human review |

---

## Evaluation Checks

Run all of these programmatically:

### 1. Duration check
- Minimum: 40 seconds
- Maximum: 90 seconds (preview clip)

### 2. Audio quality (if waveform data available)
- No flat lining (RMS energy > threshold)
- No obvious clipping

### 3. Content alignment
- Recipient name mentioned (if short name)
- Genre matches order
- Mood matches tempo

### 4. Linguistic check
- Song language matches order language
- No obvious garbled/missing lyrics

### 5. Suno quality signal
- `quality_score` from prompt stage predicts success
- Score < 5 from OpenRouter = flag regardless of output

---

## Output

```json
{
  "order_ref": "MLD-XXXXX",
  "quality_score": 8,
  "passed_gates": ["duration", "content_alignment", "linguistic"],
  "warnings": [],
  "action": "deliver",
  "deliverable": true
}
```

If `deliverable: false`:
- Log warning to D1 `issue_notes`
- Send to human review queue
- Do NOT auto-deliver
