import * as api from "./api.js";
import * as mgmt from "./mgmt.js";
import { provision } from "./provision.js";

const $ = (id) => document.getElementById(id);

const STEP_NUMBER = { project: "1", schema: "2", functions: "3", redirect: "4", auth: "5" };

function setStep(id, state, detail) {
  const step = $(`step-${id}`);
  step.dataset.state = state;
  step.querySelector("[data-status]").textContent = detail;
  // A step blocked by an earlier failure isn't itself broken — keep its number
  // rather than flagging it, so the one thing worth fixing stands out.
  step.querySelector(".dot").textContent =
    state === "ok" ? "✓" : state === "bad" ? "!" : STEP_NUMBER[id] ?? "";
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
  const ids = ["project", "schema", "functions", "redirect", "auth"];
  $("summary").textContent = "Checking setup…";
  for (const id of ids) {
    const step = $(`step-${id}`);
    step.dataset.state = "busy";
    step.querySelector("[data-status]").textContent = "Checking…";
  }

  const project = await api.checkProject();
  setStep("project", project.ok ? "ok" : "bad", project.detail);

  if (!project.ok) {
    for (const id of ids.slice(1)) setStep(id, "wait", "Waiting on step 1.");
    $("summary").textContent = "Start at step 1.";
    return;
  }

  const [schema, functions, google, auth] = await Promise.all([
    api.checkSchema(),
    api.checkFunctions(),
    api.checkGoogle(project),
    api.checkAuth(),
  ]);

  setStep("schema", schema.ok ? "ok" : "bad", schema.detail);
  setStep("functions", functions.ok ? "ok" : "bad", functions.detail);
  setStep("redirect", google.ok ? "ok" : "bad", google.detail);
  setStep("auth", auth.ok ? "ok" : "bad", auth.detail);

  $("schemaHelp").hidden = schema.ok;
  $("functionsHelp").hidden = functions.ok;

  const signedIn = auth.ok;
  $("signedIn").hidden = !signedIn;
  $("signedOut").hidden = signedIn;
  if (signedIn) $("who").textContent = (await api.whoAmI())?.email ?? "unknown";

  // Once you're signed in the whole setup is done; the express card is only in
  // the way. It comes back if you sign out.
  $("express").hidden = signedIn;

  const failed = [schema, functions, auth].filter((c) => !c.ok).length;
  $("summary").textContent = failed === 0
    ? "Everything is set up. Reload Gmail and compose a message."
    : `${failed} step${failed === 1 ? "" : "s"} still to do.`;
}

async function loadForm() {
  const config = await api.getConfig();
  const bundled = await api.configIsBundled();

  // With a bundled project there is nothing to type, so the form collapses to a
  // disclosure and the step reads as done rather than as a chore not yet started.
  $("bundledNote").hidden = !bundled;
  $("projectForm").open = !bundled;
  $("useBundled").hidden = bundled || !(await api.hasBundledConfig());
  if (bundled) $("bundledUrl").textContent = config.url.replace("https://", "");

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

$("useBundled").addEventListener("click", async () => {
  say($("projectMsg"), "");
  await api.clearConfig();
  await loadForm();
  await runChecks();
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

// ---------------------------------------------------------- express setup --

$("showManual").addEventListener("click", (e) => {
  e.preventDefault();
  $("manualWrap").hidden = false;
  $("showManual").parentElement.hidden = true;
  $("manualWrap").scrollIntoView({ behavior: "smooth" });
});

$("findProjects").addEventListener("click", async () => {
  const button = $("findProjects");
  button.disabled = true;
  say($("expMsg"), "Reading your projects…");
  try {
    await mgmt.setToken($("mgmtToken").value);
    const projects = await mgmt.listProjects();
    if (!projects.length) {
      say($("expMsg"), "No projects on that account yet. Create an empty one first, then try again.", "bad");
      return;
    }
    const select = $("projectPick");
    select.textContent = "";
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p.ref;
      // Region and status help tell two similarly-named projects apart, and
      // flag one that isn't finished spinning up yet.
      opt.textContent = `${p.name} — ${p.region}${p.status && p.status !== "ACTIVE_HEALTHY" ? ` (${p.status})` : ""}`;
      select.appendChild(opt);
    }
    $("projectPickWrap").hidden = false;
    say($("expMsg"), "");
  } catch (err) {
    say($("expMsg"), err.message, "bad");
  } finally {
    button.disabled = false;
  }
});

$("provision").addEventListener("click", async () => {
  const button = $("provision");
  button.disabled = true;
  $("findProjects").disabled = true;

  const list = $("provStatus");
  list.hidden = false;
  list.textContent = "";
  const rows = new Map();
  const onStep = ({ n, of, label, state, error }) => {
    let li = rows.get(n);
    if (!li) { li = document.createElement("li"); list.appendChild(li); rows.set(n, li); }
    const mark = state === "ok" ? "✓" : state === "bad" ? "✗" : "…";
    li.textContent = `${mark} ${label}${error ? ` — ${error}` : ""}`;
    li.style.color = state === "bad" ? "var(--critical)" : state === "ok" ? "var(--good)" : "var(--text-2)";
  };

  say($("expMsg"), "Setting up… this can take a few seconds per step.");
  try {
    await provision($("projectPick").value, onStep);
    say($("expMsg"), "Backend ready. Create your login to finish.", "ok");
    $("expLogin").hidden = false;
    $("expEmail").focus();
    await loadForm();
    await runChecks();  // reflect the now-green manual steps too
  } catch (err) {
    say($("expMsg"), err.message, "bad");
    // The token may still be needed for a retry, so it is not cleared on failure.
    $("findProjects").disabled = false;
  } finally {
    button.disabled = false;
  }
});

$("expCreate").addEventListener("click", async () => {
  const button = $("expCreate");
  button.disabled = true;
  say($("expMsg"), "Creating your login…");
  try {
    await api.signUp($("expEmail").value.trim(), $("expPass").value);
    $("expPass").value = "";
    say($("expMsg"), "All set. Reload Gmail and compose a message — a Tracking chip appears by Send.", "ok");
    await runChecks();
  } catch (err) {
    say($("expMsg"), err.message, "bad");
  } finally {
    button.disabled = false;
  }
});

(async () => {
  await loadForm();
  await runChecks();
})();
