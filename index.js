// Registro MCP v4 — modello "sync dal telefono".
// Il telefono (rete residenziale) fa login al registro e scarica i dati, poi li invia qui
// via /sync/<SYNC_KEY>. Il Worker li conserva (KV) e l'MCP li serve 24h su 24.
// Il Worker NON contatta mai il registro: nessun blocco, nessun aggiramento, gratis.

import { OAuthProvider, AuthorizationError } from "@cloudflare/workers-oauth-provider";

const SYNC_KEY = "s7Kq2SYNCxZ9r4"; // chiave che protegge l'invio dati dal telefono
const KV_SNAP = "snapshot";
const SEZIONI = ["voti", "assenze", "compiti", "argomenti", "comunicazioni", "note", "materie", "periodi"];
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "registro",
    title: "Registro elettronico",
    description:
      "Legge i dati del registro elettronico (sincronizzati dal telefono). Scegli 'cosa': " +
      SEZIONI.join(", ") + ". Restituisce le righe e la data dell'ultima sincronizzazione.",
    inputSchema: {
      type: "object",
      properties: { cosa: { type: "string", enum: SEZIONI, description: "Sezione da leggere." } },
      required: ["cosa"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "registro_stato",
    title: "Stato sincronizzazione",
    description: "Mostra quando il telefono ha sincronizzato l'ultima volta e quali sezioni sono disponibili.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

// ---------------- OAuth ----------------
const providers = new Map();
function getProvider(origin) {
  if (!providers.has(origin)) {
    providers.set(origin, new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: { fetch: mcpFetch },
      defaultHandler: { fetch: pagesFetch },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["registro"],
      requiredScopes: ["registro"],
      refreshTokenTTL: 180 * 86400,
      resourceMetadata: { resource: origin + "/mcp", authorization_servers: [origin], resource_name: "Registro elettronico" },
    }));
  }
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    return getProvider(new URL(request.url).origin).fetch(request, env, ctx);
  },
};

// ---------------- Pagine + /sync ----------------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(body, headers = new Headers()) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registro MCP</title><style>
body{font-family:system-ui,sans-serif;background:#f3f5f9;margin:0;padding:24px;color:#1d2433}
.card{max-width:420px;margin:24px auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 20px #0001}
h1{font-size:22px;margin:0 0 8px}p{line-height:1.45;color:#4a5263}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font-size:17px;padding:12px;border-radius:10px;border:0;background:#3f6ea6;color:#fff;font-weight:600}
button.no{background:#e6e9ef;color:#1d2433}code{word-break:break-all}</style></head><body><div class="card">${body}</div></body></html>`,
    { headers }
  );
}

async function pagesFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return page(`<h1>Registro MCP attivo ✅</h1><p>Connettore MCP:</p><p><code>${esc(url.origin)}/mcp</code></p>
<p>I dati arrivano dal telefono tramite sincronizzazione.</p>`);
  }

  // Il telefono invia qui i dati scaricati dal registro.
  if (url.pathname === "/sync/" + SYNC_KEY && request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: "JSON non valido" }, 400);
    }
    if (!payload || typeof payload !== "object") return json({ ok: false, error: "payload vuoto" }, 400);
    payload.ricevuto = new Date().toISOString();
    await env.OAUTH_KV.put(KV_SNAP, JSON.stringify(payload));
    const sez = payload.dati ? Object.keys(payload.dati) : [];
    return json({ ok: true, ricevuto: payload.ricevuto, sezioni: sez });
  }
  if (url.pathname.startsWith("/sync/")) return json({ ok: false, error: "chiave errata o metodo errato" }, 403);

  // --- OAuth: consenso semplice, senza credenziali (il telefono le gestisce) ---
  if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    let authRequest;
    try {
      authRequest = await oauth.parseAuthRequest(request);
    } catch (err) {
      if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
      return page(`<h1>Richiesta non valida</h1><p>${esc(err.message)}</p>`);
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page(
      `<h1>Collega il registro</h1><p><strong>${esc(details.clientName)}</strong> vuole leggere i dati del tuo registro (già sincronizzati dal telefono).</p>
<form method="post"><input type="hidden" name="handle" value="${esc(consent.handle)}">
<div class="row"><button class="no" name="decision" value="deny">Annulla</button><button name="decision" value="approve">Collega</button></div></form>`,
      consent.headers
    );
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const handle = String(form.get("handle") || "");
    try {
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: ["registro"] });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: { label: "owner" },
        scope: approved.request.scope,
        props: {},
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (err) {
      if (err instanceof AuthorizationError) return page(`<h1>Pagina scaduta</h1><p>${esc(err.message)}</p>`);
      throw err;
    }
  }
  return new Response("Method not allowed", { status: 405 });
}

// ---------------- MCP ----------------
async function mcpFetch(request, env, ctx) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) {
    const r = await handle(m, env);
    if (r) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}

async function readSnap(env) {
  const raw = await env.OAUTH_KV.get(KV_SNAP);
  return raw ? JSON.parse(raw) : null;
}

async function handle(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const text = (t) => ok({ content: [{ type: "text", text: t }] });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "registro-orsoline", version: "4.0.0" },
        instructions: "Registro elettronico. I dati sono sincronizzati dal telefono. Usa 'registro' con 'cosa' (voti, compiti, assenze...).",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const a = params?.arguments || {};
      const snap = await readSnap(env);
      if (params?.name === "registro_stato") {
        if (!snap) return text("Nessun dato sincronizzato. Lancia lo script sul telefono (app Scriptable).");
        const sez = snap.dati ? Object.keys(snap.dati) : [];
        return text(`Ultima sincronizzazione: ${snap.ts || snap.ricevuto}\nStudente: ${snap.studente || "?"}\nSezioni disponibili: ${sez.join(", ")}`);
      }
      if (params?.name === "registro") {
        if (!snap) return text("Nessun dato sincronizzato ancora. Apri l'app Scriptable sul telefono e lancia lo script, poi riprova.");
        const sezione = snap.dati?.[a.cosa];
        if (sezione === undefined) return text(`La sezione "${a.cosa}" non è nei dati sincronizzati. Disponibili: ${Object.keys(snap.dati || {}).join(", ")}.`);
        return text(`${String(a.cosa).toUpperCase()} — sincronizzato il ${snap.ts || snap.ricevuto}\n\n` + formatRows(sezione));
      }
      return fail(-32602, `Strumento sconosciuto: ${params?.name}`);
    }
    default:
      return fail(-32601, `Metodo non supportato: ${method}`);
  }
}

function json(d, status = 200) {
  return new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["Tabella1", "tabella1", "Table1", "righe", "rows", "dati", "Dati", "result", "Result"])
      if (Array.isArray(data[k])) return data[k];
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return null;
}
function formatRows(data) {
  const rows = rowsOf(data);
  if (!rows) return JSON.stringify(data, null, 2).slice(0, 12000);
  if (rows.length === 0) return "(nessuna voce)";
  return rows.slice(0, 300).map((r) => {
    if (r && typeof r === "object") {
      const parts = Object.entries(r).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      return "• " + parts.join(" | ");
    }
    return "• " + r;
  }).join("\n").slice(0, 16000);
}
