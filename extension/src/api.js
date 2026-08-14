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

  // The dashboard shows a shortened preview with a real U+2026 ellipsis in it.
  // Paste that and fetch() dies with "String contains non ISO-8859-1 code
  // point", because a header value can't hold it — which tells you nothing
  // about what you actually did wrong.
  if (/…|\.{3}/.test(key)) {
    throw new Error(
      "That's the dashboard's shortened preview of the key, not the key itself. " +
      "Use the copy button beside it.",
    );
  }

  // Supabase keys are base64url, plus dots in the legacy JWT form. Anything
  // else is a stray character that came along with the paste.
  const stray = key.match(/[^A-Za-z0-9._-]/);
  if (stray) {
    throw new Error(
      `The key contains ${JSON.stringify(stray[0])}, which no Supabase key does. ` +
      "Re-copy it straight from the API settings page.",
    );
  }

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

/**
 * The URL Google will hand the session back to. Supabase must have this in its
 * allowed redirect list or the flow dies at the last step, so the options page
 * shows it for copying rather than making anyone derive it from the
 * extension ID.
 */
export function redirectUrl() {
  return chrome.identity.getRedirectURL();
}

/**
 * Google sign-in through chrome.identity.
 *
 * Supabase's implicit flow hands tokens back in the URL fragment, which never
 * leaves the browser. The alternative — asking people to invent yet another
 * password for a tool that only ever watches one Gmail account — is worse in
 * every way, including security.
 */
export async function signInWithGoogle() {
  const cfg = await requireConfig();
  const redirectTo = chrome.identity.getRedirectURL();
  const authUrl =
    `${cfg.url}/auth/v1/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectTo)}`;

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (url) => {
      if (chrome.runtime.lastError || !url) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Sign-in was cancelled."));
        return;
      }
      resolve(url);
    });
  });

  const params = new URLSearchParams(new URL(responseUrl).hash.replace(/^#/, ""));

  const failure = params.get("error_description") ?? params.get("error");
  if (failure) throw new Error(decodeURIComponent(failure.replace(/\+/g, " ")));

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Google came back without a session. The usual cause is this extension's " +
      "redirect URL not being whitelisted in Supabase — see the setup step above.",
    );
  }

  // The fragment carries no identity, so ask who we just became.
  let user = {};
  try {
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.anonKey, authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) user = await res.json();
  } catch { /* identity is cosmetic; the session is what matters */ }

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Number(params.get("expires_at")) ||
                now() + Number(params.get("expires_in") ?? 3600),
    email: user?.email ?? null,
    user_id: user?.id ?? null,
  };
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

// ------------------------------------------------------------------ health --

/**
 * Setup checks, each resolving to { ok, detail }.
 *
 * Every one of these exists because the corresponding failure, left unchecked,
 * surfaces much later as something that looks unrelated: a key from the wrong
 * project reads as "Invalid API key" during sign-in, an unrun migration reads
 * as a permanently empty dashboard, and a function deployed with JWT
 * verification still on reads as opens that simply never arrive. Catching them
 * here, by name, is worth more than any amount of documentation.
 */

export async function checkProject() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, detail: "No project URL and key saved yet." };

  try {
    // /auth/v1/settings is the right probe: it accepts a publishable key and
    // reports which providers the project has enabled.
    //
    // /rest/v1/ looks like the obvious choice and is a trap — it demands a
    // SECRET key and answers 401 to a perfectly good publishable one, so it
    // reports a healthy project as a rejected key.
    const res = await fetch(`${cfg.url}/auth/v1/settings`, {
      headers: { apikey: cfg.anonKey },
    });
    if (res.status === 401) {
      return { ok: false, detail: "The project rejected this key. Is it from this project?" };
    }
    if (!res.ok) {
      return { ok: false, detail: `Project responded HTTP ${res.status}.` };
    }
    const settings = await res.json();
    return {
      ok: true,
      detail: `Reachable at ${cfg.url.replace("https://", "")}`,
      providers: settings?.external ?? {},
    };
  } catch {
    return { ok: false, detail: "Could not reach the project at all. Check the URL." };
  }
}

/**
 * Whether the Google provider is switched on.
 *
 * Note the limit: this confirms the provider is configured, not that this
 * extension's redirect URL is whitelisted. Nothing readable from here can
 * confirm that — a missing redirect URL only shows up as Google returning no
 * session, which signInWithGoogle names explicitly when it happens.
 */
export async function checkGoogle(project) {
  const p = project ?? (await checkProject());
  if (!p.ok) return { ok: false, detail: "Waiting on step 1." };
  return p.providers?.google
    ? { ok: true, detail: "Google provider enabled. Redirect URL still needs whitelisting once." }
    : { ok: false, detail: "Google provider is off — Authentication → Providers → Google." };
}

export async function checkSchema() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, detail: "Configure the project first." };

  try {
    const res = await fetch(`${cfg.url}/rest/v1/message_stats?select=token&limit=1`, {
      headers: { apikey: cfg.anonKey, authorization: `Bearer ${cfg.anonKey}` },
    });
    if (res.ok) return { ok: true, detail: "Tables, view and functions are in place." };

    const body = await res.json().catch(() => ({}));
    if (res.status === 404 || body?.code === "PGRST205") {
      return { ok: false, detail: "Schema missing — run supabase/migrations/0001_init.sql." };
    }
    return { ok: false, detail: body?.message ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, detail: "Could not query the project." };
  }
}

export async function checkFunctions() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, detail: "Configure the project first." };

  try {
    // A token that will never exist. Logs nothing, still returns an image.
    const res = await fetch(`${cfg.url}/functions/v1/px/setupprobe00000000.gif`, {
      cache: "no-store",
    });
    if (res.status === 401) {
      return {
        ok: false,
        detail: "Deployed, but demanding a JWT. Redeploy px with --no-verify-jwt.",
      };
    }
    if (res.status === 404) {
      return { ok: false, detail: "Not deployed — run: supabase functions deploy px" };
    }
    if (!(res.headers.get("content-type") ?? "").includes("image/gif")) {
      return { ok: false, detail: `Responded HTTP ${res.status}, but not with an image.` };
    }
    return { ok: true, detail: "Pixel endpoint is live and open to mail clients." };
  } catch {
    return { ok: false, detail: "Could not reach the pixel endpoint." };
  }
}

export async function checkAuth() {
  const cfg = await getConfig();
  if (!cfg) return { ok: false, detail: "Configure the project first." };

  const session = await readSession();
  if (!session) return { ok: false, detail: "Not signed in." };

  try {
    const token = await accessToken();
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.anonKey, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, detail: "Session expired — sign in again." };
    const user = await res.json();
    return { ok: true, detail: `Signed in as ${user.email ?? "unknown"}` };
  } catch {
    return { ok: false, detail: "Could not verify the session." };
  }
}

// -------------------------------------------------------------- geolocation --

const GEO_ENDPOINT = "https://ipapi.co/{ip}/json/";

/**
 * Country/city for an address, on demand.
 *
 * Never called automatically. On a Gmail or Apple fetch the address belongs to
 * their proxy and the answer describes a datacentre; on a direct fetch it may be
 * the reader's own address, and handing that to a third party is a decision the
 * user makes per click, not a background behaviour.
 *
 * Results are cached per address so the same one is never sent twice.
 */
export async function lookupIp(ip) {
  const address = String(ip ?? "").trim();
  if (!/^[0-9a-f:.]{3,45}$/i.test(address)) throw new Error("Not a usable address.");

  const key = `geo:${address}`;
  const cached = (await store.get(key))[key];
  if (cached !== undefined) return cached;

  let res;
  try {
    res = await fetch(GEO_ENDPOINT.replace("{ip}", encodeURIComponent(address)));
  } catch {
    throw new Error("Couldn't reach the lookup service.");
  }

  if (res.status === 429) throw new Error("Lookup service is rate-limiting — try later.");
  if (!res.ok) throw new Error(`Lookup failed (HTTP ${res.status}).`);

  const data = await res.json().catch(() => ({}));
  if (data?.error) throw new Error(data.reason ?? "Lookup failed.");

  const place = [data.city, data.region, data.country_name].filter(Boolean).join(", ");
  const label = place ? (data.org ? `${place} · ${data.org}` : place) : null;

  await store.set({ [key]: label });
  return label;
}

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
