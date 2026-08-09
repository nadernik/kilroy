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
    recipientInputs: 'input[name="to"], input[name="cc"], input[name="bcc"]',
    recipientChips: "[data-hovercard-id]",
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

    const dot = document.createElement("span");
    dot.className = "kilroy-chip__dot";
    const label = document.createElement("span");
    label.className = "kilroy-chip__label";
    chip.append(dot, label);

    send.parentElement.insertBefore(chip, send.nextSibling);
    return chip;
  }

  function paintChip(chip, armed, note) {
    if (!chip) return;
    chip.dataset.armed = String(armed);
    chip.querySelector(".kilroy-chip__label").textContent = armed ? "Tracking" : "Not tracked";
    chip.title = note ?? (armed
      ? "Kilroy will tell you when this is opened. Click to turn off."
      : "Click to track this message.");
  }

  function readRecipients(root) {
    const out = new Set();

    root.querySelectorAll(SEL.recipientInputs).forEach((input) => {
      String(input.value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((addr) => out.add(addr));
    });

    // Newer chip UI keeps the address on the chip itself.
    root.querySelectorAll(SEL.recipientChips).forEach((chip) => {
      const addr = chip.getAttribute("data-hovercard-id");
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
      ask("markSent", {
        token,
        subject: root.querySelector(SEL.subject)?.value ?? "",
        recipients: readRecipients(root),
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
      const mark = document.createElement("span");
      mark.className = "kilroy-badge__mark";
      const text = document.createElement("span");
      text.className = "kilroy-badge__text";
      badge.append(mark, text);
      host.appendChild(badge);
    }

    const opens = Number(row?.open_count ?? 0);
    const prefetches = Number(row?.prefetch_count ?? 0);
    const clicks = Number(row?.click_count ?? 0);

    let state = "unopened";
    let mark = "✓";
    let text = "sent";

    if (opens > 0) {
      state = "opened";
      mark = "✓✓";
      text = opens === 1 ? `opened ${ago(row.first_open_at)}` : `${opens} opens · ${ago(row.last_open_at)}`;
    } else if (prefetches > 0) {
      state = "prefetch";
      text = "delivered — machine fetch only";
    }

    if (clicks > 0) text += ` · ${clicks} click${clicks === 1 ? "" : "s"}`;

    badge.dataset.state = state;
    badge.querySelector(".kilroy-badge__mark").textContent = mark;
    badge.querySelector(".kilroy-badge__text").textContent = text;
    badge.title = prefetches > 0 && opens > 0
      ? `${prefetches} machine fetch(es) discounted — see docs/ACCURACY.md`
      : "";
  }

  let lastBeat = 0;

  /**
   * Two jobs at once: tell the backend you're looking at these messages (so its
   * own fetch of the pixel doesn't get counted as the recipient opening it),
   * and paint the current numbers onto the thread.
   */
  async function pulse() {
    if (document.hidden) return;

    const rendered = renderedTokens();
    if (!rendered.size) return;
    if (Date.now() - lastBeat < 4_000) return;
    lastBeat = Date.now();

    const tokens = [...rendered.keys()];
    const threadId = currentThreadId();

    // Order matters: claim the view before asking for numbers, so a proxy fetch
    // racing us gets reclassified rather than counted.
    await ask("selfView", { tokens, threadId });

    const stats = await ask("stats", { tokens });
    if (!stats.ok) return;

    const byToken = new Map((stats.rows ?? []).map((r) => [r.token, r]));
    for (const [token, img] of rendered) paintBadge(img, byToken.get(token));
  }

  // --------------------------------------------------------------- driver --

  const scan = debounce(() => {
    document.querySelectorAll(SEL.composeBody).forEach((el) => {
      instrumentCompose(el).catch(() => {});
    });
    pulse().catch(() => {});
  }, 400);

  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scan();
  });
  window.addEventListener("hashchange", scan);
  setInterval(() => pulse().catch(() => {}), 12_000);

  scan();
})();
