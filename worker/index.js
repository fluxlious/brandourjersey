/**
 * brandourjersey API — Cloudflare Worker
 *
 * Three endpoints, no more:
 *   GET  /api/spots          which spots are taken (public)
 *   POST /api/checkout       reserve-check a spot and open a Dodo checkout
 *   POST /api/webhooks/dodo  Dodo tells us a payment succeeded
 *
 * Secrets live in Worker secrets, never in the page:
 *   DODO_API_KEY  DODO_WEBHOOK_KEY  DODO_PRODUCT_ID
 */

/* Prices live here, on the server. The browser never gets to say what a
   spot costs — it only sends a spot number. */
const SPOTS = {
  1: { name: "The Chest", amountCents: 20000 },
  2: { name: "Left Sleeve", amountCents: 6000 },
  3: { name: "Right Sleeve", amountCents: 6000 },
  4: { name: "Front Hem", amountCents: 3500 },
  5: { name: "Back Top", amountCents: 12000 },
  6: { name: "Back Bottom", amountCents: 11000 },
  7: { name: "The Nape", amountCents: 4500 },
};

const ALLOWED_ORIGINS = [
  "https://brandourjersey.com",
  "https://www.brandourjersey.com",
];

/* ── helpers ─────────────────────────────────────────────── */

/* The live site, plus any localhost port so the flow can be rehearsed before
   it goes anywhere near real money. CORS is hygiene here, not a lock: the
   real guards are server-side prices, the spot check, and webhook signing. */
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin) {
  const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* Constant-time compare so a wrong signature leaks no timing information. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacBase64(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToBase64(new Uint8Array(mac));
}

/** Standard Webhooks: HMAC-SHA256 over "<id>.<timestamp>.<body>". */
async function webhookIsGenuine(env, req, rawBody) {
  const id = req.headers.get("webhook-id");
  const ts = req.headers.get("webhook-timestamp");
  const header = req.headers.get("webhook-signature");
  if (!id || !ts || !header) return false;

  /* Reject replays of an old, previously valid delivery. */
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const raw = (env.DODO_WEBHOOK_KEY || "").replace(/^whsec_/, "");
  if (!raw) return false;

  /* The spec base64-encodes the secret, but not every dashboard hands it
     over that way, so accept a signature made with either reading. */
  const candidates = [];
  try {
    candidates.push(base64ToBytes(raw));
  } catch {
    /* not base64 — the UTF-8 reading below is the only one left */
  }
  candidates.push(new TextEncoder().encode(raw));

  const signed = `${id}.${ts}.${rawBody}`;
  const sent = header
    .split(" ")
    .map((part) => (part.includes(",") ? part.split(",")[1] : part));

  for (const keyBytes of candidates) {
    const expected = await hmacBase64(keyBytes, signed);
    if (sent.some((sig) => safeEqual(sig, expected))) return true;
  }
  return false;
}

/** Accept only a plain http(s) address, and hand back a tidy brand name. */
function parseBrandUrl(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error("Enter your website address");
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("That does not look like a website address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("That does not look like a website address");
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (!host.includes(".")) throw new Error("That does not look like a website address");

  const label = host.split(".")[0];
  return {
    url: parsed.origin,
    host,
    name: label.charAt(0).toUpperCase() + label.slice(1),
  };
}

/* Send the buyer back to the page they actually started from — the live site
   in normal use, a localhost copy while testing. Anything that is not an
   allowed origin falls back to the configured site, so this cannot be talked
   into redirecting somewhere else. */
function returnBase(requested, env) {
  const configured = env.SITE_URL || ALLOWED_ORIGINS[0];
  const fallback = configured.endsWith("/") ? configured : configured + "/";
  if (!requested) return fallback;
  try {
    const parsed = new URL(requested);
    if (!isAllowedOrigin(parsed.origin)) return fallback;
    return parsed.origin + parsed.pathname;
  } catch {
    return fallback;
  }
}

function dodoBase(env) {
  return env.DODO_ENVIRONMENT === "live_mode"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";
}

/* ── endpoints ───────────────────────────────────────────── */

/* Only paid spots are public. A reservation is a private hold, not a sale. */
async function getSpots(env, origin) {
  const { results } = await env.DB.prepare(
    `SELECT spot_id, name, url, logo, logo_b64 IS NOT NULL AS has_upload
       FROM claims WHERE status = 'paid'`,
  ).all();

  const taken = {};
  for (const row of results || []) {
    /* An uploaded file wins over a hand-set URL. It is served from its own
       endpoint so this response stays small. */
    const logo = row.has_upload
      ? `/api/logo/${row.spot_id}`
      : row.logo || null;
    taken[row.spot_id] = { name: row.name, url: row.url, logo };
  }
  return json({ taken }, 200, origin);
}

/* A view counter that cannot be turned back into a person: the visitor key is
   a hash of IP + user agent + today's date + a secret, so it is different
   tomorrow, and the rows are dropped after two days. Nothing is stored that
   identifies a reader, which is also why the page needs no cookie banner. */
async function postVisit(req, env, origin) {
  const day = new Date().toISOString().slice(0, 10);
  const raw = [
    req.headers.get("CF-Connecting-IP") || "",
    req.headers.get("User-Agent") || "",
    day,
    env.DODO_WEBHOOK_KEY || "salt",
  ].join("|");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  const visitor = bytesToBase64(new Uint8Array(digest)).slice(0, 22);

  const first = await env.DB.prepare(
    "INSERT OR IGNORE INTO seen (day, visitor) VALUES (?, ?)",
  )
    .bind(day, visitor)
    .run();

  if (first.meta && first.meta.changes > 0) {
    await env.DB.prepare(
      `INSERT INTO counters (key, value) VALUES ('views', 1)
       ON CONFLICT(key) DO UPDATE SET value = value + 1`,
    ).run();

    /* Cheap housekeeping on the way past, rather than a scheduled job. */
    await env.DB.prepare("DELETE FROM seen WHERE day < date('now', '-2 days')").run();
  }

  const row = await env.DB.prepare(
    "SELECT value FROM counters WHERE key = 'views'",
  ).first();

  return json({ views: (row && row.value) || 0 }, 200, origin);
}

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const LOGO_MAX_BYTES = 400 * 1024;

/* Deliberately no SVG: it can carry script, and this file is served back to
   every visitor. */
async function postLogo(req, env, origin) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send valid JSON" }, 400, origin);
  }

  const spotId = Number(body.spotId);
  const token = String(body.token || "");
  const dataUrl = String(body.dataUrl || "");
  if (!SPOTS[spotId] || !token) {
    return json({ error: "Missing spot or token" }, 400, origin);
  }

  const match = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!match) return json({ error: "Send the image as a data URL" }, 400, origin);

  const mime = match[1].toLowerCase();
  const b64 = match[2];
  if (!LOGO_TYPES.includes(mime)) {
    return json({ error: "Use a PNG, JPG or WebP file" }, 415, origin);
  }
  if (Math.floor(b64.length * 3 / 4) > LOGO_MAX_BYTES) {
    return json({ error: "That file is over 400 KB. Send a smaller one." }, 413, origin);
  }

  const row = await env.DB.prepare(
    "SELECT upload_token FROM claims WHERE spot_id = ? AND status = 'paid'",
  )
    .bind(spotId)
    .first();

  if (!row || !row.upload_token || !safeEqual(row.upload_token, token)) {
    return json({ error: "That upload link is not valid" }, 403, origin);
  }

  await env.DB.prepare(
    "UPDATE claims SET logo_mime = ?, logo_b64 = ? WHERE spot_id = ?",
  )
    .bind(mime, b64, spotId)
    .run();

  return json({ ok: true }, 200, origin);
}

async function getLogo(spotId, env, origin) {
  const row = await env.DB.prepare(
    "SELECT logo_mime, logo_b64 FROM claims WHERE spot_id = ? AND status = 'paid'",
  )
    .bind(spotId)
    .first();

  if (!row || !row.logo_b64) {
    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  }

  return new Response(base64ToBytes(row.logo_b64), {
    headers: {
      "Content-Type": row.logo_mime || "image/png",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

async function postCheckout(req, env, origin) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send valid JSON" }, 400, origin);
  }

  const spotId = Number(body.spotId);
  const spot = SPOTS[spotId];
  if (!spot) return json({ error: "No such spot" }, 404, origin);

  let brand;
  try {
    brand = parseBrandUrl(body.url);
  } catch (err) {
    return json({ error: err.message }, 400, origin);
  }

  if (!env.DODO_API_KEY || !env.DODO_PRODUCT_ID) {
    return json({ error: "Checkout is not switched on yet" }, 503, origin);
  }

  /* Hold the spot for as long as the checkout page is realistically open, so
     two people cannot both pay for it. An abandoned hold frees itself. */
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    "SELECT status, expires_at FROM claims WHERE spot_id = ?",
  )
    .bind(spotId)
    .first();

  if (existing) {
    if (existing.status === "paid") {
      return json({ error: "That spot has gone. Pick another one." }, 409, origin);
    }
    if (existing.expires_at && existing.expires_at > now) {
      return json(
        { error: "Someone is paying for that spot right now. Try again in a few minutes." },
        409,
        origin,
      );
    }
    await env.DB.prepare(
      "DELETE FROM claims WHERE spot_id = ? AND status = 'reserved'",
    )
      .bind(spotId)
      .run();
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  /* Minted here so it can ride back on the return URL. Only whoever went
     through this checkout can then upload a logo for this spot. */
  const uploadToken = crypto.randomUUID();
  const held = await env.DB.prepare(
    `INSERT OR IGNORE INTO claims (spot_id, status, name, url, expires_at, upload_token)
     VALUES (?, 'reserved', ?, ?, ?, ?)`,
  )
    .bind(spotId, brand.name, brand.url, expiresAt, uploadToken)
    .run();

  /* Lost the race to another request between the check and the insert. */
  if (!held.meta || held.meta.changes === 0) {
    return json({ error: "That spot just went. Pick another one." }, 409, origin);
  }

  const releaseHold = () =>
    env.DB.prepare("DELETE FROM claims WHERE spot_id = ? AND status = 'reserved'")
      .bind(spotId)
      .run()
      .catch(() => {});

  const siteUrl = returnBase(body.returnTo, env);
  let res;
  try {
    res = await fetch(dodoBase(env) + "/checkouts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.DODO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        product_cart: [
          {
            product_id: env.DODO_PRODUCT_ID,
            quantity: 1,
            amount: spot.amountCents,
          },
        ],
        return_url: `${siteUrl}?claimed=${spotId}&t=${uploadToken}`,
        cancel_url: siteUrl,
        /* Without this the checkout converts to the buyer's local currency and
           the total stops matching the euro price on the page. */
        billing_currency: "EUR",
        metadata: {
          spot_id: String(spotId),
          brand_name: brand.name,
          brand_url: brand.url,
          brand_host: brand.host,
        },
        /* Strip the checkout back to card details. A tax ID or phone number
           is pure friction on a EUR 35 purchase, and an empty tax ID field
           fails validation rather than being skipped. */
        feature_flags: {
          allow_discount_code: false,
          allow_currency_selection: false,
          allow_tax_id: false,
          allow_phone_number_collection: false,
          redirect_immediately: true,
        },
      }),
    });
  } catch {
    await releaseHold();
    return json({ error: "Could not reach the payment provider" }, 502, origin);
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || !payload.checkout_url) {
    console.error("[checkout] dodo said", res.status, JSON.stringify(payload));
    await releaseHold();
    return json({ error: "Could not open checkout" }, 502, origin);
  }

  return json({ checkoutUrl: payload.checkout_url }, 200, origin);
}

async function postWebhook(req, env) {
  const rawBody = await req.text();

  if (!(await webhookIsGenuine(env, req, rawBody))) {
    return new Response("Unauthorized", { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  if (event.type !== "payment.succeeded") {
    return new Response(null, { status: 200 });
  }

  const data = event.data || {};
  const meta = data.metadata || {};
  const spotId = Number(meta.spot_id);
  if (!SPOTS[spotId]) return new Response(null, { status: 200 });

  /* No logo is stored on purchase. Most sites either have no favicon or a
     32px one, and both look wrong blown up on a shirt — the page falls back
     to the sponsor's name as a wordmark, which is what real kits carry
     anyway. A proper logo goes in by hand once the sponsor sends one. */
  const logo = null;

  /* Turn the hold into a sale. The WHERE clause means a redelivered webhook
     leaves an already-paid spot exactly as it is. */
  await env.DB.prepare(
    `INSERT INTO claims (spot_id, status, name, url, logo, payment_id, expires_at)
     VALUES (?, 'paid', ?, ?, ?, ?, NULL)
     ON CONFLICT(spot_id) DO UPDATE SET
       status     = 'paid',
       name       = excluded.name,
       url        = excluded.url,
       logo       = excluded.logo,
       payment_id = excluded.payment_id,
       expires_at = NULL
     WHERE claims.status <> 'paid'`,
  )
    .bind(
      spotId,
      meta.brand_name || "Sponsor",
      meta.brand_url || null,
      logo,
      data.payment_id || null,
    )
    .run();

  return new Response(null, { status: 200 });
}

/* ── router ──────────────────────────────────────────────── */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/spots" && req.method === "GET") {
      return getSpots(env, origin);
    }
    if (url.pathname === "/api/checkout" && req.method === "POST") {
      return postCheckout(req, env, origin);
    }
    if (url.pathname === "/api/visit" && req.method === "POST") {
      return postVisit(req, env, origin);
    }
    if (url.pathname === "/api/logo" && req.method === "POST") {
      return postLogo(req, env, origin);
    }
    const logoMatch = /^\/api\/logo\/(\d+)$/.exec(url.pathname);
    if (logoMatch && req.method === "GET") {
      return getLogo(Number(logoMatch[1]), env, origin);
    }
    if (url.pathname === "/api/webhooks/dodo" && req.method === "POST") {
      return postWebhook(req, env);
    }

    return json({ error: "Not found" }, 404, origin);
  },
};
