import { DRIVE_SCOPES, getClientId } from "./config";
import { useDrive } from "./state";

/* Sign-in uses Google's token flow: a popup asks for permission once, and the app then holds a
   short-lived access token (about an hour) in memory only. Nothing secret is stored; asking
   again later is silent while the person is still signed in to Google. */

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (options?: { prompt?: string }) => void };
type GoogleApi = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }) => TokenClient;
      revoke: (token: string, done?: () => void) => void;
    };
  };
};

const GIS_SRC = "https://accounts.google.com/gsi/client";
const CONNECTED_KEY = "cad.driveConnected";

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

async function requestToken(prompt: "" | "consent"): Promise<string> {
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
    drive.setStatus("signedIn", await fetchEmail(accessToken));
  } catch (error) {
    drive.setStatus("signedOut");
    drive.setError(error instanceof Error ? error.message : "Sign-in failed.");
    throw error;
  }
}

export function signOut(): void {
  if (token) google()?.accounts.oauth2.revoke(token.value, () => {});
  token = null;
  try {
    localStorage.removeItem(CONNECTED_KEY);
  } catch {
    /* nothing to clear */
  }
  useDrive.getState().setStatus("signedOut", null);
}

/** A valid access token, asking Google for a fresh one when the last has expired. */
export async function getAccessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  try {
    const fresh = await requestToken("");
    useDrive.getState().setStatus("signedIn");
    return fresh;
  } catch (error) {
    // Without a click the browser may refuse the popup: the person has to reconnect by hand.
    useDrive.getState().setStatus("signedOut");
    throw error;
  }
}

export function hasToken(): boolean {
  return !!token && Date.now() < token.expiresAt;
}
