/**
 * Google Drive settings. The sign-in "client ID" identifies ShapeForge to Google; it is not a
 * secret (every web app ships it in its page), so it can live in the repository or be pasted
 * into the app. A value pasted in the app wins, which lets it be tried without rebuilding.
 */
const CLIENT_ID_KEY = "cad.googleClientId";

/** Narrow permission: ShapeForge only ever sees the files and folders it made itself. */
export const DRIVE_SCOPES = "openid email profile https://www.googleapis.com/auth/drive.file";

/** The visible folder created at the top of the person's Drive. */
export const APP_FOLDER_NAME = "ShapeForge";
export const ASSETS_FOLDER_NAME = "_files";

export function getClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch {
    /* storage unavailable: fall back to the built-in value */
  }
  return ((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "").trim();
}

export function setClientId(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(CLIENT_ID_KEY, trimmed);
    else localStorage.removeItem(CLIENT_ID_KEY);
  } catch {
    /* nothing to do */
  }
}

export function driveConfigured(): boolean {
  return getClientId().length > 0;
}

/** Google client IDs look like 123456789-abcdefg.apps.googleusercontent.com. */
export function looksLikeClientId(value: string): boolean {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(value.trim());
}
