/**
 * Rendering only — charts, tiles, table, drill-down.
 *
 * Deliberately free of chrome.* and fetch: every function takes plain data and
 * a host element. That keeps this file previewable outside the extension, which
 * is how the chart geometry gets checked (bar paths, tick values, label
 * overflow) instead of taken on trust.
 */

// ------------------------------------------------------------------ helpers --

export const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function ago(iso) {
  if (!iso) return "";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const fmtDate = (iso) => iso
  ? new Date(iso).toLocaleString(undefined,
      { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  : "";

const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-` +
         `${String(x.getDate()).padStart(2, "0")}`;
};

const shortDay = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Round axis maximum up, so ticks land on clean numbers. */
function niceMax(value) {
  if (value <= 4) return Math.max(1, value);
  const pow = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / (pow / 2)) * (pow / 2);
}

export const inRange = (iso, days) =>
  !days || new Date(iso).getTime() >= Date.now() - days * 86400_000;

// ----------------------------------------------------------------- tooltip --

let tip = null;

export function initTooltip(node) {
  tip = node;
  addEventListener("scroll", hideTip, { passive: true });
}

function showTip(evt, html) {
  if (!tip) return;
  tip.innerHTML = html;
  tip.style.opacity = "1";
  const box = tip.getBoundingClientRect();
  let x = evt.clientX + 14;
  let y = evt.clientY - box.height - 10;
  if (x + box.width > innerWidth - 8) x = evt.clientX - box.width - 14;
  if (y < 8) y = evt.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTip() {
  if (tip) tip.style.opacity = "0";
}

function attachTip(node, html) {
  node.addEventListener("pointermove", (e) => showTip(e, html));
  node.addEventListener("pointerleave", hideTip);
}

// ------------------------------------------------------------------- tiles --

export function renderTiles(host, rows) {
  const opened = rows.filter((m) => Number(m.open_count) > 0).length;
  const clicks = rows.reduce((a, m) => a + Number(m.click_count ?? 0), 0);
  const rate = rows.length ? Math.round((opened / rows.length) * 100) : 0;

  const tile = (value, key) => {
    const node = el("div", "tile");
    node.append(el("div", "v", String(value)), el("div", "k", key));
    return node;
  };

  host.replaceChildren(
    tile(rows.length, "tracked"),
    tile(opened, "opened"),
    tile(`${rate}%`, "open rate"),
    tile(clicks, "clicks"),
  );
}

// ------------------------------------------------------------------ charts --

/**
 * Opens per day. One series, so no legend — the card title names what's plotted.
 * Columns rather than a line: sparse daily counts, and a line through a run of
 * zeros implies a continuity that isn't in the data.
 */
export function drawTimeChart(host, events, days) {
  host.replaceChildren();

  const span = days || 30;
  const buckets = new Map();
  for (let i = span - 1; i >= 0; i--) buckets.set(dayKey(Date.now() - i * 86400_000), 0);
  for (const e of events) {
    const key = dayKey(e.opened_at);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }

  const data = [...buckets.entries()];
  if (!data.some(([, n]) => n > 0)) {
    host.append(el("p", "empty", "No confirmed opens in this range."));
    return;
  }

  const W = 720, H = 200, padL = 30, padR = 6, padT = 8, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(...data.map(([, n]) => n)));
  const band = plotW / data.length;
  // Cap thickness, and always leave the 2px surface gap between neighbours.
  const barW = Math.max(3, Math.min(24, band - 2));
  const y = (v) => padT + plotH - (v / max) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Confirmed opens per day",
  });

  const ticks = max <= 4 ? max : 4;
  for (let i = 0; i <= ticks; i++) {
    const value = Math.round((max / ticks) * i);
    svg.append(svgEl("line", {
      x1: padL, x2: W - padR, y1: y(value), y2: y(value),
      stroke: i === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1,
    }));
    const label = svgEl("text", { x: padL - 7, y: y(value) + 3.5, "text-anchor": "end" });
    label.setAttribute("class", "tick num");
    label.textContent = value;
    svg.append(label);
  }

  const every = Math.ceil(data.length / 6);

  data.forEach(([key, n], i) => {
    const x = padL + i * band + (band - barW) / 2;

    if (n > 0) {
      // 4px rounded data-end, square at the baseline.
      const h = plotH - (y(n) - padT);
      const r = Math.min(4, h, barW / 2);
      svg.append(svgEl("path", {
        d: `M${x},${padT + plotH} L${x},${y(n) + r} Q${x},${y(n)} ${x + r},${y(n)} ` +
           `L${x + barW - r},${y(n)} Q${x + barW},${y(n)} ${x + barW},${y(n) + r} ` +
           `L${x + barW},${padT + plotH} Z`,
        fill: "var(--series)",
      }));
    }

    // Hit area spans the whole band and full height — hovering never needs aim.
    const hit = svgEl("rect", {
      x: padL + i * band, y: padT, width: band, height: plotH, fill: "transparent",
    });
    attachTip(hit, `<b>${shortDay(key)}</b><br><span class="n">${n}</span> open${n === 1 ? "" : "s"}`);
    svg.append(hit);

    if (i % every === 0) {
      const t = svgEl("text", {
        x: padL + i * band + band / 2, y: H - 8, "text-anchor": "middle",
      });
      t.setAttribute("class", "tick");
      t.textContent = shortDay(key);
      svg.append(t);
    }
  });

  host.append(svg);
}

/**
 * Opens by recipient. Horizontal because addresses are long. One hue for every
 * bar — darkening by value would double-encode length as colour and spend the
 * only free channel restating what the bar already shows.
 */
export function drawRecipientChart(host, rows) {
  host.replaceChildren();

  const totals = new Map();
  for (const m of rows) {
    const n = Number(m.open_count ?? 0);
    if (!n) continue;
    for (const addr of m.recipients ?? []) totals.set(addr, (totals.get(addr) ?? 0) + n);
  }

  const data = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!data.length) {
    host.append(el("p", "empty", "No confirmed opens in this range."));
    return;
  }

  const W = 720, rowH = 30, padL = 190, padR = 44, padT = 4;
  const H = padT + data.length * rowH;
  const plotW = W - padL - padR;
  const max = niceMax(Math.max(...data.map(([, n]) => n)));
  const barH = Math.min(24, rowH - 8);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Confirmed opens by recipient",
  });

  data.forEach(([addr, n], i) => {
    const y = padT + i * rowH + (rowH - barH) / 2;
    const w = Math.max(2, (n / max) * plotW);
    const r = Math.min(4, w, barH / 2);

    // Measured: a 29-character address lands 19px from the left edge, so the cap
    // sits below that rather than at the point it starts clipping.
    const label = svgEl("text", { x: padL - 10, y: y + barH / 2 + 4, "text-anchor": "end" });
    label.setAttribute("class", "rowlabel");
    label.textContent = addr.length > 26 ? `${addr.slice(0, 25)}…` : addr;
    svg.append(label);

    svg.append(svgEl("path", {
      d: `M${padL},${y} L${padL + w - r},${y} Q${padL + w},${y} ${padL + w},${y + r} ` +
         `L${padL + w},${y + barH - r} Q${padL + w},${y + barH} ${padL + w - r},${y + barH} ` +
         `L${padL},${y + barH} Z`,
      fill: "var(--series)",
    }));

    // Value outside the bar end, so it can never be clipped by its own mark.
    const value = svgEl("text", { x: padL + w + 8, y: y + barH / 2 + 4 });
    value.setAttribute("class", "barlabel");
    value.textContent = n;
    svg.append(value);

    const hit = svgEl("rect", {
      x: 0, y: padT + i * rowH, width: W, height: rowH, fill: "transparent",
    });
    attachTip(hit, `<b>${addr}</b><br><span class="n">${n}</span> open${n === 1 ? "" : "s"}`);
    svg.append(hit);
  });

  host.append(svg);
}

// ------------------------------------------------------------------- table --

export function renderTable(host, rows, onSelect) {
  host.replaceChildren();

  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "dim", "Nothing tracked in this range.");
    td.colSpan = 7;
    tr.append(td);
    host.append(tr);
    return;
  }

  for (const m of rows) {
    const tr = el("tr", "msg");
    tr.append(el("td", "subj", m.subject || "(no subject)"));
    tr.append(el("td", "to", (m.recipients ?? []).join(", ") || "—"));

    const opens = Number(m.open_count ?? 0);
    const prefetches = Number(m.prefetch_count ?? 0);
    const cell = el("td", "num");
    if (opens > 0) cell.append(el("span", "pill open", String(opens)));
    else if (prefetches > 0) cell.append(el("span", "pill prefetch", "machine only"));
    else cell.append(el("span", "dim", "—"));
    tr.append(cell);

    tr.append(el("td", "when", fmtDate(m.first_open_at)));
    tr.append(el("td", "when", fmtDate(m.last_open_at)));
    tr.append(el("td", "num", String(m.click_count ?? 0)));
    tr.append(el("td", "when", fmtDate(m.sent_at)));

    tr.addEventListener("click", () => onSelect(tr, m));
    host.append(tr);
  }
}

/** The raw classification history for one message. */
export function renderDetail(inner, events, error) {
  inner.replaceChildren(el("h3", null, "Every fetch recorded"));

  if (error) { inner.append(el("p", "dim", error)); return; }
  if (!events.length) {
    inner.append(el("p", "dim", "Nothing has fetched this pixel yet."));
    return;
  }

  for (const e of events) {
    const line = el("div", "ev");
    line.append(el("span", "t", fmtDate(e.opened_at)));
    const wrap = el("span");
    wrap.append(el("span", `pill ${e.classification}`, e.classification));
    line.append(wrap);
    line.append(el("span", "r", e.reason ?? (e.proxy ? `via ${e.proxy}` : "counted")));
    inner.append(line);
  }
}
