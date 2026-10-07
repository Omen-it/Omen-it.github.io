// Proveedor LLM Anthropic (SDK oficial @anthropic-ai/sdk). Misma interfaz que
// llm-openai.js. El cliente se construye por request: en Workers `env` llega
// con cada fetch. La llave nunca se loguea ni se devuelve.
//
// Chat: client.beta.messages.stream con fallback server-side de rechazos
//       (betas server-side-fallback-2026-07-01 + fallbacks "default").
//       Sin `thinking` (adaptive por default; disabled/budget dan 400);
//       el costo se controla con output_config.effort.
// Extracción: client.messages.parse con output_config.format (JSON schema).
//       Haiku 5.5 no tiene fallback server-side: un rechazo devuelve null.

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { buildExtractionPrompt, transcriptText, LEAD_FIELDS } from "./lead.js";

export const name = "anthropic";

const REFUSAL_TEXT = {
  es: "Prefiero no responder eso por aquí. Con gusto te ayudo con tu proyecto de software, ciberseguridad o IA; también puedes escribirnos a contacto@omen-it.tech.",
  en: "I would rather not answer that here. I am glad to help with your software, cybersecurity, or AI project; you can also reach us at contacto@omen-it.tech.",
};

// Todos los campos presentes; string o null (el ledger tolera vacíos).
const LEAD_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(LEAD_FIELDS.map((k) => [k, { type: ["string", "null"] }])),
  required: [...LEAD_FIELDS],
  additionalProperties: false,
};

export function configured(env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

function client(env) {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function* streamChat({ env, system, turns, lang, signal }) {
  const stream = client(env).beta.messages.stream({
    model: env.ANTHROPIC_MODEL || "claude-opus-5-5",
    max_tokens: 1024,
    system,
    messages: turns,
    output_config: { effort: env.ANTHROPIC_EFFORT || "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  }, signal ? { signal } : undefined);

  let finished = false, sent = false;
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
        sent = true;
        yield ev.delta.text;
      }
    }
    const msg = await stream.finalMessage();
    finished = true;
    // Rechazo de toda la cadena (modelo + fallback): frase cortés en vez de silencio.
    if (msg.stop_reason === "refusal") {
      yield (sent ? "\n\n" : "") + (lang === "en" ? REFUSAL_TEXT.en : REFUSAL_TEXT.es);
    }
  } finally {
    if (!finished) { try { stream.abort(); } catch (_) {} }
  }
}

export async function extractJSON({ env, lang, turns }) {
  try {
    const res = await client(env).messages.parse({
      model: env.ANTHROPIC_LEAD_MODEL || "claude-haiku-5-5",
      max_tokens: 512,
      system: buildExtractionPrompt(lang),
      messages: [{ role: "user", content: transcriptText(turns, lang, 8000) }],
      output_config: { effort: "low", format: jsonSchemaOutputFormat(LEAD_SCHEMA) },
    });
    if (res.stop_reason === "refusal") return null;
    const o = res.parsed_output;
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch (_) {
    return null;
  }
}
