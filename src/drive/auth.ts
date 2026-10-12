import { DRIVE_SCOPES, getAuthWorkerUrl, getClientId } from "./config";
import { useDrive } from "./state";

/* Sign-in uses Google's token flow: a popup asks for permission once, and the app then holds a
   short-lived access token (about an hour) in memory only. Nothing secret is stored; asking
   again later is silent while the person is still signed in to Google. */

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
type CodeResponse = { code?: string; error?: string; error_description?: string };
type CodeClient = { requestCode: () => void };
type GoogleApi = {
  accounts: {
    oauth2: {
      initCodeClient: (config: {
        client_id: string;
        scope: string;
        ux_mode: "popup";
        callback: (response: CodeResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }) => CodeClient;
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }) => TokenClient;
      revoke: (token: string, done?: () => void) => void;
      hasGrantedAllScopes: (response: TokenResponse, ...scopes: string[]) => boolean;
    };
  };
};

const GIS_SRC = "https://accounts.google.com/gsi/client";
const CONNECTED_KEY = "cad.driveConnected";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

let loading: Promise<void> | null = null;
let client: TokenClient | null = null;
let clientFor = "";
let token: { value: string; expiresAt: number } | null = null;
let pending: { resolve: (token: string) => void; reject: (error: Error) => void }[] = [];

const google = (): GoogleApi | undefined => (window as unknown as { google?: GoogleApi }).google;

function loadGoogleScript(): Promise<void> {
  if (google()?.accounts?.oauth2) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loading = null;
        reject(new Error("Couldn't load Google sign-in. Check your connection and try again."));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

function settle(error: Error | null) {
  const waiting = pending;
  pending = [];
  for (const p of waiting) {
    if (error || !token) p.reject(error ?? new Error("Sign-in failed."));
    else p.resolve(token.value);
  }
}

function ensureClient(): TokenClient {
  const id = getClientId();
  if (client && clientFor === id) return client;
  clientFor = id;
  client = google()!.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: DRIVE_SCOPES,
    callback: (response) => {
      if (response.error || !response.access_token) {
        settle(new Error(response.error_description || response.error || "Sign-in failed."));
        return;
      }
      token = {
        value: response.access_token,
        // A minute early, so a request never starts with a token that is about to expire.
        expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000,
      };
      rememberToken();
      watchExpiry();
      // Google lets people untick individual permissions, so check Drive was really granted.
      if (!google()!.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_FILE_SCOPE)) {
        token = null;
        settle(new Error("The Drive permission wasn't ticked. Sign out, connect again, and tick the Google Drive box before clicking Continue."));
        return;
      }
      settle(null);
    },
    error_callback: (error) => {
      settle(
        new Error(
          error?.type === "popup_closed"
            ? "Sign-in was cancelled."
            : error?.type === "popup_failed_to_open"
              ? "The Google sign-in window was blocked. Allow pop-ups for this site, then click Connect."
              : error?.message || "Sign-in failed.",
        ),
      );
    },
  });
  return client;
}

/* With the helper configured, signing in uses Google's "code" flow: the popup returns a one-time code, the
   helper swaps it for an access token plus a sealed renewal key, and the key is kept here. When the hour is
   up the helper trades the key for a fresh token, with no popup and no click. */
const SEALED_KEY = "cad.driveSealed";

function readSealed(): string | null {
  try {
    return localStorage.getItem(SEALED_KEY);
  } catch {
    return null;
  }
}

function writeSealed(value: string | null) {
  try {
    if (value) localStorage.setItem(SEALED_KEY, value);
    else localStorage.removeItem(SEALED_KEY);
  } catch {
    /* the next hour will ask again */
  }
}

type WorkerReply = { access_token?: string; expires_in?: number | string; scope?: string; sealed?: string | null; error?: string; error_description?: string };

async function callWorker(path: string, body: Record<string, string>): Promise<{ status: number; data: WorkerReply }> {
  const res = await fetch(getAuthWorkerUrl() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: WorkerReply = {};
  try {
    data = (await res.json()) as WorkerReply;
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

function acceptToken(data: WorkerReply) {
  token = {
    value: data.access_token!,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000,
  };
  rememberToken();
  watchExpiry();
}

let codeClient: CodeClient | null = null;
let codeClientFor = "";
let codePending: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;

function ensureCodeClient(): CodeClient {
  const id = getClientId();
  if (codeClient && codeClientFor === id) return codeClient;
  codeClientFor = id;
  codeClient = google()!.accounts.oauth2.initCodeClient({
    client_id: id,
    scope: DRIVE_SCOPES,
    ux_mode: "popup",
    callback: (response) => {
      const waiting = codePending;
      codePending = null;
      if (response.error || !response.code) waiting?.reject(new Error(response.error_description || response.error || "Sign-in failed."));
      else waiting?.resolve(response.code);
    },
    error_callback: (error) => {
      const waiting = codePending;
      codePending = null;
      waiting?.reject(
        new Error(
          error?.type === "popup_closed"
            ? "Sign-in was cancelled."
            : error?.type === "popup_failed_to_open"
              ? "The Google sign-in window was blocked. Allow pop-ups for this site, then click Connect."
              : error?.message || "Sign-in failed.",
        ),
      );
    },
  });
  return codeClient;
}

/**
 * The desktop app is not a browser Google trusts, so it signs in through the person's own browser: that opens
 * Google's page, which comes back to the app's local address, and the app collects the result from there.
 * Returns null when this is not the desktop app.
 */
const DESKTOP_REDIRECT_PATH = "/oauth-callback";
async function isDesktopApp(): Promise<boolean> {
  try {
    const res = await fetch("/__auth/available");
    return res.ok && (await res.text()).trim() === "shapeforge-desktop";
  } catch {
    return false;
  }
}

async function requestCodeInBrowser(): Promise<string> {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: location.origin + DESKTOP_REDIRECT_PATH,
    response_type: "code",
    scope: DRIVE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  window.open("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(), "_blank");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch("/__auth/poll?state=" + encodeURIComponent(state));
    if (res.status !== 200) continue;
    const result = (await res.json()) as { code?: string; error?: string };
    if (result.code) return result.code;
    throw new Error(result.error === "access_denied" ? "Sign-in was cancelled." : "Sign-in failed.");
  }
  throw new Error("Sign-in took too long. Click Connect to try again.");
}

async function requestTokenViaWorker(): Promise<string> {
  const desktop = await isDesktopApp();
  let code: string;
  if (desktop) {
    code = await requestCodeInBrowser();
  } else {
    await loadGoogleScript();
    const c = ensureCodeClient();
    code = await new Promise<string>((resolve, reject) => {
      codePending = { resolve, reject };
      c.requestCode();
    });
  }
  const { status, data } = await callWorker(
    "/exchange",
    desktop ? { code, redirect_uri: location.origin + DESKTOP_REDIRECT_PATH } : { code },
  );
  if (status !== 200 || !data.access_token) throw new Error(data.error_description || data.error || "The sign-in helper could not finish signing in.");
  if (data.scope && !data.scope.includes(DRIVE_FILE_SCOPE)) {
    throw new Error("The Drive permission wasn't ticked. Sign out, connect again, and tick the Google Drive box before clicking Continue.");
  }
  writeSealed(data.sealed ?? null);
  acceptToken(data);
  return data.access_token;
}

/** A new access token from the sealed renewal key, with no popup. Null when there is no key or Google no longer honours it. */
let renewing: Promise<boolean> | null = null;
export function renewQuietly(): Promise<boolean> {
  const sealed = readSealed();
  if (!sealed || !getAuthWorkerUrl()) return Promise.resolve(false);
  if (!renewing) {
    renewing = (async () => {
      try {
        const { status, data } = await callWorker("/refresh", { sealed });
        if (status === 200 && data.access_token) {
          acceptToken(data);
          return true;
        }
        // Google no longer honours the key (revoked, or the account changed): a real sign-in is needed.
        if (status === 401) writeSealed(null);
      } catch {
        /* the helper could not be reached: try again later, or fall back to the popup */
      }
      return false;
    })().finally(() => {
      renewing = null;
    });
  }
  return renewing;
}

async function requestToken(prompt: "" | "consent"): Promise<string> {
  // Google only hands out a renewal key at the moment of first agreeing, so a device that signed in before
  // the helper existed needs one Sign out and Connect to get one.
  if (getAuthWorkerUrl()) return requestTokenViaWorker();
  await loadGoogleScript();
  const c = ensureClient();
  return new Promise<string>((resolve, reject) => {
    const alreadyAsking = pending.length > 0;
    pending.push({ resolve, reject });
    // A second caller joins the request already open instead of opening another popup.
    if (!alreadyAsking) c.requestAccessToken({ prompt });
  });
}

async function fetchEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

/** When the token runs out, show it plainly and get the quick reconnect ready. */
function watchExpiry() {
  clearTimeout(expiryTimer);
  if (!token) return;
  expiryTimer = setTimeout(() => {
    if (token && Date.now() < token.expiresAt) return watchExpiry();
    token = null;
    void renewQuietly().then((renewed) => {
      if (renewed) return;
      noteSignedOut("Google's one-hour sign-in ran out.");
      useDrive.getState().setStatus("signedOut");
      armQuietReconnect();
    });
  }, Math.max(1000, token.expiresAt - Date.now() + 500));
}

/* The token only lasts about an hour. It is kept here until it runs out, so a refresh, a new tab or
   a reload of the app's own code (which happens a lot while developing) carries on signed in. */
const TOKEN_KEY = "cad.driveToken";
const SIGNOUT_KEY = "cad.driveSignedOut";

/** Remembers why the person was last signed out, so the Home page can say so. */
function noteSignedOut(reason: string, reconnectFailed = false) {
  try {
    const previous = lastSignOut();
    // A failed reconnect right after an expiry adds to the story instead of replacing it.
    const recent = previous && Date.now() - previous.at < 10 * 60 * 1000 && !previous.reason.includes("Reconnecting");
    const record =
      reconnectFailed && recent && previous
        ? { at: previous.at, reason: `${previous.reason} Reconnecting then failed: ${reason}` }
        : { at: Date.now(), reason };
    localStorage.setItem(SIGNOUT_KEY, JSON.stringify(record));
  } catch {
    /* only a convenience */
  }
}

export function lastSignOut(): { at: number; reason: string } | null {
  try {
    return JSON.parse(localStorage.getItem(SIGNOUT_KEY) ?? "null") as { at: number; reason: string } | null;
  } catch {
    return null;
  }
}

/** A sign-in recorded earlier that is still good: for when the in-memory one has gone missing. */
function loadSavedToken(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "null") as { value?: string; expiresAt?: number } | null;
    if (saved?.value && saved.expiresAt && Date.now() < saved.expiresAt) {
      token = { value: saved.value, expiresAt: saved.expiresAt };
      watchExpiry();
      return true;
    }
  } catch {
    /* nothing usable stored */
  }
  return false;
}

function rememberToken(email?: string | null) {
  try {
    if (!token) return;
    const previous = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "null") as { email?: string | null } | null;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ ...token, email: email === undefined ? previous?.email ?? null : email }));
  } catch {
    /* a refresh will then need a click to reconnect */
  }
}

/** After a refresh: picks the still-valid token back up, so no sign-in window is needed. */
export function restoreSession(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "null") as
      | { value?: string; expiresAt?: number; email?: string | null }
      | null;
    if (loadSavedToken()) {
      useDrive.getState().setStatus("signedIn", saved?.email ?? null);
    } else if (wasConnected() && readSealed() && getAuthWorkerUrl()) {
      // The hour is up, but the sealed key can still get a new one without asking.
      useDrive.getState().setStatus("connecting");
      void renewQuietly().then((renewed) => {
        if (renewed) {
          useDrive.getState().setStatus("signedIn", saved?.email ?? null);
        } else {
          noteSignedOut("The saved Google sign-in had run out and could not be renewed.");
          useDrive.getState().setStatus("signedOut");
          armQuietReconnect();
        }
      });
    } else {
      localStorage.removeItem(TOKEN_KEY);
      if (wasConnected() && saved) noteSignedOut("The saved Google sign-in had run out by the time ShapeForge opened.");
    }
  } catch {
    /* nothing to restore */
  }
}

export function wasConnected(): boolean {
  try {
    return localStorage.getItem(CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Asks for permission (a popup). Must be called from a click so the browser allows the popup. */
export async function signIn(): Promise<void> {
  const drive = useDrive.getState();
  drive.setStatus("connecting");
  drive.setError(null);
  try {
    const accessToken = await requestToken(wasConnected() ? "" : "consent");
    try {
      localStorage.setItem(CONNECTED_KEY, "1");
    } catch {
      /* not remembered, so the next visit asks again */
    }
    // Google lets people untick the Drive permission; a token without it can sign in but never save anything.
    const scopes = await grantedScopes(accessToken);
    if (scopes && !scopes.includes(DRIVE_FILE_SCOPE)) {
      try {
        google()?.accounts.oauth2.revoke(accessToken, () => {});
      } catch {
        /* the grant simply stays */
      }
      signedOutByGoogle("Google signed you in but did not give ShapeForge permission to use your Drive. Connect again and tick the Google Drive box.", true);
      throw new Error("The Google Drive permission was not ticked. Click Connect again and tick the Google Drive box before clicking Continue.");
    }
    const email = await fetchEmail(accessToken);
    rememberToken(email);
    drive.setStatus("signedIn", email);
  } catch (error) {
    // A reconnect attempt that fails must not undo a sign-in that is still good.
    if (hasToken() || loadSavedToken()) {
      drive.setStatus("signedIn");
    } else {
      noteSignedOut(error instanceof Error ? error.message : "Sign-in failed.", true);
      drive.setStatus("signedOut");
    }
    drive.setError(error instanceof Error ? error.message : "Sign-in failed.");
    throw error;
  }
}

export function signOut(): void {
  const sealed = readSealed();
  if (sealed && getAuthWorkerUrl()) void callWorker("/revoke", { sealed }).catch(() => {});
  writeSealed(null);
  if (token) google()?.accounts.oauth2.revoke(token.value, () => {});
  token = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CONNECTED_KEY);
    localStorage.removeItem(SIGNOUT_KEY);
  } catch {
    /* nothing to clear */
  }
  useDrive.getState().setStatus("signedOut", null);
}

/** A valid access token, asking Google for a fresh one when the last has expired. */
export async function getAccessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  // The in-memory copy can vanish (the app's code reloaded, another tab signed in); the saved one may still be good.
  if (loadSavedToken() && token) {
    useDrive.getState().setStatus("signedIn");
    return (token as { value: string }).value;
  }
  if (await renewQuietly()) {
    useDrive.getState().setStatus("signedIn");
    return (token as unknown as { value: string }).value;
  }
  try {
    const fresh = await requestToken("");
    useDrive.getState().setStatus("signedIn");
    return fresh;
  } catch (error) {
    // Without a click the browser may refuse the popup: the person has to reconnect by hand.
    noteSignedOut(error instanceof Error ? error.message : "Google would not renew the sign-in.", true);
    useDrive.getState().setStatus("signedOut");
    armQuietReconnect();
    throw error;
  }
}

let quietArmed = false;

/** Google only opens its window from a click, so the next click anywhere quietly signs back in. */
export function armQuietReconnect(): void {
  if (quietArmed || !wasConnected()) return;
  quietArmed = true;
  const reconnect = () => {
    window.removeEventListener("pointerdown", reconnect, true);
    quietArmed = false;
    if (useDrive.getState().status === "signedOut") void signIn().catch(() => {});
  };
  window.addEventListener("pointerdown", reconnect, true);
}

/** Used when Drive itself says the sign-in was refused. */
export function signedOutByGoogle(reason?: string, askAgain = false): void {
  token = null;
  writeSealed(null);
  try {
    localStorage.removeItem(TOKEN_KEY);
    // Without the "connected" mark the next Connect shows Google's full permission screen again.
    if (askAgain) localStorage.removeItem(CONNECTED_KEY);
  } catch {
    /* nothing to clear */
  }
  noteSignedOut(reason ?? "Google Drive refused the saved sign-in (it was revoked, or the account's access was changed).");
}

/** What Google says this token may do, or null when it cannot be asked (offline, blocked). */
async function grantedScopes(accessToken: string): Promise<string[] | null> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { scope?: string };
    return (data.scope ?? "").split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

export function hasToken(): boolean {
  return !!token && Date.now() < token.expiresAt;
}
