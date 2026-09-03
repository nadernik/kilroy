# Privacy policy

**Kilroy Chrome extension.** Last updated 27 August 2026.

## The short version

The developer of Kilroy receives no data from you. None. There is no
analytics, no telemetry, no crash reporting, and no server operated by the
developer for this extension to talk to.

Everything Kilroy records goes to **a Supabase project you create and own**,
using credentials you supply. The developer has no access to it and no way to
obtain access.

This is unusual enough to be worth stating plainly: the reason the setup asks
you to stand up your own database is precisely so that this section can say
what it says.

## What Kilroy stores, and where

All of it is written to your own Supabase project:

| Data | Why |
| --- | --- |
| Subject and recipient addresses of messages you choose to track | So the dashboard can tell one tracked message from another |
| A random token per message | Identifies the tracking pixel; unguessable by design |
| Gmail thread and message ids | To show the open count against the right message in Gmail |
| Open events: timestamp, IP address of the fetching client, user agent, classification | The open record itself, and the basis for filtering out machine fetches |
| Link clicks, if you enable link tracking | The stronger signal that someone acted on the message |
| Your Supabase session tokens | Kept in `chrome.storage.local` on your machine so you stay signed in |

Kilroy reads the Gmail page you have open in order to place its controls and
badges, and to attach the pixel to messages you compose. It does not read,
copy, or transmit the body of your mail.

## About the people you email

If you track a message, Kilroy records the recipient addresses you sent it to
and the fetches that message's pixel receives. Those fetches are how open
tracking works, and the recipient is not asked.

That makes **you** the party responsible for that data and for the decision to
collect it. Under GDPR and ePrivacy rules, tracking pixels aimed at recipients
in the EU and UK may require their consent, and some jurisdictions take a
stricter view than others. Kilroy provides a per-message off switch beside the
Send button for exactly this reason. Whether and when to use it is your call
and your responsibility, not the developer's.

Note also what an open event does *not* contain. For a Gmail recipient the IP
address belongs to Google's image proxy, not to the reader. See
[ACCURACY.md](ACCURACY.md).

## Third-party services

- **Your Supabase project.** All storage. Governed by Supabase's terms and
  whatever region you chose.
- **Google Sign-In**, if you use it, through Supabase's OAuth flow. Kilroy
  never sees your Google password.
- **ipwho.is**, only for IP geolocation, and only when you press the lookup
  button on a specific address. It is never called automatically. Results are
  cached locally so the same address is not sent twice.

## Permissions, and why each exists

| Permission | Reason |
| --- | --- |
| `storage` | Save your project settings and session locally |
| `identity` | Google sign-in via `chrome.identity.launchWebAuthFlow` |
| `https://mail.google.com/*` | Place the tracking control and open badges in Gmail, and attach the pixel to messages you compose |
| `https://*.supabase.co/*` | Talk to your own project |
| `https://ipwho.is/*` | The manual IP lookup described above |

## Deleting your data

It is your database. Delete rows, drop tables, or delete the Supabase project
outright. Signing out of the extension clears the stored session from your
machine; removing the extension clears the rest.

## Source

Kilroy is open source under the MIT licence:
<https://github.com/RelayLabs-apps/kilroy>. Every claim on this page can be checked
against the code.

## Contact

Open an issue at <https://github.com/RelayLabs-apps/kilroy/issues>.
