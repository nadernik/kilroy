/**
 * GET /functions/v1/px/<token>.gif
 *
 * Serves a 1x1 transparent GIF and records the fetch. Two rules govern this
 * file: it always returns a valid image, whatever goes wrong, and it never
 * makes the caller wait on the database.
 *
 * Deploy with --no-verify-jwt (or leave verify_jwt = false in config.toml).
 */

import { classifyAgent, clientIp, tokenFromPath } from "../_shared/classify.ts";

// 42-byte 1x1 transparent GIF.
const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const HEADERS: HeadersInit = {
  "content-type": "image/gif",
  "content-length": String(PIXEL.byteLength),
  // Gmail, Apple and Outlook all cache proxied images hard. Without these you
  // record the first open of a message and then silence for ever after.
  "cache-control": "no-store, no-cache, must-revalidate, private, max-age=0",
  "pragma": "no-cache",
  "expires": "0",
  "x-content-type-options": "nosniff",
};

const image = (body: BodyInit | null) =>
  new Response(body, { status: 200, headers: HEADERS });

async function record(token: string, req: Request): Promise<void> {
  const userAgent = req.headers.get("user-agent");
  const { proxy, prefetch } = classifyAgent(userAgent);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_open`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({
      p_token: token,
      p_user_agent: userAgent,
      p_ip: clientIp(req),
      p_proxy: proxy,
      p_ua_prefetch: prefetch,
    }),
  });

  if (!res.ok) console.error("record_open failed", res.status, await res.text());
}

Deno.serve(async (req: Request) => {
  const body = req.method === "HEAD" ? null : PIXEL;

  const token = tokenFromPath(req.url, "px");
  if (!token || (req.method !== "GET" && req.method !== "HEAD")) return image(body);

  const task = record(token, req).catch((err) => console.error("record_open", err));

  // Hand back the image now and finish the insert after the response has gone
  // out. Falls back to awaiting where waitUntil isn't offered, since a dropped
  // isolate would lose the open entirely.
  // deno-lint-ignore no-explicit-any
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
  if (typeof waitUntil === "function") {
    // deno-lint-ignore no-explicit-any
    waitUntil.call((globalThis as any).EdgeRuntime, task);
  } else {
    await task;
  }

  return image(body);
});
