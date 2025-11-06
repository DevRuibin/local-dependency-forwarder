import * as vscode from 'vscode';
import { EnvironmentConfig, ForwardKey } from './config';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'toggle'; key: ForwardKey }
  | { type: 'toggleAll'; envId: string; start: boolean };

export type HostMessage =
  | { type: 'init'; envs: EnvironmentConfig[]; running: string[] }
  | { type: 'status'; running: string[] };

export class AdminPanel {
  static readonly viewType = 'localDependencyForwarder.admin';
  private panel?: vscode.WebviewPanel;

  constructor(private context: vscode.ExtensionContext) {}

  public show(getHtml: (webview: vscode.Webview) => string, onDidDispose: () => void): vscode.Webview {
    if (this.panel) {
      this.panel.reveal();
      return this.panel.webview;
    }
    this.panel = vscode.window.createWebviewPanel(
      AdminPanel.viewType,
      'Local Dependency Forwarder',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    this.panel.webview.html = getHtml(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = undefined; onDidDispose(); }, null, this.context.subscriptions);
    return this.panel.webview;
  }
}

export function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};`;
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Local Dependency Forwarder</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, Noto Sans, 'Apple Color Emoji', 'Segoe UI Emoji'; padding: 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
      .card { background: #eef3fb; border-radius: 8px; padding: 12px 16px; box-shadow: 0 0 0 1px #d9e2f3 inset; }
      .header { display:flex; align-items:center; justify-content: space-between; margin-bottom: 8px; }
      .title { font-weight: 600; letter-spacing: .02em; }
      .row { display:grid; grid-template-columns: 22px 1fr 1fr; align-items:center; gap: 8px; padding: 6px 4px; }
      .row:hover { background: #e7eefc; border-radius: 4px; }
      .power { width: 18px; height: 18px; border: 2px solid #334; border-radius: 50%; position: relative; }
      .power::after { content: ''; position: absolute; top: -3px; left: 50%; transform: translateX(-50%); width: 2px; height: 8px; background: #334; border-radius: 1px; }
      .toggle { appearance: none; width: 38px; height: 22px; background: #bcc8dd; border-radius: 999px; position: relative; outline: none; cursor: pointer; transition: .15s; }
      .toggle:checked { background: #3b82f6; }
      .toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; background: white; border-radius: 999px; transition: .15s; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
      .toggle:checked::after { transform: translateX(16px); }
      .muted { color: #465; opacity: .8; font-size: 12px; }
      .blocked { opacity: .5; cursor: not-allowed; }
    </style>
  </head>
  <body>
    <div class="grid" id="grid"></div>
    <pre id="log" class="muted">Loading…</pre>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
  </html>`;
}


