// Server MCP per il registro elettronico registro.orsoline.it (OneClickSchool / Sigma Sistemi).
// Usa direttamente l'API REST dell'app ufficiale (nessun browser): login con token Bearer
// e operazioni via /api/query/esegui. Gira su Cloudflare Workers, gratis e senza limiti di browser.
//
// Collegandolo a un'AI si apre una pagina dove inserisci le credenziali del registro:
// vengono verificate e salvate cifrate (OAuth). L'AI non le vede mai.

import { OAuthProvider, AuthorizationError } from "@cloudflare/workers-oauth-provider";

// Endpoint della scuola (ricavati dalla configurazione dell'app, codice scuola "Dedalo").
const PURL = "https://registro.orsoline.it/registroWs"; // operazioni registro (voti, assenze, ...)
const WURL = "https://registro.orsoline.it/oneClickSchoolWs"; // servizi app
const APP_VERSION = "1.2.39";
const DEVICE = "android";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// Operazioni note (codice -> parametri accettati). Il valore "studente" viene riempito
// automaticamente col codice dell'utente autenticato se non specificato.
const OPERAZIONI = {
  voti: { codice: "REVOTD_votiStudente", params: ["studente", "materia", "tipo", "nascondiVoti", "periodo"], def: { tipo: "0", nascondiVoti: "0" } },
  assenze: { codice: "REAPPE_assenzeStudente", params: ["studente"] },
  compiti: { codice: "RECOMP_elencoStudente", params: ["studente", "mese", "materia"] },
  argomenti: { codice: "REARGO_elencoStudente", params: ["studente", "mese", "materia"] },
  comunicazioni: { codice: "RECOMU_elencoComunicazioniStudente", params: ["studente"] },
  materie: { codice: "RE_getElencoMaterieStudente", params: ["studente"] },
  periodi: { codice: "RE_getElencoPeriodiStudente", params: ["studente"] },
  note: { codice: "RENODI_elencoStudente", params: ["studente"] },
};

const TOOLS = [
  {
    name: "registro",
    title: "Registro elettronico",
    description:
      "Legge i dati dal registro elettronico della scuola (OneClickSchool). " +
      "Scegli 'cosa': voti, assenze, compiti, argomenti, comunicazioni, materie, periodi, note. " +
      "Parametri utili: 'materia' (codice materia da 'materie'), 'periodo' (codice da 'periodi'), " +
      "'mese' (per compiti/argomenti, formato AAAA-MM o MM). " +
      "Il codice studente è automatico. Restituisce le righe della tabella dati del registro.",
    inputSchema: {
      type: "object",
      properties: {
        cosa: { type: "string", enum: Object.keys(OPERAZIONI), description: "Cosa leggere dal registro." },
        materia: { type: "string", description: "Codice materia (facoltativo)." },
        periodo: { type: "string", description: "Codice periodo/quadrimestre (facoltativo)." },
        mese: { type: "string", description: "Mese per compiti/argomenti (facoltativo)." },
        nascondiVoti: { type: "string", enum: ["0", "1"], description: "Per i voti: 1 nasconde i voti nascosti dal docente." },
      },
      required: ["cosa"],
    },
    annotations: { openWorldHint: true, readOnlyHint: true },
  },
  {
    name: "registro_operazione",
    title: "Operazione grezza sul registro",
    description:
      "Avanzato/diagnostica. Esegue una qualunque operazione dell'API (codice tipo 'REVOTD_votiStudente') " +
      "con i parametri indicati, e restituisce la risposta grezza del server. Usala per esplorare o correggere.",
    inputSchema: {
      type: "object",
      properties: {
        codice: { type: "string", description: "Codice operazione, es. REVOTD_votiStudente." },
        parametri: { type: "object", description: "Coppie nome/valore dei parametri, es. { studente: \"123\", periodo: \"1\" }." },
        base: { type: "string", enum: ["registroWs", "oneClickSchoolWs"], description: "Base da usare (default registroWs)." },
      },
      required: ["codice"],
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "registro_account",
    title: "Info account",
    description: "Esegue il login e mostra i dati dell'utente autenticato (codice studente, nome, scuola). Utile per diagnostica.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

// ---------------- OAuth provider ----------------
const providers = new Map();
function getProvider(origin) {
  if (!providers.has(origin)) {
    providers.set(
      origin,
      new OAuthProvider({
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
        resourceMetadata: {
          resource: origin + "/mcp",
          authorization_servers: [origin],
          resource_name: "Registro elettronico Orsoline",
        },
      })
    );
  }
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    return getProvider(new URL(request.url).origin).fetch(request, env, ctx);
  },
};

// ---------------- Pagine ----------------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(body, headers = new Headers()) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registro MCP</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f3f5f9;margin:0;padding:24px;color:#1d2433}
.card{max-width:420px;margin:24px auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 20px #0001}
h1{font-size:22px;margin:0 0 8px}p{line-height:1.45;color:#4a5263}label{display:block;font-weight:600;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border:1px solid #c9d0dc;border-radius:10px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;font-size:17px;padding:12px;border-radius:10px;border:0;background:#3f6ea6;color:#fff;font-weight:600}
button.no{background:#e6e9ef;color:#1d2433}.err{background:#fde8e8;color:#9b1c1c;padding:10px 12px;border-radius:10px}
code{word-break:break-all}</style></head><body><div class="card">${body}</div></body></html>`,
    { headers }
  );
}
function loginForm(details, handle, error, user = "") {
  return `<h1>Collega il registro elettronico</h1>
<p><strong>${esc(details.clientName)}</strong>${details.clientDomain ? ` (${esc(details.clientDomain)})` : ""} vuole leggere il tuo registro.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="u">Username del registro</label><input id="u" name="username" value="${esc(user)}" autocomplete="username" autocapitalize="none" required>
<label for="p">Password del registro</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="no" name="decision" value="deny" formnovalidate>Annulla</button><button name="decision" value="approve">Collega</button></div>
</form>
<p style="font-size:13px">Le credenziali vengono verificate e salvate cifrate su questo server. L'AI non le vede mai.</p>`;
}

async function pagesFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return page(`<h1>Registro MCP attivo ✅</h1>
<p>Indirizzo da usare come connettore MCP:</p><p><code>${esc(url.origin)}/mcp</code></p>`);
  }
  if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    let authRequest;
    try {
      authRequest = await oauth.parseAuthRequest(request);
    } catch (err) {
      if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
      return page(`<h1>Richiesta non valida</h1><p class="err">${esc(err.message)}</p>`);
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return page(loginForm(details, consent.handle), consent.headers);
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const handle = String(form.get("handle") || "");
    try {
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const creds = { user: String(form.get("username") || "").trim(), pass: String(form.get("password") || "") };
      let error = null;
      try {
        await apiLogin(creds); // verifica reale
      } catch (err) {
        error = err.message;
      }
      if (error) {
        const details = { clientName: "Connettore", clientDomain: "" };
        return page(loginForm(details, handle, error, creds.user),
          new Headers({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" }));
      }
      const approved = await oauth.approveConsent(request, handle, { scope: ["registro"] });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: creds.user,
        metadata: { label: creds.user },
        scope: approved.request.scope,
        props: creds,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        return page(`<h1>Pagina scaduta</h1><p class="err">${esc(err.message)}</p>`);
      }
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
  const creds = ctx.props;
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) {
    const r = await handle(m, creds);
    if (r) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}

async function handle(msg, creds) {
  if (!msg || msg.jsonrpc !== "2.0") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const errTool = (m) => ok({ content: [{ type: "text", text: m }], isError: true });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "registro-orsoline", version: "3.0.0" },
        instructions: "Registro elettronico via API. Usa lo strumento 'registro' con 'cosa' = voti/compiti/assenze/argomenti/comunicazioni. Niente limiti di browser.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const a = params?.arguments || {};
      try {
        if (params?.name === "registro_account") {
          const s = await apiLogin(creds);
          return ok({ content: [{ type: "text", text: "Login riuscito.\n\n" + JSON.stringify(redact(s.utente), null, 2) }] });
        }
        if (params?.name === "registro") {
          const op = OPERAZIONI[a.cosa];
          if (!op) return errTool(`Valore 'cosa' non valido. Usa: ${Object.keys(OPERAZIONI).join(", ")}.`);
          const s = await apiLogin(creds);
          const p = { ...(op.def || {}) };
          if (op.params.includes("studente")) p.studente = s.studente;
          for (const k of ["materia", "periodo", "mese", "nascondiVoti"]) {
            if (a[k] != null && a[k] !== "" && op.params.includes(k)) p[k] = String(a[k]);
          }
          const r = await esegui(s.token, op.codice, p, PURL);
          return ok({ content: [{ type: "text", text: formatRows(a.cosa, r) }] });
        }
        if (params?.name === "registro_operazione") {
          if (!a.codice) return errTool("Specifica 'codice'.");
          const s = await apiLogin(creds);
          const base = a.base === "oneClickSchoolWs" ? WURL : PURL;
          const p = { ...(a.parametri || {}) };
          if (p.studente === "me" || p.studente === "") p.studente = s.studente;
          const r = await esegui(s.token, a.codice, p, base, true);
          return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 2).slice(0, 18000) }] });
        }
        return fail(-32602, `Strumento sconosciuto: ${params?.name}`);
      } catch (err) {
        return errTool(`Errore: ${err.message}`);
      }
    }
    default:
      return fail(-32601, `Metodo non supportato: ${method}`);
  }
}
function json(d, status = 200) {
  return new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
}

// ---------------- API client ----------------
const UA = "OneClickSchool/" + APP_VERSION + " (Android)";

async function apiLogin(creds) {
  if (!creds?.user || !creds?.pass) throw new Error("Credenziali mancanti: ricollega il connettore.");
  const res = await fetch(PURL + "/users/authenticate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({ username: creds.user, password: creds.pass, versione: APP_VERSION, device: DEVICE }),
  });
  const text = await res.text();
  if (res.status === 403 || /Attention Required|you have been blocked/i.test(text)) {
    throw new Error("Il server blocca le richieste dal cloud (protezione anti-bot). Serve l'esecuzione da rete residenziale.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Risposta login non JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const token = data.token || data.Token || data.accessToken || data.access_token || (data.utente && (data.utente.token || data.utente.Token));
  const utente = data.utente || data.Utente || data;
  if (!token) {
    if (data.autenticato === false || data.Autenticato === false || res.status === 401)
      throw new Error("Login non riuscito: username o password errati.");
    throw new Error(`Login: token non trovato. Risposta: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const studente = utente?.Codice ?? utente?.codice ?? utente?.CodiceStudente ?? utente?.Id ?? utente?.id ?? "";
  return { token, utente, studente: String(studente) };
}

async function esegui(token, codice, params, base, raw = false) {
  const parametri = Object.entries(params).map(([nome, valore]) => ({ nome, valore: String(valore) }));
  const res = await fetch(base + "/api/query/esegui", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + token,
      "User-Agent": UA,
    },
    body: JSON.stringify({ codice, parametri }),
  });
  const text = await res.text();
  if (res.status === 403 || /Attention Required|you have been blocked/i.test(text)) {
    throw new Error("Il server blocca le richieste dal cloud (protezione anti-bot).");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Risposta non JSON (HTTP ${res.status}) per ${codice}: ${text.slice(0, 300)}`);
  }
  if (raw) return data;
  if (data && (data.errore || data.Errore)) throw new Error(String(data.errore || data.Errore));
  return data;
}

// ---------------- Formattazione ----------------
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  for (const k of ["Tabella1", "tabella1", "Table1", "righe", "rows", "dati", "Dati", "result", "Result"]) {
    if (data && Array.isArray(data[k])) return data[k];
  }
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return null;
}
function formatRows(cosa, data) {
  const rows = rowsOf(data);
  if (!rows) return `Risposta per ${cosa}:\n` + JSON.stringify(data, null, 2).slice(0, 12000);
  if (rows.length === 0) return `Nessun dato trovato per ${cosa}.`;
  const lines = rows.slice(0, 200).map((r, i) => {
    if (r && typeof r === "object") {
      const parts = Object.entries(r)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
      return `• ${parts.join(" | ")}`;
    }
    return `• ${r}`;
  });
  return `${cosa.toUpperCase()} (${rows.length} voci):\n` + lines.join("\n").slice(0, 16000);
}
function redact(u) {
  if (!u || typeof u !== "object") return u;
  const c = { ...u };
  for (const k of Object.keys(c)) if (/pass|token|secret/i.test(k)) c[k] = "***";
  return c;
}
