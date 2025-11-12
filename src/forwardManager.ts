import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as vscode from 'vscode';
import { EnvironmentConfig, ForwardKey } from './config';

type RunningProc = {
  key: ForwardKey;
  process: ChildProcess;
  command: string;
  args: string[];
  localPort: number;
  startedAt: number;
};

export class ForwardManager {
  private processes = new Map<string, RunningProc>();
  private output: vscode.OutputChannel;
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private portFailureCounts = new Map<string, number>();
  private readonly healthGraceMs = 20000; // allow startup time before strict health checks

  constructor(private envs: EnvironmentConfig[]) {
    this.output = vscode.window.createOutputChannel('Local Dependency Forwarder');
  }

  public setEnvironments(envs: EnvironmentConfig[]) {
    this.envs = envs;
  }

  public getEnvironments(): EnvironmentConfig[] {
    return this.envs;
  }

  public async ensureSshKeys(envId: string): Promise<void> {
    const env = this.envs.find(e => e.id === envId);
    if (!env) return;
    await this.addSshKeysIfPresent(env);
  }

  public isRunning(key: ForwardKey): boolean {
    return this.processes.has(this.keyToId(key));
  }

  public async start(key: ForwardKey): Promise<void> {
    if (this.isRunning(key)) {
      return;
    }
    const env = this.envs.find(e => e.id === key.envId);
    if (!env) {
      throw new Error(`Unknown env ${key.envId}`);
    }

    // Best effort: add configured ssh keys to agent each time
    await this.addSshKeysIfPresent(env);

    if (key.kind === 'ssh') {
      const item = env.sshTunnels.find(t => t.id === key.id);
      if (!item) throw new Error(`Unknown ssh tunnel ${key.id}`);
      // port conflict check (running). Prune stale entries first.
      if (this.findByPort(item.localPort)) {
        await this.pruneDeadByPort(item.localPort);
        if (this.findByPort(item.localPort)) {
          throw new Error(`Port ${item.localPort} is already used by another forward`);
        }
      }
      const args = [
        '-v',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=60',
        '-o', 'ServerAliveCountMax=3',
        // Avoid impacting other tunnels if user has ControlMaster enabled in ssh config
        '-o', 'ControlMaster=no',
        '-o', 'ControlPersist=no',
        '-o', 'StrictHostKeyChecking=no',
        '-NL', `${item.localPort}:${item.remoteHost}:${item.remotePort}`,
        item.sshHost
      ];
      this.spawnAndTrack(key, 'ssh', args, item.localPort);
      return;
    }

    const item = env.k8sForwards.find(f => f.id === key.id);
    if (!item) throw new Error(`Unknown k8s forward ${key.id}`);
    if (this.findByPort(item.localPort)) {
      await this.pruneDeadByPort(item.localPort);
      if (this.findByPort(item.localPort)) {
        throw new Error(`Port ${item.localPort} is already used by another forward`);
      }
    }
    const args = [
      ...(env.kubectlContext ? ['--context', env.kubectlContext] : []),
      '-n', item.namespace,
      'port-forward', `services/${item.serviceName}`,
      `${item.localPort}:${item.remotePort}`
    ];
    this.spawnAndTrack(key, 'kubectl', args, item.localPort);
    console.log('kubectl port-forward', args);
  }

  public async stop(key: ForwardKey): Promise<void> {
    const id = this.keyToId(key);
    const running = this.processes.get(id);
    if (running) {
      running.process.kill();
      this.processes.delete(id);
      this.onDidChangeEmitter.fire();
    }
  }

  public async stopAllForEnv(envId: string): Promise<void> {
    for (const [id, p] of [...this.processes.entries()]) {
      if (p.key.envId === envId) {
        p.process.kill();
        this.processes.delete(id);
      }
    }
    this.onDidChangeEmitter.fire();
  }

  public async stopAll(): Promise<void> {
    if (this.processes.size === 0) return;
    for (const [id, p] of [...this.processes.entries()]) {
      try { p.process.kill(); } catch {}
      this.processes.delete(id);
    }
    this.onDidChangeEmitter.fire();
  }

  private spawnAndTrack(key: ForwardKey, command: string, args: string[], localPort: number) {
    const child = spawn(command, args, { stdio: 'pipe' });
    const id = this.keyToId(key);
    this.processes.set(id, { key, process: child, command, args, localPort, startedAt: Date.now() });
    this.output.appendLine(`Started: ${command} ${args.join(' ')}`);
    this.onDidChangeEmitter.fire();
    child.stdout?.on('data', d => {
      this.output.append(d.toString());
    });
    child.stderr?.on('data', d => {
      this.output.append(d.toString());
    });
    child.on('exit', (code, signal) => {
      this.output.appendLine(`Stopped: ${command} ${args.join(' ')} (code=${code} signal=${signal})`);
      this.processes.delete(id);
      this.onDidChangeEmitter.fire();
    });
    child.on('error', (err) => {
      this.output.appendLine(`Failed to start: ${command} ${args.join(' ')} (error=${String(err)})`);
      this.processes.delete(id);
      this.onDidChangeEmitter.fire();
    });

    // Removed non-authoritative 5s port check to avoid false negatives
  }

  private keyToId(key: ForwardKey): string {
    return `${key.envId}:${key.kind}:${key.id}`;
  }

  public validateConfigDuplicates(): string[] {
    const errors: string[] = [];
    for (const env of this.envs) {
      const seen = new Map<number, string[]>();
      const add = (port: number, label: string) => {
        const list = seen.get(port) ?? [];
        list.push(label);
        seen.set(port, list);
      };
      for (const t of env.sshTunnels) add(t.localPort, `ssh:${t.id}`);
      for (const f of env.k8sForwards) add(f.localPort, `k8s:${f.id}`);
      for (const [port, labels] of seen.entries()) {
        if (labels.length > 1) {
          errors.push(`Env ${env.name}: localPort ${port} used by ${labels.join(', ')}`);
        }
      }
    }
    return errors;
  }

  public findByPort(port: number): RunningProc | undefined {
    for (const p of this.processes.values()) {
      if (p.localPort === port) return p;
    }
    return undefined;
  }

  public getOccupiedPorts(): number[] {
    const ports: number[] = [];
    for (const p of this.processes.values()) ports.push(p.localPort);
    return ports;
  }

  public getPortUsage(): { port: number; key: string }[] {
    const list: { port: number; key: string }[] = [];
    for (const p of this.processes.values()) {
      list.push({ port: p.localPort, key: this.keyToId(p.key) });
    }
    return list;
  }

  public getAllConfiguredPorts(): number[] {
    const ports: number[] = [];
    for (const env of this.envs) {
      for (const t of env.sshTunnels) ports.push(t.localPort);
      for (const f of env.k8sForwards) ports.push(f.localPort);
    }
    return Array.from(new Set(ports));
  }

  public async killSshByPorts(ports: number[]): Promise<number[]> {
    const killed: number[] = [];
    const uniquePorts = Array.from(new Set(ports));
    for (const port of uniquePorts) {
      try {
        // macOS/Linux: get PIDs (-t: terse pids) listening on port, restricted to ssh command
        const proc = spawn('lsof', ['-tiTCP:' + String(port), '-sTCP:LISTEN', '-n', '-P', '-c', 'ssh']);
        const bufs: Buffer[] = [];
        const errs: Buffer[] = [];
        await new Promise<void>((resolve) => {
          proc.stdout?.on('data', d => bufs.push(Buffer.from(d)));
          proc.stderr?.on('data', d => errs.push(Buffer.from(d)));
          proc.on('close', () => resolve());
        });
        const out = Buffer.concat(bufs).toString('utf8').trim();
        if (!out) continue;
        const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            killed.push(pid);
            this.output.appendLine(`Killed ssh pid=${pid} on port ${port}`);
          } catch (e) {
            this.output.appendLine(`Failed killing ssh pid=${pid} on port ${port}: ${String(e)}`);
          }
        }
      } catch (e) {
        this.output.appendLine(`lsof not available or failed for port ${port}: ${String(e)}`);
      }
    }
    return killed;
  }

  public async killKubectlByPorts(ports: number[]): Promise<number[]> {
    const killed: number[] = [];
    const uniquePorts = Array.from(new Set(ports));
    for (const port of uniquePorts) {
      try {
        // Find kubectl processes listening on the specific TCP port
        const proc = spawn('lsof', ['-tiTCP:' + String(port), '-sTCP:LISTEN', '-n', '-P', '-c', 'kubectl']);
        const bufs: Buffer[] = [];
        const errs: Buffer[] = [];
        await new Promise<void>((resolve) => {
          proc.stdout?.on('data', d => bufs.push(Buffer.from(d)));
          proc.stderr?.on('data', d => errs.push(Buffer.from(d)));
          proc.on('close', () => resolve());
        });
        const out = Buffer.concat(bufs).toString('utf8').trim();
        if (!out) continue;
        const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            killed.push(pid);
            this.output.appendLine(`Killed kubectl pid=${pid} on port ${port}`);
          } catch (e) {
            this.output.appendLine(`Failed killing kubectl pid=${pid} on port ${port}: ${String(e)}`);
          }
        }
      } catch (e) {
        this.output.appendLine(`lsof not available or failed for port ${port}: ${String(e)}`);
      }
    }
    return killed;
  }

  public async killAnyByPorts(ports: number[]): Promise<number[]> {
    const killed: number[] = [];
    const uniquePorts = Array.from(new Set(ports));
    for (const port of uniquePorts) {
      try {
        // Kill any process LISTENing on the port (no command filter)
        const proc = spawn('lsof', ['-tiTCP:' + String(port), '-sTCP:LISTEN', '-n', '-P']);
        const bufs: Buffer[] = [];
        const errs: Buffer[] = [];
        await new Promise<void>((resolve) => {
          proc.stdout?.on('data', d => bufs.push(Buffer.from(d)));
          proc.stderr?.on('data', d => errs.push(Buffer.from(d)));
          proc.on('close', () => resolve());
        });
        const out = Buffer.concat(bufs).toString('utf8').trim();
        if (!out) continue;
        const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            killed.push(pid);
            this.output.appendLine(`Killed pid=${pid} listening on port ${port}`);
          } catch (e) {
            this.output.appendLine(`Failed killing pid=${pid} on port ${port}: ${String(e)}`);
          }
        }
      } catch (e) {
        this.output.appendLine(`lsof not available or failed for port ${port}: ${String(e)}`);
      }
    }
    return killed;
  }

  public async healthCheck(): Promise<void> {
    let changed = false;
    const now = Date.now();
    for (const [id, p] of this.processes.entries()) {
      // Remove if the child has already exited
      if (p.process.exitCode !== null) {
        this.output.appendLine(`Health: ${id} process exited (code=${p.process.exitCode}).`);
        this.processes.delete(id);
        this.portFailureCounts.delete(id);
        changed = true;
        continue;
      }
      // Require multiple consecutive port failures before taking action
      const age = now - p.startedAt;
      if (age < this.healthGraceMs) {
        // within grace, skip port checks to avoid flapping during startup
        continue;
      }
      const ok = await this.isPortOpenNow(p.localPort, 1200);
      if (ok) {
        if (this.portFailureCounts.has(id)) this.portFailureCounts.delete(id);
        continue;
      }
      const failures = (this.portFailureCounts.get(id) || 0) + 1;
      this.output.appendLine(`Health: ${id} port ${p.localPort} closed (${failures}/3).`);
      this.portFailureCounts.set(id, failures);
      if (failures >= 3) {
        try { p.process.kill(); } catch {}
        this.processes.delete(id);
        this.portFailureCounts.delete(id);
        this.output.appendLine(`Health: ${id} removed after ${failures} failures.`);
        changed = true;
      }
    }
    if (changed) this.onDidChangeEmitter.fire();
  }

  private async isPortOpenNow(port: number, timeoutMs: number): Promise<boolean> {
    return await new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, timeoutMs);
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        clearTimeout(timer);
        settled = true;
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        clearTimeout(timer);
        if (!settled) { settled = true; }
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async addSshKeysIfPresent(env: EnvironmentConfig): Promise<void> {
    const keys = env.sshAddKeys || [];
    if (!keys.length) {
      return;
    }
    const expand = (p: string): string => {
      if (!p) {
        return p;
      }
      if (p.startsWith('~')) {
        return path.join(os.homedir(), p.slice(1));
      }
      return p;
    };
    const candidates = Array.from(new Set(keys.map(expand)));
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) {
          continue;
        }
        await new Promise<void>((resolve) => {
          const proc = spawn('ssh-add', ['-q', file], { stdio: 'ignore' });
          proc.on('close', () => resolve());
          proc.on('error', () => resolve());
        });
        this.output.appendLine(`ssh-add attempted for ${file}`);
      } catch {
        // ignore
      }
    }
  }

  private async pruneDeadByPort(port: number): Promise<void> {
    const holder = this.findByPort(port);
    if (!holder) {
      return;
    }
    const ok = await this.isPortOpenNow(port, 300);
    if (!ok) {
      try { holder.process.kill(); } catch {}
      for (const [id, p] of this.processes.entries()) {
        if (p.localPort === port) {
          this.processes.delete(id);
        }
      }
      this.onDidChangeEmitter.fire();
    }
  }
}


