/**
 * User-agent triage for inbound pixel hits.
 *
 * The thing to internalise: on Gmail-to-Gmail mail you are almost never talking
 * to the recipient. Google fetches every image through its own proxy, so the UA
 * and IP you see belong to Google. `proxy` records who we think fetched it;
 * `prefetch` marks fetches we believe no human triggered at all.
 */

export interface AgentVerdict {
  proxy: string | null;
  prefetch: boolean;
}

const SCANNERS = [
  "proofpoint",
  "barracuda",
  "mimecast",
  "symantec",
  "forcepoint",
  "trendmicro",
  "sophos",
  "messagelabs",
  "cloudmark",
  "urldefense",
  "virustotal",
];

const ROBOTS = [
  "bot",
  "crawler",
  "spider",
  "slurp",
  "headlesschrome",
  "python-requests",
  "go-http-client",
  "curl/",
  "wget",
  "libwww",
];

export function classifyAgent(userAgent: string | null): AgentVerdict {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return { proxy: null, prefetch: false };

  // Gmail. Expect this on the overwhelming majority of hits.
  if (ua.includes("googleimageproxy") || ua.includes("ggpht.com")) {
    return { proxy: "google", prefetch: false };
  }

  if (ua.includes("yahoomailproxy")) return { proxy: "yahoo", prefetch: false };

  if (
    ua.includes("bingpreview") ||
    ua.includes("skypeuripreview") ||
    ua.includes("microsoft office") ||
    ua.includes("ms-office")
  ) {
    return { proxy: "microsoft", prefetch: false };
  }

  // Corporate mail gateways detonate every image and link on arrival, long
  // before anyone reads the message.
  for (const s of SCANNERS) {
    if (ua.includes(s)) return { proxy: "scanner", prefetch: true };
  }
  for (const r of ROBOTS) {
    if (ua.includes(r)) return { proxy: "scanner", prefetch: true };
  }

  // Apple Mail Privacy Protection, best effort. MPP fetches through a relay
  // using a URLSession-style agent: a macOS AppleWebKit string with neither a
  // `Version/` nor a `Safari/` token, which a real Safari always carries. This
  // is a heuristic and it will miss cases — see docs/ACCURACY.md.
  if (
    ua.includes("mac os x") &&
    ua.includes("applewebkit") &&
    !ua.includes("version/") &&
    !ua.includes("safari/")
  ) {
    return { proxy: "apple", prefetch: true };
  }

  return { proxy: null, prefetch: false };
}

/** First entry of X-Forwarded-For; the rest are downstream hops we don't trust. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip");
}

/** Pull the token out of `/px/<token>.gif`, `/r/<token>`, and friends. */
export function tokenFromPath(url: string, functionName: string): string | null {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  if (!last || last === functionName) return null;
  const token = last.replace(/\.(gif|png|jpe?g|webp)$/i, "");
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
}
