/**
 * Kilroy in Gmail.
 *
 * Design note worth reading before changing anything here: the tracking token
 * is minted when a compose window OPENS, not when you press Send. That means
 * the pixel is already in the body by send time and we never have to intercept,
 * delay, or re-dispatch Gmail's send — the single most fragile thing an
 * extension like this can do. Send-time work is one fire-and-forget PATCH that
 * flips the row from 'draft' to 'sent' and attaches subject and recipients.
 *
 * The consequence is orphan draft rows when you abandon a compose. Those are
 * cheap, invisible (message_stats filters on status = 'sent'), and swept up by
 * purge_stale_drafts().
 *
 * Gmail's DOM is unversioned and changes without notice. Every selector below
 * is written to fail soft: if we can't find something, Kilroy does nothing and
 * Gmail behaves exactly as it would without the extension installed.
 */

(() => {
  "use strict";

  const SEL = {
    composeBody: 'div[role="textbox"][g_editable="true"]',
    send: 'div[role="button"][data-tooltip^="Send"], div[role="button"][aria-label^="Send"], div.T-I.aoO[role="button"]',
    subject: 'input[name="subjectbox"]',
    // Current Gmail has NO input[name="to"]. The address fields carry an
    // aria-label and no name at all, which is why recipients came back empty
    // on every message. Keep the named variants for older builds.
    recipientInputs: 'input[name="to"], input[name="cc"], input[name="bcc"], ' +
                     'input[aria-label="To recipients"], input[aria-label="Cc recipients"], ' +
                     'input[aria-label="Bcc recipients"]',
    recipientChips: "[data-hovercard-id], [email]",
  };

  const TOKEN_IN_URL = /\/px\/([A-Za-z0-9_-]{16,64})\.gif/;

  // ------------------------------------------------------------- plumbing --

  function ask(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          // Fires when the extension is reloaded out from under this page.
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: chrome.runtime.lastError.message });
          }
          resolve(res ?? { ok: false, error: "no response" });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function debounce(fn, ms) {
    let t = 0;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /**
   * Leading-edge throttle: runs immediately, then at most once per `ms`.
   *
   * Not interchangeable with debounce here. Gmail rewrites its DOM more or less
   * continuously, so a trailing-edge debounce on a MutationObserver waits for a
   * quiet period that may never arrive — the callback starves, and the UI only
   * catches up on the fallback interval. Throttling reacts on the first
   * mutation and stays bounded after that.
   */
  function throttle(fn, ms) {
    let last = 0;
    let timer = 0;
    return (...args) => {
      const wait = ms - (Date.now() - last);
      if (wait <= 0) {
        last = Date.now();
        fn(...args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = 0;
          last = Date.now();
          fn(...args);
        }, wait);
      }
    };
  }

  function ago(iso) {
    if (!iso) return "";
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  let statusCache = null;
  let statusAt = 0;

  async function getStatus(force = false) {
    if (!force && statusCache && Date.now() - statusAt < 30_000) return statusCache;
    const res = await ask("status");
    if (res.ok) {
      statusCache = res;
      statusAt = Date.now();
    }
    return statusCache;
  }

  /** Gmail keeps the open thread's id as the last path segment of the hash. */
  function currentThreadId() {
    const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    return parts.length >= 2 && /^[A-Za-z0-9_-]{10,}$/.test(last) ? last : null;
  }

  // -------------------------------------------------------------- compose --

  const instrumented = new WeakSet();

  /** Nearest ancestor holding both the editor and a Send button. */
  function composeRootFor(bodyEl) {
    let el = bodyEl;
    for (let i = 0; i < 14; i++) {
      el = el.parentElement;
      if (!el) return null;
      if (el.querySelector(SEL.send)) return el;
    }
    return null;
  }

  function injectPixel(bodyEl, base, token) {
    if (bodyEl.querySelector("img[data-kilroy]")) return;
    const img = document.createElement("img");
    img.src = `${base}/px/${token}.gif`;
    img.setAttribute("width", "1");
    img.setAttribute("height", "1");
    img.setAttribute("alt", "");
    img.setAttribute("data-kilroy", token);
    img.style.cssText = "width:1px;height:1px;border:0;display:block;";
    bodyEl.appendChild(img);
    // Your own browser loads this while you compose. Harmless: record_open
    // ignores any token whose row is still 'draft'.
  }

  function removePixel(bodyEl) {
    bodyEl.querySelectorAll("img[data-kilroy]").forEach((el) => el.remove());
  }

  function addChip(root) {
    const existing = root.querySelector(".kilroy-chip");
    if (existing) return existing;

    const send = root.querySelector(SEL.send);
    if (!send || !send.parentElement) return null;

    const chip = document.createElement("div");
    chip.className = "kilroy-chip";
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
    chip.textContent = "K";  // stands in for a real mark later

    send.parentElement.insertBefore(chip, send.nextSibling);
    return chip;
  }

  function paintChip(chip, armed, note) {
    if (!chip) return;
    chip.dataset.armed = String(armed);
    chip.title = note ?? (armed
      ? "Kilroy is tracking this message. Click to turn off."
      : "Kilroy is not tracking this message. Click to turn on.");
  }

  /**
   * Where the subject and address fields actually live.
   *
   * composeRootFor() returns the nearest ancestor containing a Send button,
   * which in Gmail's current compose is a toolbar wrapper *below* the header —
   * so it holds the body and the Send button but not the subject or recipient
   * rows. Reading fields from it silently yielded empty strings on every
   * message. Scope field reads to the form or dialog instead.
   */
  function fieldScopeFor(bodyEl, root) {
    // Walk up until we reach something that actually holds the header fields.
    // Measured against a live compose: the editor sits 16 levels below the
    // container that has the subject, while the Send button turns up at 14 —
    // hence the two-level gap that made every subject come back empty. There
    // is no <form> and no role="dialog" anywhere on that path, so neither is
    // usable as an anchor; only the presence of the fields themselves is.
    let el = bodyEl;
    for (let i = 0; i < 20 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelector(SEL.subject) || el.querySelector(SEL.recipientInputs)) return el;
    }
    return bodyEl.closest("form") ?? bodyEl.closest('div[role="dialog"]') ?? root;
  }

  // Gmail's compose markup is unversioned and has changed under us more than
  // once. Try progressively wider nets rather than trusting any single one.
  const SUBJECT_SELECTORS = [
    'input[name="subjectbox"]',
    'input[aria-label="Subject"]',
    'input[placeholder="Subject"]',
    // Gmail's own hidden form field, mirrored from the visible box. Last
    // resort: it can lag what you've typed, but it beats an empty string.
    'input[name="subject"]',
  ];

  function readSubject(scope) {
    // Scoped first; then document-wide, which is safe in practice because more
    // than one compose window open at once is rare.
    for (const root of [scope, document]) {
      for (const selector of SUBJECT_SELECTORS) {
        const value = root.querySelector(selector)?.value?.trim();
        if (value) return value;
      }
    }
    // Inline replies have no subject field; they inherit the thread's.
    return document.querySelector("h2.hP")?.textContent?.trim() ?? "";
  }

  function readRecipients(scope) {
    // The hidden inputs are authoritative and exist only inside a compose, so
    // widening to the document can't drag in unrelated addresses.
    for (const root of [scope, document]) {
      const out = new Set();
      root.querySelectorAll(SEL.recipientInputs).forEach((input) => {
        String(input.value ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((addr) => out.add(addr));
      });
      if (out.size) return [...out];
    }

    // Chips are a scoped-only fallback: the same attributes appear on every
    // sender in the thread list, so a document-wide sweep would invent
    // recipients wholesale.
    const out = new Set();
    scope.querySelectorAll(SEL.recipientChips).forEach((el) => {
      if (el.closest('div[role="textbox"]')) return;  // quoted reply, not a recipient
      const addr = el.getAttribute("data-hovercard-id") || el.getAttribute("email");
      if (addr && addr.includes("@")) out.add(addr);
    });
    return [...out];
  }

  function hookSend(root, bodyEl, token) {
    let fired = false;

    const fire = () => {
      if (fired) return;
      // Absent pixel means you toggled tracking off for this one. Leave the row
      // as a draft and let the sweeper collect it.
      if (!bodyEl.querySelector("img[data-kilroy]")) return;
      fired = true;
      const scope = fieldScopeFor(bodyEl, root);
      ask("markSent", {
        token,
        subject: readSubject(scope),
        recipients: readRecipients(scope),
        threadId: currentThreadId(),
      });
    };

    root.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest(SEL.send)) fire();
    }, true);

    root.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") fire();
    }, true);
  }

  function watchLinks(bodyEl, messageToken, base) {
    const sweep = debounce(async () => {
      const anchors = [...bodyEl.querySelectorAll('a[href^="http"]')].filter(
        (a) => !a.dataset.kilroy && !a.href.startsWith(base),
      );

      for (const a of anchors) {
        a.dataset.kilroy = "pending";
        const res = await ask("registerLink", {
          messageToken,
          targetUrl: a.href,
          label: (a.textContent ?? "").trim().slice(0, 120),
        });
        if (res.ok && res.token) {
          a.href = `${base}/r/${res.token}`;
          a.dataset.kilroy = res.token;
        } else {
          // Registration failed, so leave the real URL alone. An unregistered
          // token would just 404 the recipient.
          delete a.dataset.kilroy;
        }
      }
    }, 900);

    new MutationObserver(sweep).observe(bodyEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    sweep();
  }

  async function instrumentCompose(bodyEl) {
    if (instrumented.has(bodyEl)) return;

    const root = composeRootFor(bodyEl);
    if (!root) return;  // not a compose, or Gmail hasn't finished rendering it
    instrumented.add(bodyEl);

    const status = await getStatus();
    if (!status?.ok || !status.signedIn) return;

    const chip = addChip(root);

    if (!status.settings.trackPixel) {
      paintChip(chip, false, "Tracking is off in Kilroy's options.");
      return;
    }

    const draft = await ask("createDraft");
    if (!draft.ok) {
      paintChip(chip, false, `Kilroy: ${draft.error}`);
      return;
    }

    const { token } = draft;
    injectPixel(bodyEl, status.base, token);
    paintChip(chip, true);

    chip?.addEventListener("click", () => {
      const armed = chip.dataset.armed !== "true";
      if (armed) injectPixel(bodyEl, status.base, token);
      else removePixel(bodyEl);
      paintChip(chip, armed);
    });

    hookSend(root, bodyEl, token);
    if (status.settings.trackLinks) watchLinks(bodyEl, token, status.base);
  }

  // ------------------------------------------------- reading your own mail --

  /**
   * Tracked pixels currently rendered on the page. Gmail rewrites the src to a
   * googleusercontent.com proxy URL but keeps the original after a '#', so the
   * token survives and stays findable.
   *
   * Excludes img[data-kilroy] — that's a pixel we just injected into a compose
   * window, and the message hasn't been sent yet.
   */
  function renderedTokens() {
    const found = new Map();
    for (const img of document.querySelectorAll('img[src*="/px/"]')) {
      if (img.hasAttribute("data-kilroy")) continue;
      const match = TOKEN_IN_URL.exec(img.src ?? "");
      if (match) found.set(match[1], img);
    }
    return found;
  }

  /** Which Gmail account this tab is currently showing. */
  function currentAccountEmail() {
    for (const el of document.querySelectorAll('[aria-label*="@"]')) {
      const found = /[\w.+-]+@[\w.-]+\.\w{2,}/.exec(el.getAttribute("aria-label") ?? "");
      if (found) return found[0].toLowerCase();
    }
    return null;
  }

  /** Who sent the message this pixel belongs to. */
  function senderOf(img) {
    const item = img.closest('[role="listitem"]');
    const addr = item?.querySelector("span[email], .gD")?.getAttribute("email");
    return addr ? addr.toLowerCase() : null;
  }

  function badgeHostFor(img) {
    const body = img.closest(".a3s");
    const item = (body ?? img).closest('[role="listitem"]');
    return item?.querySelector(".gE") ?? item?.querySelector(".gH") ?? body ?? null;
  }

  function paintBadge(img, row) {
    const host = badgeHostFor(img);
    if (!host) return;

    let badge = host.querySelector(":scope > .kilroy-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "kilroy-badge";
      const k = document.createElement("span");
      k.className = "kilroy-badge__k";
      k.textContent = "K";
      const text = document.createElement("span");
      text.className = "kilroy-badge__text";
      badge.append(k, text);
      host.appendChild(badge);
    }

    const opens = Number(row?.open_count ?? 0);
    const prefetches = Number(row?.prefetch_count ?? 0);
    const clicks = Number(row?.click_count ?? 0);

    // On screen: the mark and a number. Everything else in the tooltip — this
    // sits in a thread header you read every day.
    let state = "unopened";
    let short = "";
    let detail = "Sent. No open recorded yet.";

    if (opens > 0) {
      state = "opened";
      short = String(opens);
      detail = opens === 1
        ? `Opened ${ago(row.first_open_at)}.`
        : `${opens} opens. First ${ago(row.first_open_at)}, last ${ago(row.last_open_at)}.`;
    } else if (prefetches > 0) {
      state = "prefetch";
      detail = "Delivered, but every fetch so far looks automated — a scanner or a privacy prefetch. Not evidence it was read.";
    }

    if (clicks > 0) {
      short = short ? `${short}·${clicks}` : `0·${clicks}`;
      detail += ` ${clicks} link click${clicks === 1 ? "" : "s"}.`;
    }
    if (prefetches > 0 && opens > 0) {
      detail += ` ${prefetches} automated fetch${prefetches === 1 ? "" : "es"} discounted.`;
    }

    badge.dataset.state = state;
    badge.querySelector(".kilroy-badge__text").textContent = short;
    badge.title = `Kilroy — ${detail}`;
  }

  // Last known numbers per token. Gmail tears down and rebuilds thread DOM
  // constantly, taking our badge with it. Without a cache the badge stays gone
  // until the next network round trip completes, which is most of what made
  // this feel sluggish — the data was already here, we just weren't drawing it.
  const statsCache = new Map();
  let lastFetch = 0;

  // Tokens whose self-view we've already reported this render.
  //
  // Gmail fetches a pixel ONCE, when the message renders — not repeatedly
  // while you read. So one claim per render is all that's ever needed, and
  // claiming continuously was actively destructive: every heartbeat reached
  // back 20s and rewrote any genuine open that had landed in the meantime.
  // Entries are dropped when a message leaves the screen, so returning to a
  // thread (a fresh render, hence a fresh fetch) claims again.
  const claimed = new Set();

  /** Redraw from cache. Synchronous and cheap; safe on every mutation. */
  function paintFromCache(rendered) {
    for (const [token, img] of rendered) paintBadge(img, statsCache.get(token));
  }

  /**
   * Tell the backend you're looking at these messages, so its own fetch of the
   * pixel isn't counted as the recipient opening it, and refresh the numbers.
   */
  async function pulse({ force = false } = {}) {
    if (document.hidden) return;

    const rendered = renderedTokens();
    if (!rendered.size) return;

    paintFromCache(rendered);
    if (!force && Date.now() - lastFetch < 1_500) return;
    lastFetch = Date.now();

    const tokens = [...rendered.keys()];

    // Only the account that SENT a message may suppress its opens.
    //
    // This content script matches mail.google.com for every account you're
    // signed into, not just the sending one. Read your own mail in a second
    // Gmail account in the same browser and, without this check, that read
    // cancels out the very open you were trying to observe. When we can
    // identify both the viewer and the sender and they differ, we are the
    // recipient here and must stay quiet.
    const account = currentAccountEmail();
    const ours = tokens.filter((token) => {
      const from = senderOf(rendered.get(token));
      return !(account && from && from !== account);
    });

    // Forget messages that have left the screen; seeing them again means a new
    // render and a new fetch to account for.
    for (const token of claimed) {
      if (!rendered.has(token)) claimed.delete(token);
    }

    // Claim only what we haven't claimed yet, and only when this tab is
    // genuinely in front of you — a Gmail tab open in a background window
    // would otherwise suppress real opens for as long as it sat there.
    const fresh = ours.filter((token) => !claimed.has(token));
    const claiming = document.hasFocus() && fresh.length;
    if (claiming) fresh.forEach((token) => claimed.add(token));

    // Both at once. These used to run in series, which doubled the wait for no
    // benefit: note_self_view reaches back a few seconds to reclassify, so it
    // doesn't need to land before the read to stay correct.
    const [, stats] = await Promise.all([
      claiming
        ? ask("selfView", { tokens: fresh, threadId: currentThreadId() })
        : Promise.resolve(null),
      ask("stats", { tokens }),
    ]);

    if (!stats?.ok) return;
    for (const row of stats.rows ?? []) statsCache.set(row.token, row);
    paintFromCache(renderedTokens());
  }

  // --------------------------------------------------------------- driver --

  const scan = throttle(() => {
    document.querySelectorAll(SEL.composeBody).forEach((el) => {
      instrumentCompose(el).catch(() => {});
    });
    pulse().catch(() => {});
  }, 250);

  const pulseNow = () => pulse({ force: true }).catch(() => {});

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pulseNow(); });
  window.addEventListener("focus", pulseNow);
  window.addEventListener("hashchange", pulseNow);
  setInterval(() => pulse().catch(() => {}), 5_000);

  scan();
})();
