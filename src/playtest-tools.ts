import { PlaytestSession } from './playtest.js';
import { PlaytestInputEvent } from './playtest-contract.js';

const booleanProperty = { type: 'boolean' };
const numberProperty = { type: 'number' };

export const playtestToolDefinitions = [
  {
    name: 'start_playtest',
    description: 'Start one instrumented Godot playtest using a transient localhost bridge',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to a Godot project directory' },
        mode: { type: 'string', enum: ['headless', 'windowed'], default: 'headless' },
        scene: { type: 'string', description: 'Optional scene path to run' },
        startupTimeoutMs: { type: 'number', minimum: 1, maximum: 60000 },
      },
      required: ['projectPath'],
    },
  },
  { name: 'stop_playtest', description: 'Stop the active playtest and return its final output', inputSchema: { type: 'object', properties: {} } },
  { name: 'playtest_status', description: 'Report active playtest connection and process state', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'send_action',
    description: 'Send a Godot InputMap action through the production input path',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, pressed: booleanProperty, strength: numberProperty },
      required: ['action', 'pressed'],
    },
  },
  {
    name: 'send_key',
    description: 'Send a key event through the production input path',
    inputSchema: {
      type: 'object',
      properties: { keycode: numberProperty, pressed: booleanProperty },
      required: ['keycode', 'pressed'],
    },
  },
  {
    name: 'send_mouse',
    description: 'Send mouse motion or button input through the production input path',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['motion', 'button'] },
        x: numberProperty,
        y: numberProperty,
        relativeX: numberProperty,
        relativeY: numberProperty,
        button: numberProperty,
        pressed: booleanProperty,
      },
      required: ['kind', 'x', 'y'],
    },
  },
  {
    name: 'send_joypad_button',
    description: 'Send a joypad button event through the production input path',
    inputSchema: {
      type: 'object',
      properties: { device: numberProperty, button: numberProperty, pressed: booleanProperty, pressure: numberProperty },
      required: ['button', 'pressed'],
    },
  },
  {
    name: 'send_joypad_motion',
    description: 'Send an analog joypad axis value through the production input path',
    inputSchema: {
      type: 'object',
      properties: { device: numberProperty, axis: numberProperty, value: { type: 'number', minimum: -1, maximum: 1 } },
      required: ['axis', 'value'],
    },
  },
  {
    name: 'run_input_sequence',
    description: 'Run up to 256 typed input events with bounded inter-event delays',
    inputSchema: {
      type: 'object',
      properties: {
        events: {
          type: 'array', minItems: 1, maxItems: 256,
          items: { type: 'object', description: 'Typed input event plus optional delayMs' },
        },
      },
      required: ['events'],
    },
  },
  { name: 'capture_viewport', description: 'Capture a windowed playtest viewport as PNG; headless renderers may not expose pixels', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_runtime_state', description: 'Read bounded scene, focus, viewport, mouse, pause, and frame state', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'wait_for_signal',
    description: 'Wait for a zero-argument signal on an absolute /root node path',
    inputSchema: {
      type: 'object',
      properties: { nodePath: { type: 'string' }, signal: { type: 'string' }, timeoutMs: { type: 'number', minimum: 1, maximum: 60000 } },
      required: ['nodePath', 'signal'],
    },
  },
  { name: 'get_runtime_errors', description: 'Read stderr and error-like output from the active playtest', inputSchema: { type: 'object', properties: {} } },
];

function text(value: unknown): any {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function error(message: string): any {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function event(type: PlaytestInputEvent['type'], args: any): PlaytestInputEvent {
  return { ...args, type };
}

export class PlaytestTools {
  readonly session = new PlaytestSession();

  async handle(name: string, rawArgs: any, godotPath: string | null): Promise<any | null> {
    const args = rawArgs ?? {};
    try {
      switch (name) {
        case 'start_playtest':
          if (!godotPath) throw new Error('Godot executable is not configured');
          return text(await this.session.start({
            projectPath: args.projectPath,
            godotPath,
            mode: args.mode,
            scene: args.scene,
            startupTimeoutMs: args.startupTimeoutMs,
          }));
        case 'stop_playtest': return text(await this.session.stop());
        case 'playtest_status': return text(this.session.status());
        case 'send_action': return text(await this.session.sendInput(event('action', args)));
        case 'send_key': return text(await this.session.sendInput(event('key', args)));
        case 'send_mouse':
          return text(await this.session.sendInput(event(args.kind === 'button' ? 'mouse_button' : 'mouse_motion', args)));
        case 'send_joypad_button': return text(await this.session.sendInput(event('joypad_button', args)));
        case 'send_joypad_motion': return text(await this.session.sendInput(event('joypad_motion', args)));
        case 'run_input_sequence': return text(await this.session.runSequence(args.events));
        case 'capture_viewport': {
          const png = await this.session.captureViewport();
          return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
        }
        case 'get_runtime_state': return text(await this.session.getRuntimeState());
        case 'wait_for_signal': return text(await this.session.waitForSignal(args.nodePath, args.signal, args.timeoutMs));
        case 'get_runtime_errors': return text(this.session.runtimeErrors());
        default: return null;
      }
    } catch (caught) {
      return error(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async cleanup(): Promise<void> {
    if (this.session.active) await this.session.stop();
  }
}
