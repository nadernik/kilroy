/**
 * Supabase Management API client, for one-click setup.
 *
 * This is a SEPARATE credential from everything else Kilroy holds. The
 * publishable key in api.js is public and read-mostly; the token here is a
 * personal access token that can do anything the account can, so it is treated
 * accordingly: kept only while setup is running, never written beside the
 * project config, and cleared the moment provisioning succeeds.
 *
 * It exists for exactly one job — turning a blank Supabase project into a
 * Kilroy backend without a CLI or the SQL editor — and nothing at runtime uses
 * it. Once setup is done the extension talks only to the project, as before.
 */

const BASE = "https://api.supabase.com";
const store = chrome.storage.session ?? chrome.storage.local;

// Session storage clears when the browser closes, which is the right lifetime
// for a setup token: long enough to finish, gone by the next launch. Falls
// back to local where session storage isn't exposed.
export async function setToken(token) {
  const clean = String(token ?? "").trim();
  if (!/^sbp_[a-f0-9]{40,}$/i.test(clean)) {
    throw new Error(
      "That doesn't look like a Supabase access token. They start with " +
      "\"sbp_\" and come from supabase.com/dashboard/account/tokens.",
    );
  }
  await store.set({ mgmtToken: clean });
}

export async function getToken() {
  const { mgmtToken } = await store.get("mgmtToken");
  return mgmtToken ?? null;
}

export async function clearToken() {
  await store.remove("mgmtToken");
}

export async function hasToken() {
  return Boolean(await getToken());
}

async function call(path, { method = "GET", body, raw } = {}) {
  const token = await getToken();
  if (!token) throw new Error("No Supabase access token set.");

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.parse(text).message ?? detail; } catch { /* text as-is */ }
    if (res.status === 401) {
      throw new Error("Supabase rejected the access token. Generate a fresh one and paste it again.");
    }
    throw new Error(`Supabase API ${res.status}: ${String(detail).slice(0, 300)}`);
  }
  if (raw) return text;
  return text ? JSON.parse(text) : null;
}

/** Projects the token can see, newest first, shaped for a picker. */
export async function listProjects() {
  const rows = await call("/v1/projects");
  return (rows ?? [])
    .map((p) => ({
      ref: p.id ?? p.ref,
      name: p.name,
      region: p.region,
      status: p.status,
      createdAt: p.created_at,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * The publishable (anon) key for a project — the one thing the extension needs
 * to save, and the one the setup wizard otherwise asks you to copy by hand.
 * Prefers the modern publishable key, falls back to the legacy anon JWT.
 */
export async function anonKey(ref) {
  const keys = await call(`/v1/projects/${ref}/api-keys`);
  const publishable = keys.find((k) => k.type === "publishable");
  const legacy = keys.find((k) => k.id === "anon" || k.name === "anon");
  const chosen = publishable ?? legacy;
  if (!chosen?.api_key) throw new Error("Couldn't read a publishable key for that project.");
  return chosen.api_key;
}

/** Run one SQL statement block against the project's database. */
export async function runSql(ref, sql) {
  return call(`/v1/projects/${ref}/database/query`, { method: "POST", body: { query: sql } });
}

/**
 * Create or update one Edge Function, carrying its verify_jwt setting.
 *
 * Idempotent so setup can be re-run: a slug that already exists is PATCHed
 * rather than colliding. The mail endpoints must deploy with verify_jwt=false
 * or a client with no login token is turned away and no open is ever recorded.
 */
export async function deployFunction(ref, { slug, source, verify_jwt }) {
  const exists = await call(`/v1/projects/${ref}/functions/${slug}`)
    .then(() => true)
    .catch(() => false);

  const q = `slug=${encodeURIComponent(slug)}&verify_jwt=${verify_jwt ? "true" : "false"}`;
  if (exists) {
    return call(`/v1/projects/${ref}/functions/${slug}?${q}`, {
      method: "PATCH",
      body: { name: slug, body: source, verify_jwt },
    });
  }
  return call(`/v1/projects/${ref}/functions?${q}`, {
    method: "POST",
    body: { slug, name: slug, body: source, verify_jwt },
  });
}

export async function getAuthConfig(ref) {
  return call(`/v1/projects/${ref}/config/auth`);
}

export async function updateAuthConfig(ref, patch) {
  return call(`/v1/projects/${ref}/config/auth`, { method: "PATCH", body: patch });
}

/** The project's public REST/Auth base, derived from its ref. */
export function projectUrl(ref) {
  return `https://${ref}.supabase.co`;
}
