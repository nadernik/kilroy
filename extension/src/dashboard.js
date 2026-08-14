/**
 * Full-page dashboard, inside the extension.
 *
 * It reuses the extension's session, so there is nothing to sign into here.
 * The previous standalone page needed its own email/password login, which meant
 * maintaining two identities for one tool — indefensible, and now gone.
 *
 * Data fetching and wiring only; all rendering lives in views.js.
 */

import * as api from "./api.js";
import * as views from "./views.js";

const $ = (id) => document.getElementById(id);

let messages = [];
let opens = [];
let days = 30;

function gate(message, label, run) {
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gateMsg").textContent = message;
  const button = $("gateAction");
  button.textContent = label;
  button.onclick = run;
}

function render() {
  const rows = messages.filter((m) => views.inRange(m.sent_at, days));
  const events = opens.filter(
    (o) => o.classification === "open" && views.inRange(o.opened_at, days),
  );

  views.renderTiles($("tiles"), rows);
  views.drawTimeChart($("chartTime"), events, days);
  views.drawRecipientChart($("chartWho"), rows);
  views.renderTable($("rows"), rows, selectRow);
}

/** Expand one message's raw classification history beneath its row. */
async function selectRow(tr, message) {
  const open = tr.nextElementSibling;
  if (open?.classList.contains("detail")) { open.remove(); return; }
  document.querySelectorAll("tr.detail").forEach((n) => n.remove());

  const row = document.createElement("tr");
  row.className = "detail";
  const cell = document.createElement("td");
  cell.colSpan = 7;
  const inner = document.createElement("div");
  inner.className = "inner";
  cell.append(inner);
  row.append(cell);
  tr.after(row);

  views.renderDetail(inner, [], message, { error: "Loading…" });

  try {
    const data = await api.rest(
      `messages?select=opens(opened_at,classification,reason,proxy,ip,user_agent)` +
      `&token=eq.${encodeURIComponent(message.token)}`,
    );
    const events = (data?.[0]?.opens ?? [])
      .sort((a, b) => new Date(b.opened_at) - new Date(a.opened_at));
    views.renderDetail(inner, events, message, { onLookup: api.lookupIp });
  } catch (err) {
    views.renderDetail(inner, [], message, { error: err.message });
  }
}

async function load() {
  [messages, opens] = await Promise.all([
    api.rest("message_stats?select=*&order=sent_at.desc&limit=500"),
    api.rest("opens?select=opened_at,classification&order=opened_at.desc&limit=5000"),
  ]);
  render();
}

$("range").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-days]");
  if (!button) return;
  days = Number(button.dataset.days);
  [...$("range").children].forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  render();
});

$("refresh").addEventListener("click", async () => {
  const button = $("refresh");
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    await load();
  } catch (err) {
    gate(err.message, "Open settings", () => chrome.runtime.openOptionsPage());
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
});

(async () => {
  views.initTooltip($("tip"));

  if (!(await api.getConfig())) {
    return gate(
      "Kilroy isn't pointed at a Supabase project yet.",
      "Open settings",
      () => chrome.runtime.openOptionsPage(),
    );
  }

  const me = await api.whoAmI();
  if (!me) {
    return gate(
      "You're signed out, so there's nothing to show.",
      "Sign in",
      () => chrome.runtime.openOptionsPage(),
    );
  }

  $("gate").hidden = true;
  $("app").hidden = false;
  $("who").textContent = me.email ?? "";

  try {
    await load();
  } catch (err) {
    gate(err.message, "Open settings", () => chrome.runtime.openOptionsPage());
  }
})();
