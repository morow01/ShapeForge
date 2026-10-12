/**
 * ShapeForge sign-in helper (Cloudflare Worker).
 *
 * Google only hands out long-lived "refresh tokens" to a server that holds the app's client secret,
 * and the secret cannot sit in a web page. This worker is that server, and nothing else:
 *   POST /exchange  { code }    Google's one-time sign-in code  ->  access token + sealed renewal key
 *   POST /refresh   { sealed }  sealed renewal key              ->  fresh access token
 *   POST /revoke    { sealed }  sealed renewal key              ->  tells Google to forget it
 * The renewal key is encrypted with a secret only this worker knows ("sealed") before it goes to the
 * browser, so a copy found in someone's storage is useless on its own. Nothing is stored here.
 */

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** 32 random bytes, base64. Encrypts the renewal keys. */
  SEAL_KEY: string;
  /** Comma-separated list of web addresses allowed to call this worker. */
  ALLOWED_ORIGINS: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Where the desktop app's sign-in comes back to (see electron/main.cjs). */
const DESKTOP_REDIRECTS = ["http://localhost:5173/oauth-callback"];
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const b64 = {
  enc: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  dec: (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};

async function sealKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64.dec(env.SEAL_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv);
  out.set(data, iv.length);
  return b64.enc(out);
}

async function unseal(env: Env, sealed: string): Promise<string | null> {
  try {
    const all = b64.dec(sealed);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await sealKey(env), all.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function corsHeaders(request: Request, env: Env): Record<string, string> | null {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}

async function askGoogle(params: Record<string, string>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* Google answered with something that is not JSON */
  }
  return { ok: res.ok, data };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (!cors) return new Response("Not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return reply({ error: "POST only" }, 405, cors);

    const path = new URL(request.url).pathname;
    let body: { code?: string; sealed?: string; redirect_uri?: string } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return reply({ error: "bad_request" }, 400, cors);
    }
    const base = { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET };

    if (path === "/exchange") {
      if (!body.code) return reply({ error: "bad_request" }, 400, cors);
      // "postmessage" is what Google expects for a code handed over by its sign-in popup. The desktop app signs in
      // through the person's own browser instead, which comes back to its own local address.
      const redirect = body.redirect_uri && DESKTOP_REDIRECTS.includes(body.redirect_uri) ? body.redirect_uri : "postmessage";
      const { ok, data } = await askGoogle({ ...base, grant_type: "authorization_code", code: body.code, redirect_uri: redirect });
      if (!ok) return reply({ error: data.error ?? "exchange_failed", error_description: data.error_description }, 400, cors);
      const refresh = typeof data.refresh_token === "string" ? await seal(env, data.refresh_token) : null;
      return reply({ access_token: data.access_token, expires_in: data.expires_in, scope: data.scope, sealed: refresh }, 200, cors);
    }

    if (path === "/refresh") {
      const refresh = body.sealed ? await unseal(env, body.sealed) : null;
      if (!refresh) return reply({ error: "invalid_sealed" }, 401, cors);
      const { ok, data } = await askGoogle({ ...base, grant_type: "refresh_token", refresh_token: refresh });
      // invalid_grant means Google no longer honours it (revoked, or the account changed): sign in again.
      if (!ok) return reply({ error: data.error ?? "refresh_failed", error_description: data.error_description }, data.error === "invalid_grant" ? 401 : 502, cors);
      return reply({ access_token: data.access_token, expires_in: data.expires_in, scope: data.scope }, 200, cors);
    }

    if (path === "/revoke") {
      const refresh = body.sealed ? await unseal(env, body.sealed) : null;
      if (refresh) {
        await fetch(REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refresh }),
        });
      }
      return reply({ ok: true }, 200, cors);
    }

    return reply({ error: "not_found" }, 404, cors);
  },
};
