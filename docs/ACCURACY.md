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
