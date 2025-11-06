// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { loadConfig, sampleConfig, ForwardKey, EnvironmentConfig, writeSampleConfig } from './config';
import { ForwardManager } from './forwardManager';
import { AdminPanel, buildHtml, WebviewMessage } from './panel';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    console.log('local-dependency-forwarder activated');

    let currentEnvs: EnvironmentConfig[] = [];
    const load = async () => {
        const { envs, workspacePath, globalPath } = await loadConfig();
        currentEnvs = envs;
        if (!envs.length) {
            const choice = await vscode.window.showQuickPick([
                { label: 'Create Workspace Config (.vscode/local-dependency-forwarder.json)', target: 'workspace' },
                { label: 'Create Global Config (~/.vscode/local-dependency-forwarder.json)', target: 'global' }
            ], { placeHolder: 'No config found. Create a sample?' });
            if (choice) {
                const uri = await writeSampleConfig(choice.target as 'workspace' | 'global');
                if (uri) {
                    const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc);
                }
            }
        }
    };
    
    // initial load
    await load();
    const manager = new ForwardManager(currentEnvs);
    const panelHost = new AdminPanel(context);

    function runningKeys(): string[] {
        const envs = manager.getEnvironments();
        const ids: string[] = [];
        for (const env of envs) {
            for (const t of env.sshTunnels) {
                const k = { envId: env.id, kind: 'ssh' as const, id: t.id };
                if (manager.isRunning(k)) ids.push(`${env.id}:ssh:${t.id}`);
            }
            for (const f of env.k8sForwards) {
                const k = { envId: env.id, kind: 'k8s' as const, id: f.id };
                if (manager.isRunning(k)) ids.push(`${env.id}:k8s:${f.id}`);
            }
        }
        return ids;
    }

    function occupiedPorts(): number[] { return manager.getOccupiedPorts(); }
    function portUsage(): { port: number; key: string }[] { return manager.getPortUsage(); }

    const disposable = vscode.commands.registerCommand('local-dependency-forwarder.openPanel', () => {
        // reload config each open
        load().then(() => manager.setEnvironments(currentEnvs));
        const webview = panelHost.show(wv => buildHtml(wv, context.extensionUri), () => {/* no-op */});
        const configErrors = manager.validateConfigDuplicates();
        if (configErrors.length) {
            vscode.window.showErrorMessage('Config errors: ' + configErrors.join(' | '));
        }
        const sendInit = () => webview.postMessage({ type: 'init', envs: manager.getEnvironments(), running: runningKeys(), occupied: occupiedPorts(), usage: portUsage() });
        webview.onDidReceiveMessage(async (message: WebviewMessage) => {
            if (message.type === 'ready') {
                sendInit();
                return;
            }
            // @ts-ignore allow extra message type from webview
            if ((message as any).type === 'notify') {
                const m: any = message as any;
                vscode.window.showInformationMessage(String(m.text || ''));
                return;
            }
            if (message.type === 'toggle') {
                const key: ForwardKey = message.key;
                try {
                    if (manager.isRunning(key)) {
                        await manager.stop(key);
                    } else {
                        await manager.start(key);
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(String(e?.message ?? e));
                }
                webview.postMessage({ type: 'status', running: runningKeys(), occupied: occupiedPorts(), usage: portUsage() });
                return;
            }
            if (message.type === 'toggleAll') {
                if (message.start) {
                    const env = manager.getEnvironments().find(e => e.id === message.envId);
                    if (env) {
                        for (const t of env.sshTunnels) { try { await manager.start({ envId: env.id, kind: 'ssh', id: t.id }); } catch {} }
                        for (const f of env.k8sForwards) { try { await manager.start({ envId: env.id, kind: 'k8s', id: f.id }); } catch {} }
                    }
                } else {
                    await manager.stopAllForEnv(message.envId);
                }
                webview.postMessage({ type: 'status', running: runningKeys(), occupied: occupiedPorts(), usage: portUsage() });
                return;
            }
        }, undefined, context.subscriptions);
    });

    context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
