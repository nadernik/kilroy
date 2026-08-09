/**
 * Service worker. Sole owner of the Supabase session.
 *
 * Content scripts never hold credentials or talk to Supabase directly — they
 * ask for an operation by name and get a plain result back. MV3 tears this
 * worker down whenever it feels like it, so every piece of state lives in
 * chrome.storage rather than in a module variable.
 */

import * as api from "./api.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const handlers = {
  async status() {
    const config = await api.getConfig();
    if (!config) return { configured: false, signedIn: false };

    const me = await api.whoAmI();
    return {
      configured: true,
      signedIn: Boolean(me),
      email: me?.email ?? null,
      settings: await api.getSettings(),
      base: await api.endpointBase(),
    };
  },

  /**
   * Called when a compose window opens, not when you hit send. Minting the
   * token up front means the pixel is already sitting in the body by the time
   * you send, so we never have to intercept and delay the send itself.
   */
  async createDraft() {
    const me = await api.whoAmI();
    if (!me) throw new Error("Not signed in");

    const token = api.mintToken();
    await api.rest("messages", {
      method: "POST",
      body: { token, status: "draft", user_id: me.userId },
      prefer: "return=minimal",
    });
    return { token };
  },

  async markSent({ token, subject, recipients, threadId }) {
    if (!TOKEN_RE.test(token ?? "")) throw new Error("bad token");
    await api.rest(`messages?token=eq.${token}`, {
      method: "PATCH",
      body: {
        status: "sent",
        subject: subject || null,
        recipients: Array.isArray(recipients) ? recipients : [],
        thread_id: threadId || null,
        sent_at: new Date().toISOString(),
      },
      prefer: "return=minimal",
    });
    return {};
  },

  async registerLink({ messageToken, targetUrl, label }) {
    if (!TOKEN_RE.test(messageToken ?? "")) throw new Error("bad token");
    if (!/^https?:\/\//i.test(targetUrl ?? "")) throw new Error("bad url");

    const rows = await api.rest(`messages?token=eq.${messageToken}&select=id`);
    if (!rows?.length) throw new Error("unknown message");

    const token = api.mintToken();
    await api.rest("links", {
      method: "POST",
      body: {
        message_id: rows[0].id,
        token,
        target_url: targetUrl,
        label: label ? String(label).slice(0, 200) : null,
      },
      prefer: "return=minimal",
    });
    return { token };
  },

  /** "I am looking at this message right now, so don't count what follows." */
  async selfView({ tokens, threadId }) {
    const valid = (tokens ?? []).filter((t) => TOKEN_RE.test(t));
    await Promise.all(
      valid.map((p_token) =>
        api.rpc("note_self_view", { p_token, p_thread_id: threadId || null })
           .catch(() => {}),
      ),
    );
    return { noted: valid.length };
  },

  async stats({ tokens }) {
    const valid = (tokens ?? []).filter((t) => TOKEN_RE.test(t));
    if (!valid.length) return { rows: [] };
    const rows = await api.rest(`message_stats?token=in.(${valid.join(",")})&select=*`);
    return { rows };
  },

  async recent({ limit = 25 } = {}) {
    const rows = await api.rest(
      `message_stats?select=*&order=sent_at.desc&limit=${Math.min(Number(limit) || 25, 100)}`,
    );
    return { rows };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    reply({ ok: false, error: `unknown message: ${msg?.type}` });
    return false;
  }

  Promise.resolve(handler(msg))
    .then((result) => reply({ ok: true, ...result }))
    .catch((err) => reply({ ok: false, error: String(err?.message ?? err) }));

  return true;  // keeps the channel open for the async reply
});
