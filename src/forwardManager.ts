import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as vscode from 'vscode';
import { EnvironmentConfig, ForwardKey } from './config';

type RunningProc = {
  key: ForwardKey;
  process: ChildProcess;
  command: string;
  args: string[];
  localPort: number;
};

export class ForwardManager {
  private processes = new Map<string, RunningProc>();
  private output: vscode.OutputChannel;

  constructor(private envs: EnvironmentConfig[]) {
    this.output = vscode.window.createOutputChannel('Local Dependency Forwarder');
  }

  public setEnvironments(envs: EnvironmentConfig[]) {
    this.envs = envs;
  }

  public getEnvironments(): EnvironmentConfig[] {
    return this.envs;
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

    if (key.kind === 'ssh') {
      const item = env.sshTunnels.find(t => t.id === key.id);
      if (!item) throw new Error(`Unknown ssh tunnel ${key.id}`);
      // port conflict check (running)
      if (this.findByPort(item.localPort)) {
        throw new Error(`Port ${item.localPort} is already used by another forward`);
      }
      const args = [
        '-v',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=60',
        '-o', 'StrictHostKeyChecking=no',
        '-NL', `${item.localPort}:${item.remoteHost}:${item.remotePort}`,
        item.sshHost
      ];
      this.spawnAndTrack(key, 'ssh', args, item.localPort);
      const ok = await this.waitForPort(item.localPort, 5000);
      if (!ok) {
        await this.stop(key);
        throw new Error(`Could not connect for ${env.name}:${key.id}. Check config/credentials.`);
      }
      return;
    }

    const item = env.k8sForwards.find(f => f.id === key.id);
    if (!item) throw new Error(`Unknown k8s forward ${key.id}`);
    if (this.findByPort(item.localPort)) {
      throw new Error(`Port ${item.localPort} is already used by another forward`);
    }
    const args = [
      ...(env.kubectlContext ? ['--context', env.kubectlContext] : []),
      '-n', item.namespace,
      'port-forward', `services/${item.serviceName}`,
      `${item.localPort}:${item.remotePort}`
    ];
    this.spawnAndTrack(key, 'kubectl', args, item.localPort);
    const ok = await this.waitForPort(item.localPort, 5000);
    if (!ok) {
      await this.stop(key);
      throw new Error(`Could not start port-forward for ${env.name}:${key.id}. Check kubectl context and service.`);
    }
  }

  public async stop(key: ForwardKey): Promise<void> {
    const id = this.keyToId(key);
    const running = this.processes.get(id);
    if (running) {
      running.process.kill();
      this.processes.delete(id);
    }
  }

  public async stopAllForEnv(envId: string): Promise<void> {
    for (const [id, p] of [...this.processes.entries()]) {
      if (p.key.envId === envId) {
        p.process.kill();
        this.processes.delete(id);
      }
    }
  }

  private spawnAndTrack(key: ForwardKey, command: string, args: string[], localPort: number) {
    const child = spawn(command, args, { stdio: 'pipe' });
    const id = this.keyToId(key);
    this.processes.set(id, { key, process: child, command, args, localPort });
    this.output.appendLine(`Started: ${command} ${args.join(' ')}`);
    child.stdout?.on('data', d => {
      this.output.append(d.toString());
    });
    child.stderr?.on('data', d => {
      this.output.append(d.toString());
    });
    child.on('exit', (code, signal) => {
      this.output.appendLine(`Stopped: ${command} ${args.join(' ')} (code=${code} signal=${signal})`);
      this.processes.delete(id);
    });

    if (localPort) {
      const thisId = id;
      this.waitForPort(localPort, 5000).then(ok => {
        // Only notify if this forward is still running
        if (!ok && this.processes.has(thisId)) {
          vscode.window.showErrorMessage(`Port ${localPort} did not open. Check Output: Local Dependency Forwarder`);
        }
      });
    }
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    return await new Promise(resolve => {
      const tryOnce = () => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(tryOnce, 200);
        });
      };
      tryOnce();
    });
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
}


