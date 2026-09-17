# Revivir el chat concierge de OMEN (Groq + Cloudflare Worker)

Backend de streaming que reemplaza el `/api/concierge` que murió con el droplet.
Gratis: Cloudflare Workers (100k req/día) + Groq (free tier).

## 1. Key de Groq (gratis, 30 seg)
1. Entra a https://console.groq.com → **API Keys** → **Create API Key**.
2. Cópiala (empieza con `gsk_...`).

## 2. Desplegar el Worker

### Opción A — Dashboard (sin instalar nada)
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
npx wrangler deploy
```

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
