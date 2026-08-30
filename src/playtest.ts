import { randomBytes } from 'crypto';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createServer, Server as NetServer, Socket } from 'net';
import { basename, dirname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import {
  addTransientAutoload,
  PlaytestInputEvent,
  PlaytestMode,
  PlaytestStartOptions,
  resolveWindowedGodotPath,
  validateInputEvent,
} from './playtest-contract.js';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface ProjectMutation {
  projectFile: string;
  original: Buffer;
  bridgeFile: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class PlaytestSession {
  private process: ChildProcessWithoutNullStreams | null = null;
  private server: NetServer | null = null;
  private socket: Socket | null = null;
  private token = '';
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private receiveBuffer = '';
  private mutation: ProjectMutation | null = null;
  private lockFile: string | null = null;
  private output: string[] = [];
  private errors: string[] = [];
  private projectPath: string | null = null;
  private mode: PlaytestMode | null = null;
  private startedAt: string | null = null;

  get active(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async start(options: PlaytestStartOptions): Promise<Record<string, unknown>> {
    if (this.active || this.socket) throw new Error('A playtest session is already active');
    const projectPath = normalize(options.projectPath);
    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) throw new Error(`Not a Godot project: ${projectPath}`);
    if (options.scene?.includes('..')) throw new Error('Scene path must not contain ..');

    this.resetRuntimeState();
    this.projectPath = projectPath;
    this.mode = options.mode ?? 'headless';
    this.startedAt = new Date().toISOString();
    this.token = randomBytes(24).toString('hex');

    try {
      this.acquireProjectLock(projectPath);
      const port = await this.listen();
      this.mutation = this.installBridge(projectPath);
      const executable = this.mode === 'windowed'
        ? resolveWindowedGodotPath(options.godotPath)
        : options.godotPath;
      const args = ['--path', projectPath];
      if (this.mode === 'headless') args.unshift('--headless');
      if (options.scene) args.push(options.scene);
      this.process = spawn(executable, args, {
        cwd: projectPath,
        env: {
          ...process.env,
          GODOT_MCP_PLAYTEST_PORT: String(port),
          GODOT_MCP_PLAYTEST_TOKEN: this.token,
        },
        stdio: 'pipe',
      });
      this.captureProcessOutput(this.process);
      await this.waitForConnection(options.startupTimeoutMs ?? 15_000);
      this.restoreProject();
      return this.status();
    } catch (error) {
      await this.abortStart();
      throw error;
    }
  }

  status(): Record<string, unknown> {
    return {
      active: this.active,
      connected: this.socket !== null && !this.socket.destroyed,
      pid: this.process?.pid ?? null,
      projectPath: this.projectPath,
      mode: this.mode,
      startedAt: this.startedAt,
    };
  }

  async sendInput(event: PlaytestInputEvent): Promise<any> {
    validateInputEvent(event);
    return this.request('input', { event });
  }

  async runSequence(events: Array<PlaytestInputEvent & { delayMs?: number }>): Promise<any[]> {
    if (!Array.isArray(events) || events.length === 0 || events.length > 256) {
      throw new Error('events must contain between 1 and 256 entries');
    }
    const results: any[] = [];
    for (const event of events) {
      validateInputEvent(event);
      results.push(await this.request('input', { event }));
      const delayMs = event.delayMs ?? 0;
      if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30_000) {
        throw new Error('delayMs must be between 0 and 30000');
      }
      if (delayMs > 0) await delay(delayMs);
    }
    return results;
  }

  getRuntimeState(): Promise<any> {
    return this.request('state', {});
  }

  waitForSignal(nodePath: string, signal: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (!nodePath.startsWith('/root/') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(signal)) {
      throw new Error('wait_for_signal requires an absolute /root node path and a simple signal name');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('timeoutMs must be between 1 and 60000');
    }
    return this.request('wait_signal', { nodePath, signal, timeoutMs }, timeoutMs + 1_000);
  }

  async captureViewport(): Promise<Buffer> {
    const response = await this.request('capture', {});
    if (typeof response?.path !== 'string' || !existsSync(response.path)) {
      throw new Error('Bridge did not produce a viewport capture');
    }
    const image = readFileSync(response.path);
    rmSync(response.path, { force: true });
    return image;
  }

  runtimeErrors(): Record<string, string[]> {
    return {
      errors: this.errors.filter((line) => line.trim()),
      outputErrors: this.output.filter((line) => /\b(error|warning|failed)\b/i.test(line)),
    };
  }

  async stop(): Promise<Record<string, unknown>> {
    const finalStatus = this.status();
    if (this.socket && !this.socket.destroyed) {
      await this.request('quit', {}, 2_000).catch(() => undefined);
    }
    await this.waitForExit(2_000);
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
      await this.waitForExit(2_000);
    }
    if (this.process && this.process.exitCode === null) this.process.kill('SIGKILL');
    this.closeTransport(new Error('Playtest session stopped'));
    this.restoreProject();
    this.releaseProjectLock();
    const result = { ...finalStatus, active: false, finalOutput: this.output, finalErrors: this.errors };
    this.process = null;
    this.projectPath = null;
    this.mode = null;
    return result;
  }

  private async listen(): Promise<number> {
    this.server = createServer((socket) => this.acceptSocket(socket));
    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate playtest port');
    return address.port;
  }

  private installBridge(projectPath: string): ProjectMutation {
    const projectFile = join(projectPath, 'project.godot');
    const original = readFileSync(projectFile);
    const bridgeDirectory = join(projectPath, '.godot', 'mcp-playtest');
    mkdirSync(bridgeDirectory, { recursive: true });
    const bridgeFile = join(bridgeDirectory, `bridge-${this.token}.gd`);
    const sourceBridge = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'playtest_bridge.gd');
    copyFileSync(sourceBridge, bridgeFile);
    const resourcePath = `res://.godot/mcp-playtest/${basename(bridgeFile)}`;
    writeFileSync(projectFile, addTransientAutoload(original, resourcePath));
    return { projectFile, original, bridgeFile };
  }

  private acquireProjectLock(projectPath: string): void {
    const lockDirectory = join(projectPath, '.godot', 'mcp-playtest');
    mkdirSync(lockDirectory, { recursive: true });
    const lockFile = join(lockDirectory, 'session.lock');
    const claim = (): void => {
      const descriptor = openSync(lockFile, 'wx');
      try {
        writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: this.token }));
      } finally {
        closeSync(descriptor);
      }
      this.lockFile = lockFile;
    };
    try {
      claim();
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let ownerPid = 0;
    try { ownerPid = Number(JSON.parse(readFileSync(lockFile, 'utf8')).pid); } catch { ownerPid = 0; }
    if (ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        throw new Error(`Project already has an active playtest session owned by process ${ownerPid}`);
      } catch (error: any) {
        if (!['ESRCH', 'EINVAL'].includes(error?.code)) throw error;
      }
    }
    rmSync(lockFile, { force: true });
    claim();
  }

  private releaseProjectLock(): void {
    if (!this.lockFile) return;
    rmSync(this.lockFile, { force: true });
    this.lockFile = null;
  }

  private restoreProject(): void {
    if (!this.mutation) return;
    writeFileSync(this.mutation.projectFile, this.mutation.original);
    rmSync(this.mutation.bridgeFile, { force: true });
    this.mutation = null;
  }

  private acceptSocket(socket: Socket): void {
    if (this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.consume(String(chunk)));
    socket.on('close', () => { if (this.socket === socket) this.socket = null; });
    socket.on('error', (error) => this.closeTransport(error));
  }

  private consume(chunk: string): void {
    this.receiveBuffer += chunk;
    while (this.receiveBuffer.includes('\n')) {
      const newline = this.receiveBuffer.indexOf('\n');
      const line = this.receiveBuffer.slice(0, newline).trim();
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.token !== this.token) {
        this.socket?.destroy();
        continue;
      }
      if (message.type === 'ready') continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error ?? 'Bridge request failed')));
    }
  }

  private request(command: string, payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('No connected playtest session'));
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket!.write(`${JSON.stringify({ id, token: this.token, command, ...payload })}\n`);
    });
  }

  private waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const deadline = Date.now() + timeoutMs;
      const poll = (): void => {
        if (this.socket && !this.socket.destroyed) return resolvePromise();
        if (this.process?.exitCode !== null) return reject(new Error(`Godot exited during startup: ${this.errors.join('\n')}`));
        if (Date.now() >= deadline) return reject(new Error(`Playtest bridge did not connect within ${timeoutMs} ms`));
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  private captureProcessOutput(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on('data', (data: Buffer) => this.output.push(...data.toString().split(/\r?\n/)));
    child.stderr.on('data', (data: Buffer) => this.errors.push(...data.toString().split(/\r?\n/)));
    child.on('exit', () => {
      if (this.process === child) {
        this.restoreProject();
        this.releaseProjectLock();
        this.closeTransport(new Error('Godot process exited'));
      }
    });
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (!this.process || this.process.exitCode !== null) return Promise.resolve();
    return Promise.race([
      new Promise<void>((resolvePromise) => this.process!.once('exit', () => resolvePromise())),
      delay(timeoutMs),
    ]);
  }

  private closeTransport(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  private resetRuntimeState(): void {
    this.output = [];
    this.errors = [];
    this.receiveBuffer = '';
    this.nextRequestId = 1;
  }

  private async abortStart(): Promise<void> {
    this.restoreProject();
    this.releaseProjectLock();
    if (this.process && this.process.exitCode === null) this.process.kill('SIGTERM');
    this.closeTransport(new Error('Playtest startup aborted'));
    this.process = null;
    this.projectPath = null;
    this.mode = null;
  }
}
