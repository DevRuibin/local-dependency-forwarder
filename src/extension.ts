// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { loadConfig, ForwardKey, EnvironmentConfig, writeSampleConfig } from './config';
import { ForwardManager } from './forwardManager';
import { AdminPanel, buildHtml, WebviewMessage } from './panel';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    console.log('local-dependency-forwarder activated');

    let currentEnvs: EnvironmentConfig[] = [];
    const load = async () => {
        const { envs } = await loadConfig();
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
                if (manager.isRunning(k)) { ids.push(`${env.id}:ssh:${t.id}`); }
            }
            for (const f of env.k8sForwards) {
                const k = { envId: env.id, kind: 'k8s' as const, id: f.id };
                if (manager.isRunning(k)) { ids.push(`${env.id}:k8s:${f.id}`); }
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
        const post = (msg: any) => { void webview.postMessage(msg); };
        const sendInit = () => post({ type: 'init', envs: manager.getEnvironments(), running: runningKeys(), occupied: occupiedPorts(), usage: portUsage() });
        const sendStatus = () => post({ type: 'status', running: runningKeys(), occupied: occupiedPorts(), usage: portUsage() });
        // fire an eager init as a fallback
        setTimeout(() => sendInit(), 50);
        // subscribe to manager changes
        const changeSub = manager.onDidChange(() => { sendStatus(); });
        context.subscriptions.push({ dispose: () => (changeSub as any)?.dispose?.() });
        // periodic health check to reflect crashed/closed forwards
        const timer = setInterval(async () => { try { await manager.healthCheck(); } catch {} finally { sendStatus(); } }, 3000);
        context.subscriptions.push({ dispose: () => clearInterval(timer) });
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
                post({ type: 'status', running: runningKeys(), occupied: occupiedPorts(), usage: portUsage() });
                return;
            }
            if (message.type === 'toggleAll') {
                if (message.start) {
                    const env = manager.getEnvironments().find(e => e.id === message.envId);
                    if (env) {
                        const tasks: Promise<any>[] = [];
                        for (const t of env.sshTunnels) {
                            tasks.push(manager.start({ envId: env.id, kind: 'ssh', id: t.id }).catch(() => {}));
                        }
                        for (const f of env.k8sForwards) {
                            tasks.push(manager.start({ envId: env.id, kind: 'k8s', id: f.id }).catch(() => {}));
                        }
                        await Promise.allSettled(tasks);
                    }
                } else {
                    await manager.stopAllForEnv(message.envId);
                }
                sendStatus();
                return;
            }
            // @ts-ignore: support extra message type from webview
            if ((message as any).type === 'stopAll') {
                try {
                    await manager.stopAll();
                    const ports = manager.getAllConfiguredPorts();
                    await manager.killSshByPorts(ports);
                    await manager.killKubectlByPorts(ports);
                    await manager.killAnyByPorts(ports);
                } catch (e: any) {
                    vscode.window.showErrorMessage(String(e?.message ?? e));
                }
                sendStatus();
                return;
            }
        }, undefined, context.subscriptions);
    });

    context.subscriptions.push(disposable);

    // Command: Stop All Forwards (also clean ssh listeners on configured ports)
    context.subscriptions.push(vscode.commands.registerCommand('local-dependency-forwarder.stopAll', async () => {
        try {
            await manager.stopAll();
            const ports = manager.getAllConfiguredPorts();
            const killedSsh = await manager.killSshByPorts(ports);
            const killedKubectl = await manager.killKubectlByPorts(ports);
            const killedAny = await manager.killAnyByPorts(ports);
            const parts: string[] = [];
            if (killedSsh.length) { parts.push(`killed ${killedSsh.length} ssh listener(s)`); }
            if (killedKubectl.length) { parts.push(`killed ${killedKubectl.length} kubectl listener(s)`); }
            if (killedAny.length) { parts.push(`killed ${killedAny.length} other listener(s)`); }
            vscode.window.showInformationMessage(`Stopped all forwards${parts.length ? `, ${parts.join(', ')}` : ''}.`);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e?.message ?? e));
        }
    }));

    // Command: Reset (Kill Orphaned) - aggressively clean listeners on configured ports
    context.subscriptions.push(vscode.commands.registerCommand('local-dependency-forwarder.resetOrphans', async () => {
        try {
            const ports = manager.getAllConfiguredPorts();
            const killedSsh = await manager.killSshByPorts(ports);
            const killedKubectl = await manager.killKubectlByPorts(ports);
            const killedAny = await manager.killAnyByPorts(ports);
            const parts: string[] = [];
            if (killedSsh.length) { parts.push(`killed ${killedSsh.length} ssh listener(s)`); }
            if (killedKubectl.length) { parts.push(`killed ${killedKubectl.length} kubectl listener(s)`); }
            if (killedAny.length) { parts.push(`killed ${killedAny.length} other listener(s)`); }
            vscode.window.showInformationMessage(`Reset complete${parts.length ? `, ${parts.join(', ')}` : ''}.`);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e?.message ?? e));
        }
    }));
}

// This method is called when your extension is deactivated
export function deactivate() {}
