from __future__ import annotations

import base64
import json
import os
import re
import time
from collections import defaultdict
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from google import genai
from google.genai import types
import edge_tts


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()


APP_NAME = "Medi-Shield"
APP_VERSION = "1.0.0"


GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()


# ============================================================
# MODEL POOL
# ============================================================
#
# IMPORTANT:
# Do not assume these quotas are equal.
# AI Studio determines the real quota available to the project.
#
# The backend uses them as a failover pool.
#
# ============================================================

PRIMARY_MODEL = os.getenv(
    "PRIMARY_MODEL",
    "gemini-3.5-flash-lite",
).strip()


BACKUP_MODEL_1 = os.getenv(
    "BACKUP_MODEL_1",
    "gemini-3.1-flash-lite",
).strip()


BACKUP_MODEL_2 = os.getenv(
    "BACKUP_MODEL_2",
    "gemini-2.5-flash",
).strip()


BACKUP_MODEL_3 = os.getenv(
    "BACKUP_MODEL_3",
    "gemini-2.5-flash-lite",
).strip()


BACKUP_MODEL_4 = os.getenv(
    "BACKUP_MODEL_4",
    "gemini-3.5-flash",
).strip()


MODEL_POOL = [
    PRIMARY_MODEL,
    BACKUP_MODEL_1,
    BACKUP_MODEL_2,
    BACKUP_MODEL_3,
    BACKUP_MODEL_4,
]


# Remove duplicates while preserving order.
MODEL_POOL = list(dict.fromkeys(
    model for model in MODEL_POOL if model
))


# ============================================================
# HARD DISABLED MODELS
# ============================================================

DISABLED_MODELS = {
    "gemini-3.8-flash",
    "gemini-3.8-flash-tts",
}


# ============================================================
# VOICE
# ============================================================

NATIVE_AUDIO_MODEL = os.getenv(
    "GEMINI_NATIVE_AUDIO_MODEL",
    "gemini-2.5-flash-native-audio-preview-12-2025",
).strip()


VOICE_PROVIDER = os.getenv(
    "VOICE_PROVIDER",
    "edge_tts",
).strip()


EDGE_TTS_VOICE_EN = os.getenv(
    "EDGE_TTS_VOICE_EN",
    "en-US-AriaNeural",
).strip()


EDGE_TTS_VOICE_HI = os.getenv(
    "EDGE_TTS_VOICE_HI",
    "hi-IN-SwaraNeural",
).strip()


# ============================================================
# QUOTA / COOLDOWN
# ============================================================

MODEL_COOLDOWN_SECONDS = int(
    os.getenv(
        "MODEL_COOLDOWN_SECONDS",
        "300",
    )
)


model_cooldowns: dict[str, float] = {}

model_failures: dict[str, int] = defaultdict(int)

model_last_used: dict[str, float] = defaultdict(float)


# ============================================================
# GEMINI CLIENT
# ============================================================

client: Optional[genai.Client] = None

if GEMINI_API_KEY:
    client = genai.Client(
        api_key=GEMINI_API_KEY,
    )


# ============================================================
# FASTAPI
# ============================================================

app = FastAPI(
    title="Medi-Shield API",
    version=APP_VERSION,
    description=(
        "Medi-Shield — AI Second Pair of Eyes "
        "for Medication Safety."
    ),
)


# ============================================================
# CORS
# ============================================================

allowed_origins_raw = os.getenv(
    "ALLOWED_ORIGINS",
    "*",
)

if allowed_origins_raw == "*":
    allowed_origins = ["*"]
else:
    allowed_origins = [
        origin.strip()
        for origin in allowed_origins_raw.split(",")
        if origin.strip()
    ]


app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=allowed_origins != ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# PROMPTS
# ============================================================

MEDLY_SYSTEM_PROMPT = """
You are Medly, the AI companion inside Medi-Shield.

Medi-Shield is an AI second pair of eyes for medication safety.

PERSONALITY
- Calm, warm, intelligent and human-like.
- Conversational rather than robotic.
- Helpful without sounding like a disclaimer generator.
- Understand English, Hinglish, Roman Hindi and imperfect English.
- Match the user's language naturally.
- Use conversation context.
- Keep simple questions concise.
- Explain difficult medical information in simple language.
- You may naturally say things like "Haan, samjha" when appropriate.
- Never pretend to be a doctor.

ROLE
You can:
- Explain medicines and medical terminology.
- Explain information visible in prescriptions.
- Identify details that may need verification.
- Help prepare questions for a doctor or pharmacist.
- Give general food and wellness information.
- Help users navigate Medi-Shield.
- Research uncertain/current information when appropriate.

SAFETY
- Never diagnose a disease.
- Never prescribe treatment.
- Never tell the user to start, stop, increase, decrease or change a medicine or dose.
- Never invent prescription details.
- Never invent medical facts.
- Clearly distinguish known information from uncertainty.
- Encourage professional verification when a clinical decision is involved.
- If the situation appears urgent or life-threatening, prioritize emergency medical care.

COMMUNICATION
- Answer the actual question first.
- Do not repeat the user's question unnecessarily.
- Do not overuse warnings.
- Do not turn every response into a disclaimer.
- Understand Hinglish naturally.
- Do not translate every Hinglish sentence into formal Hindi.
- Remember relevant conversation context.
"""


PRESCRIPTION_SYSTEM_PROMPT = """
You are the medication-safety analysis engine for Medi-Shield.

Analyze the supplied prescription/document image conservatively.

Return ONLY valid JSON.

Required structure:

{
  "summary": "short plain-language summary",
  "medications": [
    {
      "name": "medicine name or Unknown",
      "strength": "strength or Unknown",
      "form": "tablet/capsule/syrup/etc or Unknown",
      "directions": "directions exactly as understood or Unclear",
      "confidence": "high/medium/low"
    }
  ],
  "flags": [
    {
      "severity": "clear/verify/review",
      "title": "short title",
      "detail": "why this deserves attention"
    }
  ],
  "timeline": [],
  "questions_for_professional": [],
  "diet_guidance": [],
  "warning": "important uncertainty or warning"
}

RULES:

1. Never invent handwriting.
2. Never invent missing dose, frequency, duration, strength or medicine name.
3. If text is unclear, say it is unclear.
4. Never claim certainty from poor image quality.
5. If multiple interpretations are possible, mark the information unclear.
6. Do not diagnose.
7. Do not prescribe.
8. Do not tell the patient to start, stop, increase, decrease or change medication.
9. Identify information that should be verified by a doctor or pharmacist.
10. General food guidance only.
11. Distinguish clear information from uncertain information.
12. Be especially conservative with handwritten prescriptions.
13. Return JSON only.
"""


# ============================================================
# REQUEST MODELS
# ============================================================

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)
    language: str = "en"


class PrescriptionRequest(BaseModel):
    image_data: str
    extra_context: str = ""


class SpeakRequest(BaseModel):
    text: str
    language: str = "en"


# ============================================================
# HELPERS
# ============================================================

def now() -> float:
    return time.time()


def is_disabled(model: str) -> bool:
    return model.lower().strip() in {
        item.lower()
        for item in DISABLED_MODELS
    }


def is_model_available(model: str) -> bool:
    if not model:
        return False

    if is_disabled(model):
        return False

    cooldown_until = model_cooldowns.get(model, 0)

    return now() >= cooldown_until


def cooldown_model(
    model: str,
    reason: str = "",
) -> None:

    model_cooldowns[model] = (
        now() + MODEL_COOLDOWN_SECONDS
    )

    model_failures[model] += 1

    print(
        f"[MODEL COOLDOWN] {model} "
        f"for {MODEL_COOLDOWN_SECONDS}s "
        f"reason={reason}"
    )


def mark_model_used(model: str) -> None:
    model_last_used[model] = now()


def is_quota_error(exc: Exception) -> bool:
    text = str(exc).lower()

    quota_signals = [
        "429",
        "resource_exhausted",
        "resource exhausted",
        "quota",
        "rate limit",
        "rate_limit",
        "too many requests",
        "exceeded",
        "limit reached",
    ]

    return any(
        signal in text
        for signal in quota_signals
    )


def get_model_status(model: str) -> dict[str, Any]:

    if is_disabled(model):
        return {
            "model": model,
            "status": "disabled",
            "reason": "Hard-disabled by application configuration.",
        }

    cooldown_until = model_cooldowns.get(
        model,
        0,
    )

    if now() < cooldown_until:
        return {
            "model": model,
            "status": "cooldown",
            "retry_in_seconds": max(
                0,
                int(cooldown_until - now()),
            ),
            "failures": model_failures.get(
                model,
                0,
            ),
        }

    return {
        "model": model,
        "status": "available",
        "failures": model_failures.get(
            model,
            0,
        ),
    }


def available_models() -> list[str]:
    return [
        model
        for model in MODEL_POOL
        if is_model_available(model)
    ]


def ordered_model_pool() -> list[str]:

    available = available_models()

    # Primary first.
    # Remaining models are ordered by least recent usage.
    primary = [
        model
        for model in available
        if model == PRIMARY_MODEL
    ]

    remaining = [
        model
        for model in available
        if model != PRIMARY_MODEL
    ]

    remaining.sort(
        key=lambda model: model_last_used.get(
            model,
            0,
        )
    )

    return primary + remaining


def extract_data_uri(
    image_data: str,
) -> tuple[str, bytes]:

    if not image_data:
        raise ValueError(
            "Image data is empty."
        )

    if image_data.startswith("data:"):

        match = re.match(
            r"data:([^;]+);base64,(.+)",
            image_data,
            re.DOTALL,
        )

        if not match:
            raise ValueError(
                "Invalid image data."
            )

        mime_type = match.group(1)

        raw_base64 = match.group(2)

        return (
            mime_type,
            base64.b64decode(
                raw_base64
            ),
        )

    # Assume raw base64.
    return (
        "image/jpeg",
        base64.b64decode(
            image_data
        ),
    )


def clean_json_text(text: str) -> str:

    text = text.strip()

    if text.startswith("```"):
        text = re.sub(
            r"^```(?:json)?\s*",
            "",
            text,
            flags=re.IGNORECASE,
        )

        text = re.sub(
            r"\s*```$",
            "",
            text,
        )

    return text.strip()


def safe_json_parse(text: str) -> dict[str, Any]:

    cleaned = clean_json_text(text)

    try:
        result = json.loads(cleaned)

        if isinstance(result, dict):
            return result

    except Exception:
        pass

    # Try extracting first JSON object.
    start = cleaned.find("{")
    end = cleaned.rfind("}")

    if start != -1 and end > start:

        candidate = cleaned[
            start:end + 1
        ]

        try:
            result = json.loads(
                candidate
            )

            if isinstance(result, dict):
                return result

        except Exception:
            pass

    raise ValueError(
        "The AI returned invalid JSON."
    )


def normalize_history(
    history: list[ChatMessage],
) -> list[types.Content]:

    result: list[types.Content] = []

    for item in history:

        role = (
            "model"
            if item.role == "assistant"
            else "user"
        )

        content = item.content.strip()

        if not content:
            continue

        result.append(
            types.Content(
                role=role,
                parts=[
                    types.Part.from_text(
                        text=content
                    )
                ],
            )
        )

    return result


# ============================================================
# GEMINI GENERATION
# ============================================================

def generate_text(
    *,
    contents: Any,
    system_instruction: str,
    thinking_level: Optional[str] = None,
) -> tuple[str, str]:

    if not client:
        raise RuntimeError(
            "GEMINI_API_KEY is not configured."
        )

    models = ordered_model_pool()

    if not models:
        raise RuntimeError(
            "All configured Gemini models are currently unavailable."
        )

    last_error: Optional[Exception] = None

    for model in models:

        if is_disabled(model):
            continue

        try:

            config_kwargs: dict[str, Any] = {
                "system_instruction": (
                    system_instruction
                ),
            }

            if thinking_level:
                config_kwargs[
                    "thinking_config"
                ] = types.ThinkingConfig(
                    thinking_level=thinking_level
                )

            response = client.models.generate_content(
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(
                    **config_kwargs
                ),
            )

            text = (
                response.text
                if response.text
                else ""
            ).strip()

            if not text:
                raise RuntimeError(
                    f"{model} returned an empty response."
                )

            mark_model_used(model)

            return text, model

        except Exception as exc:

            last_error = exc

            print(
                f"[MODEL ERROR] "
                f"{model}: {exc}"
            )

            if is_quota_error(exc):

                cooldown_model(
                    model,
                    reason=str(exc),
                )

                continue

            # Non-quota error:
            # try another model, but don't permanently
            # mark this one unavailable.
            continue

    if last_error:

        raise RuntimeError(
            "All available Gemini models failed. "
            f"Last error: {last_error}"
        )

    raise RuntimeError(
        "No Gemini model was available."
    )


# ============================================================
# LOCAL CHAT BRAIN
# ============================================================

def local_medly_response(
    message: str,
) -> Optional[str]:

    text = message.lower().strip()

    simple_responses = {
        "hi": "Haan, I'm here. What do you want to check?",
        "hello": "Hey! I'm Medly. What can I help you understand?",
        "hey": "Hey! I'm Medly. What are we checking today?",
        "thanks": "You're welcome. I'm here if you want to check anything else.",
        "thank you": "You're welcome. 🌿",
    }

    if text in simple_responses:
        return simple_responses[text]

    if text in {
        "who are you",
        "what are you",
        "what is medly",
    }:
        return (
            "I'm Medly, the medication-safety companion "
            "inside Medi-Shield. I can help you understand "
            "medicine information and spot things that may "
            "need verification."
        )

    if text in {
        "are you a doctor",
        "are you doctor",
    }:
        return (
            "No — I'm not a doctor. I'm a second pair of "
            "eyes that helps explain medication information "
            "and highlight things worth verifying."
        )

    return None


# ============================================================
# HEALTH
# ============================================================

@app.get("/")
async def root():

    return {
        "service": APP_NAME,
        "version": APP_VERSION,
        "status": "running",
    }


@app.get("/api/health")
async def health():

    models = [
        get_model_status(model)
        for model in MODEL_POOL
    ]

    usable = [
        model
        for model in MODEL_POOL
        if is_model_available(model)
    ]

    return {
        "status": (
            "healthy"
            if client and usable
            else "degraded"
        ),
        "service": APP_NAME,
        "version": APP_VERSION,
        "gemini_configured": bool(
            GEMINI_API_KEY
        ),
        "model_pool": models,
        "primary_model": PRIMARY_MODEL,
        "native_audio_model": NATIVE_AUDIO_MODEL,
        "voice_provider": VOICE_PROVIDER,
        "disabled_models": sorted(
            DISABLED_MODELS
        ),
    }


# ============================================================
# MEDLY CHAT
# ============================================================

@app.post("/api/medly/chat")
async def medly_chat(
    request: ChatRequest,
):

    message = request.message.strip()

    if not message:
        raise HTTPException(
            status_code=400,
            detail="Message cannot be empty.",
        )

    # --------------------------------------------------------
    # LOCAL-FIRST BRAIN
    # --------------------------------------------------------

    local = local_medly_response(
        message
    )

    if local:

        return {
            "reply": local,
            "text": local,
            "model": "local",
            "source": "local_brain",
        }

    # --------------------------------------------------------
    # GEMINI
    # --------------------------------------------------------

    history = normalize_history(
        request.history
    )

    history.append(
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=message
                )
            ],
        )
    )

    try:

        reply, model = generate_text(
            contents=history,
            system_instruction=(
                MEDLY_SYSTEM_PROMPT
                + "\n\n"
                + f"Preferred language: {request.language}"
            ),
            thinking_level="minimal",
        )

        return {
            "reply": reply,
            "text": reply,
            "model": model,
            "source": "gemini",
        }

    except Exception as exc:

        print(
            f"[CHAT FAILURE] {exc}"
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Medly's AI models are temporarily "
                "unavailable. Please try again shortly."
            ),
        )


# ============================================================
# PRESCRIPTION ANALYSIS
# ============================================================

@app.post("/api/medly/analyze")
async def analyze_prescription(
    request: PrescriptionRequest,
):

    try:

        mime_type, image_bytes = (
            extract_data_uri(
                request.image_data
            )
        )

    except Exception:

        raise HTTPException(
            status_code=400,
            detail="Invalid prescription image.",
        )

    image_part = types.Part.from_bytes(
        data=image_bytes,
        mime_type=mime_type,
    )

    prompt = """
Analyze this prescription/document image.

Be conservative.

Do not guess handwriting.

Return ONLY JSON matching the required schema.

"""

    if request.extra_context.strip():

        prompt += (
            "\nAdditional user context:\n"
            + request.extra_context.strip()
        )

    contents = [
        types.Content(
            role="user",
            parts=[
                types.Part.from_text(
                    text=prompt
                ),
                image_part,
            ],
        )
    ]

    try:

        raw, model = generate_text(
            contents=contents,
            system_instruction=(
                PRESCRIPTION_SYSTEM_PROMPT
            ),
            thinking_level="medium",
        )

        analysis = safe_json_parse(
            raw
        )

        return {
            **analysis,
            "model": model,
            "source": "gemini",
        }

    except ValueError as exc:

        print(
            f"[PRESCRIPTION JSON ERROR] {exc}"
        )

        raise HTTPException(
            status_code=502,
            detail=(
                "The prescription analysis "
                "could not be safely structured. "
                "Please try the image again."
            ),
        )

    except Exception as exc:

        print(
            f"[PRESCRIPTION FAILURE] {exc}"
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Prescription analysis is "
                "temporarily unavailable."
            ),
        )


# ============================================================
# VOICE — CURRENT SAFE PATH
# ============================================================
#
# The frontend currently expects an audio blob.
#
# We keep Edge TTS as the reliable production fallback.
#
# Native Audio is exposed in /api/health and can later be
# connected to a true Gemini Live WebSocket flow.
#
# This avoids breaking the current frontend.
# ============================================================

def choose_edge_voice(
    language: str,
) -> str:

    language = (
        language or "en"
    ).lower()

    if language.startswith("hi"):
        return EDGE_TTS_VOICE_HI

    return EDGE_TTS_VOICE_EN


@app.post("/api/medly/speak")
async def medly_speak(
    request: SpeakRequest,
):

    text = request.text.strip()

    if not text:
        raise HTTPException(
            status_code=400,
            detail="Text cannot be empty.",
        )

    if len(text) > 5000:
        raise HTTPException(
            status_code=400,
            detail="Text is too long for voice generation.",
        )

    voice = choose_edge_voice(
        request.language
    )

    try:

        communicate = edge_tts.Communicate(
            text,
            voice,
        )

        audio_chunks = []

        async for chunk in communicate.stream():

            if (
                chunk["type"]
                == "audio"
            ):
                audio_chunks.append(
                    chunk["data"]
                )

        audio = b"".join(
            audio_chunks
        )

        if not audio:
            raise RuntimeError(
                "Voice generation returned no audio."
            )

        return Response(
            content=audio,
            media_type="audio/mpeg",
            headers={
                "Cache-Control": "no-store",
            },
        )

    except Exception as exc:

        print(
            f"[VOICE ERROR] {exc}"
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Voice generation failed. "
                "Please try again."
            ),
        )


# ============================================================
# NATIVE AUDIO INFORMATION
# ============================================================

@app.get("/api/medly/voice")
async def medly_voice_info():

    return {
        "provider": "gemini_live_available",
        "model": NATIVE_AUDIO_MODEL,
        "fallback": "edge_tts",
        "mode": (
            "live_audio_model_configured"
        ),
        "note": (
            "Native Audio requires a bidirectional "
            "Live API/WebSocket client flow. "
            "The current blob endpoint intentionally "
            "uses Edge TTS for compatibility."
        ),
    }


# ============================================================
# RUN DIRECTLY
# ============================================================

if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(
            os.getenv(
                "PORT",
                "8000",
            )
        ),
        reload=False,
    )