# ShapeForge sign-in helper

A tiny Cloudflare Worker that lets Google Drive sign-in last weeks instead of one hour.
Google only gives out long-lived renewal keys to a server holding the app's client secret, so this
is that server. It stores nothing; renewal keys are encrypted ("sealed") before the browser keeps them.

- Code: `src/index.ts`. Settings: `wrangler.toml`.
- Deploy: `cd worker && npx wrangler deploy` (after `npx wrangler login`).
- Secrets, set once with `npx wrangler secret put NAME`:
  - `GOOGLE_CLIENT_SECRET` from Google Cloud, Google Auth Platform, Clients, ShapeForge, Add secret (shown in full only once).
  - `SEAL_KEY` 32 random bytes, base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
    Changing it makes every saved renewal key invalid (everyone signs in again).
- The app finds the worker through `DEFAULT_AUTH_WORKER_URL` in `src/drive/config.ts`
  (override with the `VITE_AUTH_WORKER_URL` build variable).
