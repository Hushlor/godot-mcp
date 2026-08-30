import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PlaytestSession } from '../build/playtest.js';

const godotPath = process.env.GODOT_PATH;
const projectPath = process.env.GODOT_MCP_TEST_PROJECT;
const playtestMode = process.env.GODOT_MCP_TEST_MODE === 'windowed' ? 'windowed' : 'headless';

test('drives a real Godot project and restores its configuration', {
  skip: !godotPath || !projectPath,
  timeout: 45_000,
}, async () => {
  const originalProject = readFileSync(`${projectPath}/project.godot`);
  const session = new PlaytestSession();
  try {
    const started = await session.start({ projectPath, godotPath, mode: playtestMode });
    assert.equal(started.active, true);
    assert.deepEqual(readFileSync(`${projectPath}/project.godot`), originalProject);
    const competingSession = new PlaytestSession();
    await assert.rejects(
      competingSession.start({ projectPath, godotPath, mode: 'headless' }),
      /active playtest session/,
    );

    await session.sendInput({ type: 'action', action: 'ui_accept', pressed: true, strength: 1 });
    await session.sendInput({ type: 'action', action: 'ui_accept', pressed: false, strength: 0 });
    await session.sendInput({ type: 'key', keycode: 32, pressed: true });
    await session.sendInput({ type: 'key', keycode: 32, pressed: false });
    await session.sendInput({ type: 'mouse_motion', x: 20, y: 30, relativeX: 2, relativeY: 3 });
    await session.sendInput({ type: 'mouse_button', button: 1, x: 20, y: 30, pressed: true });
    await session.sendInput({ type: 'mouse_button', button: 1, x: 20, y: 30, pressed: false });
    await session.sendInput({ type: 'joypad_button', device: 0, button: 0, pressed: true, pressure: 1 });
    await session.sendInput({ type: 'joypad_button', device: 0, button: 0, pressed: false, pressure: 0 });
    await session.sendInput({ type: 'joypad_motion', device: 0, axis: 0, value: 0.75 });
    await session.sendInput({ type: 'joypad_motion', device: 0, axis: 0, value: 0 });

    const state = await session.getRuntimeState();
    assert.match(state.currentSceneNodePath, /^\/root\//);
    assert.ok(state.viewportSize.x > 0 && state.viewportSize.y > 0);
    if (playtestMode === 'windowed') {
      const png = await session.captureViewport();
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    } else {
      await assert.rejects(session.captureViewport(), /empty image/);
    }

    const signalWait = session.waitForSignal(state.currentSceneNodePath, 'tree_exiting', 5_000);
    await session.stop();
    assert.deepEqual(await signalWait, { emitted: true });
    assert.deepEqual(readFileSync(`${projectPath}/project.godot`), originalProject);
  } finally {
    if (session.active) await session.stop();
    assert.deepEqual(readFileSync(`${projectPath}/project.godot`), originalProject);
  }
});
