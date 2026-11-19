// Server MCP per il registro elettronico registro.orsoline.it (Sigma Sistemi).
// Gira su Cloudflare Workers e usa Browser Rendering (un vero Chrome in cloud).
// Collegandolo a un'AI (Claude, ChatGPT, ...) si apre una pagina di accesso dove inserisci
// le credenziali del registro: vengono verificate sul sito e salvate cifrate (OAuth),
// senza passare mai dalla chat. Funziona con qualsiasi client MCP che supporti OAuth.

import puppeteer from "@cloudflare/puppeteer";
import { OAuthProvider, AuthorizationError } from "@cloudflare/workers-oauth-provider";

const BASE = "https://registro.orsoline.it";
const LOGIN_URL = BASE + "/Default.aspx";
const MAX_TEXT = 20000;
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "registro_apri",
    title: "Apri il registro elettronico",
    description:
      "Accede al registro elettronico della scuola (registro.orsoline.it) con le credenziali dello studente " +
      "e restituisce: URL corrente, testo della pagina e l'elenco degli elementi cliccabili (voci di menu, link, pulsanti). " +
      "Senza argomenti mostra la pagina iniziale dopo il login: usala per prima per scoprire il menu. " +
      "Per arrivare a una sezione (voti, compiti, assenze, comunicazioni...) passa in 'azioni' i clic da fare, in ordine, " +
      "usando i testi esatti visti nell'elenco degli elementi cliccabili. Ogni chiamata parte da un nuovo login, " +
      "quindi ripeti tutta la sequenza di clic per arrivare a una sottopagina. " +
      "Non usare 'scrivi' per inviare giustificazioni, prenotazioni o altri moduli senza conferma esplicita dell'utente.",
    inputSchema: {
      type: "object",
      properties: {
        percorso: {
          type: "string",
          description: "Facoltativo. URL o percorso del registro da aprire dopo il login, es. '/Default.aspx'.",
        },
        azioni: {
          type: "array",
          description: "Facoltativo. Azioni da eseguire in ordine dopo il login.",
          items: {
            type: "object",
            properties: {
              tipo: { type: "string", enum: ["clicca", "scrivi", "attendi"] },
              testo: {
                type: "string",
                description:
                  "Per 'clicca': il testo visibile dell'elemento. Per 'scrivi': etichetta, placeholder, name o id del campo.",
              },
              valore: {
                type: "string",
                description: "Per 'scrivi': il testo da inserire o l'opzione da scegliere. Per 'attendi': millisecondi.",
              },
            },
            required: ["tipo"],
          },
        },
        screenshot: {
          type: "boolean",
          description: "Facoltativo. Se true allega uno screenshot della pagina finale.",
        },
      },
    },
    annotations: { openWorldHint: true },
  },
];

// ---------------- OAuth: il provider si crea per l'indirizzo su cui gira il Worker ----------------

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

// ---------------- Pagine: home e accesso ----------------

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
.warn{background:#fff6dd;padding:10px 12px;border-radius:10px}code{word-break:break-all}
</style></head><body><div class="card">${body}</div></body></html>`,
    { headers }
  );
}

function loginPage(details, handle, error) {
  return `<h1>Collega il registro elettronico</h1>
<p><strong>${esc(details.clientName)}</strong>${details.clientDomain ? ` (${esc(details.clientDomain)})` : ""} chiede di leggere il tuo registro su registro.orsoline.it.
L'accesso verrà inviato a <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">Questo invia l\'accesso a un\'app sul tuo computer: continua solo se hai appena avviato il collegamento da lì.</p>' : ""}
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="u">Username del registro</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required>
<label for="p">Password del registro</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<div class="row"><button class="no" name="decision" value="deny" formnovalidate>Annulla</button><button name="decision" value="approve">Collega</button></div>
</form>
<p style="font-size:13px">Le credenziali vengono verificate sul registro e salvate cifrate su questo server. L'AI non le vede mai.</p>`;
}

async function pagesFetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return page(`<h1>Registro MCP attivo ✅</h1>
<p>Per collegarlo a un'AI aggiungi un connettore MCP personalizzato con questo indirizzo:</p>
<p><code>${esc(url.origin)}/mcp</code></p>
<p>Al collegamento si aprirà la pagina per inserire le credenziali del registro.</p>`);
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
    return page(loginPage(details, consent.handle), consent.headers);
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

      // Verifica le credenziali sul registro prima di consumare il modulo.
      let error = null;
      try {
        await verificaCredenziali(env, creds);
      } catch (err) {
        error = err.message;
      }
      if (error) {
        return page(
          `<h1>Accesso non riuscito</h1><p class="err">${esc(error)}</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<label for="u">Username del registro</label><input id="u" name="username" value="${esc(creds.user)}" autocapitalize="none" required>
<label for="p">Password del registro</label><input id="p" name="password" type="password" required>
<div class="row"><button class="no" name="decision" value="deny" formnovalidate>Annulla</button><button name="decision" value="approve">Riprova</button></div></form>`,
          new Headers({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" })
        );
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
        return page(`<h1>Pagina scaduta</h1><p class="err">${esc(err.message)}</p><p>Torna all'app e ricollega il connettore.</p>`);
      }
      throw err;
    }
  }
  return new Response("Method not allowed", { status: 405 });
}

// ---------------- MCP (Streamable HTTP, senza stato) ----------------

async function mcpFetch(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const creds = ctx.props;
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleMessage(msg, env, creds);
    if (res) responses.push(res);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}

async function handleMessage(msg, env, creds) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notifica

  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "registro-orsoline", version: "2.0.0" },
        instructions:
          "Registro elettronico dello studente. Chiama prima registro_apri senza argomenti per vedere il menu, " +
          "poi naviga con 'azioni' di tipo 'clicca'. Il piano gratuito ha circa 10 minuti di browser al giorno: evita chiamate inutili.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      if (params?.name !== "registro_apri") return fail(-32602, `Strumento sconosciuto: ${params?.name}`);
      try {
        return ok(await registroApri(env, creds, params.arguments || {}));
      } catch (err) {
        return ok({ content: [{ type: "text", text: `Errore: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Metodo non supportato: ${method}`);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function verificaCredenziali(env, creds) {
  if (!creds.user || !creds.pass) throw new Error("Inserisci username e password.");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const p = await browser.newPage();
    p.setDefaultTimeout(20000);
    await login(p, creds);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------- Browser ----------------

async function registroApri(env, creds, args) {
  if (!creds?.user || !creds?.pass) throw new Error("Credenziali mancanti: ricollega il connettore.");
  if (!env.BROWSER) throw new Error("Binding BROWSER mancante: controlla wrangler.jsonc.");

  const browser = await puppeteer.launch(env.BROWSER);
  const log = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await login(page, creds);
    log.push("Login eseguito.");

    if (args.percorso) {
      const target = new URL(args.percorso, BASE);
      if (target.origin !== BASE) throw new Error("Il percorso deve restare su registro.orsoline.it.");
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(page);
      log.push(`Aperto ${target.pathname}.`);
    }

    for (const azione of args.azioni || []) {
      if (azione.tipo === "clicca") {
        const done = await clicca(page, azione.testo || "");
        log.push(done ? `Cliccato "${azione.testo}".` : `NON trovato da cliccare: "${azione.testo}".`);
        if (!done) break;
      } else if (azione.tipo === "scrivi") {
        const done = await scrivi(page, azione.testo || "", azione.valore ?? "");
        log.push(done ? `Compilato "${azione.testo}".` : `NON trovato il campo: "${azione.testo}".`);
        if (!done) break;
      } else if (azione.tipo === "attendi") {
        const ms = Math.min(Number(azione.valore) || 1000, 10000);
        await sleep(ms);
        log.push(`Atteso ${ms} ms.`);
      }
    }

    const snapshot = await leggiPagina(page);
    const content = [
      {
        type: "text",
        text:
          `${log.join("\n")}\n\nURL: ${page.url()}\n\n=== TESTO DELLA PAGINA ===\n${snapshot.text}\n\n` +
          `=== ELEMENTI CLICCABILI ===\n${snapshot.clickable.join("\n") || "(nessuno)"}`,
      },
    ];
    if (args.screenshot) {
      const data = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false, encoding: "base64" });
      content.push({ type: "image", data, mimeType: "image/jpeg" });
    }
    return { content };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function login(page, creds) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await settle(page);

  const fields = [];
  for (const el of await page.$$(
    "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])"
  )) {
    if (await el.boundingBox()) fields.push(el);
  }
  if (fields.length < 2) {
    throw new Error("Pagina di login non riconosciuta (il sito potrebbe aver bloccato il browser di Cloudflare).");
  }
  let pass = null;
  for (const f of fields) {
    if ((await f.evaluate((e) => e.type)) === "password") pass = f;
  }
  if (!pass) pass = fields[1];
  const user = fields.find((f) => f !== pass);

  await user.click({ clickCount: 3 });
  await user.type(creds.user);
  await pass.click({ clickCount: 3 });
  await pass.type(creds.pass);

  if (!(await clicca(page, "Log in"))) {
    await pass.press("Enter");
    await settle(page);
  }

  if (await trovaElemento(page, "Log in", true)) {
    throw new Error("Login non riuscito: username o password errati.");
  }
}

async function settle(page) {
  await sleep(300);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Cerca in tutti i frame l'elemento visibile il cui testo corrisponde (esatto prima, poi "contiene").
async function trovaElemento(page, testo, soloEsatto = false) {
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle(
        (t, exactOnly) => {
          const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
          const target = norm(t);
          if (!target) return null;
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const sel =
            "a,button,[role=button],[role=menuitem],[role=tab],[role=link],[onclick],input[type=button],input[type=submit],li,span,div,td,label";
          let best = null;
          let bestScore = Infinity;
          for (const el of document.querySelectorAll(sel)) {
            const txt = norm(el.innerText || el.value || el.getAttribute("aria-label") || el.title);
            if (!txt) continue;
            const exact = txt === target;
            if (!exact && (exactOnly || !txt.includes(target))) continue;
            if (!visible(el)) continue;
            const interactive = el.matches(
              "a,button,[role=button],[role=menuitem],[role=tab],[role=link],[onclick],input[type=button],input[type=submit]"
            );
            const score = (exact ? 0 : 1e6) + (interactive ? 0 : 1e4) + txt.length;
            // a parità di punteggio vince l'elemento più interno (che viene dopo nel DOM)
            if (score <= bestScore) {
              best = el;
              bestScore = score;
            }
          }
          return best;
        },
        testo,
        soloEsatto
      );
    } catch {
      continue;
    }
    const el = handle.asElement();
    if (el) return el;
  }
  return null;
}

async function clicca(page, testo) {
  const el = await trovaElemento(page, testo);
  if (!el) return false;
  try {
    await el.click();
  } catch {
    await el.evaluate((e) => e.click());
  }
  await settle(page);
  return true;
}

async function scrivi(page, campo, valore) {
  for (const frame of page.frames()) {
    let handle;
    try {
      handle = await frame.evaluateHandle((c) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const t = norm(c);
        for (const f of document.querySelectorAll("input,textarea,select")) {
          const r = f.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || f.type === "hidden") continue;
          const label = f.id ? document.querySelector(`label[for="${CSS.escape(f.id)}"]`) : null;
          const keys = [f.placeholder, f.name, f.id, f.getAttribute("aria-label"), f.title, label && label.innerText].map(norm);
          if (keys.some((k) => k && (k === t || k.includes(t)))) return f;
        }
        return null;
      }, campo);
    } catch {
      continue;
    }
    const el = handle.asElement();
    if (!el) continue;
    const tag = await el.evaluate((e) => e.tagName);
    if (tag === "SELECT") {
      const ok = await el.evaluate((sel, v) => {
        const want = v.trim().toLowerCase();
        const opt = [...sel.options].find(
          (o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want
        ) || [...sel.options].find((o) => o.text.toLowerCase().includes(want));
        if (!opt) return false;
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, String(valore));
      await settle(page);
      return ok;
    }
    await el.click({ clickCount: 3 });
    await el.type(String(valore));
    return true;
  }
  return false;
}

async function leggiPagina(page) {
  const parts = [];
  const clickable = [];
  const seen = new Set();
  for (const frame of page.frames()) {
    try {
      const r = await frame.evaluate(() => {
        const visible = (el) => {
          const b = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        const items = [];
        const sel =
          "a,button,[role=button],[role=menuitem],[role=tab],[role=link],[onclick],input[type=button],input[type=submit]";
        for (const el of document.querySelectorAll(sel)) {
          if (!visible(el)) continue;
          const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          if (!t) continue;
          const href = el.getAttribute("href");
          items.push(href && !href.startsWith("javascript") && href !== "#" ? `${t} → ${new URL(href, location.href).href}` : t);
        }
        return { text: document.body ? document.body.innerText : "", items };
      });
      if (r.text.trim()) parts.push(r.text.trim());
      for (const it of r.items) {
        if (!seen.has(it) && clickable.length < 200) {
          seen.add(it);
          clickable.push("- " + it);
        }
      }
    } catch {
      // frame non accessibile
    }
  }
  let text = parts.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n");
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n[...testo troncato...]";
  return { text, clickable };
}
