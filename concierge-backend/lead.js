/**
 * OMEN — concierge: lógica pura de leads (sin red, sin estado global).
 * Portado de omen-api/main.py (extractor, normalización, dedupe y correos).
 * Solo usa APIs estándar (WebCrypto, Intl) → corre igual en Workers y en Node.
 */

export const LEAD_FIELDS = ["name", "email", "phone", "sector", "project"];

const FIELD_MAX = 300;

// Respuestas evasivas / placeholders que nunca cuentan como dato capturado,
// aunque el modelo extractor las devuelva como valor (de main.py + nulos).
const EVASIVE = new Set([
  "no sé", "no se", "nose", "ns", "n/s", "no lo sé", "no lo se", "no se aun",
  "lo que sea", "lo q sea", "cualquiera", "lo que quieras", "n/a", "na",
  "ninguno", "ninguna", "nada", "idk", "tbd", "no aplica", "no aun", "aun no",
  "-", "--", "x", "?", "—",
  "null", "none", "undefined", "nil", "unknown", "desconocido", "n.a.",
]);

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;

// ---------- prompts del extractor ----------

const EXTRACT_PROMPT_ES = `Eres un extractor estricto. Recibes la transcripción de una conversación entre OMEN y un visitante. Devuelve EXCLUSIVAMENTE un objeto JSON válido con exactamente estas claves:
{"name":"","email":"","phone":"","sector":"","project":""}
Reglas:
- Usa cadena vacía si el dato aún no fue dicho con claridad. NO inventes y NO rellenes.
- Respuestas como "no sé", "lo que sea", "cualquiera", vacías o fuera de tema NO son datos: déjalas vacías.
- name: nombre de la persona o de su empresa.
- email: correo electrónico tal como lo dio.
- phone: teléfono o WhatsApp tal como lo dio, idealmente con lada/país (p. ej. "+5215512345678").
- sector: a qué se dedica la persona u organización (giro/actividad real, p. ej., "restaurante", "clínica dental", "ecommerce de ropa").
- project: la necesidad o idea que expresó, si la tiene; vacío si aún no la tiene clara (es válido que no la tenga).
Usa solo lo que aparezca EXPLÍCITAMENTE en el historial. No agregues texto fuera del JSON. No uses code fences.`;

const EXTRACT_PROMPT_EN = `You are a strict extractor. You receive the transcript of a conversation between OMEN and a visitor. Return EXCLUSIVELY a valid JSON object with exactly these keys:
{"name":"","email":"","phone":"","sector":"","project":""}
Rules:
- Use an empty string if the item hasn't been stated clearly yet. Do NOT invent or fill in.
- Answers like "I don't know", "whatever", "anything", empty or off-topic replies are NOT data: leave them empty.
- name: the person's or company's name.
- email: email address as given.
- phone: phone or WhatsApp as given, ideally with country code (e.g. "+13125550142").
- sector: what the person or organization does (their actual line of business, e.g. "restaurant", "dental clinic", "clothing ecommerce").
- project: the need or idea they expressed, if any; empty if they don't have one yet (that's valid).
Use only what appears EXPLICITLY in the transcript. Add no text outside the JSON. No code fences.`;

export function buildExtractionPrompt(lang) {
  return lang === "en" ? EXTRACT_PROMPT_EN : EXTRACT_PROMPT_ES;
}

// Transcripción plana para el extractor (y para el correo interno).
export function transcriptText(turns, lang, maxChars = 8000) {
  const U = lang === "en" ? "Visitor: " : "Usuario: ";
  const A = lang === "en" ? "OMEN: " : "Asistente: ";
  const txt = (turns || [])
    .filter((m) => m && m.content)
    .map((m) => (m.role === "user" ? U : A) + String(m.content))
    .join("\n");
  return txt.length > maxChars ? txt.slice(-maxChars) : txt;
}

export function countUserTurns(turns) {
  return (turns || []).filter((m) => m && m.role === "user" && String(m.content || "").trim()).length;
}

// ---------- parseo robusto de la salida del extractor ----------

export function parseExtraction(txt) {
  if (txt && typeof txt === "object") return txt;
  let s = String(txt || "").trim();
  if (!s) return null;
  // Quita code fences ```json ... ```
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch (_) {}
  // Texto alrededor: toma el primer objeto {...} balanceado
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const o = JSON.parse(s.slice(start, i + 1));
        return o && typeof o === "object" ? o : null;
      } catch (_) { return null; }
    }
  }
  return null;
}

// ---------- normalización / calificación ----------

function cleanValue(v) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  // Quita caracteres de control y colapsa espacios
  const s = String(v).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);
  return s && !EVASIVE.has(s.toLowerCase()) ? s : "";
}

// Campos para el ledger lateral: texto limpio, sin placeholders (forma visible intacta).
export function cleanFields(obj) {
  const o = obj && typeof obj === "object" ? obj : {};
  const out = {};
  for (const k of LEAD_FIELDS) out[k] = cleanValue(o[k]);
  return out;
}

export function normalizeEmail(v) {
  const s = cleanValue(v).toLowerCase().replace(/^mailto:/, "");
  return EMAIL_RE.test(s) ? s : "";
}

// Solo dígitos, con "+" inicial permitido. Mínimo 7 dígitos para contar.
export function normalizePhone(v) {
  const s = cleanValue(v);
  if (!s) return "";
  const plus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return (plus ? "+" : "") + digits;
}

export function normalizeLead(obj) {
  const c = cleanFields(obj);
  return {
    name: c.name,
    email: normalizeEmail(c.email),
    phone: normalizePhone(c.phone),
    sector: c.sector,
    project: c.project,
  };
}

// Lead calificado: nombre + al menos un contacto válido (correo o teléfono).
export function isQualified(lead) {
  if (!lead) return false;
  const n = normalizeLead(lead);
  return Boolean(n.name && (n.email || n.phone));
}

// ---------- dedupe ----------

// Igual que main.py: primer mensaje del usuario (200 chars) + contacto.
export async function dedupeKey(turns, lead) {
  const first = (turns || []).find((m) => m && m.role === "user");
  const firstUser = first ? String(first.content || "").slice(0, 200) : "";
  const n = normalizeLead(lead || {});
  const raw = firstUser + "|" + (n.email || n.phone || "");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ---------- correos ----------

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function mxTimestamp(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date) + " (America/Mexico_City)";
  } catch (_) {
    return date.toISOString();
  }
}

// (a) Aviso interno a Enrique.
export function buildNotificationEmail({ lead, lang, origin, turns, date } = {}) {
  const n = normalizeLead(lead || {});
  const raw = cleanFields(lead || {});
  const dash = (v) => v || "—";
  const langS = lang === "en" ? "en" : "es";
  const name = n.name || "sin nombre";
  const subject = "Nuevo lead OMEN — " + name + (n.sector ? " (" + n.sector + ")" : "");
  const ts = mxTimestamp(date || new Date());
  const transcript = transcriptText(turns, langS, 20000);
  const rows = [
    ["nombre", n.name],
    ["correo", n.email],
    ["tel", n.phone || raw.phone],
    ["sector", n.sector],
    ["proyecto", n.project],
    ["lang", langS],
    ["origen", cleanValue(origin).slice(0, 200)],
    ["fecha", ts],
  ];
  const text =
    rows.map(([k, v]) => k + ": " + dash(v)).join("\n") +
    "\n\n--- transcripción ---\n" + (transcript || "—") + "\n";
  const html =
    '<div style="font-family:\'IBM Plex Mono\',\'Courier New\',monospace;font-size:13px;line-height:1.6;color:#E6E6E3;background:#070708;padding:24px">' +
    '<p style="margin:0 0 16px;color:#9DB4C0;font-weight:600;letter-spacing:0.3em">OMEN · lead</p>' +
    '<table role="presentation" cellspacing="0" cellpadding="4" border="0">' +
    rows.map(([k, v]) =>
      '<tr><td style="color:#7c7c83;vertical-align:top">' + escapeHtml(k) +
      '</td><td style="color:#E6E6E3">' + escapeHtml(dash(v)) + "</td></tr>").join("") +
    "</table>" +
    '<p style="margin:24px 0 8px;color:#7c7c83">transcripción</p>' +
    '<pre style="white-space:pre-wrap;margin:0;color:#E6E6E3">' + escapeHtml(transcript || "—") + "</pre>" +
    "</div>";
  return { subject, text, html, replyTo: n.email || "" };
}

// (b) Confirmación al cliente (port fiel de _build_confirmation_email).
export function buildConfirmationEmail({ lead, lang } = {}) {
  const n = normalizeLead(lead || {});
  const isEn = lang === "en";
  const plainName = n.name || (isEn ? "visitor" : "visitante");
  const name = escapeHtml(plainName);
  let subject, emailTitle, htmlLang, p1Html, p2Html, text;

  if (isEn) {
    subject = "Confirmation — OMEN";
    emailTitle = "Confirmation OMEN";
    htmlLang = "en";
    p1Html = "Your case is registered. An OMEN engineer will contact you by email or phone to define the scope.";
    p2Html = 'If an idea or question comes up before then, write to <a href="mailto:contacto@omen-it.tech" style="color:#E6E6E3;text-decoration:none;border-bottom:1px dotted #56565d;">contacto@omen-it.tech</a>.';
    text =
      "OMEN — Confirmation\n\n" +
      plainName + ",\n\n" +
      "Your case is registered. An OMEN engineer will contact you by email " +
      "or phone to define the scope.\n\n" +
      "If an idea or question comes up before then, write to contacto@omen-it.tech.\n\n" +
      "OMEN";
  } else {
    subject = "Confirmación — OMEN";
    emailTitle = "Confirmación OMEN";
    htmlLang = "es";
    p1Html = 'Tu caso quedó registrado. Un ingeniero de OMEN te contactará por correo o <span style="color:#9DB4C0;">WhatsApp</span> para definir el alcance.';
    p2Html = 'Si surge una idea o duda antes, escríbenos a <a href="mailto:contacto@omen-it.tech" style="color:#E6E6E3;text-decoration:none;border-bottom:1px dotted #56565d;">contacto@omen-it.tech</a>.';
    text =
      "OMEN — Confirmación\n\n" +
      plainName + ",\n\n" +
      "Tu caso quedó registrado. Un ingeniero de OMEN te contactará por correo " +
      "o WhatsApp para definir el alcance.\n\n" +
      "Si surge una idea o duda antes, escríbenos a contacto@omen-it.tech.\n\n" +
      "OMEN";
  }

  const html =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n' +
    '<html lang="' + htmlLang + '">\n' +
    "<head>\n" +
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    "<title>" + emailTitle + "</title>\n" +
    "</head>\n" +
    '<body style="margin:0;padding:0;background-color:#070708;">\n' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">\n' +
    '<tr><td align="center" style="padding: 32px 16px;">\n' +
    '<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;">\n' +
    "<tr><td style=\"font-family:'IBM Plex Mono','Courier New',monospace;font-size:14px;line-height:1.7;color:#E6E6E3;padding-bottom:24px;border-bottom:1px solid #1a1a1d;\">\n" +
    '<span style="color:#9DB4C0;font-weight:600;letter-spacing:0.3em;">OMEN</span>\n' +
    "</td></tr>\n" +
    "<tr><td style=\"font-family:'IBM Plex Mono','Courier New',monospace;font-size:14px;line-height:1.7;color:#E6E6E3;padding-top:24px;\">\n" +
    '<p style="margin:0 0 16px;">' + name + ",</p>\n" +
    '<p style="margin:0 0 16px;">' + p1Html + "</p>\n" +
    '<p style="margin:0 0 16px;color:#7c7c83;">' + p2Html + "</p>\n" +
    '<p style="margin:24px 0 0;color:#56565d;font-size:11px;letter-spacing:0.18em;">OMEN</p>\n' +
    "</td></tr>\n" +
    "</table>\n" +
    "</td></tr>\n" +
    "</table>\n" +
    "</body>\n" +
    "</html>";

  return { subject, text, html, to: n.email };
}
