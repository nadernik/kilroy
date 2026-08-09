import * as api from "./api.js";

const $ = (id) => document.getElementById(id);

function say(el, text, kind = "") {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

async function refresh() {
  const config = await api.getConfig();
  if (config) {
    $("url").value = config.url;
    $("anon").value = config.anonKey;
  }

  const me = await api.whoAmI();
  $("signedIn").hidden = !me;
  $("signedOut").hidden = Boolean(me);
  if (me) $("who").textContent = me.email ?? "(unknown)";

  const settings = await api.getSettings();
  $("trackPixel").checked = settings.trackPixel;
  $("trackLinks").checked = settings.trackLinks;
}

$("saveConfig").addEventListener("click", async () => {
  try {
    await api.setConfig({ url: $("url").value, anonKey: $("anon").value });
    say($("configMsg"), "Saved.", "ok");
  } catch (err) {
    say($("configMsg"), err.message, "bad");
  }
});

$("signIn").addEventListener("click", async () => {
  const button = $("signIn");
  button.disabled = true;
  say($("authMsg"), "Signing in…");
  try {
    await api.signIn($("email").value.trim(), $("password").value);
    $("password").value = "";
    say($("authMsg"), "Signed in.", "ok");
    await refresh();
  } catch (err) {
    say($("authMsg"), err.message, "bad");
  } finally {
    button.disabled = false;
  }
});

$("signOut").addEventListener("click", async () => {
  await api.signOut();
  say($("authMsg"), "Signed out.");
  await refresh();
});

for (const key of ["trackPixel", "trackLinks"]) {
  $(key).addEventListener("change", async (e) => {
    await api.setSettings({ [key]: e.target.checked });
    say($("settingsMsg"), "Saved. Reload Gmail for it to take effect.", "ok");
  });
}

refresh();
