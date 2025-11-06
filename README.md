### Local Dependency Forwarder

Forward database/redis/rabbitmq and Kubernetes services to your machine with one-click toggles in a VS Code panel.

### Why
- Quickly switch between environments (e.g. TH/PH) while developing locally.
- Prevent port conflicts automatically and show who is using a port.

### Features
- Admin panel with environment cards and master/item toggles
- SSH tunnels (ssh -NL) and `kubectl port-forward`
- Port conflict detection and friendly messages
- Configurable via JSON at workspace and/or global level

### Requirements
- ssh client available on PATH and access to your jump hosts
- kubectl for Kubernetes forwards (optional)

### Configuration
The extension reads environments from (merged, workspace overrides global):
- Workspace: `.vscode/local-dependency-forwarder.json`
- Global: `~/.vscode/local-dependency-forwarder.json`

Each file contains an array of environments:

```json
[
  {
    "id": "th",
    "name": "TH",
    "kubectlContext": "stg4",
    "sshTunnels": [
      { "id": "db-3316", "title": "database:3316", "localPort": 3316, "remoteHost": "1.2.3.4", "remotePort": 3306, "sshHost": "stg4" }
    ],
    "k8sForwards": [
      { "id": "loan-trade", "title": "loan-trade:18001", "namespace": "th-finance", "serviceName": "loan-trade", "localPort": 18001, "remotePort": 8001 }
    ]
  }
]
```

Tips:
- Use unique `localPort` values per environment to avoid conflicts.
- The panel shows a tooltip/explainer if a port is already in use.

### Usage
1. Command Palette → `Local Dependency Forwarder: Open Panel`
2. Toggle items or the environment switch. The master switch turns ON when any item is ON.
3. Check Output → `Local Dependency Forwarder` for ssh/kubectl logs.

### Privacy
No credentials or host details are stored in the extension. Put your endpoints in the JSON config files listed above.

### License
MIT
