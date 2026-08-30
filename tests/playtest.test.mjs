import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addTransientAutoload,
  validateInputEvent,
} from '../build/playtest-contract.js';

test('adds a new autoload section without changing line endings', () => {
  const source = Buffer.from('[application]\r\nconfig/name="Fixture"\r\n');
  const result = addTransientAutoload(source, 'res://.godot/mcp-playtest/bridge.gd').toString();
  assert.equal(
    result,
    '[application]\r\nconfig/name="Fixture"\r\n\r\n[autoload]\r\nMcpPlaytestBridge="*res://.godot/mcp-playtest/bridge.gd"\r\n',
  );
});

test('inserts into an existing autoload section', () => {
  const source = Buffer.from('[autoload]\nExisting="*res://existing.gd"\n\n[display]\n');
  const result = addTransientAutoload(source, 'res://bridge.gd').toString();
  assert.equal(
    result,
    '[autoload]\nMcpPlaytestBridge="*res://bridge.gd"\nExisting="*res://existing.gd"\n\n[display]\n',
  );
});

test('accepts every bounded input family', () => {
  const events = [
    { type: 'action', action: 'ui_accept', pressed: true, strength: 1 },
    { type: 'key', keycode: 32, pressed: false },
    { type: 'mouse_motion', x: 10, y: 20, relativeX: 1, relativeY: -1 },
    { type: 'mouse_button', button: 1, x: 10, y: 20, pressed: true },
    { type: 'joypad_button', device: 0, button: 1, pressed: true, pressure: 1 },
    { type: 'joypad_motion', device: 0, axis: 0, value: -0.75 },
  ];
  for (const event of events) assert.doesNotThrow(() => validateInputEvent(event));
});

test('rejects malformed input before it reaches Godot', () => {
  assert.throws(
    () => validateInputEvent({ type: 'joypad_motion', axis: 0, value: Number.NaN }),
    /finite number/,
  );
  assert.throws(
    () => validateInputEvent({ type: 'action', action: '', pressed: true }),
    /required/,
  );
});
