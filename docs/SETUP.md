# Setup

About fifteen minutes. Everything here fits inside Supabase's free tier.

You need: a Google account using Gmail on the web, a Supabase account, Chrome (or
any Chromium browser), and the [Supabase CLI](https://supabase.com/docs/guides/cli).

## Already set this up once? Start here

On a second (or fifth) computer there is nothing to configure:

1. `chrome://extensions` → Developer mode → **Load unpacked** → the `extension/` folder
2. Kilroy icon → Settings → **Sign in with Google**

That's it. Two things make it that short, and both are worth knowing about
because both are easy to break:

**`extension/config.local.json`** carries the project URL and publishable key, so
there is nothing to paste. It is gitignored deliberately — it names your backend
— which means it travels with the *working copy*, not with the repo. Sync the
folder (Dropbox, Syncthing, a USB stick) and it comes along; `git clone` alone
will not bring it, and the options page falls back to asking you to type it in.

**`manifest.json` has a `key` field** pinning the extension ID to
`ccgiabiiglmhioaaionkhjhcihmpampc` on every machine. Without it Chrome invents a
random ID per install, the OAuth redirect URL changes with it, and Google
sign-in dies at the last step on each new computer until you go and whitelist
the new URL. Pinned, you whitelist one URL once — Supabase → **Authentication →
URL Configuration → Redirect URLs**, add
`https://ccgiabiiglmhioaaionkhjhcihmpampc.chromiumapp.org/` — and never think
about it again. The extension's options page shows that URL with a copy button.

The private half of that key is `tools/kilroy-extension.pem`. It is only needed
to pack a `.crx`, it is gitignored, and losing it costs you nothing unless you
publish to the Web Store. Regenerating it changes the extension ID and puts you
back to whitelisting a redirect URL.

> Forking this? Generate your own key rather than inheriting this one:
> ```bash
> openssl genrsa 2048 > tools/kilroy-extension.pem
> ```
> then put the base64 of `openssl rsa -in tools/kilroy-extension.pem -pubout -outform DER`
> into `manifest.json` as `key`, and whitelist your own redirect URL. Chrome shows
> you the resulting ID as soon as you load the folder.

The rest of this document is the from-scratch path.

---

## 1. Create the Supabase project

New project, any region near you. Save the database password somewhere — you'll
want it eventually, though not for this walkthrough.

From **Project Settings → API**, note two values:

- **Project URL** — `https://<ref>.supabase.co`
- **anon / publishable key** — a long `eyJ…` string

The anon key is designed to be public. Row-level security is what protects your
data. **Never** put the `service_role` key anywhere near the extension or the
dashboard; it bypasses RLS entirely.

## 2. Create your user

**Authentication → Users → Add user → Create new user.** Use any email and
password. Tick *Auto Confirm User* so you don't have to click a confirmation
link.

This is the account you'll sign into the extension with. Kilroy is multi-tenant
by construction — RLS scopes everything to `auth.uid()` — so if you ever share
the deployment, each person's data stays theirs.

## 3. Run the schema

**SQL Editor → New query.** Run every file in `supabase/migrations/` **in
numerical order**, 0001 through 0004, one query at a time.

0001 creates the tables, the RLS policies, the `message_stats` view, and the
`record_open` / `record_click` / `note_self_view` functions. The rest are not
optional extras: 0002 narrows the self-view windows that otherwise erase genuine
opens, and 0003–0004 add the column that thread-list badges are looked up by.
Stop at 0001 and Kilroy runs, but wrongly.

Verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by 1;
```

You should see `link_clicks`, `links`, `message_stats`, `messages`, `opens`,
`self_views`.

## 4. Deploy the endpoints

From the repo root:

```bash
supabase functions deploy px --project-ref YOUR_REF --no-verify-jwt
```

```bash
supabase functions deploy r --project-ref YOUR_REF --no-verify-jwt
```

`--no-verify-jwt` is essential and not optional. These endpoints are hit by mail
clients that will never carry a JWT; if the gateway demands one, no open is ever
recorded. `supabase/config.toml` sets the same thing, so either mechanism works —
belt and braces.

Check it:

```bash
curl -sS -D - -o /dev/null https://YOUR_REF.supabase.co/functions/v1/px/TESTtoken123456789.gif
```

You want `200`, `content-type: image/gif`, and `cache-control: no-store…`. An
unknown token still returns a valid image and logs nothing — a tracking pixel
that 404s is a tracking pixel that announces itself.

## 5. Load the extension

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder

Publishing to the Chrome Web Store is optional and costs a one-time $5 developer
registration. Loading unpacked is free and works indefinitely; the only cost is a
"Developer mode extensions" nag on each browser start.

## 6. Point it at your project

Click the Kilroy icon → **Settings**, or right-click the icon → *Options*.

- Paste your **Project URL** and **anon key**, save
- Then save them to `extension/config.local.json` as
  `{"url": "https://<ref>.supabase.co", "anonKey": "sb_publishable_…"}`, so the
  next machine you load this folder on needs neither. The options page reads that
  file when nothing has been saved by hand, and shows the form as an override
- Sign in with the user from step 2
- Leave **Track opens** on. **Track link clicks** is off by default — it rewrites
  hrefs, so recipients see a `supabase.co` URL on hover. Turn it on when you want
  the stronger signal and don't mind that.

### Copying the key without corrupting it

Sounds trivial. It isn't — there are three distinct ways to get this wrong, and
each fails with an error that points somewhere else:

- **Selecting the key text in the dashboard** copies its *masked* form. The mask
  is made of U+00B7 middle dots. Use the **copy icon** beside the key, not
  select-and-copy.
- **Piping the CLI through a non-UTF-8 console** mangles those same bytes: UTF-8
  `0xC2 0xB7` decoded as CP850 becomes `┬·`, so a box-drawing character lands
  inside your key.
- **Grabbing the wrong key.** The page offers four. `sb_secret_…` and
  `service_role` bypass row-level security entirely and must never go in the
  extension. Kilroy rejects both on sight.

A bad key surfaces as `Invalid API key`, or — if it carries a non-Latin-1
character — as `Failed to read the 'headers' property from 'RequestInit': String
contains non ISO-8859-1 code point`, since HTTP headers can't hold one. Kilroy
now checks for all of these when you save, so you get a real explanation instead.

On Windows, `tools/copy-key.ps1` handles it: forces UTF-8, picks the key by its
`type` field rather than by pattern-matching text, and refuses to touch the
clipboard unless what it got is clean printable ASCII.

```powershell
.\tools\copy-key.ps1
```

## 7. Try it

Reload Gmail. Open a compose window — a **Tracking** chip appears next to Send.
Click it to disarm for that one message.

Send yourself a message from another account. Open it. Within a few seconds the
sent copy in your thread shows `✓✓ opened just now`.

If you open your *own* sent message, that should **not** count — the extension
tells the backend you're looking, and the hit is filed as `self`. That mechanism
working is the difference between a useful tracker and a noise generator.

## 8. The dashboard

Click the Kilroy icon → **Dashboard**. It opens in a tab, inside the extension,
and reuses the session you already signed in with — there is nothing further to
configure or log into.

It shows opens per day, opens by recipient, and a table of every tracked message.
Click any row to expand the raw classification history: every fetch recorded for
that message and which rule counted or discounted it. That view is the fastest
way to answer "why didn't this register as an open?" without opening the SQL
editor.

---

## Optional: sweep abandoned drafts

Every compose window you open and then discard leaves a `draft` row. They're
invisible and tiny, but if you want them gone automatically, enable `pg_cron` in
**Database → Extensions** and schedule:

```sql
select cron.schedule('kilroy-purge', '0 4 * * *', $$select public.purge_stale_drafts()$$);
```

Or just run `select public.purge_stale_drafts();` when you think of it.

## Optional: a nicer pixel URL

`https://<ref>.supabase.co/functions/v1/px/<token>.gif` works fine, but it's long
and it names your backend.

Supabase custom domains are a paid add-on. The free route is a Cloudflare Worker
on a domain you own (~$10/yr for the domain, Workers free tier covers the
traffic) that proxies `img.yourdomain.com/i/<token>.gif` to the Edge Function.
Set `X-Forwarded-For` through so open classification keeps working, then change
the base URL in the extension options.

## Free-tier caveat worth knowing

Supabase pauses free projects after **7 days with no activity**. A paused project
means pixels stop recording, silently. Ordinary use keeps it awake; a fortnight's
holiday might not. If you go quiet for a while, check the project is still
`ACTIVE_HEALTHY` before trusting a run of zeroes.

## Troubleshooting

**No chip in the compose window.** Reload Gmail after loading the extension.
Check `chrome://extensions` for content-script errors — Gmail's DOM shifts and
selectors in `content.js` occasionally need adjusting.

**Chip says "Not signed in".** Options → sign in. The session refreshes itself,
but a password change invalidates it.

**Google sign-in returns "came back without a session".** The redirect URL isn't
whitelisted. Compare the URL on the options page against
**Authentication → URL Configuration → Redirect URLs** — they must match
exactly, trailing slash included. If the URL on the options page is *not*
`https://ccgiabiiglmhioaaionkhjhcihmpampc.chromiumapp.org/`, the `key` field has
gone missing from `manifest.json` and Chrome has assigned a random ID.

**Opens never appear.** Confirm the function was deployed with `--no-verify-jwt`
and curl it as in step 4. Then check the function logs in the dashboard.

**Everything shows as `self` or `prefetch`.** Working as designed, probably —
query the `opens` table directly and read the `reason` column, then see
[ACCURACY.md](ACCURACY.md) for how to retune the windows.
