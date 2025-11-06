export type SshTunnel = {
  id: string;
  title: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  sshHost: string;
};

export type K8sForward = {
  id: string;
  title: string;
  namespace: string;
  serviceName: string;
  localPort: number;
  remotePort: number;
};

export type EnvironmentConfig = {
  id: string;
  name: string;
  kubectlContext?: string;
  sshTunnels: SshTunnel[];
  k8sForwards: K8sForward[];
};

export type ForwardKey = { envId: string; kind: 'ssh' | 'k8s'; id: string };

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export function getWorkspaceConfigUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return vscode.Uri.joinPath(folder.uri, '.vscode/local-dependency-forwarder.json');
}

export function getGlobalConfigUri(): vscode.Uri {
  const p = path.join(os.homedir(), '.vscode', 'local-dependency-forwarder.json');
  return vscode.Uri.file(p);
}

function parseJsonOrEmpty<T>(buf: Uint8Array | undefined): T | undefined {
  if (!buf) return undefined;
  try { return JSON.parse(Buffer.from(buf).toString('utf8')) as T; } catch { return undefined; }
}

function mergeEnvs(globalEnvs: EnvironmentConfig[] | undefined, workspaceEnvs: EnvironmentConfig[] | undefined): EnvironmentConfig[] {
  const map = new Map<string, EnvironmentConfig>();
  for (const list of [globalEnvs || [], workspaceEnvs || []]) {
    for (const env of list) map.set(env.id, env);
  }
  return Array.from(map.values());
}

export async function loadConfig(): Promise<{ envs: EnvironmentConfig[]; workspacePath?: vscode.Uri; globalPath?: vscode.Uri }> {
  const wUri = getWorkspaceConfigUri();
  const gUri = getGlobalConfigUri();
  let wEnvs: EnvironmentConfig[] | undefined;
  let gEnvs: EnvironmentConfig[] | undefined;
  try { if (wUri) { const buf = await vscode.workspace.fs.readFile(wUri); wEnvs = parseJsonOrEmpty<EnvironmentConfig[]>(buf); } } catch {}
  try { const buf = await vscode.workspace.fs.readFile(gUri); gEnvs = parseJsonOrEmpty<EnvironmentConfig[]>(buf); } catch {}
  const envs = mergeEnvs(gEnvs, wEnvs);
  return { envs, workspacePath: wUri, globalPath: gUri };
}

export function sampleConfig(): EnvironmentConfig[] {
  return [
    {
      id: 'example',
      name: 'Example',
      kubectlContext: 'your-kube-context',
      sshTunnels: [
        { id: 'db', title: 'database:3316', localPort: 3316, remoteHost: '1.2.3.4', remotePort: 3306, sshHost: 'stg' }
      ],
      k8sForwards: [
        { id: 'svc', title: 'service:18001', namespace: 'ns', serviceName: 'svc', localPort: 18001, remotePort: 8001 }
      ]
    }
  ];
}

export async function writeSampleConfig(target: 'workspace' | 'global'): Promise<vscode.Uri | undefined> {
  const uri = target === 'workspace' ? getWorkspaceConfigUri() : getGlobalConfigUri();
  if (!uri) return undefined;
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(dir);
  const content = Buffer.from(JSON.stringify(sampleConfig(), null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(uri, content);
  return uri;
}

