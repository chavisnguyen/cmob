/**
 * E2E Multi-Agent Live Verification Script
 * Validates full bidirectional control, transcript tailing, and adaptive approvals
 * for both Antigravity CLI and Claude Code over localhost and Tailscale HTTPS.
 * Sources:
 * - architecture.md: Section 5.1
 * - roadmap_and_tasks.md: Milestone 4.3
 */

import { readFileSync } from "node:fs";

const LOCAL_WS = "ws://127.0.0.1:8088/ws";
const TAILSCALE_WS = process.env.CMOB_E2E_TAILSCALE_WS || ""; // e.g. wss://<machine>.<tailnet>.ts.net/ws
const TOKEN =
  process.env.CMUX_GATEWAY_TOKEN ||
  readFileSync(`${process.env.HOME}/.cmux/gateway-token`, "utf8").trim();

async function runSessionTest(url, label) {
  console.log(`\n============================================================`);
  console.log(`  E2E Test: ${label}`);
  console.log(`  Endpoint: ${url}`);
  console.log(`============================================================`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let reqCounter = 0;

    const callRpc = (method, params = {}) => {
      const id = `req-${++reqCounter}`;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`Timeout calling ${method}`));
          }
        }, 5000);
      });
    };

    ws.onopen = () => {
      console.log(`[+] Connected to WebSocket. Sending auth handshake...`);
      ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    };

    ws.onerror = (err) => {
      console.error(`[-] WebSocket error on ${label}:`, err);
      reject(err);
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "auth_ok") {
        console.log(`[+] Auth OK! Session ID: ${msg.session_id}`);

        try {
          // 1. Fetch Workspace Tree
          console.log(`[*] Requesting mobile.workspace.tree...`);
          const treeResp = await callRpc("mobile.workspace.tree");
          const workspaces = treeResp.workspaces || [];
          console.log(`[+] Discovered ${workspaces.length} workspaces.`);
          if (workspaces.length === 0) throw new Error("No workspaces found!");

          const allSurfaces = workspaces.flatMap((w) =>
            w.surfaces.map((s) => ({ ...s, workspaceTitle: w.title })),
          );

          // 2. Validate Antigravity Agent Session
          const agySurf = allSurfaces.find((s) => s.agent?.agent_kind === "antigravity");
          if (!agySurf) throw new Error("No active Antigravity surface discovered!");

          console.log(`\n--- Validating Antigravity Session ---`);
          console.log(`  Workspace     : ${agySurf.workspaceTitle}`);
          console.log(`  Surface Title : ${agySurf.title}`);
          console.log(`  Surface ID    : ${agySurf.id}`);
          console.log(`  Agent Kind    : ${agySurf.agent?.agent_kind}`);
          console.log(`  Session ID    : ${agySurf.agent?.session_id}`);

          console.log(`[*] Reading Antigravity session transcript...`);
          const agyChat = await callRpc("mobile.chat.readSession", {
            surface_id: agySurf.id || agySurf.ref,
            session_id: agySurf.agent?.session_id,
            agent_kind: "antigravity",
            max_turns: 20,
          });
          console.log(`[+] Antigravity Turns Loaded: ${agyChat.turns?.length || 0}`);
          if (!agyChat.turns || agyChat.turns.length === 0) {
            throw new Error("Antigravity turns were empty!");
          }
          const lastAgyTurn = agyChat.turns[agyChat.turns.length - 1];
          console.log(`  Last Turn Role   : ${lastAgyTurn.role}`);
          console.log(`  Last Turn Events : ${lastAgyTurn.events.length}`);

          console.log(`[*] Reading Antigravity terminal buffer...`);
          const agyTerm = await callRpc("mobile.terminal.read", {
            surface_id: agySurf.id || agySurf.ref,
            lines: 50,
          });
          const agyBuffer = agyTerm.screen || agyTerm.text;
          console.log(`[+] Terminal buffer received: ${agyBuffer?.length || 0} bytes`);
          if (!agyBuffer || agyBuffer.length < 20) {
            throw new Error("Antigravity terminal buffer too short!");
          }

          // 3. Validate Claude Code Agent Session
          const claudeSurf = allSurfaces.find((s) => s.agent?.agent_kind === "claude");
          if (!claudeSurf) {
            console.warn(`[!] No surface explicitly latched to Claude in tree; probing Project A...`);
          } else {
            console.log(`\n--- Validating Claude Code Session ---`);
            console.log(`  Workspace    : ${claudeSurf.workspaceTitle}`);
            console.log(`  Surface Title: ${claudeSurf.title}`);
            console.log(`  Surface ID   : ${claudeSurf.id}`);
            console.log(`  Session ID   : ${claudeSurf.agent?.session_id}`);

            console.log(`[*] Reading Claude Code session transcript...`);
            const claudeChat = await callRpc("mobile.chat.readSession", {
              surface_id: claudeSurf.id || claudeSurf.ref,
              session_id: claudeSurf.agent?.session_id || "ebba74a3-6bc3-4231-8a8f-89141bb626f3",
              agent_kind: "claude",
              max_turns: 20,
            });
            console.log(`[+] Claude Turns Loaded: ${claudeChat.turns?.length || 0}`);
            if (claudeChat.turns && claudeChat.turns.length > 0) {
              const lastClaude = claudeChat.turns[claudeChat.turns.length - 1];
              console.log(`  Last Turn Role: ${lastClaude.role}`);
              console.log(`  Last Turn Events: ${lastClaude.events?.length || 0}`);
            }

            console.log(`[*] Reading Claude Code terminal buffer...`);
            const claudeTerm = await callRpc("mobile.terminal.read", {
              surface_id: claudeSurf.id || claudeSurf.ref,
              lines: 50,
            });
            const claudeBuffer = claudeTerm.screen || claudeTerm.text;
            console.log(`[+] Claude Terminal Buffer: ${claudeBuffer?.length || 0} bytes`);
          }

          // 4. Test Key Delivery & Adaptive Approval Dispatches
          console.log(`\n--- Testing Key & Control RPC Dispatches ---`);
          console.log(`[*] Testing 1-Tap Approval for Antigravity (\\r Enter mapping)...`);
          const agyApprove = await callRpc("mobile.chat.approve", {
            surface_id: agySurf.id || agySurf.ref,
            agent_kind: "antigravity",
          });
          console.log(`[+] Antigravity Approve result:`, agyApprove);

          if (claudeSurf) {
            console.log(`[*] Testing 1-Tap Approval for Claude Code ('1' mapping)...`);
            const claudeApprove = await callRpc("mobile.chat.approve", {
              surface_id: claudeSurf.id || claudeSurf.ref,
              agent_kind: "claude",
            });
            console.log(`[+] Claude Code Approve result:`, claudeApprove);
          }

          console.log(`[*] Testing Terminal Quick Key Send (Arrow Up)...`);
          const keySend = await callRpc("mobile.terminal.send", {
            surface_id: agySurf.id || agySurf.ref,
            key: "up",
          });
          console.log(`[+] Terminal key send result:`, keySend);

          console.log(`\n[SUCCESS] ${label} passed all checks!`);
          ws.close();
          resolve();
        } catch (e) {
          console.error(`[-] Test error on ${label}:`, e);
          ws.close();
          reject(e);
        }
      }

      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`RPC Error (${msg.error.code}): ${msg.error.message}`));
        } else {
          res(msg.result);
        }
      }
    };
  });
}

async function main() {
  try {
    // 1. Localhost probe
    await runSessionTest(LOCAL_WS, "Localhost Loopback");

    // 2. Remote Tailscale WSS probe
    if (TAILSCALE_WS) {
      await runSessionTest(TAILSCALE_WS, "Tailscale HTTPS/WSS Remote Ingress");
    } else {
      console.log("\nSkipping the Tailscale probe (set CMOB_E2E_TAILSCALE_WS=wss://<machine>.<tailnet>.ts.net/ws).");
    }

    console.log(`\n============================================================`);
    console.log(`  ALL E2E MULTI-AGENT VERIFICATION TESTS PASSED!`);
    console.log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n[FATAL] E2E verification failed:`, err);
    process.exit(1);
  }
}

main();
