/**
 * GET /functions/v1/r/<token>
 *
 * Records a click and forwards to the registered destination.
 *
 * The destination is never taken from the request. It is looked up by token in
 * the `links` table, which only your own signed-in extension can write to. A
 * token nobody registered resolves to nothing and the request 404s — which is
 * what keeps this from being an open redirect anyone can point wherever they
 * like using your domain's reputation.
 *
 * Deploy with --no-verify-jwt (or leave verify_jwt = false in config.toml).
 */

import { clientIp, tokenFromPath } from "../_shared/classify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });

Deno.serve(async (req: Request) => {
  const token = tokenFromPath(req.url, "r");
  if (!token) return notFound();

  let target: unknown = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_click`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: SERVICE_KEY,
        authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        p_token: token,
        p_user_agent: req.headers.get("user-agent"),
        p_ip: clientIp(req),
      }),
    });
    if (res.ok) target = await res.json();
  } catch (err) {
    console.error("record_click", err);
  }

  if (typeof target !== "string" || !/^https?:\/\//i.test(target)) return notFound();

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "no-store, no-cache, must-revalidate",
      // Don't leak the tracking URL to the destination site.
      "referrer-policy": "no-referrer",
    },
  });
});
