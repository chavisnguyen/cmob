const { spawn } = require('node:child_process');

async function runTest() {
  const gateway = spawn('./repos/cmux-gateway/target/debug/cmux-gateway', [
    '--port',
    '8092',
    '--token',
    'test_sec_999',
    '--quiet'
  ], { stdio: 'inherit' });

  await new Promise((r) => setTimeout(r, 1000));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:8092/ws');

    ws.onopen = () => {
      console.log('[TEST] WebSocket connected, sending auth frame...');
      ws.send(JSON.stringify({ type: 'auth', token: 'test_sec_999' }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      console.log('[TEST] Received frame:', msg.type || msg.id);

      if (msg.type === 'auth_ok') {
        console.log('[TEST] Authenticated. Requesting mobile.workspace.tree...');
        ws.send(JSON.stringify({
          id: 'tree-req',
          method: 'mobile.workspace.tree',
          params: {}
        }));
      } else if (msg.id === 'tree-req') {
        const workspaces = msg.result.workspaces;
        console.log(`[TEST] Successfully received ${workspaces.length} workspaces:`);
        for (const wsItem of workspaces) {
          console.log(`\n📁 [${wsItem.title}]`);
          console.log(`   - ID: ${wsItem.id}`);
          console.log(`   - Status: ${wsItem.status}`);
          console.log(`   - CWD: ${wsItem.current_directory}`);
          console.log(`   - Snippet: ${wsItem.snippet ? wsItem.snippet.slice(0, 50) + '...' : '(none)'}`);
          console.log(`   - Surfaces (${wsItem.surfaces.length}):`);
          for (const s of wsItem.surfaces) {
            const agentStr = s.agent ? `🤖 [Agent: ${s.agent.agent_kind} (${s.agent.status})]` : '💻 [Shell]';
            console.log(`     * "${s.title}" (${s.surface_type}) ${agentStr}`);
          }
        }
        ws.close();
        gateway.kill();
        resolve();
      }
    };

    ws.onerror = (err) => {
      gateway.kill();
      reject(err);
    };
  });
}

runTest().then(() => {
  console.log('\n[PASS] Live WebSocket mobile.workspace.tree test verified successfully!');
  process.exit(0);
}).catch((err) => {
  console.error('[FAIL] Test error:', err);
  process.exit(1);
});
