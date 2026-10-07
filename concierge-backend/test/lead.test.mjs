// Pruebas de la lógica pura de leads: node --test concierge-backend/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isQualified, normalizeLead, normalizeEmail, normalizePhone, cleanFields,
  dedupeKey, parseExtraction, buildExtractionPrompt, countUserTurns,
  buildNotificationEmail, buildConfirmationEmail,
} from "../lead.js";

const TURNS = [
  { role: "user", content: "hola, necesito automatizar cotizaciones" },
  { role: "assistant", content: "Claro. ¿A qué se dedica tu negocio?" },
  { role: "user", content: "Soy Ana Pérez, tengo una clínica dental. ana@clinica.mx, +52 477 123 4567" },
  { role: "assistant", content: "Gracias, Ana. Un ingeniero te contactará." },
];

test("calificación: acepta nombre+correo y nombre+teléfono", () => {
  assert.equal(isQualified({ name: "Ana", email: "ana@x.mx" }), true);
  assert.equal(isQualified({ name: "Ana", phone: "477 123 4567" }), true);
});

test("calificación: rechaza sin nombre, sin contacto o con placeholders", () => {
  assert.equal(isQualified({ email: "ana@x.mx", phone: "4771234567" }), false);
  assert.equal(isQualified({ name: "Ana" }), false);
  assert.equal(isQualified({ name: "null", email: "ana@x.mx" }), false);
  assert.equal(isQualified({ name: "n/a", phone: "4771234567" }), false);
  assert.equal(isQualified({ name: "Ana", email: "null", phone: "N/A" }), false);
  assert.equal(isQualified({ name: "Ana", email: "no-es-correo", phone: "123" }), false);
  assert.equal(isQualified(null), false);
});

test("normalización: trim, correo en minúsculas, teléfono solo dígitos con +", () => {
  assert.equal(normalizeEmail("  Ana@Clinica.MX "), "ana@clinica.mx");
  assert.equal(normalizePhone("+52 (477) 123-4567"), "+524771234567");
  assert.equal(normalizePhone("477.123.4567"), "4771234567");
  assert.equal(normalizePhone("12"), "");
  const n = normalizeLead({ name: "  Ana  Pérez ", email: "ANA@X.MX", phone: "+1 312 555 0142", sector: " clínica ", project: 5 });
  assert.deepEqual(n, { name: "Ana Pérez", email: "ana@x.mx", phone: "+13125550142", sector: "clínica", project: "5" });
  assert.deepEqual(cleanFields({ name: "undefined", email: null }), { name: "", email: "", phone: "", sector: "", project: "" });
});

test("dedupe: determinista y distinto con otro contacto o conversación", async () => {
  const lead = { name: "Ana", email: "ana@clinica.mx" };
  const k1 = await dedupeKey(TURNS, lead);
  const k2 = await dedupeKey(TURNS, { name: "Ana", email: "ANA@clinica.mx " });
  assert.equal(k1, k2);
  assert.match(k1, /^[0-9a-f]{32}$/);
  assert.notEqual(k1, await dedupeKey(TURNS, { name: "Ana", email: "otra@clinica.mx" }));
  const other = [{ role: "user", content: "busco una auditoría" }, ...TURNS.slice(1)];
  assert.notEqual(k1, await dedupeKey(other, lead));
});

test("parseo del extractor: limpio, con code fences y con basura alrededor", () => {
  const obj = { name: "Ana", email: "ana@x.mx", phone: "", sector: "clínica", project: "bot {de} citas" };
  assert.deepEqual(parseExtraction(JSON.stringify(obj)), obj);
  assert.deepEqual(parseExtraction("```json\n" + JSON.stringify(obj) + "\n```"), obj);
  assert.deepEqual(parseExtraction("Aquí está: " + JSON.stringify(obj) + " listo. {otro}"), obj);
  assert.equal(parseExtraction("sin json"), null);
  assert.equal(parseExtraction(""), null);
  assert.equal(parseExtraction("{roto"), null);
});

test("prompts del extractor por idioma y conteo de turnos", () => {
  assert.match(buildExtractionPrompt("es"), /extractor estricto/);
  assert.match(buildExtractionPrompt("en"), /strict extractor/);
  assert.match(buildExtractionPrompt(undefined), /extractor estricto/);
  assert.equal(countUserTurns(TURNS), 2);
});

test("correo interno: incluye todos los campos y la transcripción", () => {
  const lead = { name: "Ana Pérez", email: "ana@clinica.mx", phone: "+52 477 123 4567", sector: "clínica dental", project: "automatizar <cotizaciones>" };
  const m = buildNotificationEmail({ lead, lang: "es", origin: "https://omen-it.tech", turns: TURNS, date: new Date("2026-10-07T18:00:00Z") });
  assert.equal(m.subject, "Nuevo lead OMEN — Ana Pérez (clínica dental)");
  assert.equal(m.replyTo, "ana@clinica.mx");
  for (const v of ["Ana Pérez", "ana@clinica.mx", "+524771234567", "clínica dental", "automatizar <cotizaciones>", "lang: es", "https://omen-it.tech", "America/Mexico_City", "12:00"]) {
    assert.ok(m.text.includes(v), "text sin " + v);
  }
  for (const t of TURNS) assert.ok(m.text.includes(t.content), "falta turno en text");
  assert.ok(m.html.includes("automatizar &lt;cotizaciones&gt;"));
  assert.ok(!m.html.includes("<cotizaciones>"));
  assert.ok(m.html.includes("hola, necesito automatizar cotizaciones"));
});

test("confirmación al cliente: ES vs EN y sin undefined/null", () => {
  const es = buildConfirmationEmail({ lead: { name: "Ana", email: "ana@x.mx" }, lang: "es" });
  assert.equal(es.subject, "Confirmación — OMEN");
  assert.ok(es.text.includes("Tu caso quedó registrado"));
  assert.ok(es.html.includes('lang="es"'));
  assert.equal(es.to, "ana@x.mx");
  const en = buildConfirmationEmail({ lead: { name: "Bob", email: "bob@x.com" }, lang: "en" });
  assert.equal(en.subject, "Confirmation — OMEN");
  assert.ok(en.text.includes("Your case is registered"));
  assert.ok(en.html.includes('lang="en"'));
  const empty = buildConfirmationEmail({ lead: {}, lang: "en" });
  const nul = buildConfirmationEmail({ lead: { name: null, email: null } });
  for (const m of [es, en, empty, nul]) {
    for (const part of [m.subject, m.text, m.html, m.to]) {
      assert.ok(!/undefined|null/.test(part), "contiene undefined/null");
    }
  }
  assert.ok(empty.text.includes("visitor,"));
  assert.ok(nul.text.includes("visitante,"));
  const xss = buildConfirmationEmail({ lead: { name: "<b>x</b>", email: "a@b.co" }, lang: "es" });
  assert.ok(!xss.html.includes("<b>x</b>"));
});
