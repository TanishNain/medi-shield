import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  chatWithMedly,
  speakWithMedly,
} from "./api";

import "./styles/Medly.css";

/* =========================================================
   CONFIG
   ========================================================= */

const MAX_HISTORY = 12;

const INITIAL_MESSAGE = {
  id: "medly-welcome",
  role: "assistant",
  text:
    "Hey, I’m Medly. I’m here to help you understand, verify, and stay safe.",
};

/* =========================================================
   TEXT EXTRACTION
   ---------------------------------------------------------
   Safely converts Gemini/API response structures into
   actual human-readable text.

   Prevents:
   [object Object],[object Object]...
   ========================================================= */

function extractMedlyText(value, depth = 0) {
  if (value == null || depth > 10) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) =>
        extractMedlyText(item, depth + 1)
      )
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (typeof value === "object") {
    /*
     * Most likely response-text fields first.
     */
    const preferredKeys = [
      "reply",
      "text",
      "content",
      "message",
      "answer",
      "output",
      "response",
      "output_text",
      "generated_text",
    ];

    for (const key of preferredKeys) {
      if (
        Object.prototype.hasOwnProperty.call(
          value,
          key
        )
      ) {
        const result = extractMedlyText(
          value[key],
          depth + 1
        );

        if (result) {
          return result;
        }
      }
    }

    /*
     * Gemini response structures.
     */
    if (value.candidates) {
      const result = extractMedlyText(
        value.candidates,
        depth + 1
      );

      if (result) {
        return result;
      }
    }

    if (value.parts) {
      const result = extractMedlyText(
        value.parts,
        depth + 1
      );

      if (result) {
        return result;
      }
    }

    /*
     * Last-resort recursive search.
     */
    const ignoredKeys = new Set([
      "id",
      "role",
      "status",
      "model",
      "metadata",
      "usage",
      "finishReason",
      "finish_reason",
      "safetyRatings",
      "safety_ratings",
    ]);

    for (const [key, child] of Object.entries(
      value
    )) {
      if (ignoredKeys.has(key)) {
        continue;
      }

      const result = extractMedlyText(
        child,
        depth + 1
      );

      if (result) {
        return result;
      }
    }
  }

  return "";
}

/* =========================================================
   CLEAN TEXT
   ========================================================= */

function cleanText(value) {
  return extractMedlyText(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* =========================================================
   BACKEND HISTORY FORMAT
   ---------------------------------------------------------
   IMPORTANT:

   Your FastAPI model is:

   class ChatMessage(BaseModel):
       role: str
       content: str

   Therefore we MUST send "content", NOT "text".
   ========================================================= */

function buildBackendHistory(messages) {
  return messages
    .slice(-MAX_HISTORY)
    .map((message) => ({
      role:
        message.role === "user"
          ? "user"
          : "assistant",

      content: cleanText(message.text),
    }))
    .filter(
      (message) =>
        message.content.length > 0
    );
}

/* =========================================================
   COMPONENT
   ========================================================= */

export default function Medly({
  open = true,
  onClose,
  name = "",
}) {
  /* -------------------------------------------------------
     STATE
     ------------------------------------------------------- */

  const [messages, setMessages] =
    useState([INITIAL_MESSAGE]);

  const [input, setInput] =
    useState("");

  const [thinking, setThinking] =
    useState(false);

  const [speaking, setSpeaking] =
    useState(false);

  const [listening, setListening] =
    useState(false);

  const [language, setLanguage] =
    useState("en");

  const [error, setError] =
    useState("");

  /* -------------------------------------------------------
     REFS
     ------------------------------------------------------- */

  const inputRef =
    useRef(null);

  const messagesEndRef =
    useRef(null);

  const audioRef =
    useRef(null);

  const recognitionRef =
    useRef(null);

  /*
   * Invalidates old speech requests.
   */
  const speechTokenRef =
    useRef(0);

  /*
   * Prevents double-send.
   */
  const sendLockRef =
    useRef(false);

  /* =======================================================
     SCROLL
     ======================================================= */

  const scrollToBottom =
    useCallback(() => {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "end",
        });
      });
    }, []);

  useEffect(() => {
    scrollToBottom();
  }, [
    messages,
    thinking,
    scrollToBottom,
  ]);

  /* =======================================================
     STOP SPEAKING
     ======================================================= */

  const stopSpeaking =
    useCallback(() => {
      /*
       * Invalidate all pending async speech.
       */
      speechTokenRef.current += 1;

      /* ---------- BACKEND AUDIO ---------- */

      try {
        const audio =
          audioRef.current;

        if (audio) {
          audio.onended = null;
          audio.onerror = null;

          audio.pause();

          try {
            audio.currentTime = 0;
          } catch {}

          const source =
            audio.src;

          audio.src = "";

          audioRef.current = null;

          if (
            source &&
            source.startsWith("blob:")
          ) {
            try {
              URL.revokeObjectURL(
                source
              );
            } catch {}
          }
        }
      } catch {}

      /* ---------- BROWSER TTS ---------- */

      try {
        if (
          typeof window !== "undefined" &&
          "speechSynthesis" in window
        ) {
          window.speechSynthesis.cancel();
        }
      } catch {}

      setSpeaking(false);
    }, []);

  /* =======================================================
     STOP LISTENING
     ======================================================= */

  const stopListening =
    useCallback(() => {
      try {
        recognitionRef.current?.abort();
      } catch {
        try {
          recognitionRef.current?.stop();
        } catch {}
      }

      recognitionRef.current = null;

      setListening(false);
    }, []);

  /* =======================================================
     ADD MESSAGE
     ======================================================= */

  const addMessage =
    useCallback(
      (role, rawText) => {
        const text =
          cleanText(rawText);

        if (!text) {
          return;
        }

        setMessages((previous) => [
          ...previous,
          {
            id:
              `${role}-${Date.now()}-` +
              Math.random()
                .toString(36)
                .slice(2),

            role:
              role === "user"
                ? "user"
                : "assistant",

            text,
          },
        ]);
      },
      []
    );

  /* =======================================================
     SPEAK
     ======================================================= */

  const speak =
    useCallback(
      async (rawText) => {
        const text =
          cleanText(rawText);

        if (!text) {
          setSpeaking(false);
          return;
        }

        /*
         * Starting a NEW assistant answer intentionally
         * replaces any previous speech.
         */
        stopSpeaking();

        const token =
          speechTokenRef.current;

        setSpeaking(true);

        try {
          const blob =
            await speakWithMedly(
              text,
              language
            );

          /*
           * User may have closed Medly or sent another
           * message while voice generation was running.
           */
          if (
            token !==
            speechTokenRef.current
          ) {
            return;
          }

          if (
            !(blob instanceof Blob) ||
            blob.size === 0
          ) {
            throw new Error(
              "Voice response was empty."
            );
          }

          const url =
            URL.createObjectURL(blob);

          const audio =
            new Audio(url);

          audio.preload = "auto";

          audioRef.current =
            audio;

          audio.onended = () => {
            try {
              URL.revokeObjectURL(
                url
              );
            } catch {}

            if (
              audioRef.current ===
              audio
            ) {
              audioRef.current =
                null;
            }

            if (
              token ===
              speechTokenRef.current
            ) {
              setSpeaking(false);
            }
          };

          audio.onerror = () => {
            try {
              URL.revokeObjectURL(
                url
              );
            } catch {}

            if (
              audioRef.current ===
              audio
            ) {
              audioRef.current =
                null;
            }

            if (
              token ===
              speechTokenRef.current
            ) {
              setSpeaking(false);
            }
          };

          await audio.play();

          if (
            token !==
            speechTokenRef.current
          ) {
            try {
              audio.pause();
            } catch {}
          }
        } catch {
          /*
           * Don't resurrect speech after it has been
           * intentionally cancelled.
           */
          if (
            token !==
            speechTokenRef.current
          ) {
            return;
          }

          /*
           * Browser TTS fallback.
           */
          try {
            if (
              typeof window ===
                "undefined" ||
              !(
                "speechSynthesis" in
                window
              )
            ) {
              setSpeaking(false);
              return;
            }

            window.speechSynthesis.cancel();

            const utterance =
              new SpeechSynthesisUtterance(
                text
              );

            utterance.lang =
              language === "hi"
                ? "hi-IN"
                : "en-IN";

            utterance.rate =
              1.02;

            utterance.pitch =
              1.03;

            utterance.volume = 1;

            utterance.onend = () => {
              if (
                token ===
                speechTokenRef.current
              ) {
                setSpeaking(false);
              }
            };

            utterance.onerror = () => {
              if (
                token ===
                speechTokenRef.current
              ) {
                setSpeaking(false);
              }
            };

            window.speechSynthesis.speak(
              utterance
            );
          } catch {
            setSpeaking(false);
          }
        }
      },
      [language, stopSpeaking]
    );

  /* =======================================================
     SEND
     ======================================================= */

  const send =
    useCallback(async () => {
      if (
        sendLockRef.current ||
        thinking
      ) {
        return;
      }

      const text =
        input.trim();

      if (!text) {
        return;
      }

      sendLockRef.current =
        true;

      /*
       * Sending a new message intentionally stops
       * the previous assistant voice.
       */
      stopSpeaking();

      /*
       * Mic should also stop when a typed message
       * is sent.
       */
      stopListening();

      setError("");
      setInput("");
      setThinking(true);

      /*
       * IMPORTANT:
       * Capture the previous conversation using
       * BACKEND FORMAT:
       *
       * { role, content }
       */
      const history =
        buildBackendHistory(
          messages
        );

      /*
       * Put user message on screen immediately.
       */
      addMessage(
        "user",
        text
      );

      try {
        /*
         * EXACT payload expected by your FastAPI endpoint.
         */
        const payload = {
          message: text,

          language:
            language || "auto",

          name:
            typeof name === "string"
              ? name.trim()
              : "",

          history,
        };

        const response =
          await chatWithMedly(
            payload
          );

        /*
         * Extract the reply safely.
         */
        const reply =
          cleanText(
            response?.reply
          ) ||
          cleanText(
            response?.message
          ) ||
          cleanText(
            response?.answer
          ) ||
          cleanText(
            response?.output
          ) ||
          cleanText(
            response?.text
          ) ||
          cleanText(
            response
          );

        /*
         * NEVER let an object become:
         * [object Object]
         */
        const finalReply =
          reply ||
          "I’m here. Tell me what you’d like to check.";

        /*
         * Add actual assistant text.
         */
        addMessage(
          "assistant",
          finalReply
        );

        /*
         * Speak actual assistant text.
         */
        void speak(
          finalReply
        );
      } catch (err) {
        const errorMessage =
          err?.message ||
          "I couldn't connect to Medly right now.";

        console.error(
          "Medly request failed:",
          err
        );

        setError(
          errorMessage
        );

        addMessage(
          "assistant",
          "I’m having trouble connecting right now. Please try again."
        );
      } finally {
        setThinking(false);
        sendLockRef.current =
          false;
      }
    }, [
      addMessage,
      input,
      language,
      messages,
      name,
      speak,
      stopListening,
      stopSpeaking,
      thinking,
    ]);

  /* =======================================================
     INPUT CHANGE
     -------------------------------------------------------
     DO NOT STOP SPEECH HERE.
     ======================================================= */

  const handleInputChange =
    (event) => {
      setInput(
        event.target.value
      );
    };

  /* =======================================================
     KEYBOARD
     ======================================================= */

  const handleKeyDown =
    (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey
      ) {
        event.preventDefault();

        void send();
      }
    };

  /* =======================================================
     MICROPHONE
     ======================================================= */

  const startListening =
    useCallback(() => {
      if (listening) {
        stopListening();
        return;
      }

      if (thinking) {
        return;
      }

      const SpeechRecognition =
        typeof window !==
        "undefined"
          ? window.SpeechRecognition ||
            window.webkitSpeechRecognition
          : null;

      if (!SpeechRecognition) {
        setError(
          "Voice input isn't supported by this browser."
        );

        inputRef.current?.focus();

        return;
      }

      /*
       * Starting microphone input intentionally stops
       * assistant speech.
       */
      stopSpeaking();

      const recognition =
        new SpeechRecognition();

      recognition.lang =
        language === "hi"
          ? "hi-IN"
          : "en-IN";

      recognition.continuous =
        false;

      recognition.interimResults =
        true;

      recognition.maxAlternatives =
        1;

      recognition.onstart =
        () => {
          setListening(true);
          setError("");
        };

      recognition.onresult =
        (event) => {
          let transcript = "";

          for (
            let i =
              event.resultIndex;
            i <
            event.results.length;
            i += 1
          ) {
            transcript +=
              event.results[i][0]
                ?.transcript || "";
          }

          setInput(
            transcript.trim()
          );
        };

      recognition.onerror =
        (event) => {
          if (
            event?.error !==
            "aborted"
          ) {
            setError(
              "Microphone input could not be started."
            );
          }

          setListening(false);

          recognitionRef.current =
            null;
        };

      recognition.onend = () => {
        setListening(false);

        recognitionRef.current =
          null;
      };

      recognitionRef.current =
        recognition;

      try {
        recognition.start();
      } catch {
        setListening(false);

        recognitionRef.current =
          null;
      }
    }, [
      language,
      listening,
      stopListening,
      stopSpeaking,
      thinking,
    ]);

  /* =======================================================
     CLEAR CHAT
     ======================================================= */

  const clearConversation =
    useCallback(() => {
      stopSpeaking();
      stopListening();

      setInput("");
      setError("");
      setThinking(false);

      setMessages([
        INITIAL_MESSAGE,
      ]);

      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }, [
      stopListening,
      stopSpeaking,
    ]);

  /* =======================================================
     CLOSE
     ======================================================= */

  const closeMedly =
    useCallback(() => {
      stopSpeaking();
      stopListening();

      setInput("");
      setThinking(false);

      onClose?.();
    }, [
      onClose,
      stopListening,
      stopSpeaking,
    ]);

  /* =======================================================
     OPEN/CLOSE EFFECT
     ======================================================= */

  useEffect(() => {
    if (!open) {
      stopSpeaking();
      stopListening();
    }
  }, [
    open,
    stopListening,
    stopSpeaking,
  ]);

  /* =======================================================
     CLEANUP
     ======================================================= */

  useEffect(() => {
    return () => {
      stopSpeaking();
      stopListening();
    };
  }, [
    stopListening,
    stopSpeaking,
  ]);

  /* =======================================================
     AUTO FOCUS
     ======================================================= */

  useEffect(() => {
    if (!open) {
      return;
    }

    const timer =
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 200);

    return () => {
      window.clearTimeout(
        timer
      );
    };
  }, [open]);

  /* =======================================================
     PANEL CLASSES
     ======================================================= */

  const panelClassName = [
    "mdx-panel",

    speaking
      ? "is-speaking"
      : "",

    listening
      ? "is-listening"
      : "",

    thinking
      ? "is-thinking"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  /* =======================================================
     CLOSED
     ======================================================= */

  if (!open) {
    return null;
  }

  /* =======================================================
     UI
     ======================================================= */

  return (
    <div
      className="ms-medly-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Medly AI companion"
    >
      <div
        className={
          panelClassName
        }
      >
        {/* =================================================
            AMBIENT AI EFFECTS
            ================================================= */}

        <div
          className="mdx-ai-ambient"
          aria-hidden="true"
        >
          <span className="mdx-ambient-orb orb-one" />
          <span className="mdx-ambient-orb orb-two" />
          <span className="mdx-ambient-orb orb-three" />
        </div>

        {/* =================================================
            HEADER
            ================================================= */}

        <header className="mdx-header">
          <div className="mdx-header-left">
            {/* AI AVATAR */}

            <div
              className={`mdx-avatar ${
                speaking
                  ? "is-speaking"
                  : ""
              }`}
              aria-hidden="true"
            >
              <div className="mdx-avatar-halo halo-back" />

              <div className="mdx-avatar-halo halo-front" />

              <div className="mdx-avatar-core">
                <img
                  src="/medi-shield-logo.svg"
                  alt=""
                />
              </div>

              <span className="mdx-neural neural-one" />
              <span className="mdx-neural neural-two" />
              <span className="mdx-neural neural-three" />
              <span className="mdx-neural neural-four" />

              {speaking && (
                <>
                  <span className="mdx-sparkle sparkle-one" />
                  <span className="mdx-sparkle sparkle-two" />
                  <span className="mdx-sparkle sparkle-three" />
                  <span className="mdx-sparkle sparkle-four" />
                </>
              )}
            </div>

            {/* TITLE */}

            <div className="mdx-title-area">
              <div className="mdx-name-row">
                <h2>
                  Medly
                </h2>

                <span className="mdx-ai-badge">
                  AI
                </span>
              </div>

              <div className="mdx-status">
                <span className="mdx-status-dot" />

                <span>
                  {speaking
                    ? "Speaking"
                    : listening
                    ? "Listening"
                    : thinking
                    ? "Thinking"
                    : "Your second pair of eyes"}
                </span>
              </div>
            </div>
          </div>

          {/* HEADER ACTIONS */}

          <div className="mdx-header-actions">
            {messages.length >
              1 && (
              <button
                type="button"
                className="mdx-clear-chat"
                onClick={
                  clearConversation
                }
                aria-label="Clear Medly conversation"
                title="Clear chat"
              >
                <span className="mdx-clear-icon">
                  ↺
                </span>

                <span>
                  Clear chat
                </span>
              </button>
            )}

            <button
              type="button"
              className="mdx-close-btn"
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={
                closeMedly
              }
              aria-label="Close Medly"
              title="Close Medly"
            >
              <span />
              <span />
            </button>
          </div>
        </header>

        {/* =================================================
            MESSAGES
            ================================================= */}

        <main className="mdx-messages">
          <div
            className="mdx-chat-glow"
            aria-hidden="true"
          />

          {messages.map(
            (message) => (
              <div
                key={message.id}
                className={`mdx-message ${
                  message.role ===
                  "user"
                    ? "is-user"
                    : "is-assistant"
                }`}
              >
                {message.role ===
                  "assistant" && (
                  <div className="mdx-message-avatar">
                    <div className="mdx-mini-core">
                      <img
                        src="/medi-shield-logo.svg"
                        alt=""
                      />
                    </div>
                  </div>
                )}

                <div className="mdx-message-content">
                  <div className="mdx-message-label">
                    {message.role ===
                    "assistant"
                      ? "MEDLY"
                      : "YOU"}
                  </div>

                  <div className="mdx-bubble">
                    {message.text}
                  </div>
                </div>
              </div>
            )
          )}

          {/* THINKING */}

          {thinking && (
            <div className="mdx-message is-assistant">
              <div className="mdx-message-avatar">
                <div className="mdx-mini-core">
                  <img
                    src="/medi-shield-logo.svg"
                    alt=""
                  />
                </div>
              </div>

              <div className="mdx-message-content">
                <div className="mdx-message-label">
                  MEDLY
                </div>

                <div
                  className="mdx-thinking-bubble"
                  aria-label="Medly is thinking"
                >
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </main>

        {/* =================================================
            ERROR
            ================================================= */}

        {error && (
          <div className="mdx-inline-error">
            <span>!</span>
            <span>
              {error}
            </span>
          </div>
        )}

        {/* =================================================
            COMPOSER
            ================================================= */}

        <footer className="mdx-composer">
          <div className="mdx-composer-inner">
            {/* MIC */}

            <button
              type="button"
              className={`mdx-action-btn ${
                listening
                  ? "is-listening"
                  : ""
              }`}
              onClick={
                startListening
              }
              disabled={thinking}
              aria-label={
                listening
                  ? "Stop listening"
                  : "Use microphone"
              }
              title={
                listening
                  ? "Stop listening"
                  : "Talk to Medly"
              }
            >
              <span className="mdx-mic-icon">
                {listening
                  ? "■"
                  : "⌕"}
              </span>
            </button>

            {/* TEXT INPUT */}

            <textarea
              ref={inputRef}
              value={input}
              onChange={
                handleInputChange
              }
              onKeyDown={
                handleKeyDown
              }
              placeholder="Ask Medly anything..."
              rows={1}
              aria-label="Message Medly"
              disabled={thinking}
            />

            {/* RIGHT */}

            <div className="mdx-composer-right">
              <select
                value={language}
                onChange={(event) =>
                  setLanguage(
                    event.target.value
                  )
                }
                aria-label="Language"
                className="mdx-language"
                disabled={thinking}
              >
                <option value="en">
                  EN
                </option>

                <option value="hi">
                  HI
                </option>
              </select>

              <button
                type="button"
                className="mdx-send-btn"
                onClick={() =>
                  void send()
                }
                disabled={
                  !input.trim() ||
                  thinking
                }
                aria-label="Send message"
                title="Send"
              >
                <span>↑</span>
              </button>
            </div>
          </div>

          <div className="mdx-composer-hint">
            <span>
              Enter to send
            </span>

            <span className="mdx-hint-separator">
              •
            </span>

            <span>
              Medly can make mistakes
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}