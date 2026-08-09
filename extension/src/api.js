/**
 * Supabase client, hand-rolled.
 *
 * Deliberately dependency-free: GoTrue and PostgREST are both plain HTTP, and
 * writing the ~40 lines it takes to call them keeps this whole project
 * buildless — no npm, no bundler, no lockfile to age badly.
 *
 * Loaded only by the background service worker. Content scripts reach it
 * through chrome.runtime.sendMessage.
 */

const store = chrome.storage.local;

const DEFAULT_SETTINGS = {
  trackPixel: true,
  // Off by default: rewriting hrefs means the recipient sees a supabase.co URL
  // on hover instead of the real destination. Opt in per your own taste.
  trackLinks: false,
};

// ------------------------------------------------------------------ config --

export async function getConfig() {
  const { config } = await store.get("config");
  return config ?? null;
}

export async function setConfig({ url, anonKey }) {
  const clean = String(url ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(clean)) {
    throw new Error("Project URL should look like https://xxxx.supabase.co");
  }
  // Keys never contain whitespace, but copying one out of the dashboard often
  // wraps it across lines. Strip rather than let it through and fail later with
  // a baffling "Invalid API key".
  const key = String(anonKey ?? "").replace(/\s+/g, "");
  if (!key) throw new Error("Anon key is required");
  if (/^sb_secret_/.test(key) || /"role":"service_role"/.test(atobSafe(key))) {
    throw new Error("That's the secret/service_role key. It bypasses row-level security — use the publishable (anon) key.");
  }
  await store.set({ config: { url: clean, anonKey: key } });
}

/** Best-effort peek at a JWT payload, purely to catch a pasted service key. */
function atobSafe(token) {
  try {
    return atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
}

async function requireConfig() {
  const cfg = await getConfig();
  if (!cfg) throw new Error("Kilroy is not configured yet");
  return cfg;
}

/** Base URL the pixel and redirect endpoints live under. */
export async function endpointBase() {
  const cfg = await requireConfig();
  return `${cfg.url}/functions/v1`;
}

// ---------------------------------------------------------------- settings --

export async function getSettings() {
  const { settings } = await store.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await store.set({ settings: next });
  return next;
}

// -------------------------------------------------------------------- auth --

const now = () => Math.floor(Date.now() / 1000);

function normalizeSession(raw) {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at ?? now() + (raw.expires_in ?? 3600),
    email: raw.user?.email ?? null,
    user_id: raw.user?.id ?? null,
  };
}

async function readSession() {
  const { session } = await store.get("session");
  return session ?? null;
}

async function authRequest(cfg, grantType, body) {
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: cfg.anonKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Worth separating: this one is about the project key, not your password,
    // and the stock message sends people hunting for the wrong problem.
    if (res.status === 401 || /invalid api key/i.test(data.message ?? "")) {
      throw new Error(
        "Supabase rejected the API key — this is not about your password. " +
        "Check the key came from this project's API settings and wasn't truncated.",
      );
    }
    throw new Error(
      data.error_description || data.msg || data.message || `Auth failed (${res.status})`,
    );
  }
  return data;
}

export async function signIn(email, password) {
  const cfg = await requireConfig();
  const data = await authRequest(cfg, "password", { email, password });
  const session = normalizeSession(data);
  await store.set({ session });
  return session;
}

export async function signOut() {
  await store.remove("session");
}

export async function whoAmI() {
  const session = await readSession();
  return session ? { email: session.email, userId: session.user_id } : null;
}

// The service worker can be woken by several content scripts at once. Without
// this lock they would all refresh in parallel and the losers would be left
// holding a refresh token the server has already rotated away.
let refreshInFlight = null;

async function accessToken() {
  const cfg = await requireConfig();
  const session = await readSession();
  if (!session) return null;
  if (session.expires_at - 60 > now()) return session.access_token;

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const data = await authRequest(cfg, "refresh_token", {
          refresh_token: session.refresh_token,
        });
        const next = normalizeSession(data);
        await store.set({ session: next });
        return next.access_token;
      } catch (err) {
        await store.remove("session");  // token is dead; force a re-login
        throw err;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

// --------------------------------------------------------------- postgrest --

export async function rest(path, { method = "GET", body, prefer, headers = {} } = {}) {
  const cfg = await requireConfig();
  const token = await accessToken();
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      apikey: cfg.anonKey,
      authorization: `Bearer ${token}`,
      ...(prefer ? { prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? data?.hint ?? `HTTP ${res.status}`);
  return data;
}

export const rpc = (name, args) => rest(`rpc/${name}`, { method: "POST", body: args });

// ------------------------------------------------------------------ tokens --

/**
 * 16 random bytes as 22 base64url characters. Unguessable is the whole security
 * model for the pixel URL, so this must come from the CSPRNG, never Math.random.
 */
export function mintToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
