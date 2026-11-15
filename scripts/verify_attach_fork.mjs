/**
 * Live verification of image attachment and fork against a running gateway + a real agent in cmux.
 * Usage: node scripts/verify_attach_fork.mjs <ws-url> <token> <surface-id> [workspace-id]
 * Steps print PASS/FAIL/INFO lines; nothing is submitted to the agent (images are pasted without Enter).
 */
const [url, token, surfaceId, workspaceId] = process.argv.slice(2);
if (!url || !token || !surfaceId) {
  console.error("usage: verify_attach_fork.mjs <ws-url> <token> <surface-id> [workspace-id]");
  process.exit(2);
}
// 1x1 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ws = new WebSocket(url);
const pending = new Map();
let n = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = `r${++n}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`timeout ${method}`))), 40000);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (ok, label, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  -- " + extra : ""}`);
const info = (s) => console.log(`INFO  ${s}`);
const screen = async (lines = 40) => (await call("mobile.terminal.read", { surface_id: surfaceId, lines, scrollback: false })).text ?? "";

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "auth_ok") return void run().catch((e) => { console.error("ERROR", e.message); process.exit(1); });
  if (m.type === "auth_error") { console.error("auth failed"); process.exit(1); }
  const p = m.id && pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result); }
};
ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));

async function run() {
  // 1. the startup-dialog guard must refuse typing into a folder-trust dialog
  const before = await screen();
  info(`screen starts: ${JSON.stringify(before.trim().split("\n").slice(-3))}`);
  const dialogUp = /trust this folder|Quick safety check/i.test(before);
  if (dialogUp) {
    try {
      await call("mobile.chat.send", { surface_id: surfaceId, agent_kind: "claude", text: "hello", enter: true });
      report(false, "guard: send into trust dialog was refused");
    } catch (e) {
      report(/dialog|startup/i.test(e.message), "guard: send into trust dialog was refused", e.message);
    }
    const sess = await call("mobile.chat.readSession", { surface_id: surfaceId, agent_kind: "claude" });
    const d = sess.startup_dialog;
    info(`startup_dialog = ${JSON.stringify(d)}`);
    const idx = d?.choices?.findIndex((c) => /trust/i.test(c.label ?? c));
    if (idx >= 0) {
      await call("mobile.chat.answerDialog", { surface_id: surfaceId, choice: idx + 1, fingerprint: d.fingerprint });
      report(true, "answerDialog sent (trust scratch folder)");
    } else report(false, "found a 'trust' choice in the dialog");
  }
  for (let i = 0; i < 20; i += 1) {
    const s = await screen();
    if (!/trust this folder|Quick safety check/i.test(s) && /\?|>|❯/.test(s)) break;
    await sleep(1000);
  }
  info(`after dialog, screen tail: ${JSON.stringify((await screen()).trim().split("\n").slice(-6))}`);

  // 2. image upload + path paste
  const up = await call("mobile.upload.image", { content_base64: PNG_B64 });
  report(typeof up.path === "string" && up.path.endsWith(".png"), "upload returned a host path", up.path);
  await call("mobile.chat.send", { surface_id: surfaceId, agent_kind: "claude", text: up.path, enter: false });
  await sleep(2000);
  const after = await screen();
  const attached = /\[Image #\d+\]/i.test(after);
  report(attached, "agent shows the pasted path as an image attachment ([Image #N])");
  if (!attached) info(`screen tail: ${JSON.stringify(after.trim().split("\n").slice(-8))}`);

  // 3. rejects non-images
  try {
    await call("mobile.upload.image", { content_base64: Buffer.from("#!/bin/sh\necho hi").toString("base64") });
    report(false, "upload rejects a non-image");
  } catch (e) { report(true, "upload rejects a non-image", e.message); }

  // 4. fork (needs a workspace id and a real claude session id supplied via FORK_SESSION)
  if (workspaceId && process.env.FORK_SESSION) {
    const r = await call("mobile.chat.fork", { workspace_id: workspaceId, session_id: process.env.FORK_SESSION, agent_kind: "claude" });
    info(`fork result: ${JSON.stringify(r)}`);
  }
  process.exit(0);
}
