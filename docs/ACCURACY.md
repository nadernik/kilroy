# What the numbers actually mean

An open event is not a person reading your email. It is *an HTTP request for an
image*. Everything below is about the distance between those two things.

Read this once and the dashboard becomes genuinely useful. Skip it and you will
draw confident conclusions from noise.

## The one that matters most: Gmail proxies everything

Gmail never lets a recipient's browser talk to your server. It fetches every
image through `googleusercontent.com` and serves a cached copy.

So for a Gmail recipient:

| You might expect | You actually get |
| --- | --- |
| Recipient's IP | A Google datacentre IP |
| Recipient's device / client | `…via ggpht.com GoogleImageProxy` |
| Their city | Nothing usable |
| Every open | Reliably the first; later ones only if Google revalidates |

Kilroy sends `Cache-Control: no-store` precisely to push Google into
re-requesting, and in practice repeat opens do come through — but repeat counts
are a *floor*, never a total. If it says three opens, it means at least three.

This is why there is no map in this project. A map would be a lie.

## False positives

**Apple Mail Privacy Protection.** On by default since iOS 15. Apple fetches
every image in every message *on delivery*, through a relay, whether or not the
recipient ever opens it. An Apple Mail recipient will look like they opened your
message within minutes, forever, regardless of the truth.

Kilroy guesses at MPP from the user agent — Apple's relay uses a macOS
AppleWebKit string with no `Version/` or `Safari/` token, which a real Safari
always carries — and marks those `prefetch`. It is a heuristic. It will miss.

**Corporate mail gateways.** Proofpoint, Mimecast, Barracuda and friends detonate
every image and link on arrival to check for malware. Matched by user agent and
marked `prefetch`. This also means link clicks from corporate recipients can be
the scanner clicking, not the human.

**You, reading your own Sent mail.** Your Gmail fetches your pixel exactly like a
recipient's would. Untreated this is the single largest source of garbage in a
tracker like this.

Kilroy's answer: while you have a tracked message on screen, the extension calls
`note_self_view`, which both records that you're looking *and* reaches back
twenty seconds to reclassify anything already logged. Google's proxy fetch often
lands a beat before the extension notices the thread rendered, hence the reach
back.

**The moment after you hit send.** Anything arriving within 45 seconds of send is
marked `prefetch`. Nobody reads that fast; that window is your own client and
the delivery pipeline.

## False negatives

- **Images off.** No fetch, no data. You cannot distinguish "read with images
  disabled" from "never opened". Both look identical: silence.
- **Plain-text and preview panes.** Many clients render enough to read without
  loading remote content.
- **Spam.** If it never lands, it never opens. An unopened message is not
  evidence of being ignored.

## How to read a row

| What you see | What it supports |
| --- | --- |
| `✓✓ 3 opens` | It was opened. Probably more than once. Timing is good. |
| `machine fetch only` | It was *delivered*. Says nothing about being read. |
| `✓ sent, not opened` | Weak evidence. Images-off recipients look like this. |
| Any click | Strong. Someone (or a scanner) actually followed a link. |

First-open **time** is the most reliable field in the whole system. Open
**counts** are a lower bound. "Not opened" is the weakest signal here — treat it
as absence of evidence, not evidence of absence.

## Which recipient opened it

For a message with one recipient: that person, trivially. For more than one:
**unknowable**, and the dashboard says so rather than guessing.

One pixel is embedded in one message body, and every recipient receives the same
body. A fetch therefore identifies the *message*, never which of its recipients
triggered it. Trackers that show a per-recipient breakdown of a group email are
either sending a separate copy per person, or inferring.

If you need per-recipient attribution, the honest way is to send individually so
each copy carries its own token — at the cost of turning one thread into several.

## The address, and looking it up

Kilroy stores the address every fetch came from, and the dashboard can look up
its location on demand. Both are more limited than they sound.

For a Gmail recipient the address belongs to **Google**. For Apple Mail with
privacy protection, **Apple**. For a corporate recipient, often their **security
gateway**. Geolocating any of those tells you where that company's servers are.
The dashboard labels the result accordingly — "where Google's image proxy sits,
not where the reader is" — because the number on its own invites exactly the wrong
reading.

The one case where an address means something is a fetch with **no proxy
detected**: the mail client came to us directly, so the address plausibly belongs
to whoever read it. Those rows are marked as such.

Lookups are never automatic. Each one is a button press, because the request
hands that address to a third-party service (`ipwho.is`), and on a direct fetch
that address may be a real person's. Results are cached per address, so the same
one is never sent twice.

A demonstration of the whole problem: Google's proxy, Apple's relay, and Google's
public DNS all resolve to *San Jose, California*. That is where the datacentres
are. If a tracker ever shows you a recipient's city with confidence, this is the
number it is showing you.

The service is a single constant, `GEO_ENDPOINT` in `extension/src/api.js`. These
free endpoints change their terms without notice — `ipapi.co` and `ip-api.com`
were both tried first and rejected the request outright — so if lookups start
failing, swapping it is a one-line edit plus a matching entry in the manifest's
`host_permissions`.

## Classification reference

Every row in `opens` carries one of these, with a `reason`:

| Class | Meaning |
| --- | --- |
| `open` | Survived every filter. Counted. |
| `prefetch` | Machine fetch — scanner UA, suspected MPP, or inside the post-send window. |
| `self` | You had the thread open. |
| `dup` | Collapsed into a hit less than 15 seconds old. |

Only `open` reaches `message_stats.open_count`. Nothing is deleted, so if you
suspect the filters are wrong you can query `opens` directly and judge for
yourself:

```sql
select o.classification, o.reason, o.proxy, o.user_agent, o.opened_at
from opens o
join messages m on m.id = o.message_id
where m.token = 'PASTE_TOKEN'
order by o.opened_at;
```

## Tuning

The windows are constants in `record_open` in `0001_init.sql`:

- **15s** dup collapse
- **25s** self-view lookback
- **20s** self-view reach-back in `note_self_view`
- **45s** post-send grace

Widen the grace window if your own sends keep registering as opens. Narrow it if
you correspond with people who genuinely reply within a minute and you're losing
real opens to it.
