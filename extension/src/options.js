import * as api from "./api.js";

const $ = (id) => document.getElementById(id);

function setStep(id, state, detail) {
  const step = $(`step-${id}`);
  step.dataset.state = state;
  step.querySelector("[data-status]").textContent = detail;
  step.querySelector(".dot").textContent =
    state === "ok" ? "✓" : state === "bad" ? "!" : step.querySelector(".dot").textContent;
}

function say(el, text, kind = "") {
  el.textContent = text;
  el.className = `msg ${kind}`;
}

/**
 * Run every check and reflect it in the stepper.
 *
 * Ordered deliberately: each step's failure makes the ones below it
 * meaningless, so a single glance shows the first thing actually worth fixing
 * rather than a wall of red.
 */
async function runChecks() {
  $("summary").textContent = "Checking setup…";
  for (const id of ["project", "schema", "functions", "auth"]) {
    const step = $(`step-${id}`);
    step.dataset.state = "busy";
    step.querySelector("[data-status]").textContent = "Checking…";
  }

  const project = await api.checkProject();
  setStep("project", project.ok ? "ok" : "bad", project.detail);

  if (!project.ok) {
    for (const id of ["schema", "functions", "auth"]) {
      setStep(id, "bad", "Waiting on step 1.");
    }
    $("summary").textContent = "Start at step 1.";
    return;
  }

  const [schema, functions, auth] = await Promise.all([
    api.checkSchema(),
    api.checkFunctions(),
    api.checkAuth(),
  ]);

  setStep("schema", schema.ok ? "ok" : "bad", schema.detail);
  setStep("functions", functions.ok ? "ok" : "bad", functions.detail);
  setStep("auth", auth.ok ? "ok" : "bad", auth.detail);

  $("schemaHelp").hidden = schema.ok;
  $("functionsHelp").hidden = functions.ok;

  const signedIn = auth.ok;
  $("signedIn").hidden = !signedIn;
  $("signedOut").hidden = signedIn;
  if (signedIn) $("who").textContent = (await api.whoAmI())?.email ?? "unknown";

  const failed = [schema, functions, auth].filter((c) => !c.ok).length;
  $("summary").textContent = failed === 0
    ? "Everything is set up. Reload Gmail and compose a message."
    : `${failed} step${failed === 1 ? "" : "s"} still to do.`;
}

async function loadForm() {
  const config = await api.getConfig();
  if (config) {
    $("url").value = config.url;
    $("anon").value = config.anonKey;
    const ref = config.url.replace(/^https:\/\//, "").split(".")[0];
    $("callbackUrl").textContent = `https://${ref}.supabase.co/auth/v1/callback`;
  }

  try {
    $("redirectUrl").textContent = api.redirectUrl();
  } catch {
    $("redirectUrl").textContent = "Unavailable — reload the extension.";
  }

  const settings = await api.getSettings();
  $("trackPixel").checked = settings.trackPixel;
  $("trackLinks").checked = settings.trackLinks;
}

// ------------------------------------------------------------------ wiring --

$("saveProject").addEventListener("click", async () => {
  say($("projectMsg"), "");
  try {
    await api.setConfig({ url: $("url").value, anonKey: $("anon").value });
    await loadForm();
    await runChecks();
  } catch (err) {
    say($("projectMsg"), err.message, "bad");
    setStep("project", "bad", "Not saved.");
  }
});

$("copyRedirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("redirectUrl").textContent);
  $("copyRedirect").textContent = "Copied";
  setTimeout(() => { $("copyRedirect").textContent = "Copy"; }, 1500);
});

$("google").addEventListener("click", async () => {
  const button = $("google");
  button.disabled = true;
  say($("authMsg"), "Opening Google…");
  try {
    await api.signInWithGoogle();
    say($("authMsg"), "");
    await runChecks();
  } catch (err) {
    say($("authMsg"), err.message, "bad");
  } finally {
    button.disabled = false;
  }
});

$("signIn").addEventListener("click", async () => {
  const button = $("signIn");
  button.disabled = true;
  say($("authMsg"), "Signing in…");
  try {
    await api.signIn($("email").value.trim(), $("password").value);
    $("password").value = "";
    say($("authMsg"), "");
    await runChecks();
  } catch (err) {
    say($("authMsg"), err.message, "bad");
  } finally {
    button.disabled = false;
  }
});

$("signOut").addEventListener("click", async () => {
  await api.signOut();
  await runChecks();
});

for (const key of ["trackPixel", "trackLinks"]) {
  $(key).addEventListener("change", async (e) => {
    await api.setSettings({ [key]: e.target.checked });
    say($("prefsMsg"), "Saved. Reload Gmail for it to take effect.", "ok");
  });
}

$("recheck").addEventListener("click", runChecks);

(async () => {
  await loadForm();
  await runChecks();
})();
