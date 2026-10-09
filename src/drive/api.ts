/**
 * A small client for the parts of the Google Drive v3 REST API ShapeForge needs.
 *
 * Everything the app stores is tagged with a custom property (`shapeforge=1`) so it can be found
 * again with one query. With the narrow `drive.file` permission Drive only shows the app the files
 * it made itself, so that query never sees anything else in a person's Drive.
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const APP_TAG = { key: "shapeforge", value: "1" } as const;

export type DriveKind = "root" | "assets" | "folder" | "design" | "blob";

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  appProperties?: Record<string, string>;
};

export class DriveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "DriveError";
  }
}

/** The access token was refused (expired or revoked); the caller should sign in again. */
export class DriveAuthError extends DriveError {
  constructor(message = "Google Drive needs you to sign in again.") {
    super(401, message);
    this.name = "DriveAuthError";
  }
}

export type DriveFetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,mimeType,parents,modifiedTime,appProperties";

/** Drive wants thumbnails as URL-safe base64 with no padding. */
export function toUrlSafeBase64(dataUrl: string): { image: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], image: match[2].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}

export type UploadOptions = {
  /** Present to replace the contents of an existing file instead of making a new one. */
  fileId?: string;
  name: string;
  parentId?: string;
  mimeType: string;
  body: string | ArrayBuffer;
  kind: DriveKind;
  properties?: Record<string, string>;
  /** A preview picture as a data URL; Drive then shows it for the file too. */
  thumbnail?: string | null;
};

export class DriveApi {
  private getToken: () => Promise<string>;
  private doFetch: DriveFetch;

  constructor(getToken: () => Promise<string>, doFetch: DriveFetch = (url, init) => fetch(url, init)) {
    this.getToken = getToken;
    this.doFetch = doFetch;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getToken();
    const res = await this.doFetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new DriveAuthError();
    if (!res.ok) throw new DriveError(res.status, `Google Drive said ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  private tag(kind: DriveKind, extra: Record<string, string> = {}): Record<string, string> {
    return { [APP_TAG.key]: APP_TAG.value, kind, ...extra };
  }

  /** Every file and folder ShapeForge has made, across all pages of results. */
  async listAll(): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `appProperties has { key='${APP_TAG.key}' and value='${APP_TAG.value}' } and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.request(`${API}?${params}`);
      const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFolder(name: string, parentId: string | undefined, kind: "root" | "assets" | "folder", properties: Record<string, string> = {}): Promise<DriveFile> {
    const res = await this.request(`${API}?fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        ...(parentId ? { parents: [parentId] } : {}),
        appProperties: this.tag(kind, properties),
      }),
    });
    return (await res.json()) as DriveFile;
  }

  /** Creates a file, or replaces an existing one's contents, in a single request. */
  async upload(opts: UploadOptions): Promise<DriveFile> {
    const thumb = opts.thumbnail ? toUrlSafeBase64(opts.thumbnail) : null;
    const metadata: Record<string, unknown> = {
      name: opts.name,
      mimeType: opts.mimeType,
      appProperties: this.tag(opts.kind, opts.properties),
      ...(thumb ? { contentHints: { thumbnail: thumb } } : {}),
    };
    if (!opts.fileId && opts.parentId) metadata.parents = [opts.parentId];

    const boundary = `shapeforge-${Math.random().toString(36).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${opts.mimeType}\r\n\r\n`,
      opts.body,
      `\r\n--${boundary}--`,
    ]);
    const url = opts.fileId
      ? `${UPLOAD}/${opts.fileId}?uploadType=multipart&fields=${FIELDS}`
      : `${UPLOAD}?uploadType=multipart&fields=${FIELDS}`;
    const res = await this.request(url, {
      method: opts.fileId ? "PATCH" : "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()) as DriveFile;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const res = await this.request(`${API}/${fileId}?fields=${FIELDS}`);
    return (await res.json()) as DriveFile;
  }

  async downloadText(fileId: string): Promise<string> {
    return (await this.request(`${API}/${fileId}?alt=media`)).text();
  }

  async downloadBytes(fileId: string): Promise<ArrayBuffer> {
    return (await this.request(`${API}/${fileId}?alt=media`)).arrayBuffer();
  }

  /** Renames and/or moves a file or folder without touching its contents. */
  async updateMetadata(fileId: string, change: { name?: string; addParent?: string; removeParent?: string }): Promise<DriveFile> {
    const params = new URLSearchParams({ fields: FIELDS });
    if (change.addParent) params.set("addParents", change.addParent);
    if (change.removeParent) params.set("removeParents", change.removeParent);
    const res = await this.request(`${API}/${fileId}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(change.name ? { name: change.name } : {}),
    });
    return (await res.json()) as DriveFile;
  }

  /** Moves to Drive's bin, so a deletion by mistake can still be undone from Drive itself. */
  async trash(fileId: string): Promise<void> {
    await this.request(`${API}/${fileId}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
    });
  }
}
