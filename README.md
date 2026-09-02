# Kilroy

Email open tracking for Gmail that reports to a Supabase project you own, and to
nobody else.

Mailtrack, Streak and the rest work fine — but every message you send passes
through someone else's server, and your recipient list becomes their asset.
Kilroy does the same job on infrastructure you control, on the free tier, for
$0/month.

> *Kilroy was here* — the mark GIs left on walls across Europe to say someone had
> passed through. That is exactly, and only, what an open event tells you.

## What it does

- Slips an invisible 1×1 pixel into messages you compose in Gmail
- Records the fetch when the message is opened, and shows ✓✓ with a count on
  the message inside Gmail
- Optionally rewrites links so you see clicks, which are a far more trustworthy
  signal than opens
- Filters out the things that fetch images but aren't people: security scanners,
  Apple's privacy prefetch, and your own client reading its own Sent mail
- Gives you a dashboard over the whole lot

## What it does *not* do

No geolocation. No device fingerprinting. No "opened in Boston on an iPhone."

Gmail fetches every image in every message through its own proxy, so the IP and
user agent that arrive belong to Google, not to your recipient. Commercial
trackers show you a city anyway. It is, for Gmail-to-Gmail mail, made up.

**[docs/ACCURACY.md](docs/ACCURACY.md) is the most important file here.** Read it
before you draw a conclusion from any single number.

## Shape of it

```
supabase/
  migrations/0001_init.sql   schema, RLS, and the three endpoint functions
  functions/px/              serves the pixel, logs and classifies the open
  functions/r/               validates a link token and redirects
extension/
  src/content.js             the Gmail half — compose hooks, badges, self-view
  src/views.js               charts and tables, free of chrome.* so it's testable
  src/mgmt.js                Management-API client for one-click setup
  src/provision.js           runs the migrations and deploys the functions
  provision/assets.js        generated: the SQL and function source, bundled
  dashboard.html             full-page dashboard, inside the extension
  options.html               setup wizard — one-click, or manual step by step
```

There is no separate web app. The dashboard lives in the extension and reuses its
session, because a tracker for one Gmail account asking you to sign in twice is
not a design, it's an apology.

No npm, no bundler, no lockfile. The Supabase client is ~40 lines of `fetch` in
[`extension/src/api.js`](extension/src/api.js) because that is all it needed to
be, and it means nothing here rots when a dependency does.

## Setup

See **[docs/SETUP.md](docs/SETUP.md)**. The short version: make an empty Supabase
project, load the extension, paste a Supabase access token, and let Kilroy build
its own backend — migrations, endpoints, and sign-in — inside that project. A
couple of minutes, and the token is discarded when it's done. The manual route
(run the SQL yourself, deploy with the CLI) is still documented for anyone who
wants it.

## A note on tracking people

Open tracking sits in a genuine grey area. Under GDPR/ePrivacy, tracking pixels
aimed at EU recipients arguably require consent; several jurisdictions take a dim
view; and plenty of people consider it rude regardless of legality. That it is
industry-standard practice is an explanation, not a defence.

Use it on your own correspondence, at your own discretion, and know what you're
doing. Kilroy makes it easy to turn off per-message from the chip beside Send —
that button exists for a reason.

## Licence

MIT. See [LICENSE](LICENSE).
