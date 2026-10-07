# Revivir el chat concierge de OMEN (Groq + Cloudflare Worker)

Backend de streaming que reemplaza el `/api/concierge` que murió con el droplet.
Gratis: Cloudflare Workers (100k req/día) + Groq (free tier).

## 1. Key de Groq (gratis, 30 seg)
1. Entra a https://console.groq.com → **API Keys** → **Create API Key**.
2. Cópiala (empieza con `gsk_...`).

## 2. Desplegar el Worker

### Opción A — Dashboard (sin instalar nada)
> Ojo: desde la captura de leads el Worker son **dos archivos** (`worker.js` importa
> `lead.js`). Pegar solo `worker.js` en el editor ya no basta: crea también `lead.js`
> en el editor del dashboard, o mejor usa la Opción B.

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Nombre: `omen-concierge` → **Deploy**.
3. **Edit code** → borra todo y pega el contenido de `worker.js` → **Deploy**.
4. **Settings → Variables and Secrets** → **Add** → tipo **Secret** →
   nombre `GROQ_API_KEY`, valor tu `gsk_...` → **Deploy**.
5. Copia la URL del worker: `https://omen-concierge.<tu-sub>.workers.dev`

### Opción B — CLI (1 comando)
```bash
cd concierge-backend
npx wrangler login          # abre el navegador una vez
npx wrangler secret put GROQ_API_KEY   # pega tu gsk_...
npx wrangler secret put RESEND_API_KEY # pega tu re_... (aviso de leads)
npx wrangler deploy
```
`wrangler deploy` empaqueta `worker.js` + `lead.js` solo.

## 2b. Aviso de leads por correo (Resend)
Tras cada respuesta completa, si la conversación lleva **2 o más mensajes del
usuario**, el Worker extrae nombre/correo/teléfono/sector/proyecto (la misma
llamada que llena el ledger lateral). Si hay **nombre + correo o teléfono**, manda
un correo a `LEAD_NOTIFY_TO` con los datos y la transcripción completa
(`reply_to` = correo del cliente, si lo dio). Corre en `ctx.waitUntil`: no
retrasa ni altera el stream.

| Nombre | Tipo | Default | Para qué |
| --- | --- | --- | --- |
| `RESEND_API_KEY` | secret | — | Sin él no se envía nada (el chat sigue igual). |
| `EMAIL_FROM` | var | `OMEN <contacto@omen-it.tech>` | Remitente. |
| `LEAD_NOTIFY_TO` | var | `enrique-ai@omen-it.tech` | Quién recibe el aviso. |
| `SEND_CLIENT_CONFIRMATION` | var | apagado | `"1"` = además manda la confirmación bilingüe al cliente (solo si dio correo). |
| `GROQ_LEAD_MODEL` | var | `GROQ_EXTRACT_MODEL` o `openai/gpt-oss-20b` | Modelo del extractor. |

**Dominio en Resend:** para enviar desde `@omen-it.tech` hay que verificar el
dominio en https://resend.com/domains → **Add domain** `omen-it.tech` y crear en
**Cloudflare DNS** los registros que muestre (MX/TXT de SPF en el subdominio
`send`, TXT DKIM `resend._domainkey`, y opcional DMARC). Sin dominio verificado
Resend rechaza el envío (403) y el Worker solo deja `[lead] resend 403` en logs.

Las vars van en `[vars]` de `wrangler.toml` (ahí están comentadas). Ojo:
`wrangler deploy` reemplaza las vars puestas a mano en el dashboard por las del
toml; los secrets no se tocan.

**Dedupe:** el mismo lead (primer mensaje + contacto) se avisa una sola vez por
6 h, en memoria **por isolate** (best-effort): otro isolate o un redeploy pueden
generar un aviso duplicado. Para dedupe global haría falta KV/Durable Objects.

Logs en vivo: `npx wrangler tail` (busca `[lead]`).

## 3. Conectar el sitio
Pásame la URL del worker y la pongo en el shim del fork
(`window.OMEN_BACKEND`), o cámbiala tú en `index.html` / `us/index.html`.

## Probar el backend suelto
```bash
curl -N -X POST https://omen-concierge.<tu-sub>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hola, necesito automatizar cotizaciones"}]}'
```
Debe ir escupiendo `data: {"type":"token","text":"..."}`.

### Salud (solo booleanos, nunca valores de secrets)
```bash
curl https://omen-concierge.<tu-sub>.workers.dev/health
# {"status":"ok","groq":true,"resend":true,"clientConfirmation":false}
```

### Conversación de 2 turnos que debe disparar el aviso de lead
```bash
curl -N -X POST https://omen-concierge.<tu-sub>.workers.dev \
  -H "Content-Type: application/json" -H "Origin: https://omen-it.tech" \
  -d '{"messages":[
        {"role":"user","content":"hola, necesito automatizar cotizaciones"},
        {"role":"assistant","content":"Con gusto. ¿A qué se dedica tu negocio y cómo te llamas?"},
        {"role":"user","content":"Soy Prueba OMEN, tengo una clínica dental. Mi correo es enrique-ai@omen-it.tech"}
      ]}'
```
Debe terminar con `ledger`, `closed` y `done`, y en ~segundos llegar a
`LEAD_NOTIFY_TO` un correo «Nuevo lead OMEN — Prueba OMEN (clínica dental)».
Repetir el mismo curl no manda un segundo correo (dedupe).
