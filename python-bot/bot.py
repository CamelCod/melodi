"""
MELODI ARABIC SONG BOT — Python / python-telegram-bot v20+
GOAL: Collect 5 answers from Arabic-speaking users and generate a custom song via Suno.
INPUT: Telegram messages
OUTPUT: AI-generated audio file sent back to the user
STEPS:
  1. /start → ask 5 questions one at a time (Arabic)
  2. Build English Suno prompt from answers
  3. POST to Suno API → poll until complete → return audio_url
  4. Send audio file to user
"""

import asyncio
import os

import httpx
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ConversationHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

BOT_TOKEN = os.environ["BOT_TOKEN"]
SUNO_API_KEY = os.environ["SUNO_API_KEY"]
SUNO_API_BASE = "https://studio-api.suno.ai"

RECIPIENT, OCCASION, MOOD, MEMORY, LANGUAGE = range(5)

# Words that mean the user wants to skip question 4
SKIP_WORDS = {"لا", "ما في", "ما عندي", "لا شيء", "لاشيء", "تخطى", "skip", "no", "none"}


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text(
        "أهلاً! 🎵 سأساعدك في إنشاء أغنية مخصصة.\n\n"
        "السؤال الأول:\n*لمن هذه الأغنية؟* (الاسم والعلاقة — مثال: أمي فاطمة، صديقي أحمد)",
        parse_mode="Markdown",
    )
    return RECIPIENT


async def ask_occasion(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["recipient"] = update.message.text.strip()
    await update.message.reply_text(
        "السؤال الثاني:\n*ما المناسبة؟*",
        parse_mode="Markdown",
    )
    return OCCASION


async def ask_mood(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["occasion"] = update.message.text.strip()
    await update.message.reply_text(
        "السؤال الثالث:\n*ما الطابع اللي تحب للأغنية؟*\n(خليجي، شعبي، رومانسي، مرح...)",
        parse_mode="Markdown",
    )
    return MOOD


async def ask_memory(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["mood"] = update.message.text.strip()
    await update.message.reply_text(
        "السؤال الرابع:\n*في شي معين تحب يتذكر فيها؟*\n_(اختياري — اكتب \"لا\" أو \"ما في\" للتخطي)_",
        parse_mode="Markdown",
    )
    return MEMORY


async def ask_language(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip()
    is_skip = text.lower() in SKIP_WORDS or any(w in text for w in SKIP_WORDS)
    context.user_data["memory"] = None if is_skip else text
    await update.message.reply_text(
        "السؤال الخامس:\n*تبي الأغنية بالعربي ولا إنجليزي؟*",
        parse_mode="Markdown",
    )
    return LANGUAGE


async def generate(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text.strip()
    if "إنجليزي" in text or "انجليزي" in text or "english" in text.lower():
        context.user_data["language"] = "English"
    else:
        context.user_data["language"] = "Arabic"

    await update.message.reply_text("🎶 جاري إنشاء أغنيتك... قد يستغرق ذلك بضع دقائق.")

    prompt = _build_prompt(context.user_data)
    context.user_data.clear()

    try:
        audio_url = await _generate_song(prompt)
        await update.message.reply_audio(audio=audio_url, caption="🎵 هذه أغنيتك المخصصة!")
    except TimeoutError:
        await update.message.reply_text("⏱ استغرق إنشاء الأغنية وقتاً أطول من المتوقع. حاول مرة أخرى.")
    except Exception:
        await update.message.reply_text("❌ حدث خطأ أثناء إنشاء الأغنية. حاول مرة أخرى لاحقاً.")

    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("تم الإلغاء. اكتب /start للبدء من جديد.")
    return ConversationHandler.END


def _build_prompt(data: dict) -> str:
    memory_part = f" Include this memory or detail: {data['memory']}." if data.get("memory") else ""
    return (
        f"A {data['mood']} Arabic song for {data['recipient']}. "
        f"Occasion is {data['occasion']}. "
        f"{data['language']} lyrics.{memory_part} "
        f"Warm and celebratory tone. Mention the name in the lyrics."
    )


async def _generate_song(prompt: str) -> str:
    headers = {
        "Authorization": f"Bearer {SUNO_API_KEY}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{SUNO_API_BASE}/api/generation/v2/",
            json={"prompt": prompt, "make_instrumental": False, "wait_for_model": False},
            headers=headers,
        )
        resp.raise_for_status()
        generation_id = resp.json()["generation_id"]

    # Poll up to 5 minutes (24 × 12.5s)
    for _ in range(24):
        await asyncio.sleep(12.5)
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{SUNO_API_BASE}/api/generation/v2/{generation_id}",
                headers={"Authorization": f"Bearer {SUNO_API_KEY}"},
            )
            resp.raise_for_status()
            data = resp.json()

        if data["status"] == "complete":
            return data["audio_url"]
        if data["status"] == "error":
            raise RuntimeError(data.get("error", "Suno generation failed"))

    raise TimeoutError("Song generation timed out after 5 minutes")


def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()

    conv = ConversationHandler(
        entry_points=[CommandHandler("start", start)],
        states={
            RECIPIENT: [MessageHandler(filters.TEXT & ~filters.COMMAND, ask_occasion)],
            OCCASION: [MessageHandler(filters.TEXT & ~filters.COMMAND, ask_mood)],
            MOOD:     [MessageHandler(filters.TEXT & ~filters.COMMAND, ask_memory)],
            MEMORY:   [MessageHandler(filters.TEXT & ~filters.COMMAND, ask_language)],
            LANGUAGE: [MessageHandler(filters.TEXT & ~filters.COMMAND, generate)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    app.add_handler(conv)
    app.run_polling()


if __name__ == "__main__":
    main()
