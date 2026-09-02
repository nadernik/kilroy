/**
 * One-click setup: turn a blank Supabase project into a Kilroy backend.
 *
 * This is the whole reason the manual six-step wizard can now be the fallback
 * rather than the path. Given a project the user picked and an access token,
 * it does — in order — every step SETUP.md used to ask a person to do by hand:
 * reads the publishable key, runs the migrations, deploys the two functions,
 * and switches on the auth this extension signs in with.
 *
 * Every step reports through onStep so the UI can show progress and, more to
 * the point, name the exact step that failed. Provisioning half-succeeds
 * readily — a project that spun up a moment ago may not take SQL yet — and
 * "step 3 of 7 failed: <why>" is worth more than a spinner that stops.
 *
 * Idempotent by construction: the migrations use IF NOT EXISTS / OR REPLACE and
 * deployFunction upserts, so a re-run after a failure resumes rather than
 * doubling anything.
 */

import * as api from "./api.js";
import * as mgmt from "./mgmt.js";
import { MIGRATIONS, FUNCTIONS } from "../provision/assets.js";

function redirectUrl() {
  try { return chrome.identity.getRedirectURL(); } catch { return null; }
}

/**
 * @param ref     project ref chosen by the user
 * @param onStep  ({ n, of, label, state }) => void   state: "run" | "ok" | "bad"
 */
export async function provision(ref, onStep = () => {}) {
  const url = mgmt.projectUrl(ref);
  const steps = [];
  const step = (label, fn) => steps.push({ label, fn });

  step("Read the project's publishable key", async () => {
    const anonKey = await mgmt.anonKey(ref);
    // Saved config wins over the bundled file and is what every later call
    // uses; setConfig re-validates the key and refuses a secret one.
    await api.setConfig({ url, anonKey });
  });

  // One step per migration: they are the likeliest thing to fail on a project
  // that is still warming up, and a failure should name which file.
  for (const { name, sql } of MIGRATIONS) {
    step(`Run migration ${name}`, () => mgmt.runSql(ref, sql));
  }

  for (const fn of FUNCTIONS) {
    step(`Deploy the ${fn.slug} endpoint`, () => mgmt.deployFunction(ref, fn));
  }

  step("Turn on sign-in", async () => {
    const redirect = redirectUrl();
    const allow = new Set();
    // Existing entries stay; we only ever add ours. uri_allow_list is a
    // comma-separated string in the Management API.
    const current = await mgmt.getAuthConfig(ref).catch(() => ({}));
    for (const u of String(current.uri_allow_list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      allow.add(u);
    }
    if (redirect) allow.add(redirect);

    await mgmt.updateAuthConfig(ref, {
      // Email + password, confirmed on the spot: the frictionless default that
      // needs no Google Cloud client and no working project mailer.
      external_email_enabled: true,
      mailer_autoconfirm: true,
      // Harmless if unused; present so the Google button also works for anyone
      // who later adds a client. site_url wants a value it will accept.
      site_url: redirect ?? url,
      ...(allow.size ? { uri_allow_list: [...allow].join(",") } : {}),
    });
  });

  const of = steps.length;
  for (let i = 0; i < of; i++) {
    const { label, fn } = steps[i];
    onStep({ n: i + 1, of, label, state: "run" });
    try {
      await fn();
      onStep({ n: i + 1, of, label, state: "ok" });
    } catch (err) {
      onStep({ n: i + 1, of, label, state: "bad", error: String(err?.message ?? err) });
      throw new Error(`Setup stopped at "${label}": ${err?.message ?? err}`);
    }
  }

  // The token was only ever needed for the work above. Nothing at runtime uses
  // it, so it does not outlive the setup that required it.
  await mgmt.clearToken();
  return { url };
}
