// Selección de proveedor LLM + normalización de turnos (lógica pura, testeable).
// Con ANTHROPIC_API_KEY se usa Anthropic y las vars OpenAI/NIM se ignoran;
// sin ella, el camino OpenAI-compatible (Groq / NIM) de siempre.

import * as anthropic from "./llm-anthropic.js";
import * as openai from "./llm-openai.js";

export function selectProvider(env) {
  return env && env.ANTHROPIC_API_KEY ? anthropic : openai;
}

// Turnos del cliente -> [{role:"user"|"assistant", content}] apto para ambas APIs:
// descarta entradas inválidas y role "system", recorta, fusiona roles
// consecutivos iguales y garantiza que empiece con "user" (requisito de Anthropic).
export function normalizeTurns(incoming, maxMessages = 16, maxChars = 4000) {
  const list = (Array.isArray(incoming) ? incoming : [])
    .filter((m) => m && typeof m === "object" && m.role !== "system" && (m.content || m.text))
    .slice(-maxMessages)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || m.text || "").slice(0, maxChars),
    }));
  const out = [];
  for (const m of list) {
    if (!out.length && m.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  return out;
}
