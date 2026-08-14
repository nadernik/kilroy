import * as api from "./api.js";

const list = document.getElementById("list");
const searchWrap = document.getElementById("searchWrap");
const q = document.getElementById("q");

let rows = [];

document.getElementById("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("dash").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

function ago(iso) {
  if (!iso) return "";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Empty states that say what to do, rather than just that there's nothing. */
function empty(title, detail, action) {
  const box = el("div", "empty");
  box.append(el("b", null, title), el("span", null, detail));
  if (action) {
    const button = el("button", null, action.label);
    button.addEventListener("click", action.run);
    box.append(button);
  }
  list.replaceChildren(box);
  searchWrap.hidden = true;
}

function render(filter = "") {
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) =>
        (r.subject ?? "").toLowerCase().includes(needle) ||
        (r.recipients ?? []).join(" ").toLowerCase().includes(needle))
    : rows;

  if (!shown.length) {
    const box = el("div", "empty");
    box.append(el("b", null, needle ? "No matches" : "Nothing tracked yet"));
    box.append(el("span", null, needle
      ? "Try a different subject or address."
      : "Compose a message in Gmail — Kilroy picks it up automatically."));
    list.replaceChildren(box);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const row of shown) {
    const item = el("div", "row");
    item.append(el("div", "subject", row.subject || "(no subject)"));
    item.append(el("div", "to", (row.recipients ?? []).join(", ") || "—"));

    const meta = el("div", "meta");
    const opens = Number(row.open_count ?? 0);
    const prefetches = Number(row.prefetch_count ?? 0);
    const clicks = Number(row.click_count ?? 0);

    if (opens > 0) {
      meta.append(el("span", "pill open", `${opens} open${opens === 1 ? "" : "s"}`));
      meta.append(el("span", "when", `first ${ago(row.first_open_at)}`));
    } else if (prefetches > 0) {
      meta.append(el("span", "pill machine", "machine fetch only"));
    } else {
      meta.append(el("span", "pill", "not opened"));
    }

    if (clicks > 0) meta.append(el("span", "pill open", `${clicks} click${clicks === 1 ? "" : "s"}`));
    meta.append(el("span", "when", `sent ${ago(row.sent_at)}`));
    item.append(meta);

    // Kilroy only learns a thread id once you've viewed the thread since
    // sending, so older messages may not be clickable. Say so rather than
    // offering a link that goes nowhere.
    if (row.thread_id) {
      item.title = "Open this thread in Gmail";
      item.addEventListener("click", () => {
        chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#all/${row.thread_id}` });
      });
    } else {
      item.dataset.nothread = "true";
      item.title = "Open this thread in Gmail once to link it here";
    }

    frag.append(item);
  }

  list.replaceChildren(frag);
}

q.addEventListener("input", () => render(q.value));

(async () => {
  if (!(await api.getConfig())) {
    return empty("Not set up yet", "Point Kilroy at your Supabase project to get started.",
      { label: "Open settings", run: () => chrome.runtime.openOptionsPage() });
  }
  if (!(await api.whoAmI())) {
    return empty("Signed out", "Sign in to see which of your messages have been opened.",
      { label: "Sign in", run: () => chrome.runtime.openOptionsPage() });
  }

  try {
    rows = await api.rest("message_stats?select=*&order=sent_at.desc&limit=100") ?? [];
    if (!rows.length) {
      return empty("Nothing tracked yet",
        "Compose a message in Gmail — Kilroy picks it up automatically.");
    }
    searchWrap.hidden = rows.length < 8;  // a filter over five rows is clutter
    render();
  } catch (err) {
    empty("Couldn't load", err.message,
      { label: "Open settings", run: () => chrome.runtime.openOptionsPage() });
  }
})();
