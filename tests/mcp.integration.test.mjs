import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const godotPath = process.env.GODOT_PATH;
const projectPath = process.env.GODOT_MCP_TEST_PROJECT;

function jsonText(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const block = result.content.find((item) => item.type === 'text');
  assert.ok(block);
  return JSON.parse(block.text);
}

test('exposes and executes the playtest tools over MCP stdio', {
  skip: !godotPath || !projectPath,
  timeout: 45_000,
}, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'),
    env: { ...process.env, GODOT_PATH: godotPath },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'godot-mcp-fork-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const name of [
      'start_playtest', 'stop_playtest', 'playtest_status', 'send_action',
      'send_key', 'send_mouse', 'send_joypad_button', 'send_joypad_motion',
      'run_input_sequence', 'capture_viewport', 'get_runtime_state',
      'wait_for_signal', 'get_runtime_errors',
    ]) assert.ok(names.includes(name), `missing tool ${name}`);

    const started = jsonText(await client.callTool({
      name: 'start_playtest',
      arguments: { projectPath, mode: 'headless' },
    }));
    assert.equal(started.active, true);
    assert.equal(jsonText(await client.callTool({ name: 'playtest_status', arguments: {} })).connected, true);
    jsonText(await client.callTool({
      name: 'send_joypad_motion',
      arguments: { device: 0, axis: 0, value: 0.5 },
    }));
    const state = jsonText(await client.callTool({ name: 'get_runtime_state', arguments: {} }));
    assert.match(state.currentSceneNodePath, /^\/root\//);
    jsonText(await client.callTool({ name: 'get_runtime_errors', arguments: {} }));
    assert.equal(jsonText(await client.callTool({ name: 'stop_playtest', arguments: {} })).active, false);
  } finally {
    await client.close().catch(() => undefined);
  }
});
