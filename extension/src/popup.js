import * as api from "./api.js";

const body = document.getElementById("body");

document.getElementById("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function ago(iso) {
  if (!iso) return "";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function empty(text) {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  body.replaceChildren(div);
}

function line(className, text) {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function render(rows) {
  if (!rows.length) {
    empty("Nothing tracked yet. Compose a message in Gmail and Kilroy will pick it up.");
    return;
  }

  const list = document.createElement("ul");

  for (const row of rows) {
    const item = document.createElement("li");

    const subject = document.createElement("div");
    subject.className = "subject";
    subject.textContent = row.subject || "(no subject)";

    const to = document.createElement("div");
    to.className = "to";
    to.textContent = (row.recipients ?? []).join(", ") || "—";

    const stat = document.createElement("div");
    stat.className = "stat";

    const opens = Number(row.open_count ?? 0);
    const prefetches = Number(row.prefetch_count ?? 0);
    const clicks = Number(row.click_count ?? 0);

    if (opens > 0) {
      stat.append(line("opened", `✓✓ ${opens} open${opens === 1 ? "" : "s"}`));
      stat.append(line("cold", `first ${ago(row.first_open_at)}`));
    } else if (prefetches > 0) {
      stat.append(line("machine", "✓ machine fetch only"));
    } else {
      stat.append(line("cold", "✓ sent, not opened"));
    }

    if (clicks > 0) stat.append(line("opened", `${clicks} click${clicks === 1 ? "" : "s"}`));
    stat.append(line("cold", `sent ${ago(row.sent_at)}`));

    item.append(subject, to, stat);
    list.append(item);
  }

  body.replaceChildren(list);
}

(async () => {
  if (!(await api.getConfig())) return empty("Open Settings and point Kilroy at your Supabase project.");
  if (!(await api.whoAmI())) return empty("Open Settings and sign in.");

  try {
    const rows = await api.rest("message_stats?select=*&order=sent_at.desc&limit=30");
    render(rows ?? []);
  } catch (err) {
    empty(err.message);
  }
})();
