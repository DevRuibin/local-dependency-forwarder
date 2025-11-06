(function(){
  const vscode = acquireVsCodeApi();
  let state;

  const logEl = document.getElementById('log');
  function log(msg){ if (!logEl) return; logEl.textContent += "\n" + msg; }
  window.onerror = function(message, source, lineno, colno){
    log('Error: ' + message + ' @' + lineno + ':' + colno);
  };

  function envCard(env){
    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'header';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = env.name;
    const master = document.createElement('input');
    master.type = 'checkbox';
    master.className = 'toggle';
    master.addEventListener('change', () => {
      vscode.postMessage({ type: 'toggleAll', envId: env.id, start: master.checked });
    });
    header.appendChild(master); header.appendChild(title);
    card.appendChild(header);

    const rows = [];
    function addRow(label, keyId){
      const row = document.createElement('div'); row.className = 'row';
      const icon = document.createElement('div'); icon.className = 'power';
      const text = document.createElement('div'); text.textContent = label;
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'toggle'; toggle.dataset.key = keyId;
      toggle.addEventListener('click', (e) => {
        if (isBlocked(env, keyId)) {
          e.preventDefault(); e.stopPropagation();
          const reason = blockedReason(env, keyId);
          vscode.postMessage({ type: 'notify', level: 'info', text: reason });
        }
      });
      toggle.addEventListener('change', () => {
        const parts = keyId.split(':');
        const envId = parts[0], kind = parts[1], id = parts[2];
        vscode.postMessage({ type: 'toggle', key: { envId, kind, id } });
      });
      row.appendChild(icon); row.appendChild(text); row.appendChild(toggle);
      rows.push(toggle); card.appendChild(row);
    }

    for (const t of env.sshTunnels) { const key = env.id + ':ssh:' + t.id; addRow(t.title, key); }
    for (const f of env.k8sForwards) { const key = env.id + ':k8s:' + f.id; addRow(f.title, key); }

    card.update = (running) => {
      let anyOn = false;
      for (const input of rows){
        const k = input.dataset.key; const isOn = running.includes(k);
        input.checked = isOn; if (isOn) anyOn = true;
      }
      master.checked = anyOn;
    };

    return card;
  }

  function render(envs, running, occupied, usage){
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    const cards = [];
    for (const env of envs){ const c = envCard(env); grid.appendChild(c); cards.push({ env, card: c }); }
    if (logEl) { logEl.remove(); }
    update(running, occupied, usage);
    state = { envs, running, occupied, usage };
    window.state = state;

    function update(r, occ, use){
      for (const { env, card } of cards) {
        card.update(r);
        // disable conflicting toggles
        const inputs = card.querySelectorAll('input.toggle');
        for (const input of inputs){
          const key = input.dataset.key;
          if (!key) continue;
          const port = portForKey(env, key);
          const isRunning = r.includes(key);
          const holder = use && use.find(u => u.port === port);
          const blocked = !isRunning && !!holder;
          if (blocked) input.classList.add('blocked'); else input.classList.remove('blocked');
          input.dataset.blocked = blocked ? '1' : '';
          input.dataset.blockedReason = blocked ? (`Port ${port} in use by ${holder.key}`) : '';
          input.title = input.dataset.blockedReason || '';
        }
      }
    }
    render.update = update;
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'init') { log('init received'); render(message.envs, message.running, message.occupied, message.usage); }
    if (message.type === 'status') {
      state.running = message.running; state.occupied = message.occupied; state.usage = message.usage; window.state = state;
      if (render.update) render.update(state.running, state.occupied, state.usage);
    }
  });

  log('boot');
  vscode.postMessage({ type: 'ready' });
})();

function portForKey(env, key){
  const [, kind, id] = key.split(':');
  if (kind === 'ssh') { const t = env.sshTunnels.find(x => x.id === id); return t ? t.localPort : undefined; }
  if (kind === 'k8s') { const f = env.k8sForwards.find(x => x.id === id); return f ? f.localPort : undefined; }
  return undefined;
}

function isBlocked(env, key){ return !!blockedReason(env, key); }
function blockedReason(env, key){
  if (!window.state || !window.state.usage) return '';
  const port = portForKey(env, key);
  const holder = window.state.usage.find(u => u.port === port);
  const isRunning = window.state.running && window.state.running.includes(key);
  if (!isRunning && holder) return `Port ${port} in use by ${holder.key}`;
  return '';
}


