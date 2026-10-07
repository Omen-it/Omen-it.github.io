// Proveedor LLM OpenAI-compatible (Groq por default; NVIDIA NIM u otro vía
// LLM_BASE_URL). Código movido tal cual desde worker.js.
// Interfaz común de proveedores (ver llm.js):
//   streamChat({ env, system, turns, lang, signal }) -> async iterable de tokens de texto
//   extractJSON({ env, lang, turns })              -> objeto crudo | null
// Errores antes del stream: Error con .status (HTTP) o sin él (red).

import { buildExtractionPrompt, parseExtraction, transcriptText } from "./lead.js";

export const name = "openai";

// Llave: LLM_API_KEY o, si no existe, GROQ_API_KEY.
export function llmUrl(env) {
  return (env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/[/]+$/, "") + "/chat/completions";
}
export function llmKey(env) {
  return env.LLM_API_KEY || env.GROQ_API_KEY || "";
}
export function configured(env) {
  return Boolean(llmKey(env));
}

export async function* streamChat({ env, system, turns, signal }) {
  let upstream;
  try {
    upstream = await fetch(llmUrl(env), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + llmKey(env),
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages: [{ role: "system", content: system }, ...turns],
        stream: true,
        ...(env.LLM_DISABLE_THINKING === "1" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        temperature: 0.45,
        max_tokens: 600,
      }),
      signal,
    });
  } catch (_) {
    throw new Error("upstream_unreachable");
  }
  if (!upstream.ok || !upstream.body) {
    const err = new Error("upstream_status");
    err.status = upstream.status;
    throw err;
  }

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "", finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let tok;
        try {
          const j = JSON.parse(payload);
          tok = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        } catch (_) {}
        if (tok) yield tok;
      }
    }
    finished = true;
  } finally {
    // cliente desconectado o error de red -> abortamos el upstream
    if (!finished) { try { await reader.cancel(); } catch (_) {} }
  }
}

// Extracción no-stream de los datos del prospecto (prompt ES/EN en lead.js).
export async function extractJSON({ env, lang, turns }) {
  try {
    const r = await fetch(llmUrl(env), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + llmKey(env),
      },
      body: JSON.stringify({
        model: env.GROQ_LEAD_MODEL || env.GROQ_EXTRACT_MODEL || "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: buildExtractionPrompt(lang) },
          { role: "user", content: transcriptText(turns, lang, 8000) },
        ],
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    return parseExtraction(txt);
  } catch (_) {
    return null;
  }
}
