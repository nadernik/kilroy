# Chrome Web Store submission kit

Everything needed to publish Kilroy as an **unlisted** listing (installable by
link, not publicly discoverable). Paste each field from here; the zip to upload
is produced by `python tools/package.py` → `dist/kilroy-<version>.zip`.

Set **Visibility → Unlisted** in the Web Store dashboard. Unlisted still goes
through the same review as public; it only removes discoverability.

---

## Store listing

**Name**

```
Kilroy
```

**Summary** (≤132 characters)

```
See when your Gmail messages are opened — reporting only to a Supabase database you own, and to nobody else.
```

**Category:** Workflow & Planning
**Language:** English

**Detailed description**

```
Kilroy tells you when the email you send in Gmail gets opened — and reports it
only to a Supabase project that you own and control. Nobody else, including the
developer, ever sees your data.

Mailtrack, Streak and the rest work fine, but every message you send passes
through someone else's server, and your recipient list becomes their asset.
Kilroy does the same job on infrastructure you control, on the free tier.

What it does
• Adds an invisible 1×1 pixel to messages you compose, and records the fetch
  when the message is opened
• Shows ✓✓ with an open count on the message inside Gmail
• Optionally rewrites links so you can see clicks — a stronger signal than opens
• Filters out the things that fetch images but aren't people: security scanners,
  Apple Mail privacy prefetch, and your own client reading your Sent mail
• Gives you a dashboard over everything

What it does NOT do
No geolocation. No device fingerprinting. No "opened in Boston on an iPhone."
Gmail fetches every image through its own proxy, so the address and user agent
that arrive belong to Google, not your recipient — Kilroy does not pretend
otherwise.

Bring your own backend
Kilroy needs a Supabase project (free tier). One-click setup builds everything
inside a project you create: paste a Supabase access token, pick your project,
and Kilroy runs the database setup and deploys its endpoints for you. The token
is used only during setup and discarded afterward. A fully manual setup is
documented too.

Open source: https://github.com/RelayLabs-apps/kilroy

A note on tracking: open tracking sits in a genuine grey area, and tracking
recipients in some jurisdictions may require their consent. Kilroy makes it easy
to turn off per message, from the chip beside Send. Use it on your own
correspondence, at your own discretion.
```

**Single purpose** (required)

```
Kilroy tells the user when the Gmail messages they send are opened, by embedding
a tracking pixel and recording the fetch in a Supabase backend that the user
owns and controls. Everything the extension does serves that one purpose.
```

**Privacy policy URL**

```
https://github.com/RelayLabs-apps/kilroy/blob/main/docs/PRIVACY.md
```

**Homepage / support URL**

```
https://github.com/RelayLabs-apps/kilroy
```

---

## Permission justifications

Paste one per permission when the dashboard asks "why do you need this?".

**storage**
```
Stores the user's own Supabase project URL, publishable key, preferences, and
login session locally so they persist between browser sessions. Nothing here is
transmitted to the developer or any third party.
```

**identity**
```
Used only for the optional "Sign in with Google" flow, via
chrome.identity.launchWebAuthFlow, against the user's own Supabase project.
Kilroy never sees the user's Google password and requests no Gmail API scopes.
Email-and-password sign-in is the default and does not use this permission.
```

**Host — https://mail.google.com/***
```
A content script adds the tracking on/off control beside Gmail's Send button,
draws open-count badges on the user's own sent messages, and inserts the 1×1
tracking pixel into messages the user composes. It does not read, copy, store,
or transmit the contents of any email.
```

**Host — https://*.supabase.co/***
```
Kilroy communicates with the user's own Supabase project — its REST API, Auth,
and the pixel/redirect Edge Functions — which lives at a per-user subdomain of
supabase.co. The wildcard is required because every user's project has a
different subdomain; the extension only ever contacts the one the user
configured.
```

**Host — https://api.supabase.com/***
```
One-click setup uses the Supabase Management API to create the database schema
and deploy the two tracking endpoints inside the user's own project, so they do
not have to run SQL or a CLI by hand. It is used only during setup, with an
access token the user pastes in, and the token is discarded when setup finishes.
```

**Host — https://ipwho.is/***
```
Optional, on-demand IP geolocation. Called only when the user clicks a lookup
button on a specific address in the dashboard, never automatically. Results are
cached locally so the same address is not sent twice.
```

---

## Data collection disclosures

Answer the dashboard's data form as follows. The key fact: **the developer
receives nothing.** All data the extension handles goes to the user's own
Supabase project.

Data the extension handles (disclose honestly):
- **Personally identifiable information** — recipient email addresses and message
  subjects of messages the user chooses to track. Written to the user's own
  Supabase project only.
- **Authentication information** — the user's Supabase session token, stored
  locally.
- **Website content** — the extension reads the Gmail page to place its controls
  and pixel, but does not collect or transmit email contents.

Certifications (all true for Kilroy):
- ☑ I do not sell or transfer user data to third parties (outside approved use cases)
- ☑ I do not use or transfer user data for purposes unrelated to the item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending
- ☑ This item complies with the Limited Use requirements

Note for review: Kilroy uses a content script on mail.google.com; it does **not**
use the Gmail API or any Google OAuth restricted scope, so Google API
restricted-scope verification does not apply. The `identity` permission targets
the user's own Supabase project's Google provider, not Gmail.

---

## Screenshots

Required: at least one at **1280×800** or **640×400** (PNG or JPEG). Recommended
three to four. The ones that sell it are the in-Gmail shots — capture those from
your live install:

1. **Compose window** with the "Tracking" chip beside Send.
2. **A sent thread** showing the ✓✓ badge and open count.
3. **The dashboard** — opens per day and the message table.
4. **One-click setup** — the options page "Set up in one click" card.
   (A rendered copy of this one is generated at
   `dist/store/options-1280x800.png` by the screenshot step; the others need
   real Gmail data and are yours to capture.)

Optional promo tile: 440×280.

---

## Before you submit

- [ ] Bump `version` in `manifest.json` if re-uploading over a previous version
- [ ] `python tools/package.py` → upload `dist/kilroy-<version>.zip`
- [ ] Confirm the uploaded manifest has **no** `key` field (package.py strips it)
- [ ] Paste every field above; set Visibility → Unlisted
- [ ] After the first upload, read the store-assigned **Item ID** — that is the
      permanent extension ID all users share. Nothing in setup needs it by hand
      anymore (provisioning writes each user's redirect URL automatically), but
      it is what a store install is keyed to.
