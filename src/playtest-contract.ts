import { existsSync } from 'fs';

export type PlaytestMode = 'headless' | 'windowed';

export interface PlaytestStartOptions {
  projectPath: string;
  godotPath: string;
  mode?: PlaytestMode;
  scene?: string;
  startupTimeoutMs?: number;
}

export interface PlaytestInputEvent {
  type: 'action' | 'key' | 'mouse_motion' | 'mouse_button' | 'joypad_button' | 'joypad_motion';
  [key: string]: unknown;
}

const BRIDGE_NAME = 'McpPlaytestBridge';

export function addTransientAutoload(source: Buffer, bridgeResourcePath: string): Buffer {
  const text = source.toString('utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const declaration = `${BRIDGE_NAME}="*${bridgeResourcePath}"`;
  const sectionPattern = /^\[autoload\]\s*$/m;
  const match = sectionPattern.exec(text);
  if (!match) {
    const separator = text.endsWith(newline) ? newline : `${newline}${newline}`;
    return Buffer.from(`${text}${separator}[autoload]${newline}${declaration}${newline}`, 'utf8');
  }

  const insertionAt = match.index + match[0].length;
  return Buffer.from(
    `${text.slice(0, insertionAt)}${newline}${declaration}${text.slice(insertionAt)}`,
    'utf8',
  );
}

export function resolveWindowedGodotPath(godotPath: string): string {
  if (process.platform !== 'win32' || !/_console\.exe$/i.test(godotPath)) return godotPath;
  const graphicalSibling = godotPath.replace(/_console\.exe$/i, '.exe');
  return existsSync(graphicalSibling) ? graphicalSibling : godotPath;
}

export function validateInputEvent(event: PlaytestInputEvent): void {
  const numeric = (name: string): number => {
    const value = event[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${event.type}.${name} must be a finite number`);
    }
    return value;
  };
  const boolean = (name: string): void => {
    if (typeof event[name] !== 'boolean') throw new Error(`${event.type}.${name} must be a boolean`);
  };

  switch (event.type) {
    case 'action':
      if (typeof event.action !== 'string' || !event.action) throw new Error('action.action is required');
      boolean('pressed');
      if (event.strength !== undefined) numeric('strength');
      return;
    case 'key': numeric('keycode'); boolean('pressed'); return;
    case 'mouse_motion':
      numeric('x'); numeric('y');
      if (event.relativeX !== undefined) numeric('relativeX');
      if (event.relativeY !== undefined) numeric('relativeY');
      return;
    case 'mouse_button': numeric('button'); numeric('x'); numeric('y'); boolean('pressed'); return;
    case 'joypad_button':
      numeric('button'); boolean('pressed');
      if (event.device !== undefined) numeric('device');
      if (event.pressure !== undefined) numeric('pressure');
      return;
    case 'joypad_motion':
      numeric('axis'); numeric('value');
      if (event.device !== undefined) numeric('device');
      return;
    default: throw new Error(`Unsupported input event type: ${String((event as any).type)}`);
  }
}
