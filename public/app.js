/**
 * AstroControl — app.js
 * Estado central → render via rAF
 * WebSocket com backoff e heartbeat
 * Fila de comandos offline
 * Auth segura do terminal via POST
 * Fullscreen para abas remotas
 */

'use strict';

/* ══════════════════════════════════════════════
   ESTADO CENTRAL
   ══════════════════════════════════════════════ */

const STATE = {
  wsConnected: false,
  indiConnected: false,
  devices: {
    mount: { connected: false, state: 'disconnected', ra: null, dec: null, alt: null, az: null, tracking: null, parked: false, slewing: false },
    camera: { connected: false, state: 'disconnected', exposure: null, gain: null, capturing: false },
    focuser: { connected: false, state: 'disconnected', position: null, moving: false },
    filterwheel: { connected: false, state: 'disconnected', slot: null, filter: null, filterNames: [] },
    rotator: { connected: false, state: 'disconnected', angle: null },
    gps: { connected: false, state: 'disconnected', lat: null, lon: null, fix: false, sats: 0 },
  },
  currentTab: 'mount',
  sessionTab: 'setup',
  slewRate: 16,
  tracking: null,
  gotoStatus: null,
  network: { mode: '--', ip: '--', ssid: '--', signal: '--', ap_active: false, ap_clients: 0, services: {}, wifi_status: '' },
  drivers: [],
  indiserver: false,
  phd2: { online: false, connected: false, appState: 'offline', equipment: null, exposure: null, error: null },
  sequence: {
    queue: [],
    running: false,
    paused: false,
    currentIndex: -1,
    frameInItem: 0,
    doneFrames: 0,
    totalFrames: 0,
    awaitingFrame: false,
    status: 'Pronto',
  },
  logs: [],
  customDrivers: [],
  devicePorts: {},
};

let rafPending = false;
let _rotCommitTimer = null;

function setState(patch) {
  deepMerge(STATE, patch);
  scheduleRender();
}

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] !== null && typeof src[k] === 'object' && !Array.isArray(src[k])
      && target[k] !== null && typeof target[k] === 'object') {
      deepMerge(target[k], src[k]);
    } else {
      target[k] = src[k];
    }
  }
}

function scheduleRender() {
  if (!rafPending) { rafPending = true; requestAnimationFrame(render); }
}

/* ══════════════════════════════════════════════
   RENDER
   ══════════════════════════════════════════════ */

function render() {
  rafPending = false;

  setDot('pi', STATE.wsConnected);
  setDot('indi', STATE.indiConnected);
  setDot('ap', STATE.network.ap_active);
  renderGpsSatIndicator();

  if (STATE.currentTab === 'mount') renderMount();
  if (STATE.currentTab === 'capture') renderCapture();
  if (STATE.currentTab === 'drivers') renderDrivers();
  if (STATE.currentTab === 'network') renderNetwork();

  renderGotoStatus();
}

function renderMount() {
  const m = STATE.devices.mount;
  const f = STATE.devices.focuser;
  const r = STATE.devices.rotator;
  const fw= STATE.devices.filterwheel;
  const c = STATE.devices.camera;

  // ── Coordenadas ──
  setText('m-ra',  m.ra  || '--');
  setText('m-dec', m.dec || '--');
  setText('m-alt', m.alt  != null ? m.alt  + '°' : '--');
  setText('m-az',  m.az   != null ? m.az   + '°' : '--');

  // ── Badge de estado ──
  const badge = $('mount-state-badge');
  if (badge) {
    const labels = { disconnected:'Desconectado', idle:'Pronto', tracking:'Rastreando', slewing:'Slewing…', parked:'Park', error:'Erro' };
    badge.textContent = labels[m.state] || m.state;
    badge.className = 'mount-badge mount-badge-' + (m.state || 'disconnected');
  }

  // ── Pier side ──
  const pier = $('pier-badge');
  if (pier) {
    const side = m.pierSide || null;
    if (side === 'W' || side === 'West') {
      pier.textContent = 'W · Leste'; pier.className = 'pier-badge west';
    } else if (side === 'E' || side === 'East') {
      pier.textContent = 'E · Oeste'; pier.className = 'pier-badge east';
    } else {
      pier.textContent = '–'; pier.className = 'pier-badge';
    }
  }

  // ── Park button ──
  const btnPark = $('btn-park');
  if (btnPark) btnPark.classList.toggle('parked', !!m.parked);

  // ── Rastreamento ──
  document.querySelectorAll('.trk button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === STATE.tracking);
  });

  // ── Meridiano (ha = hora angle estimado via AR e LST) ──
  renderMeridianBar(m);

  // ── Focalizador ──
  setText('focus-pos', f.position != null ? f.position : '--');
  const fbadge = $('focus-state-badge');
  if (fbadge) {
    if (!f.connected)    { fbadge.textContent = 'Offline'; fbadge.className = 'sec-badge'; }
    else if (f.moving)   { fbadge.textContent = 'Movendo'; fbadge.className = 'sec-badge busy'; }
    else                 { fbadge.textContent = 'OK';      fbadge.className = 'sec-badge ok'; }
  }
  // Atualiza abs input como hint
  const fabsInp = $('focus-abs-val');
  if (fabsInp && f.position != null && fabsInp !== document.activeElement) {
    fabsInp.value = f.position;
  }

  // ── Roda de filtros ──
  renderFilterSlots(fw);
  const fwbadge = $('filter-state-badge');
  if (fwbadge) {
    if (!fw.connected)   { fwbadge.textContent = 'Offline'; fwbadge.className = 'sec-badge'; }
    else if (fw.filter)  { fwbadge.textContent = fw.filter; fwbadge.className = 'sec-badge ok'; }
    else                 { fwbadge.textContent = `Slot ${fw.slot || '?'}`; fwbadge.className = 'sec-badge ok'; }
  }

  // ── Rotacionador ──
  renderRotator(r);

  // ── Câmera ──
  renderCameraMini(c);
}

function renderMeridianBar(m) {
  // Estimativa de hora angular: usamos ra_raw e longitude do GPS
  const meridPos = $('meridian-pos');
  const meridVal = $('meridian-val');
  if (!meridPos || !meridVal) return;

  const ra = m.ra_raw;
  const lat= STATE.devices.gps?.lat;
  if (ra == null) { meridVal.textContent = '--'; meridPos.style.left = '50%'; return; }

  // LST aproximado: usa hora UTC + longitude
  const now = new Date();
  const lon = STATE.devices.gps?.lon || 0;
  const jd  = 2440587.5 + now.getTime() / 86400000;
  const T   = (jd - 2451545.0) / 36525;
  let gmst  = 280.46061837 + 360.98564736629 * (jd - 2451545) + T * T * 0.000387933;
  gmst = ((gmst % 360) + 360) % 360;
  const lst = (gmst + lon) / 15; // em horas
  const ha  = ((lst - ra) % 24 + 24) % 24; // hora angular 0-24
  const haDeg = ha > 12 ? ha - 24 : ha;    // -12 a +12

  // Posiciona o indicador: centro = meridiano (0h)
  const pct = 50 + (haDeg / 12) * 50;
  meridPos.style.left = Math.max(2, Math.min(98, pct)) + '%';

  const haH = Math.floor(Math.abs(haDeg));
  const haM = Math.round((Math.abs(haDeg) - haH) * 60);
  meridVal.textContent = `${haDeg >= 0 ? '+' : '−'}${haH}h${String(haM).padStart(2,'0')}m ${haDeg >= 0 ? '(Leste)' : '(Oeste)'}`;
  meridVal.style.color = Math.abs(haDeg) > 5.5 ? 'var(--amber)' : 'var(--muted)';
}

function renderFilterSlots(fw) {
  const container = $('filter-slots');
  if (!container) return;
  if (!fw.connected || !fw.filterNames || fw.filterNames.length === 0) {
    container.innerHTML = '<span class="filter-empty">Driver offline</span>';
    return;
  }
  const chips = fw.filterNames.map((name, i) => {
    const slot = i + 1;
    const active = fw.slot === slot;
    return `<button class="filter-chip ${active ? 'active' : ''}" onclick="setFilter(${slot})">${name || 'Filtro ' + slot}</button>`;
  }).join('');
  if (container.innerHTML !== chips) container.innerHTML = chips;
}

function renderRotator(r) {
  const angle   = parseFloat(r.angle) || 0;
  const clamped = Math.max(-90, Math.min(90, angle));

  // Badge
  const rbadge = $('rot-state-badge');
  if (rbadge) {
    if (!r.connected)  { rbadge.textContent = 'Offline'; rbadge.className = 'sec-badge'; }
    else if (r.moving) { rbadge.textContent = 'Girando'; rbadge.className = 'sec-badge busy'; }
    else               { rbadge.textContent = (clamped >= 0 ? '+' : '') + clamped.toFixed(1) + '°'; rbadge.className = 'sec-badge ok'; }
  }
  setText('rot-angle', r.connected ? (clamped >= 0 ? '+' : '') + clamped.toFixed(1) : '--');

  // ── Agulha ──
  // 0° → topo (270° em coord matemática), +90° → direita (0°), -90° → esquerda (180°)
  const needleRad = (clamped - 90) * Math.PI / 180;
  const nx = 40 + 31 * Math.cos(needleRad);
  const ny = 40 + 31 * Math.sin(needleRad);
  const needle = $('rot-needle');
  if (needle) {
    needle.setAttribute('x2', nx.toFixed(1));
    needle.setAttribute('y2', ny.toFixed(1));
  }

  // ── Arco de progresso ──
  // Estratégia: usamos um <path> que vai do ponto em -90° até o ângulo atual,
  // sempre passando pelo 0° (topo). Para isso:
  //   - centro (40,40), raio 34
  //   - ponto em -90°  = (6, 40)   → ângulo 180° em coordenadas SVG
  //   - ponto em   0°  = (40, 6)   → ângulo 270° em coordenadas SVG
  //   - ponto em +90°  = (74, 40)  → ângulo 0°   em coordenadas SVG
  // O arco parte sempre do ponto 0° (topo) e vai até o ângulo atual.
  // Se positivo → arco curto horário a partir do topo.
  // Se negativo → arco curto anti-horário a partir do topo.
  const arcEl = $('rot-arc');
  if (arcEl) {
    if (clamped === 0) {
      arcEl.setAttribute('d', '');
    } else {
      const R = 34;
      const cx = 40, cy = 40;
      // Ponto de início: sempre o topo (0°)
      const startX = cx;
      const startY = cy - R; // (40, 6)
      // Ponto final: ângulo atual
      const endRad = (clamped - 90) * Math.PI / 180;
      const endX   = cx + R * Math.cos(endRad);
      const endY   = cy + R * Math.sin(endRad);
      // large-arc-flag: 0 (arco < 180°, sempre verdade aqui pois max é 90°)
      // sweep-flag: 1 = horário (positivos), 0 = anti-horário (negativos)
      const sweep = clamped > 0 ? 1 : 0;
      arcEl.setAttribute('d',
        `M ${startX} ${startY} A ${R} ${R} 0 0 ${sweep} ${endX.toFixed(2)} ${endY.toFixed(2)}`
      );
    }
  }

  // ── Slider ──
  const slider = $('rot-slider');
  if (slider && slider !== document.activeElement) {
    slider.value = clamped;
    const pct = ((clamped + 90) / 180) * 100;
    slider.style.setProperty('--rot-pct', pct + '%');
  }
}

function renderCameraMini(c) {
  const cbadge = $('cam-state-badge');
  if (cbadge) {
    if (!c.connected)            { cbadge.textContent = 'Offline';    cbadge.className = 'sec-badge'; }
    else if (CAM.mode === 'framing')  { cbadge.textContent = 'Framing';   cbadge.className = 'sec-badge busy'; }
    else if (CAM.mode === 'capturing'){ cbadge.textContent = 'Capturando';cbadge.className = 'sec-badge busy'; }
    else                         { cbadge.textContent = 'Pronto';     cbadge.className = 'sec-badge ok'; }
  }
  // Preenche campos apenas se não estiver em foco
  const expInp  = $('cam-exp');
  const gainInp = $('cam-gain');
  if (expInp  && expInp  !== document.activeElement && c.exposure != null) expInp.value  = c.exposure;
  if (gainInp && gainInp !== document.activeElement && c.gain     != null) gainInp.value = c.gain;
}

function renderCapture() {
  const c = STATE.devices.camera;
  const f = STATE.devices.focuser;
  renderCameraMini(c);
  syncCaptureInputs(c);
  renderSessionSetup();
  renderSessionMount();
  renderGuiding();
  renderSequence();
  renderSessionLog();
  _updateCamButtons();

  setText('session-focus-pos', f.position != null ? f.position : '--');
  const sessionFocus = $('session-focus-abs');
  if (sessionFocus && sessionFocus !== document.activeElement && f.position != null) {
    sessionFocus.value = f.position;
  }
}

function syncCaptureInputs(c) {
  const pairs = [
    ['cam-exp', 'cap-exp', c.exposure],
    ['cam-gain', 'cap-gain', c.gain],
  ];

  pairs.forEach(([a, b, value]) => {
    const ea = $(a);
    const eb = $(b);
    if (value != null) {
      if (ea && ea !== document.activeElement) ea.value = value;
      if (eb && eb !== document.activeElement) eb.value = value;
    }
  });
}

function renderGuiding() {
  const p = STATE.phd2;
  setText('phd2-online', p.online ? (p.connected ? 'Conectado' : 'Online') : 'Offline');
  setText('phd2-state', p.error || p.appState || '--');
  setText('phd2-exposure', p.exposure != null ? `${p.exposure} ms` : '--');

  const eq = p.equipment;
  const eqText = eq
    ? Object.entries(eq)
        .filter(([, v]) => v && v.name)
        .map(([k, v]) => `${k}: ${v.name}${v.connected ? '' : ' off'}`)
        .join(' · ')
    : '--';
  setText('phd2-equipment', eqText || '--');
}

function renderSessionSetup() {
  setText('session-indi', STATE.indiConnected ? 'Conectado' : 'Offline');
  setText('session-setup-mount', STATE.devices.mount.connected ? (STATE.devices.mount.state || 'Pronto') : 'Offline');
  setText('session-setup-camera', STATE.devices.camera.connected ? (STATE.devices.camera.state || 'Pronta') : 'Offline');
  setText('session-setup-guide', STATE.phd2.online ? (STATE.phd2.connected ? 'Conectado' : 'Online') : 'Offline');
}

function renderSessionMount() {
  const m = STATE.devices.mount;
  setText('session-m-ra', m.ra || '--');
  setText('session-m-dec', m.dec || '--');
  setText('session-m-alt', m.alt != null ? m.alt + '°' : '--');
  setText('session-m-az', m.az != null ? m.az + '°' : '--');
}

function renderSequence() {
  const seq = STATE.sequence;
  const status = $('seq-status');
  if (status) {
    const progress = seq.totalFrames > 0 ? ` · ${seq.doneFrames}/${seq.totalFrames}` : '';
    status.textContent = `${seq.status || 'Pronto'}${progress}`;
  }

  const startBtn = $('seq-start-btn');
  if (startBtn) {
    startBtn.textContent = seq.running ? 'Executando' : 'Iniciar';
    startBtn.disabled = !!seq.running || !seq.queue.length;
  }

  const list = $('sequence-list');
  if (!list) return;

  if (!seq.queue || seq.queue.length === 0) {
    list.innerHTML = '<div class="sequence-empty">Fila vazia</div>';
    return;
  }

  const html = seq.queue.map((item, idx) => {
    const active = seq.running && idx === seq.currentIndex;
    const filter = item.filterSlot ? `Filtro ${item.filterSlot}` : 'Sem filtro';
    const dither = item.ditherEvery > 0 ? `Dither ${item.ditherEvery}` : 'Sem dither';
    const remove = seq.running
      ? ''
      : `<button class="sequence-remove" onclick="removeSequenceItem('${item.id}')">Remover</button>`;

    return `
      <div class="sequence-row ${active ? 'active' : ''}">
        <div class="sequence-main">
          <div class="sequence-title">${escapeHtml(item.target)} · ${escapeHtml(item.type)}</div>
          <div class="sequence-meta">${item.exposure}s · ganho ${item.gain} · ${item.done || 0}/${item.count} · ${filter} · ${dither}</div>
        </div>
        ${remove}
      </div>`;
  }).join('');

  if (list.innerHTML !== html) list.innerHTML = html;
}

function renderSessionLog() {
  const logEl = $('session-log');
  if (!logEl || logEl.dataset.logLen === String(STATE.logs.length)) return;

  const frag = document.createDocumentFragment();
  const sessionLogs = STATE.logs.slice(-80);
  sessionLogs.forEach(({ level, text }) => {
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.className = level;
    span.textContent = level === 'ok' ? '[OK]' : level === 'er' ? '[ER]' : level === 'wn' ? '[--]' : '[..]';
    div.appendChild(span);
    div.appendChild(document.createTextNode(' ' + text));
    frag.appendChild(div);
  });

  logEl.innerHTML = '';
  logEl.appendChild(frag);
  logEl.scrollTop = logEl.scrollHeight;
  logEl.dataset.logLen = String(STATE.logs.length);
}

function addSequenceItem() {
  if (STATE.sequence.running) return;
  const filterRaw = parseInt($('seq-filter')?.value);
  const item = {
    target: ($('seq-target')?.value || 'Alvo').trim(),
    type: $('seq-type')?.value || 'Light',
    exposure: parseFloat($('cap-exp')?.value) || 1,
    gain: parseInt($('cap-gain')?.value) || 100,
    count: parseInt($('seq-count')?.value) || 1,
    delay: parseFloat($('seq-delay')?.value) || 0,
    filterSlot: Number.isFinite(filterRaw) ? filterRaw : null,
    ditherEvery: parseInt($('seq-dither')?.value) || 0,
  };
  sendCmd({ type: 'sequence_add', item });
}

function removeSequenceItem(id) {
  sendCmd({ type: 'sequence_remove', id });
}

function clearSequenceQueue() {
  sendCmd({ type: 'sequence_clear' });
}

function startBackendSequence() {
  if (CAM.mode === 'framing') _stopFraming();
  if (CAM.mode === 'capturing') _stopCapture(true);
  sendCmd({ type: 'sequence_start' });
}

function stopBackendSequence() {
  sendCmd({ type: 'sequence_stop' }, false);
  _updateCamButtons();
}

function focusGotoSession() {
  const pos = parseInt($('session-focus-abs')?.value);
  if (isNaN(pos)) return;
  sendCmd({ type: 'focus_goto', position: pos });
}

function solverPlaceholder() {
  setText('solver-last', 'Solver local ainda não configurado');
  addLog('wn', 'Solver: integração ASTAP/StellarSolver pendente');
}

function renderDrivers() {
  /* 1. Atualiza Drivers Core (os que estão fixos no HTML) */
  const CORE_KEYS = ['mount', 'camera', 'focuser', 'filterwheel', 'rotator', 'gps', 'adxl'];
  CORE_KEYS.forEach(key => {
    const dev = STATE.devices[key];
    if (!dev) return;
    const dot = $('dot-' + key);
    const tog = $('tog-' + key);
    if (tog) tog.classList.toggle('on', !!dev.connected);
  });

  /* 2. Renderiza Drivers Customizados (Injetados dinamicamente) */
  const list = $('custom-drivers-list');
  if (list) {
    if (!STATE.customDrivers || STATE.customDrivers.length === 0) {
      list.innerHTML = '';
    } else {
      const html = STATE.customDrivers.map(bin => {
        const dev = STATE.devices[bin] || { connected: false, state: 'disconnected' };
        const dotClass = (dev.state === 'error' ? 'dr' : dev.connected ? 'dg' : dev.state !== 'disconnected' ? 'da' : 'dx');
        const togClass = dev.connected ? 'on' : '';
        const savedPort = STATE.devicePorts[bin] || '';
        return `
          <div class="drv-row">
            <span class="dot ${dotClass}"></span>
            <div class="drv-txt">
              <div class="drv-name">${bin}</div>
              <div class="drv-sub">Manual (INDI binary)</div>
            </div>
            <input type="text" class="port-input" id="port-${bin}" value="${savedPort}" placeholder="Porta" oninput="savePort('${bin}', this.value)"/>
            <button class="bp-fs sm" style="margin-right:8px; border:none; opacity:0.6" onclick="removeCustomDriver('${bin}')" title="Excluir">🗑️</button>
            <div class="tog ${togClass}" onclick="toggleDriver('${bin}')"></div>
          </div>`;
      }).join('');
      if (list.innerHTML !== html) list.innerHTML = html;
    }
  }

  const logEl = $('indi-log');
  if (logEl && logEl.dataset.logLen !== String(STATE.logs.length)) {
    const frag = document.createDocumentFragment();
    STATE.logs.forEach(({ level, text }) => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      span.className = level;
      span.textContent = level === 'ok' ? '[OK]' : level === 'er' ? '[ER]' : level === 'wn' ? '[--]' : '[..]';
      div.appendChild(span);
      div.appendChild(document.createTextNode(' ' + text));
      frag.appendChild(div);
    });
    logEl.innerHTML = '';
    logEl.appendChild(frag);
    logEl.scrollTop = logEl.scrollHeight;
    logEl.dataset.logLen = STATE.logs.length;
  }
}

function addCustomDriver() {
  const inp = $('new-driver-name');
  const bin = (inp?.value || '').trim();
  if (!bin) return;
  if (STATE.customDrivers.includes(bin)) { alert('Driver já está na lista.'); return; }

  STATE.customDrivers.push(bin);
  STATE.devices[bin] = { connected: false, state: 'disconnected' };
  
  localStorage.setItem('astro_custom_drivers', JSON.stringify(STATE.customDrivers));
  inp.value = '';
  scheduleRender();
}

function removeCustomDriver(bin) {
  if (!confirm(`Excluir driver "${bin}" da lista?`)) return;
  STATE.customDrivers = STATE.customDrivers.filter(b => b !== bin);
  delete STATE.devices[bin];
  localStorage.setItem('astro_custom_drivers', JSON.stringify(STATE.customDrivers));
  scheduleRender();
}

function renderNetwork() {
  const n = STATE.network;
  setText('net-mode', n.mode);
  setText('net-ip', n.ip);
  setText('net-ssid', n.ssid);
  setText('net-signal', n.signal);

  const tog = $('ap-tog');
  const sub = $('ap-sub');
  const detail = $('ap-info');
  if (tog) tog.classList.toggle('on', !!n.ap_active);
  if (sub) sub.textContent = n.ap_active
    ? `Ativo · AstroPi · ${n.ap_clients} cliente(s)`
    : 'Desativado · sobe automaticamente sem WiFi';
  if (detail) detail.classList.toggle('visible', !!n.ap_active);
  setText('ap-clients', String(n.ap_clients));
  setText('wifi-status-msg', n.wifi_status || 'Digite SSID e senha para conectar à nova rede.');

  Object.entries(n.services || {}).forEach(([k, up]) => {
    const dot = $('svc-dot-' + k);
    if (dot) dot.className = 'dot ' + (up ? 'dg' : 'dx');
  });
}

function renderGotoStatus() {
  const el = $('goto-status');
  if (!el) return;
  if (!STATE.gotoStatus) { el.textContent = ''; return; }
  const { success, message } = STATE.gotoStatus;
  el.style.color = success === null ? '#EF9F27' : success ? '#5DCAA5' : '#E24B4A';
  el.textContent = (success === null ? '⟳ ' : success ? '✓ ' : '✗ ') + message;
}

function setDot(id, on, warn) {
  const el = $('st-' + id);
  if (!el) return;
  const dot = el.querySelector('.dot');
  if (dot) dot.className = 'dot ' + (on ? 'dg' : warn ? 'da' : 'dx');
}

/* ══════════════════════════════════════════════
   GPS SATELLITE INDICATOR
   ══════════════════════════════════════════════ */

function renderGpsSatIndicator() {
  const gps  = STATE.devices.gps;
  const sats = gps.sats || 0;
  const fix  = gps.fix;
  const el   = $('st-gps');
  const cnt  = $('gps-sat-count');

  if (!el) return;

  // Cor do dot: verde = fix, âmbar = sats sem fix, cinza = nada
  const dot = el.querySelector('.dot');
  if (dot) dot.className = 'dot ' + (fix ? 'dg' : sats > 0 ? 'da' : 'dx');

  el.title = fix
    ? `GPS: fix (${sats} satélites)`
    : sats > 0 ? `GPS: aguardando fix (${sats} sat)`
    : 'GPS: sem sinal';

  // Contador de satélites ao lado do label
  if (cnt) cnt.textContent = sats > 0 ? String(sats) : '';
}

/* ══════════════════════════════════════════════
   WEBSOCKET — BACKEND
   ══════════════════════════════════════════════ */

const WS_HOST = window.location.hostname || 'astropi.local';
const WS_PORT = parseInt(window.location.port) || 3000;
const WS_URL = `ws://${WS_HOST}:${WS_PORT}/ws`;
const KASMVNC_PORT = 8443;

let ws = null;
let wsBackoff = 1000;
let wsTimer = null;
let wsAlive = false;
let hbTimer = null;
const CMD_Q = [];

function connectWS() {
  clearTimeout(wsTimer);
  try { ws = new WebSocket(WS_URL); }
  catch {
    setState({ wsConnected: false });
    wsTimer = setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.5, 30000);
    return;
  }

  ws.onopen = () => {
    wsBackoff = 1000; wsAlive = true;
    setState({ wsConnected: true });
    startHB(); flushQ();
    sendWS({ type: 'get_state' });
    sendWS({ type: 'network_status' });
    addLog('ok', 'Bridge conectado');
    
    // Carrega drivers customizados do localStorage
    try {
      const saved = localStorage.getItem('astro_custom_drivers');
      if (saved) {
        const list = JSON.parse(saved);
        STATE.customDrivers = list;
        list.forEach(bin => {
          if (!STATE.devices[bin]) STATE.devices[bin] = { connected: false, state: 'disconnected' };
        });
        scheduleRender();
      }
    } catch(e) {}

    // Carrega portas salvas
    try {
      const savedPorts = localStorage.getItem('astro_device_ports');
      if (savedPorts) {
        STATE.devicePorts = JSON.parse(savedPorts);
        // Preenche os inputs fixos (os dinâmicos são preenchidos no render)
        Object.entries(STATE.devicePorts).forEach(([key, port]) => {
          const inp = $('port-' + key);
          if (inp) inp.value = port;
        });
      }
    } catch(e) {}

    // Inicia loop de detecção de portas
    fetchPorts();
    setInterval(fetchPorts, 10000);
  };

  ws.onmessage = (evt) => { try { handleMsg(JSON.parse(evt.data)); } catch { } };
  ws.onerror = () => { };
  ws.onclose = () => {
    stopHB();
    setState({ wsConnected: false, indiConnected: false });
    wsTimer = setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.5, 30000);
  };
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function sendCmd(msg, queue = true) {
  if (!sendWS(msg) && queue) { CMD_Q.push(msg); addLog('wn', 'Na fila: ' + msg.type); }
}

function flushQ() {
  while (CMD_Q.length && ws && ws.readyState === WebSocket.OPEN) {
    addLog('ok', 'Reenviado: ' + CMD_Q[0].type); sendWS(CMD_Q.shift());
  }
}

function startHB() {
  stopHB();
  hbTimer = setInterval(() => {
    if (!wsAlive) { ws && ws.close(); return; }
    wsAlive = false; sendWS({ type: 'ping', ts: Date.now() });
  }, 15000);
}
function stopHB() { clearInterval(hbTimer); }

/* ══════════════════════════════════════════════
   HANDLER DE MENSAGENS DO SERVIDOR
   ══════════════════════════════════════════════ */

function handleMsg(msg) {
  wsAlive = true;

  switch (msg.type) {
    case 'pong': break;

    case 'full_state':
      if (msg.devices) setState({ devices: msg.devices });
      break;

    case 'device_update':
      if (msg.key && STATE.devices[msg.key]) {
        STATE.devices[msg.key] = { ...STATE.devices[msg.key], ...msg.data };
        if (msg.key === 'gps' && typeof applyAlignData === 'function') {
          const g = STATE.devices.gps;
          if (g.lat) applyAlignData({ lat: g.lat, lon: g.lon, fix: g.fix, sats: g.sats });
        }
        scheduleRender();
      }
      break;

    case 'indi_status':
      setState({ indiConnected: !!msg.connected });
      if (!msg.connected) {
        Object.keys(STATE.devices).forEach(k => {
          STATE.devices[k].connected = false;
          STATE.devices[k].state = 'disconnected';
        });
        scheduleRender();
      }
      break;

    case 'driver_status':
      setState({ indiserver: !!msg.indiserver, drivers: msg.drivers || [] });
      if (msg.drivers) {
        msg.drivers.forEach(d => {
          const key = driverKey(d.name);
          if (key && STATE.devices[key]) {
            STATE.devices[key].connected = d.connected;
            STATE.devices[key].state = d.error ? 'error' : d.connected ? 'idle' : 'disconnected';
          }
        });
        scheduleRender();
      }
      break;

    case 'goto_result':
      setState({ gotoStatus: { success: msg.success, message: msg.message } });
      if (msg.success !== null) setTimeout(() => setState({ gotoStatus: null }), 8000);
      break;

    case 'network': {
      /* Remove msg.type antes de salvar no STATE */
      const { type: _t, ...net } = msg;
      setState({ network: { ...STATE.network, ...net, wifi_status: net.wifi_status || STATE.network.wifi_status } });
      break;
    }

    case 'camera_image':
      onCameraImage(msg);
      break;

    case 'phd2_status':
      setState({
        phd2: {
          online: !!msg.online,
          connected: !!msg.connected,
          appState: msg.appState || 'offline',
          equipment: msg.equipment || null,
          exposure: msg.exposure ?? null,
          error: msg.error || null,
        }
      });
      break;

    case 'sequence_update':
      setState({ sequence: { ...STATE.sequence, ...msg } });
      break;

    case 'log':
      addLog(msg.level, msg.text);
      break;
  }
}

function driverKey(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('eqmod') || n.includes('telescope') || n.includes('mount')) return 'mount';
  if (n.includes('ccd') || n.includes('camera') || n.includes('canon')) return 'camera';
  if (n.includes('moonlite') || n.includes('focuser')) return 'focuser';
  if (n.includes('efw') || n.includes('filter')) return 'filterwheel';
  if (n.includes('rotat')) return 'rotator';
  if (n.includes('gps')) return 'gps';
  return null;
}

function addLog(level, text) {
  STATE.logs.push({ level, text });
  if (STATE.logs.length > 200) STATE.logs.splice(0, 100);
  if (STATE.currentTab === 'drivers' || STATE.currentTab === 'capture') scheduleRender();
}

/* ══════════════════════════════════════════════
   WEBSOCKET — SENSORES (Python bridge)
   ══════════════════════════════════════════════ */

const SENSOR_PORT = 8765;
let sensorWs = null, sensorBackoff = 2000;

function connectSensors() {
  try { sensorWs = new WebSocket(`ws://${WS_HOST}:${SENSOR_PORT}`); }
  catch { setTimeout(connectSensors, sensorBackoff); return; }

  sensorWs.onopen = () => {
    sensorBackoff = 2000;
    setDot('gps', false, true);
    if (typeof updateSensorBanner === 'function') updateSensorBanner(true);
  };

  sensorWs.onmessage = (evt) => {
    try {
      const d = normalizeSensorPayload(JSON.parse(evt.data));
      if (typeof applyAlignData === 'function') applyAlignData(d);
      if (d.sats != null || d.fix != null || d.lat != null || d.lon != null) {
        if (d.lat != null) STATE.devices.gps.lat = d.lat;
        if (d.lon != null) STATE.devices.gps.lon = d.lon;
        if (d.sats != null) STATE.devices.gps.sats = d.sats;
        if (d.fix != null) STATE.devices.gps.fix = !!d.fix;
        renderGpsSatIndicator();
      }
    } catch { }
  };

  sensorWs.onclose = () => {
    setDot('gps', false);
    STATE.devices.gps.sats = 0;
    STATE.devices.gps.fix = false;
    renderGpsSatIndicator();
    if (typeof updateSensorBanner === 'function') updateSensorBanner(false);
    sensorBackoff = Math.min(sensorBackoff * 1.5, 30000);
    setTimeout(connectSensors, sensorBackoff);
  };
}

function normalizeSensorPayload(raw) {
  const gps = raw.gps || {};
  const decMag = raw.decMag ?? raw.mag_dec;
  const heading = raw.heading ??
    (raw.true_heading != null && decMag != null
      ? ((raw.true_heading - decMag) % 360 + 360) % 360
      : raw.true_heading);

  return {
    ...raw,
    heading,
    lat: raw.lat ?? gps.lat,
    lon: raw.lon ?? gps.lon,
    fix: raw.fix ?? gps.fix,
    sats: raw.sats ?? gps.sats,
    decMag,
  };
}

/* ══════════════════════════════════════════════
   NAVEGAÇÃO
   ══════════════════════════════════════════════ */

function sw(id, el) {
  /* Esconde todos os painéis */
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.remove('active');
  });
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

  const panel = $('p-' + id);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');

  STATE.currentTab = id;
  scheduleRender();

  if (id === 'align') { if (typeof renderAlign === 'function') renderAlign(); }
  if (id === 'network') sendCmd({ type: 'network_status' }, false);
  if (id === 'drivers') sendCmd({ type: 'get_state' }, false);
  if (id === 'capture') {
    refreshPHD2();
    sendCmd({ type: 'sequence_status' }, false);
  }
  // Pausa framing ao sair da aba de montagem
  if (id !== 'mount' && id !== 'capture' && CAM.mode === 'framing') _stopFraming();
}

function sessionTab(id, el) {
  document.querySelectorAll('.session-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.session-tab').forEach(t => t.classList.remove('active'));

  const pane = $('session-' + id);
  if (pane) pane.classList.add('active');
  if (el) el.classList.add('active');

  STATE.sessionTab = id;
  if (id === 'guide') refreshPHD2();
  if (id === 'sequence') sendCmd({ type: 'sequence_status' }, false);
  scheduleRender();
}

/* ══════════════════════════════════════════════
   FULLSCREEN — todas as abas
   ══════════════════════════════════════════════ */

/**
 * Tenta fullscreen nativo (oculta barra de endereço).
 * Se não disponível, cria overlay que cobre toda a tela.
 *
 * Para abas remotas usa o frame existente.
 * Para abas nativas (mount, align, drivers, network) clona o conteúdo.
 */
function enterFullscreen(panelId) {
  /* Se houver overlay manual ativo, remova-o (toggle off) */
  const overlay = document.getElementById('fs-overlay-root');
  if (overlay) { overlay.remove(); return; }

  /* Se estiver em Fullscreen nativo, saia (toggle off) */
  if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) {
    const exitFn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
    if (exitFn) exitFn.call(document);
    return;
  }

  const panel = $(panelId);
  if (!panel) return;

  /* Tenta Fullscreen API nativa primeiro */
  const el = panel;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  if (fn) {
    fn.call(el).catch(() => _showFsOverlay(panelId));
    return;
  }
  _showFsOverlay(panelId);
}

function _showFsOverlay(panelId) {
  /* Remove overlay anterior se existir */
  const prev = document.getElementById('fs-overlay-root');
  if (prev) prev.remove();

  const panel = $(panelId);
  if (!panel) return;

  const overlay = document.createElement('div');
  overlay.id = 'fs-overlay-root';
  overlay.className = 'fs-overlay';

  /* Botão de saída */
  const exitBtn = document.createElement('button');
  exitBtn.className = 'fs-exit-btn';
  exitBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1H1v4M9 1h4v4M13 9v4H9M5 13H1V9"/></svg> Sair`;
  exitBtn.onclick = () => overlay.remove();
  overlay.appendChild(exitBtn);

  /* Para painéis remotos: move o iframe para o overlay */
  const frameId = panelId === 'p-desktop' ? 'remote-d-frame' :
    panelId === 'p-terminal' ? 'term-frame' : null;

  if (frameId) {
    const frame = $(frameId);
    if (frame) {
      const placeholder = document.createElement('div');
      placeholder.id = frameId + '-placeholder';
      placeholder.style.display = 'none';
      frame.parentNode.insertBefore(placeholder, frame);

      const frameWrapper = document.createElement('div');
      frameWrapper.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
      frameWrapper.appendChild(frame);
      overlay.appendChild(frameWrapper);

      /* Ao fechar: devolve o frame ao lugar */
      exitBtn.onclick = () => {
        placeholder.parentNode.insertBefore(frame, placeholder);
        placeholder.remove();
        overlay.remove();
      };
    }
  } else {
    /* Para painéis de conteúdo: clone visual */
    const clone = panel.cloneNode(true);
    clone.style.cssText = 'flex:1;min-height:0;overflow-y:auto;position:relative;';
    /* Mantém o botão de fullscreen visível para permitir o toggle de volta */
    overlay.appendChild(clone);
  }


  document.body.appendChild(overlay);

  /* Tenta também o Fullscreen nativo no overlay */
  const fn = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
  if (fn) fn.call(overlay).catch(() => { });
}

function requestFullscreenPanel(frameId) {
  const map = {
    'remote-d-frame': 'p-desktop', 'term-frame': 'p-terminal',
  };
  enterFullscreen(map[frameId] || frameId);
}

/* ══════════════════════════════════════════════
   MONTAGEM
   ══════════════════════════════════════════════ */

function setRate(el, rate) {
  document.querySelectorAll('.rb').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  STATE.slewRate = rate;
  sendCmd({ type: 'slew_rate', rate });
}

function jp(dir) { $('j' + dir)?.classList.add('pr'); sendCmd({ type: 'slew_start', direction: dir, rate: STATE.slewRate }); }
function jr(dir) { $('j' + dir)?.classList.remove('pr'); sendCmd({ type: 'slew_stop', direction: dir }); }
function jStop() {
  ['N', 'S', 'E', 'W'].forEach(d => { $('j' + d)?.classList.remove('pr'); sendCmd({ type: 'slew_stop', direction: d }, false); });
}

function setTrk(el, mode) {
  document.querySelectorAll('.trk button').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  STATE.tracking = mode === 'None' ? null : mode;
  sendCmd({ type: 'tracking', mode });
}

function doGotoName() {
  const name = ($('goto-name')?.value || '').trim();
  if (!name) return;
  setState({ gotoStatus: { success: null, message: `Resolvendo "${name}"…` } });
  sendCmd({ type: 'goto_name', name });
}

function doGotoCoords() {
  const ra = ($('goto-ra')?.value || '').trim();
  const dec = ($('goto-dec')?.value || '').trim();
  if (!ra || !dec) return;
  sendCmd({ type: 'goto_coords', ra, dec });
}

function syncMount()   { sendCmd({ type: 'sync' }); }
function parkMount()   { sendCmd({ type: 'park' }); }
function unparkMount() { sendCmd({ type: 'unpark' }); }

function togglePark() {
  if (STATE.devices.mount.parked) unparkMount();
  else parkMount();
}

function slewHome() {
  sendCmd({ type: 'slew_home' });
}

function meridianFlip() {
  sendCmd({ type: 'meridian_flip' });
}

/* ── Focalizador ── */
function focusMove(steps) {
  sendCmd({ type: 'focus_move', steps });
}
function focusStop() {
  sendCmd({ type: 'focus_stop' }, false);
}
function focusGoto() {
  const pos = parseInt($('focus-abs-val')?.value);
  if (isNaN(pos)) return;
  sendCmd({ type: 'focus_goto', position: pos });
}

/* ── Filtros ── */
function setFilter(slot) {
  sendCmd({ type: 'filter_set', slot });
  // Atualiza estado local imediatamente para feedback
  STATE.devices.filterwheel.slot = slot;
  const name = STATE.devices.filterwheel.filterNames?.[slot - 1] || null;
  STATE.devices.filterwheel.filter = name;
  scheduleRender();
}

/* ── Rotacionador ── */
function rotSliderInput(val) {
  const v = parseFloat(val);
  STATE.devices.rotator.angle = v.toFixed(2);
  renderRotator(STATE.devices.rotator);
  // Update slider fill
  const pct = ((v + 90) / 180) * 100;
  const slider = $('rot-slider');
  if (slider) slider.style.setProperty('--rot-pct', pct + '%');
}

function rotSliderCommit(val) {
  clearTimeout(_rotCommitTimer);
  _rotCommitTimer = setTimeout(() => rotGoto(parseFloat(val)), 150);
}

function rotGoto(angle) {
  angle = parseFloat(angle);
  if (isNaN(angle)) return;
  angle = Math.max(-90, Math.min(90, angle));
  sendCmd({ type: 'rotator_goto', angle });
  const slider = $('rot-slider');
  if (slider) {
    slider.value = angle;
    slider.style.setProperty('--rot-pct', (((angle + 90) / 180) * 100) + '%');
  }
}

function rotGotoInput() {
  const v = parseFloat($('rot-abs-val')?.value);
  if (!isNaN(v)) rotGoto(v);
}


/* ── Câmera: render preview da imagem INDI BLOB ── */
function renderCameraPreview(msg) {
  const targets = [
    { canvas: $('cam-preview-canvas'), holder: $('cam-preview-placeholder') },
    { canvas: $('capture-preview-canvas'), holder: $('capture-preview-placeholder') },
  ].filter(t => t.canvas);

  // FITS: enviamos base64 raw — renderiza como escala de cinza simples
  // JPEG/PNG: carrega direto via Image
  if (msg.format === 'fits') {
    targets.forEach(({ canvas, holder }) => _renderFitsPreview(msg.data, canvas, holder));
  } else {
    const img = new Image();
    img.onload = () => {
      targets.forEach(({ canvas, holder }) => {
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.style.display = 'block';
        if (holder) holder.style.display = 'none';
      });
    };
    img.src = `data:image/${msg.format};base64,${msg.data}`;
  }
}

function _renderFitsPreview(b64, canvas, holder) {
  // Decodifica FITS básico: pula header de 2880 bytes, lê pixels 16-bit
  try {
    const bin  = atob(b64);
    const buf  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

    // Parse FITS header para NAXIS1, NAXIS2, BITPIX
    const hdr   = new TextDecoder().decode(buf.slice(0, 2880));
    const nx    = parseInt((hdr.match(/NAXIS1\s*=\s*(\d+)/) || [])[1]) || 0;
    const ny    = parseInt((hdr.match(/NAXIS2\s*=\s*(\d+)/) || [])[1]) || 0;
    const bpix  = parseInt((hdr.match(/BITPIX\s*=\s*([-\d]+)/) || [])[1]) || 16;
    if (!nx || !ny) return;

    // Número de blocos de header (cada bloco = 2880 bytes)
    let hdrBlocks = 1;
    for (let b = 0; b < 36; b++) {
      const card = new TextDecoder().decode(buf.slice(b * 2880, (b + 1) * 2880));
      if (card.includes('END ')) { hdrBlocks = b + 1; break; }
    }
    const dataOffset = hdrBlocks * 2880;
    const bytesPerPix = Math.abs(bpix) / 8;
    const total = nx * ny;

    // Lê pixels e normaliza para 0-255
    let mn = Infinity, mx = -Infinity;
    const vals = new Float32Array(total);
    const dv   = new DataView(buf.buffer, dataOffset);
    for (let i = 0; i < total; i++) {
      const off = i * bytesPerPix;
      let v;
      if (bpix === 16)       v = dv.getInt16(off, false);
      else if (bpix === 8)   v = dv.getUint8(off);
      else if (bpix === -32) v = dv.getFloat32(off, false);
      else                   v = dv.getInt16(off, false);
      vals[i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }

    // Stretch simples (linear min-max com 0.1% clip)
    const range = mx - mn || 1;
    canvas.width = nx; canvas.height = ny;
    const ctx  = canvas.getContext('2d');
    const imgd = ctx.createImageData(nx, ny);
    for (let i = 0; i < total; i++) {
      const p = Math.round(((vals[i] - mn) / range) * 255);
      imgd.data[i*4]   = p;
      imgd.data[i*4+1] = p;
      imgd.data[i*4+2] = p;
      imgd.data[i*4+3] = 255;
    }
    ctx.putImageData(imgd, 0, 0);
    canvas.style.display = 'block';
    if (holder) holder.style.display = 'none';
  } catch (e) {
    console.warn('[FITS preview]', e.message);
  }
}


/* ══════════════════════════════════════════════
   CÂMERA — framing loop + single capture
   ══════════════════════════════════════════════

   Framing: loop de exposições curtas que atualiza
   o preview a cada BLOB recebido, igual ao AsiAir.
   O server já envia camera_image via WebSocket ao
   receber setBLOBVector do INDI.

   Modos:
   - IDLE        → nada ativo
   - FRAMING     → loop contínuo; cada BLOB recebido
                   dispara nova exposição automaticamente
   - CAPTURING   → exposição única; para ao receber BLOB
   ══════════════════════════════════════════════ */

const CAM = {
  mode:      'idle',   // 'idle' | 'framing' | 'capturing'
  expTimer:  null,
  framingWatchdog: null,
};

/* Chamado pelo server quando chega um BLOB (camera_image) */
function onCameraImage(msg) {
  renderCameraPreview(msg);

  if (CAM.mode === 'framing') {
    // Dispara próxima exposição imediatamente
    _shootFrame();
  } else if (CAM.mode === 'capturing') {
    CAM.mode = 'idle';
    _stopExpBar();
    _updateCamButtons();
  }
}

/* ── Framing ── */
function toggleFraming() {
  if (CAM.mode === 'framing') {
    _stopFraming();
  } else {
    // Para qualquer captura em andamento
    if (CAM.mode === 'capturing') _stopCapture(false);
    _startFraming();
  }
}

function _startFraming() {
  CAM.mode = 'framing';
  _updateCamButtons();
  _shootFrame();
  // Watchdog: se em 30s não chegar BLOB, tenta de novo
  _armFramingWatchdog();
}

function _stopFraming() {
  CAM.mode = 'idle';
  clearTimeout(CAM.framingWatchdog);
  _stopExpBar();
  sendCmd({ type: 'camera_abort' }, false);
  _updateCamButtons();
  // Remove overlay de framing
  const ov = $('cam-framing-overlay');
  if (ov) ov.style.display = 'none';
}

function _shootFrame() {
  clearTimeout(CAM.framingWatchdog);
  const { exp, gain } = _cameraParams();
  _startExpBar(exp);
  sendCmd({ type: 'camera_capture', exposure: exp, gain, source: 'framing' });
  _armFramingWatchdog(exp);
  // Overlay
  const ov    = $('cam-framing-overlay');
  const label = $('cam-framing-label');
  if (ov)    ov.style.display = 'flex';
  if (label) label.textContent = `Framing  ${exp}s`;
}

function _armFramingWatchdog(exp) {
  clearTimeout(CAM.framingWatchdog);
  const timeout = ((exp || 1) + 8) * 1000; // exp + 8s de margem
  CAM.framingWatchdog = setTimeout(() => {
    if (CAM.mode === 'framing') _shootFrame(); // retry
  }, timeout);
}

/* ── Single capture ── */
function toggleCapture() {
  if (CAM.mode === 'capturing') {
    _stopCapture(true);
  } else {
    if (CAM.mode === 'framing') _stopFraming();
    _startCapture();
  }
}

function _startCapture() {
  CAM.mode = 'capturing';
  const { exp, gain } = _cameraParams();
  const filterRaw = parseInt($('seq-filter')?.value);
  _startExpBar(exp);
  _updateCamButtons();
  sendCmd({
    type: 'camera_capture',
    exposure: exp,
    gain,
    source: 'manual',
    target: ($('seq-target')?.value || 'Alvo').trim(),
    frameType: $('seq-type')?.value || 'Light',
    filterSlot: Number.isFinite(filterRaw) ? filterRaw : null,
  });
}

function _stopCapture(sendAbort) {
  CAM.mode = 'idle';
  _stopExpBar();
  _updateCamButtons();
  if (sendAbort) sendCmd({ type: 'camera_abort' }, false);
}

/* ── Barra de progresso de exposição ── */
function _startExpBar(duration) {
  clearTimeout(CAM.expTimer);
  const bar  = $('cam-exp-bar');
  const prog = $('cam-exp-progress');
  if (!bar || !prog) return;
  bar.style.display = 'block';
  prog.style.transition = 'none';
  prog.style.width = '0%';
  requestAnimationFrame(() => {
    prog.style.transition = `width ${duration}s linear`;
    prog.style.width = '100%';
  });
  CAM.expTimer = setTimeout(() => {
    prog.style.transition = 'none';
    prog.style.width = '0%';
  }, duration * 1000 + 300);
}

function _stopExpBar() {
  clearTimeout(CAM.expTimer);
  const bar  = $('cam-exp-bar');
  const prog = $('cam-exp-progress');
  if (bar)  bar.style.display = 'none';
  if (prog) { prog.style.transition = 'none'; prog.style.width = '0%'; }
}

/* ── Atualiza aparência dos botões ── */
function _updateCamButtons() {
  const fBtn  = $('cam-framing-btn');
  const fTxt  = $('cam-framing-txt');
  const fIco  = $('cam-framing-icon');
  const cBtn  = $('cam-capture-btn');
  const cTxt  = $('cam-capture-txt');
  const cIco  = $('cam-capture-icon');

  const isFraming   = CAM.mode === 'framing';
  const isCapturing = CAM.mode === 'capturing';

  // Framing button
  if (fBtn) fBtn.classList.toggle('active', isFraming);
  if (fTxt) fTxt.textContent = isFraming ? 'Parar' : 'Framing';
  if (fIco) fIco.innerHTML   = isFraming
    ? '<rect x="2" y="2" width="8" height="8" rx="1"/>'       // stop square
    : '<polygon points="2,1 11,6 2,11"/>';                    // play triangle

  // Capture button
  if (cBtn) cBtn.classList.toggle('capturing', isCapturing);
  if (cTxt) cTxt.textContent = isCapturing ? 'Parar' : 'Capturar';
  if (cIco) cIco.innerHTML   = isCapturing
    ? '<rect x="2" y="2" width="8" height="8" rx="1"/>'
    : '<circle cx="6" cy="6" r="5"/>';

  // Desabilita o outro botão durante operação
  if (fBtn) fBtn.disabled = isCapturing;
  if (cBtn) cBtn.disabled = isFraming;
  if (fBtn) fBtn.style.opacity = isCapturing ? '.4' : '1';
  if (cBtn) cBtn.style.opacity = isFraming   ? '.4' : '1';

  const cfBtn = $('cap-framing-btn');
  const ccBtn = $('cap-capture-btn');
  if (cfBtn) {
    cfBtn.classList.toggle('active', isFraming);
    cfBtn.textContent = isFraming ? 'Parar' : 'Framing';
    cfBtn.disabled = isCapturing || STATE.sequence.running;
  }
  if (ccBtn) {
    ccBtn.classList.toggle('capturing', isCapturing);
    ccBtn.textContent = isCapturing ? 'Parar' : 'Capturar';
    ccBtn.disabled = isFraming || STATE.sequence.running;
  }
}

function _cameraParams() {
  const expRaw = parseFloat(
    (document.activeElement === $('cap-exp') ? $('cap-exp')?.value : null) ||
    $('cap-exp')?.value ||
    $('cam-exp')?.value
  );

  const gainRaw = parseInt(
    (document.activeElement === $('cap-gain') ? $('cap-gain')?.value : null) ||
    $('cap-gain')?.value ||
    $('cam-gain')?.value
  );

  const exp = Number.isFinite(expRaw) && expRaw > 0 ? expRaw : 1;
  const gain = Number.isFinite(gainRaw) && gainRaw >= 0 ? gainRaw : 100;

  const camExp = $('cam-exp');
  const capExp = $('cap-exp');
  const camGain = $('cam-gain');
  const capGain = $('cap-gain');
  if (camExp && camExp !== document.activeElement) camExp.value = exp;
  if (capExp && capExp !== document.activeElement) capExp.value = exp;
  if (camGain && camGain !== document.activeElement) camGain.value = gain;
  if (capGain && capGain !== document.activeElement) capGain.value = gain;

  return { exp, gain };
}

/* ══════════════════════════════════════════════
   DRIVERS
   ══════════════════════════════════════════════ */

const DRIVER_MAP = {
  mount: 'indi_eqmod_telescope', camera: 'indi_canon_ccd',
  focuser: 'indi_moonlite', filterwheel: 'indi_efw',
  rotator: 'indi_simulator_rotator', gps: 'indi_gpsd', adxl: 'python_bridge',
};

/* ══════════════════════════════════════════════
   GUIDING — PHD2
   ══════════════════════════════════════════════ */

function refreshPHD2() {
  sendCmd({ type: 'phd2_status' }, false);
}

function _phd2Settle() {
  return {
    pixels: parseFloat($('phd2-settle-px')?.value) || 1.5,
    time: parseFloat($('phd2-settle-time')?.value) || 8,
    timeout: parseFloat($('phd2-settle-timeout')?.value) || 60,
  };
}

function phd2Loop() {
  sendCmd({ type: 'phd2_loop' });
}

function phd2Guide() {
  sendCmd({ type: 'phd2_guide', ..._phd2Settle() });
}

function phd2Stop() {
  sendCmd({ type: 'phd2_stop' });
}

function phd2Dither() {
  sendCmd({
    type: 'phd2_dither',
    amount: parseFloat($('phd2-dither-amount')?.value) || 3,
    ..._phd2Settle(),
  });
}

function toggleDriver(key) {
  const dev = STATE.devices[key];
  if (!dev) return;
  const newState = !dev.connected;

  // Busca a porta no input correspondente
  const portInp = $('port-' + key);
  const port = portInp ? portInp.value.trim() : (STATE.devicePorts[key] || '');

  // Atualiza estado local imediatamente
  STATE.devices[key].connected = newState;
  STATE.devices[key].state = newState ? 'idle' : 'disconnected';
  scheduleRender();

  sendCmd({ 
    type: newState ? 'driver_start' : 'driver_stop', 
    driver: DRIVER_MAP[key] || key,
    port: newState ? port : undefined 
  });
}

/** Gerenciamento de Portas Seriais **/
let _last_port_input = null;

async function fetchPorts() {
  if (STATE.currentTab !== 'drivers') return;
  try {
    const res = await fetch('/api/ports');
    const { ports } = await res.json();
    renderPorts(ports);
  } catch(e) {}
}

function renderPorts(ports) {
  const container = $('detected-ports-container');
  if (!container) return;
  if (!ports || ports.length === 0) {
    container.innerHTML = '<span class="dim" style="font-size:10px">Nenhuma porta USB detectada</span>';
    return;
  }
  container.innerHTML = ports.map(p => `
    <span class="p-chip" onclick="usePort('${p}')">${p.replace('/dev/','')}</span>
  `).join('');
}

function usePort(path) {
  // Se o usuário clicou em um input de porta recentemente, preenche ele
  if (_last_port_input && document.body.contains(_last_port_input)) {
    _last_port_input.value = path;
    _last_port_input.dispatchEvent(new Event('input')); // Dispara o save
    
    // Auto-conecta se for um toggle
    const row = _last_port_input.closest('.drv-row');
    const tog = row?.querySelector('.tog');
    if (tog && !tog.classList.contains('on')) {
      const idStr = _last_port_input.id.replace('port-', '');
      toggleDriver(idStr);
    }
  } else {
    alert(`Selecione primeiro qual driver deve usar a porta ${path}`);
  }
}

function savePort(key, val) {
  STATE.devicePorts[key] = val;
  localStorage.setItem('astro_device_ports', JSON.stringify(STATE.devicePorts));
}

// Captura qual input foi clicado por último para o preenchimento automático
document.addEventListener('focusin', (e) => {
  if (e.target.classList.contains('port-input')) {
    _last_port_input = e.target;
    
    // Mostra sugestão se o campo estiver vazio
    if (!e.target.value && e.target.dataset.hint) {
      const hint = e.target.dataset.hint;
      // Pequeno truque para preencher se o usuário clicar de novo ou se preferir
      // Por enquanto, apenas exibimos no console ou placeholder
    }
  }
});

// Adicionando um atalho tátil: Clique duplo no input vazio preenche a sugestão
document.addEventListener('dblclick', (e) => {
  if (e.target.classList.contains('port-input') && !e.target.value && e.target.dataset.hint) {
    e.target.value = e.target.dataset.hint;
    e.target.dispatchEvent(new Event('input'));
  }
});

/* ══════════════════════════════════════════════
   REMOTE / TERMINAL
   ══════════════════════════════════════════════ */

/* ─── mapa frameId → id do rotate-hint ─── */
const _rotateHintMap = {
  'remote-d-frame': 'rotate-desktop',
};

/** Esconde o rotate-hint para que o iframe fique acessível em portrait */
function _hideRotateHint(frameId) {
  const hintId = _rotateHintMap[frameId];
  if (!hintId) return;
  const hint = $(hintId);
  if (hint) {
    hint.style.display = 'none';  // sobrescreve o @media portrait
    hint.dataset.dismissed = '1';
  }
}

/* ══════════════════════════════════════════════
   KASMVNC — iframe remoto
   ══════════════════════════════════════════════

   KasmVNC já fornece o cliente HTML5 completo. O AstroControl
   só embute a página web do servidor KasmVNC.
   ══════════════════════════════════════════════ */

/* Registro de sessões remotas ativas: frameId → { port, statusId, auth, resizeTimer, observer } */
const REMOTE_SESSIONS = new Map();

/**
 * Mede as dimensões reais do container do frame no momento da chamada.
 * Usa o elemento pai (.remote-frame) para pegar a área disponível real.
 */
function getDisplayParams(containerEl) {
  const dpr  = window.devicePixelRatio || 1;
  const rect = containerEl
    ? containerEl.getBoundingClientRect()
    : { width: window.innerWidth, height: window.innerHeight };

  const w   = Math.round(rect.width  * dpr);
  const h   = Math.round(rect.height * dpr);
  const dpi = Math.round(96 * dpr);
  return { w: Math.max(w, 320), h: Math.max(h, 240), dpi };
}

/**
 * Monta URL para o cliente web do KasmVNC.
 */
function _remoteClientUrl(port) {
  return `https://${WS_HOST}:${port || KASMVNC_PORT}/`;
}

/**
 * Injeta o iframe remoto.
 */
function _injectRemoteIframe(frame, url) {
  frame.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:#000;display:block;';
  iframe.allow = 'fullscreen clipboard-read clipboard-write';

  frame.appendChild(iframe);

  return { iframe };
}

/**
 * Conecta (ou reconecta) uma sessão remota.
 * Registra observers para resize automático.
 */
function connectRemote(frameId, statusId, port) {
  const frame  = document.getElementById(frameId);
  const status = document.getElementById(statusId);
  if (!frame) return;

  _hideRotateHint(frameId);

  // Cancela observer anterior se existir
  const prev = REMOTE_SESSIONS.get(frameId);
  if (prev?.observer) prev.observer.disconnect();
  if (prev?.resizeTimer) clearTimeout(prev.resizeTimer);

  const { w, h } = getDisplayParams(frame);
  const url = _remoteClientUrl(port);

  _injectRemoteIframe(frame, url);
  if (status) status.textContent = 'Conectado';

  const session = { port, statusId, lastW: w, lastH: h };
  REMOTE_SESSIONS.set(frameId, session);

  // Observer de resize do container
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => _onRemoteContainerResize(frameId));
    observer.observe(frame);
    session.observer = observer;
  }
}

/**
 * Chamado pelo ResizeObserver ou pelo evento de orientação.
 * Reconecta apenas se a mudança de tamanho for significativa (>5%).
 */
function _onRemoteContainerResize(frameId) {
  const session = REMOTE_SESSIONS.get(frameId);
  if (!session) return;

  clearTimeout(session.resizeTimer);
  session.resizeTimer = setTimeout(() => {
    const frame = document.getElementById(frameId);
    if (!frame || !frame.querySelector('iframe')) return;

    // Só reconecta se o painel estiver visível
    const panel = frame.closest('.panel');
    if (panel && !panel.classList.contains('active')) return;

    const { w, h } = getDisplayParams(frame);

    // Threshold: ignora mudanças menores que 5%
    const dw = Math.abs(w - session.lastW) / session.lastW;
    const dh = Math.abs(h - session.lastH) / session.lastH;
    if (dw < 0.05 && dh < 0.05) return;

    session.lastW = w;
    session.lastH = h;

    const status = document.getElementById(session.statusId);
    if (status) status.textContent = 'Conectado';
  }, 400);
}

/** Registra listeners globais de resize/orientation uma única vez */
function _remoteGlobalResizeInit() {
  let lastOrientation = screen.orientation?.type || '';

  const onOrientationChange = () => {
    const newOrientation = screen.orientation?.type || '';
    if (newOrientation === lastOrientation) return;
    lastOrientation = newOrientation;
    // Reconecta todos os painéis remotos visíveis
    REMOTE_SESSIONS.forEach((_, frameId) => _onRemoteContainerResize(frameId));
  };

  screen.orientation?.addEventListener('change', onOrientationChange);
  window.addEventListener('orientationchange', onOrientationChange);

  // resize de janela (desktop / tablet split-screen)
  let winResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(winResizeTimer);
    winResizeTimer = setTimeout(() => {
      REMOTE_SESSIONS.forEach((_, frameId) => _onRemoteContainerResize(frameId));
    }, 300);
  });
}

function showAuth(type) {
  const box = $('auth-' + type);
  if (box) box.style.display = 'block';
}

async function doAuth(type) {
  const errEl = $('err-' + type);
  if (errEl) errEl.textContent = '';

  if (type === 'terminal') {
    const user = ($('user-terminal')?.value || '').trim();
    const pwd  = $('pwd-terminal')?.value || '';
    if (!user || !pwd) { if (errEl) errEl.textContent = 'Preencha usuário e senha.'; return; }
    try {
      const res = await fetch('/api/auth/terminal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password: pwd }),
      });
      if (!res.ok) { if (errEl) errEl.textContent = 'Credenciais inválidas.'; return; }
      const frame  = $('term-frame');
      const status = $('term-status');
      frame.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.src = `http://${WS_HOST}:7681/`;
      iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#000;display:block;';
      iframe.allow = 'fullscreen; clipboard-read; clipboard-write; keyboard-map';
      iframe.tabIndex = 0;
      iframe.onload = () => {
        setTimeout(() => {
          iframe.focus();
          try { iframe.contentWindow?.focus(); } catch {}
        }, 150);
      };
      iframe.addEventListener('pointerdown', () => {
        iframe.focus();
        try { iframe.contentWindow?.focus(); } catch {}
      });
      frame.appendChild(iframe);
      if (status) status.textContent = 'Conectado';
    } catch (e) {
      if (errEl) errEl.textContent = 'Erro: ' + e.message;
    }

  } else if (type === 'desktop') {
    connectRemote('remote-d-frame', 'remote-d-status', KASMVNC_PORT);
    _hideRotateHint('remote-d-frame');
  }
}

/* ══════════════════════════════════════════════
   REDE
   ══════════════════════════════════════════════ */

function toggleAP() {
  const currentState = !!STATE.network.ap_active;
  const newState = !currentState;
  
  // Atualiza o estado local imediatamente para persistir entre abas
  setState({ network: { ap_active: newState } });
  
  sendCmd({ type: 'ap_toggle', enable: newState });
}

function wifiConnect() {
  const ssid = ($('wifi-ssid')?.value || '').trim();
  const password = ($('wifi-password')?.value || '').trim();

  if (!ssid) {
    setText('wifi-status-msg', 'SSID obrigatório.');
    return;
  }

  setText('wifi-status-msg', `Conectando a ${ssid}...`);
  setState({ network: { wifi_status: `Conectando a ${ssid}...` } });
  sendCmd({ type: 'wifi_connect', ssid, password });
}

/* ══════════════════════════════════════════════
   RELÓGIO UTC
   ══════════════════════════════════════════════ */

function tickClock() {
  const d = new Date();
  const el = $('utc');
  if (el) {
    el.textContent =
      String(d.getUTCHours()).padStart(2, '0') + ':' +
      String(d.getUTCMinutes()).padStart(2, '0') + ':' +
      String(d.getUTCSeconds()).padStart(2, '0') + ' UTC';
  }
  requestAnimationFrame(tickClock);
}

/* ══════════════════════════════════════════════
   UTILITÁRIOS
   ══════════════════════════════════════════════ */

function $(id) { return document.getElementById(id); }
function setText(id, t) { const e = $(id); if (e && e.textContent !== t) e.textContent = t; }
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ══════════════════════════════════════════════
   SERVICE WORKER
   ══════════════════════════════════════════════ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { });
}

/* ══════════════════════════════════════════════
   GESTO PULL-TO-REFRESH (SVG STROKE)
   ══════════════════════════════════════════════ */

let _start_y = 0;
let _ptr_el = null;

window.addEventListener('touchstart', (e) => {
  if (window.scrollY <= 0) {
    _start_y = e.touches[0].clientY;
    _ptr_el = document.getElementById('ptr-spinner');
    if (_ptr_el) {
      _ptr_el.classList.remove('spinning');
      _ptr_el.style.transition = 'none';
      const circle = _ptr_el.querySelector('circle');
      if (circle) circle.style.strokeDashoffset = '100';
    }
  }
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (!_start_y || !_ptr_el) return;
  const dist = e.touches[0].clientY - _start_y;

  if (dist > 0) {
    const threshold = 130;
    const progress = Math.min(1, dist / threshold); 
    
    /* AJUSTE AQUI: Ângulo máximo de giro visual ao puxar */
    const rotate = progress * 100; 

    /* AJUSTE AQUI: O quanto o círculo se completa (100 = vazio, 30 = 70% completo) */
    const dash = 100 - (progress * 70);

    const translateY = Math.min(140, dist) - 70;

    _ptr_el.style.opacity = Math.min(1, dist / 80);
    _ptr_el.style.transform = `translate(-50%, ${translateY}px)`;
    
    const svg = _ptr_el.querySelector('.ptr-svg');
    const circle = _ptr_el.querySelector('circle');
    
    if (svg) svg.style.transform = `rotate(${rotate}deg)`;
    if (circle) circle.style.strokeDashoffset = dash;
  }
}, { passive: true });

window.addEventListener('touchend', (e) => {
  if (!_ptr_el || !_start_y) return;
  _ptr_el.style.transition = '';
  const dist = e.changedTouches[0].clientY - _start_y;

  if (dist > 130) {
    /* Ativa Reload */
    const circle = _ptr_el.querySelector('circle');
    if (circle) circle.style.strokeDashoffset = '30'; // Mantém o arco aberto no giro
    
    _ptr_el.classList.add('spinning');
    _ptr_el.style.transform = 'translate(-50%, 80px)';
    setTimeout(() => location.reload(), 800);
  } else {
    /* Cancela */
    _ptr_el.style.opacity = '0';
    _ptr_el.style.transform = 'translate(-50%, -70px)';
  }
  _start_y = 0;
}, { passive: true });

/* ══════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════ */

/* Garante que só p-mount está ativo no início */
document.querySelectorAll('.panel').forEach(p => {
  if (!p.classList.contains('active')) p.classList.remove('active');
});

connectWS();
connectSensors();
requestAnimationFrame(tickClock);
scheduleRender();
_remoteGlobalResizeInit();
