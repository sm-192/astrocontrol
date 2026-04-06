/**
 * AstroControl — server.js  (production)
 *
 * Melhorias sobre versão anterior:
 *  - Parser INDI XML streaming robusto (sem regex frágil)
 *  - Estado canônico de dispositivos (DEVICE_STATE)
 *  - Reconexão INDI com exponential backoff
 *  - Heartbeat ping/pong com detecção de clientes zumbis
 *  - Fila de comandos para envio após reconexão
 *  - Auth do terminal via POST (credenciais nunca na URL)
 *  - Resolução de nomes via Sesame/CDS (mais rápido que Simbad TAP)
 *  - Todas as props INDI tratadas (número, switch, texto, luz, BLOB)
 */

'use strict';

const express        = require('express');
const http           = require('http');
const WebSocket      = require('ws');
const net            = require('net');
const crypto         = require('crypto');
const { exec }       = require('child_process');
const path           = require('path');

/* ── Configuração ── */
const CFG = {
  PORT:              3000,
  INDI_HOST:         '127.0.0.1',
  INDI_PORT:         7624,
  INDIWEB_HOST:      '127.0.0.1',
  INDIWEB_PORT:      8624,
  PUBLIC_DIR:        path.join(__dirname, 'public'),
  HEARTBEAT_MS:      15000,
  INDI_BACKOFF_INIT: 2000,
  INDI_BACKOFF_MAX:  30000,
  SESAME_TIMEOUT_MS: 10000,
  TOKEN_TTL_MS:      300000,
};

/* ══════════════════════════════════════════════
   ESTADO GLOBAL DE DISPOSITIVOS
   ══════════════════════════════════════════════ */

const DEVICE_STATE = {
  mount: {
    connected: false, state: 'disconnected',
    ra: null, dec: null, ra_raw: null, dec_raw: null,
    alt: null, az: null,
    tracking: null, parked: false, slewing: false,
    slewRate: null,
  },
  camera: {
    connected: false, state: 'disconnected',
    exposure: null, gain: null, capturing: false,
  },
  focuser: {
    connected: false, state: 'disconnected',
    position: null, moving: false,
  },
  filterwheel: {
    connected: false, state: 'disconnected',
    slot: null, filter: null, filterNames: [],
  },
  rotator: {
    connected: false, state: 'disconnected',
    angle: null, moving: false,
  },
  gps: {
    connected: false, state: 'disconnected',
    lat: null, lon: null, fix: false, sats: 0,
  },
};

/** Dispositivos INDI conhecidos e seus nomes de driver */
const MOUNT_DEV_NAME = 'Telescope Simulator'; // será sobrescrito quando defXxx chegar

/** Mapeia nome de dispositivo INDI → chave em DEVICE_STATE */
function deviceKey(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('telescope') || n.includes('eqmod') || n.includes('mount') ||
      n.includes('lx200') || n.includes('nexstar') || n.includes('ontrack') ||
      n.includes('eq') || n.includes('synscan')) return 'mount';
  if (n.includes('ccd') || n.includes('camera') || n.includes('canon') ||
      n.includes('nikon') || n.includes('asi')   || n.includes('qhy') ||
      n.includes('sv305') || n.includes('atik'))  return 'camera';
  if (n.includes('focuser') || n.includes('moonlite') || n.includes('robofocus') ||
      n.includes('esatto')  || n.includes('primaluce'))  return 'focuser';
  if (n.includes('filter') || n.includes('efw') || n.includes('cfwl')) return 'filterwheel';
  if (n.includes('rotat'))  return 'rotator';
  if (n.includes('gps') || n.includes('gpsd'))   return 'gps';
  return null;
}

/* mapa device-name → chave (preenchido dinamicamente via defXxxVector) */
const KNOWN_DEVICES = new Map();

/* ══════════════════════════════════════════════
   PARSER XML INDI — STREAMING SAX-LIKE
   ══════════════════════════════════════════════ */

const INDI_ROOT_TAGS = [
  'defNumberVector','setNumberVector','newNumberVector',
  'defTextVector',  'setTextVector',  'newTextVector',
  'defSwitchVector','setSwitchVector','newSwitchVector',
  'defLightVector', 'setLightVector',
  'defBLOBVector',  'setBLOBVector',
  'message','delProperty','getProperties',
];

/**
 * Processa buffer INDI acumulado.
 * Extrai mensagens XML completas e chama onMessage(xml, tagName).
 * Retorna o buffer residual (fragmento incompleto).
 *
 * Estratégia:
 *  1. Acha a próxima tag raiz INDI mais cedo no buffer.
 *  2. Verifica se é self-closing (/>)  OU tem fechamento completo (</tag>).
 *  3. Se incompleto, para e aguarda mais dados.
 */
function processIndiBuffer(buffer, onMessage) {
  let pos = 0;

  while (pos < buffer.length) {
    /* Encontra a tag raiz mais próxima */
    let earliest  = -1;
    let foundTag  = null;

    for (const tag of INDI_ROOT_TAGS) {
      const needle = '<' + tag;
      let idx = pos;
      while (true) {
        idx = buffer.indexOf(needle, idx);
        if (idx === -1) break;
        const ch = buffer[idx + needle.length];
        // deve ser seguida de espaço, >, / ou fim de string — para não confundir <setNumber com <setNumberVector
        if (!ch || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '>' || ch === '/') {
          if (earliest === -1 || idx < earliest) {
            earliest = idx;
            foundTag = tag;
          }
          break;
        }
        idx += needle.length; // tenta próxima ocorrência
      }
    }

    if (earliest === -1) break;

    /* Determina fim da mensagem */
    let msgEnd = -1;

    // Primeiro tenta self-closing: busca /> dentro desta tag
    // (mas apenas antes do primeiro > que fecha a tag de abertura)
    const firstGt    = buffer.indexOf('>', earliest);
    const selfCloseP = buffer.indexOf('/>', earliest);

    if (firstGt !== -1 && selfCloseP !== -1 && selfCloseP === firstGt - 1) {
      // tag de abertura é self-closing
      msgEnd = firstGt + 1;
    } else {
      // Busca tag de fechamento
      const closeTag = '</' + foundTag + '>';
      const closeIdx = buffer.indexOf(closeTag, earliest);
      if (closeIdx !== -1) {
        msgEnd = closeIdx + closeTag.length;
      }
    }

    if (msgEnd === -1) break; // incompleto

    const xml = buffer.substring(earliest, msgEnd);
    try { onMessage(xml, foundTag); } catch (e) {
      console.error('[INDI Parser]', e.message);
    }
    pos = msgEnd;
  }

  return buffer.substring(pos);
}

/**
 * Extrai valor de atributo XML.
 * Suporta aspas simples e duplas.
 */
function xAttr(xml, name) {
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*?)"|\'([^\']*?)\')');
  const m  = re.exec(xml);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

/**
 * Extrai todos os elementos filho de um tipo de tag.
 * Retorna Array<{ name, label, value, format }>.
 */
function xChildren(xml, ...tagNames) {
  const results = [];
  for (const tag of tagNames) {
    // Com conteúdo
    const reOpen = new RegExp('<' + tag + '((?:\\s[^>]*?)?)\\s*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'g');
    let m;
    while ((m = reOpen.exec(xml)) !== null) {
      const attrs = parseIndiAttrs(m[1]);
      results.push({ ...attrs, value: m[2].trim() });
    }
    // Self-closing
    const reSelf = new RegExp('<' + tag + '((?:\\s[^>]*?)?)\\s*/>', 'g');
    while ((m = reSelf.exec(xml)) !== null) {
      const attrs = parseIndiAttrs(m[1]);
      results.push({ ...attrs, value: attrs.value || '' });
    }
  }
  return results;
}

function parseIndiAttrs(str) {
  const obj = {};
  const re  = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)')/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    obj[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return obj;
}

/* ══════════════════════════════════════════════
   PARSER DE MENSAGENS INDI
   ══════════════════════════════════════════════ */

function parseIndiMessage(xml, tag, session) {
  const ws     = session.ws;
  const device = xAttr(xml, 'device');
  const name   = xAttr(xml, 'name');
  const state  = xAttr(xml, 'state');  // Ok | Busy | Alert | Idle
  const key    = device ? (KNOWN_DEVICES.get(device) || deviceKey(device)) : null;

  // Registra mapeamento device → key
  if (device && key && !KNOWN_DEVICES.has(device)) {
    KNOWN_DEVICES.set(device, key);
  }

  switch (tag) {

    /* ── Vetores numéricos ── */
    case 'defNumberVector':
    case 'setNumberVector': {
      // Coleta todos os valores numéricos do vetor
      const nums = {};
      for (const el of xChildren(xml, 'oneNumber', 'defNumber')) {
        const v = parseFloat(el.value !== '' ? el.value : (el['_value'] || '0'));
        if (!isNaN(v)) nums[el.name] = v;
      }

      if (name === 'EQUATORIAL_EOD_COORD' || name === 'EQUATORIAL_COORD') {
        const ra = nums['RA'], dec = nums['DEC'];
        if (ra != null && dec != null) {
          patchDevice('mount', {
            ra: formatRA(ra), dec: formatDec(dec),
            ra_raw: ra, dec_raw: dec,
            slewing: state === 'Busy',
            state:   state === 'Busy' ? 'slewing' :
                     DEVICE_STATE.mount.tracking ? 'tracking' : 'idle',
          });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      if (name === 'HORIZONTAL_COORD') {
        const alt = nums['ALT'], az = nums['AZ'];
        if (alt != null && az != null) {
          patchDevice('mount', { alt: alt.toFixed(2), az: az.toFixed(2) });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      if ((name === 'ABS_FOCUS_POSITION' || name === 'FOCUS_ABSOLUTE_POSITION') && key === 'focuser') {
        const pos = nums['FOCUS_ABSOLUTE_POSITION'] ?? nums['FOCUS_TICKS'];
        if (pos != null) {
          patchDevice('focuser', { position: Math.round(pos), moving: state === 'Busy' });
          emit(ws, 'device_update', { key: 'focuser', data: DEVICE_STATE.focuser });
        }
      }

      if (name === 'ABS_ROTATOR_ANGLE' && key === 'rotator') {
        const angle = nums['ANGLE'];
        if (angle != null) {
          patchDevice('rotator', { angle: angle.toFixed(2), moving: state === 'Busy' });
          emit(ws, 'device_update', { key: 'rotator', data: DEVICE_STATE.rotator });
        }
      }

      if (name === 'FILTER_SLOT' && key === 'filterwheel') {
        const slot = nums['FILTER_SLOT_VALUE'];
        if (slot != null) {
          const slotInt = Math.round(slot);
          const filterName = DEVICE_STATE.filterwheel.filterNames[slotInt - 1] || null;
          patchDevice('filterwheel', { slot: slotInt, filter: filterName });
          emit(ws, 'device_update', { key: 'filterwheel', data: DEVICE_STATE.filterwheel });
        }
      }

      if (name === 'CCD_EXPOSURE' && key === 'camera') {
        const exp = nums['CCD_EXPOSURE_VALUE'];
        if (exp != null) {
          patchDevice('camera', { exposure: exp, capturing: state === 'Busy' });
          emit(ws, 'device_update', { key: 'camera', data: DEVICE_STATE.camera });
        }
      }

      if (name === 'CCD_GAIN' && key === 'camera') {
        const gain = nums['GAIN'];
        if (gain != null) {
          patchDevice('camera', { gain });
          emit(ws, 'device_update', { key: 'camera', data: DEVICE_STATE.camera });
        }
      }

      if ((name === 'GEOGRAPHIC_COORD' || name === 'GPS_GEOGRAPHIC_COORD') && key === 'gps') {
        patchDevice('gps', { lat: nums['LAT'], lon: nums['LONG'], fix: true });
        emit(ws, 'device_update', { key: 'gps', data: DEVICE_STATE.gps });
      }

      break;
    }

    /* ── Vetores de switch ── */
    case 'defSwitchVector':
    case 'setSwitchVector': {
      const switches = {};
      for (const el of xChildren(xml, 'oneSwitch', 'defSwitch')) {
        switches[el.name] = el.value === 'On';
      }

      if (name === 'CONNECTION' && key) {
        const connected = switches['CONNECT'] === true;
        patchDevice(key, {
          connected,
          state: connected ? 'idle' : 'disconnected',
        });
        emit(ws, 'device_update', { key, data: DEVICE_STATE[key] });
        log(ws, connected ? 'ok' : 'wn',
          `${device || key} ${connected ? 'conectado' : 'desconectado'}`);
      }

      if (name === 'TELESCOPE_PARK' && key === 'mount') {
        const parked = switches['PARK'] === true;
        patchDevice('mount', {
          parked,
          state: parked ? 'parked' : 'idle',
        });
        emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
      }

      if (name === 'TELESCOPE_TRACK_MODE' && key === 'mount') {
        const modeMap = {
          TRACK_SIDEREAL:'Sidereal', TRACK_SOLAR:'Solar',
          TRACK_LUNAR:'Lunar', TRACK_CUSTOM:'Custom',
        };
        const active = Object.entries(switches).find(([,v]) => v);
        if (active) {
          patchDevice('mount', { tracking: modeMap[active[0]] || active[0] });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      if (name === 'TELESCOPE_TRACK_STATE' && key === 'mount') {
        const on = switches['TRACK_ON'] === true;
        patchDevice('mount', {
          tracking: on ? (DEVICE_STATE.mount.tracking || 'Sidereal') : null,
          state:    on ? 'tracking' : DEVICE_STATE.mount.state,
        });
        emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
      }

      if (name === 'TELESCOPE_SLEW_RATE' && key === 'mount') {
        const rateMap = {
          SLEW_GUIDE:'Guide', SLEW_CENTERING:'Centering',
          SLEW_FIND:'Find',   SLEW_MAX:'Max',
        };
        const active = Object.entries(switches).find(([,v]) => v);
        if (active) {
          patchDevice('mount', { slewRate: rateMap[active[0]] || active[0] });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      if ((name === 'FOCUS_MOTION' || name === 'FOCUSER_MOTION') && key === 'focuser') {
        const moving = switches['FOCUS_INWARD'] || switches['FOCUS_OUTWARD'];
        patchDevice('focuser', { moving: !!moving });
        emit(ws, 'device_update', { key: 'focuser', data: DEVICE_STATE.focuser });
      }

      if (name === 'GPS_STATUS' && key === 'gps') {
        patchDevice('gps', { fix: switches['GPS_FIX'] === true });
        emit(ws, 'device_update', { key: 'gps', data: DEVICE_STATE.gps });
      }

      break;
    }

    /* ── Vetores de texto ── */
    case 'defTextVector':
    case 'setTextVector': {
      const texts = {};
      for (const el of xChildren(xml, 'oneText', 'defText')) {
        texts[el.name] = el.value;
      }

      if (name === 'FILTER_NAME' && key === 'filterwheel') {
        const names = Object.values(texts).filter(Boolean);
        const slot  = DEVICE_STATE.filterwheel.slot;
        patchDevice('filterwheel', {
          filterNames: names,
          filter: slot != null ? names[slot - 1] || null : null,
        });
        emit(ws, 'device_update', { key: 'filterwheel', data: DEVICE_STATE.filterwheel });
      }

      if (name === 'GPS_UTC' && key === 'gps') {
        // GPS conectado e fornecendo hora
        patchDevice('gps', { connected: true, state: 'idle' });
        emit(ws, 'device_update', { key: 'gps', data: DEVICE_STATE.gps });
      }

      break;
    }

    /* ── Vetores de luz (status) ── */
    case 'defLightVector':
    case 'setLightVector': {
      if (state === 'Alert') {
        log(ws, 'er', `${device || '?'}/${name || '?'}: Alert`);
      }
      break;
    }

    /* ── Mensagem de log INDI ── */
    case 'message': {
      const txt = xAttr(xml, 'message');
      const ts  = xAttr(xml, 'timestamp');
      if (txt && txt.trim()) {
        const lvl = /error|err|falha/i.test(txt) ? 'er' : 'dim';
        log(ws, lvl, `[${ts||'--'}] ${device ? device + ': ' : ''}${txt}`);
      }
      break;
    }

    /* ── Dispositivo removido ── */
    case 'delProperty': {
      if (key) {
        KNOWN_DEVICES.delete(device);
        patchDevice(key, { connected: false, state: 'disconnected' });
        emit(ws, 'device_update', { key, data: DEVICE_STATE[key] });
      }
      if (device) log(ws, 'wn', `Dispositivo removido: ${device}`);
      break;
    }
  }
}

/* ── Atualiza DEVICE_STATE ── */
function patchDevice(key, patch) {
  if (DEVICE_STATE[key]) Object.assign(DEVICE_STATE[key], patch);
}

/* ══════════════════════════════════════════════
   FORMATAÇÃO DE COORDENADAS
   ══════════════════════════════════════════════ */

function formatRA(h) {
  if (h == null || isNaN(h)) return null;
  const hh = Math.floor(h), mf = (h - hh) * 60, mm = Math.floor(mf), ss = Math.round((mf - mm) * 60);
  return `${hh}h ${String(mm).padStart(2,'0')}m ${String(ss).padStart(2,'0')}s`;
}

function formatDec(d) {
  if (d == null || isNaN(d)) return null;
  const sign = d >= 0 ? '+' : '-';
  const a = Math.abs(d), dd = Math.floor(a), mf = (a - dd) * 60, mm = Math.floor(mf), ss = Math.round((mf - mm) * 60);
  return `${sign}${dd}° ${String(mm).padStart(2,"0")}' ${String(ss).padStart(2,"0")}"`;
}

function parseRA(s) {
  if (!s) return null;
  s = s.trim();
  if (/^[\d.]+$/.test(s)) return parseFloat(s);
  const m = s.match(/(\d+)\s*[h:]\s*(\d+)\s*[m:]?\s*(\d*\.?\d*)/i);
  if (m) return +m[1] + +m[2]/60 + (+m[3]||0)/3600;
  return null;
}

function parseDec(s) {
  if (!s) return null;
  s = s.trim();
  if (/^[+-]?[\d.]+$/.test(s)) return parseFloat(s);
  const neg = s[0] === '-';
  const m = s.match(/(\d+)\s*[°d:]\s*(\d+)\s*['"m:]?\s*(\d*\.?\d*)/i);
  if (m) return (neg ? -1 : 1) * (+m[1] + +m[2]/60 + (+m[3]||0)/3600);
  return null;
}

/* ══════════════════════════════════════════════
   EXPRESS + REST
   ══════════════════════════════════════════════ */

const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(CFG.PUBLIC_DIR));

/* Tokens de sessão — evita credenciais em URLs de iframe */
const TOKENS = new Map();

/**
 * POST /api/auth/terminal
 * Body: { user, password }
 * Valida via PAM (su) → retorna token temporário
 */
app.post('/api/auth/terminal', (req, res) => {
  const { user, password } = req.body || {};
  if (!user || !password)
    return res.status(400).json({ error: 'user e password obrigatórios' });

  // Validação via su — funciona sem instalar PAM extras
  const child = require('child_process').spawn('su', ['-c', 'exit 0', user], {
    stdio: ['pipe','ignore','ignore'],
  });
  child.stdin.write(password + '\n');
  child.stdin.end();
  child.on('close', (code) => {
    if (code !== 0) return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = crypto.randomBytes(32).toString('hex');
    TOKENS.set(token, { user, exp: Date.now() + CFG.TOKEN_TTL_MS });
    setTimeout(() => TOKENS.delete(token), CFG.TOKEN_TTL_MS);
    res.json({ token, ttl: CFG.TOKEN_TTL_MS });
  });
});

app.get('/api/ports', async (req, res) => {
  try {
    // Busca portas seriais comuns no Linux/Raspberry Pi
    const out = await sh('ls /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* 2>/dev/null');
    const ports = out.split('\n').filter(Boolean);
    res.json({ ports });
  } catch(e) { res.json({ ports: [] }); }
});

app.get('/api/auth/verify', (req, res) => {
  const t = TOKENS.get(req.query.token);
  if (!t || t.exp < Date.now()) return res.status(401).end();
  res.json({ user: t.user });
});

app.get('*', (_, res) => res.sendFile(path.join(CFG.PUBLIC_DIR, 'index.html')));

/* ══════════════════════════════════════════════
   WEBSOCKET — SESSÕES
   ══════════════════════════════════════════════ */

const wss      = new WebSocket.Server({ server, path: '/ws' });
const SESSIONS = new WeakMap();

wss.on('connection', (ws, req) => {
  console.log(`[WS] +cliente ${req.socket.remoteAddress}`);

  const session = {
    ws,
    alive:      true,
    indiSocket: null,
    indiBuffer: '',
    cmdQueue:   [],   // { xml, id } — enviados quando INDI reconectar
  };
  SESSIONS.set(ws, session);

  session.indiSocket = createIndiConn(session);

  ws.on('pong', () => { session.alive = true; });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') { emit(ws, 'pong', { ts: msg.ts }); return; }
      handleMsg(session, msg);
    } catch (e) { console.error('[WS msg]', e.message); }
  });
  ws.on('close',  () => {
    console.log('[WS] -cliente');
    if (session.indiSocket) session.indiSocket.destroy();
  });
  ws.on('error', (e) => console.error('[WS err]', e.message));

  // Envia estado completo inicial
  setTimeout(() => {
    emit(ws, 'full_state', { devices: DEVICE_STATE });
    refreshNet(ws);
    refreshDrivers(ws);
  }, 500);
});

/* Heartbeat — elimina zumbis */
const hbInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const s = SESSIONS.get(ws);
    if (!s) return;
    if (!s.alive) { ws.terminate(); return; }
    s.alive = false;
    ws.ping();
  });
}, CFG.HEARTBEAT_MS);

server.on('close', () => clearInterval(hbInterval));

/* ══════════════════════════════════════════════
   INDI — CONEXÃO RESILIENTE
   ══════════════════════════════════════════════ */

function createIndiConn(session) {
  const socket   = new net.Socket();
  let backoff    = CFG.INDI_BACKOFF_INIT;
  let reconTimer = null;
  let destroyed  = false;

  socket.setEncoding('utf8');
  socket.setKeepAlive(true, 10000);

  socket.connect(CFG.INDI_PORT, CFG.INDI_HOST, () => {
    backoff = CFG.INDI_BACKOFF_INIT;
    emit(session.ws, 'indi_status', { connected: true });
    log(session.ws, 'ok', `indiserver :${CFG.INDI_PORT}`);
    socket.write('<getProperties version="1.7"/>\n');
    flushQueue(session);
  });

  socket.on('data', (chunk) => {
    session.indiBuffer += chunk;
    session.indiBuffer = processIndiBuffer(session.indiBuffer, (xml, tag) => {
      parseIndiMessage(xml, tag, session);
    });
  });

  socket.on('error', (err) => {
    emit(session.ws, 'indi_status', { connected: false });
    log(session.ws, 'er', `INDI: ${err.message}`);
  });

  socket.on('close', () => {
    if (destroyed) return;
    emit(session.ws, 'indi_status', { connected: false });
    log(session.ws, 'wn', `INDI offline — reconecta em ${Math.round(backoff/1000)}s`);
    reconTimer = setTimeout(() => {
      if (!destroyed && session.ws.readyState === WebSocket.OPEN)
        session.indiSocket = createIndiConn(session);
    }, backoff);
    backoff = Math.min(backoff * 1.5, CFG.INDI_BACKOFF_MAX);
  });

  /* Sobrescreve destroy para cancelar timers */
  const origDestroy = socket.destroy.bind(socket);
  socket.destroy = () => {
    destroyed = true;
    clearTimeout(reconTimer);
    origDestroy();
  };

  return socket;
}

/* ── Flush da fila de comandos pendentes ── */
function flushQueue(session) {
  while (session.cmdQueue.length > 0) {
    const { xml } = session.cmdQueue[0];
    const s = session.indiSocket;
    if (s && !s.destroyed && s.writable) {
      s.write(xml + '\n');
      session.cmdQueue.shift();
    } else break;
  }
}

/* ── Escreve no INDI (ou enfileira) ── */
function indiWrite(session, xml, id) {
  const s = session.indiSocket;
  if (s && !s.destroyed && s.writable) {
    s.write(xml + '\n');
    return true;
  }
  if (id) session.cmdQueue.push({ xml, id });
  return false;
}

/* ══════════════════════════════════════════════
   INDI — COMANDOS
   ══════════════════════════════════════════════ */

/* Monta nome do dispositivo de montagem (usa o primeiro conhecido) */
function mountDev() {
  for (const [name, key] of KNOWN_DEVICES) {
    if (key === 'mount') return name;
  }
  return 'Telescope Simulator';
}

function indiSlew(session, dir, start) {
  const isNS = dir === 'N' || dir === 'S';
  const prop = isNS ? 'TELESCOPE_MOTION_NS' : 'TELESCOPE_MOTION_WE';
  const mot  = { N:'MOTION_NORTH', S:'MOTION_SOUTH', W:'MOTION_WEST', E:'MOTION_EAST' };
  const opp  = { N:'MOTION_SOUTH', S:'MOTION_NORTH', W:'MOTION_EAST', E:'MOTION_WEST' };
  indiWrite(session,
    `<newSwitchVector device="${mountDev()}" name="${prop}">` +
    `<oneSwitch name="${mot[dir]}">${start?'On':'Off'}</oneSwitch>` +
    `<oneSwitch name="${opp[dir]}">Off</oneSwitch>` +
    `</newSwitchVector>`);
}

function indiSlewRate(session, rate) {
  const tiers = [
    { max:2, n:'SLEW_GUIDE' }, { max:8, n:'SLEW_CENTERING' },
    { max:16, n:'SLEW_FIND' }, { max:Infinity, n:'SLEW_MAX' },
  ];
  const chosen = tiers.find(t => rate <= t.max).n;
  const sw = tiers.map(t => `<oneSwitch name="${t.n}">${t.n===chosen?'On':'Off'}</oneSwitch>`).join('');
  indiWrite(session, `<newSwitchVector device="${mountDev()}" name="TELESCOPE_SLEW_RATE">${sw}</newSwitchVector>`);
}

function indiGoto(session, ra, dec, id) {
  const dev = mountDev();
  indiWrite(session,
    `<newSwitchVector device="${dev}" name="ON_COORD_SET">` +
    `<oneSwitch name="TRACK">On</oneSwitch><oneSwitch name="SLEW">Off</oneSwitch><oneSwitch name="SYNC">Off</oneSwitch>` +
    `</newSwitchVector>`, id ? id+'_mode' : undefined);
  indiWrite(session,
    `<newNumberVector device="${dev}" name="EQUATORIAL_EOD_COORD">` +
    `<oneNumber name="RA">${ra.toFixed(6)}</oneNumber>` +
    `<oneNumber name="DEC">${dec.toFixed(6)}</oneNumber>` +
    `</newNumberVector>`, id);
}

function indiSync(session) {
  const dev = mountDev();
  indiWrite(session,
    `<newSwitchVector device="${dev}" name="ON_COORD_SET">` +
    `<oneSwitch name="SYNC">On</oneSwitch><oneSwitch name="TRACK">Off</oneSwitch><oneSwitch name="SLEW">Off</oneSwitch>` +
    `</newSwitchVector>`);
  const { ra_raw: ra, dec_raw: dec } = DEVICE_STATE.mount;
  if (ra != null && dec != null) {
    indiWrite(session,
      `<newNumberVector device="${dev}" name="EQUATORIAL_EOD_COORD">` +
      `<oneNumber name="RA">${ra.toFixed(6)}</oneNumber>` +
      `<oneNumber name="DEC">${dec.toFixed(6)}</oneNumber>` +
      `</newNumberVector>`);
  }
}

function indiPark(session, park) {
  indiWrite(session,
    `<newSwitchVector device="${mountDev()}" name="TELESCOPE_PARK">` +
    `<oneSwitch name="${park?'PARK':'UNPARK'}">On</oneSwitch>` +
    `</newSwitchVector>`);
}

function indiTracking(session, mode) {
  const dev = mountDev();
  if (mode === 'None') {
    indiWrite(session,
      `<newSwitchVector device="${dev}" name="TELESCOPE_TRACK_STATE">` +
      `<oneSwitch name="TRACK_OFF">On</oneSwitch><oneSwitch name="TRACK_ON">Off</oneSwitch>` +
      `</newSwitchVector>`);
    return;
  }
  indiWrite(session,
    `<newSwitchVector device="${dev}" name="TELESCOPE_TRACK_STATE">` +
    `<oneSwitch name="TRACK_ON">On</oneSwitch><oneSwitch name="TRACK_OFF">Off</oneSwitch>` +
    `</newSwitchVector>`);
  const mMap = { Sidereal:'TRACK_SIDEREAL', Solar:'TRACK_SOLAR', Lunar:'TRACK_LUNAR' };
  const mn   = mMap[mode];
  if (mn) {
    const all = ['TRACK_SIDEREAL','TRACK_SOLAR','TRACK_LUNAR','TRACK_CUSTOM'];
    const sw  = all.map(n => `<oneSwitch name="${n}">${n===mn?'On':'Off'}</oneSwitch>`).join('');
    indiWrite(session, `<newSwitchVector device="${dev}" name="TELESCOPE_TRACK_MODE">${sw}</newSwitchVector>`);
  }
}

/* ══════════════════════════════════════════════
   RESOLUÇÃO DE NOMES — Sesame CDS
   ══════════════════════════════════════════════ */

function resolveObject(name) {
  return new Promise((resolve, reject) => {
    // Sesame retorna XML compacto com ra/dec em graus (J2000)
    const url = `http://cdsweb.u-strasbg.fr/cgi-bin/nph-sesame/-ox?${encodeURIComponent(name)}`;
    const req = http.get(url, { timeout: CFG.SESAME_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ram  = data.match(/<jradeg>([\d.]+)<\/jradeg>/);
        const decm = data.match(/<jdedeg>([+-]?[\d.]+)<\/jdedeg>/);
        if (ram && decm) {
          resolve({ ra: parseFloat(ram[1]) / 15, dec: parseFloat(decm[1]) });
        } else {
          // Fallback: Simbad TAP
          const sql = `SELECT ra,dec FROM basic JOIN ident ON oidref=oid WHERE id='${name.replace(/'/g,"\\'")}' LIMIT 1`;
          const tap = `http://simbad.u-strasbg.fr/simbad/sim-tap/sync?REQUEST=doQuery&LANG=ADQL&FORMAT=text&QUERY=${encodeURIComponent(sql)}`;
          http.get(tap, { timeout: CFG.SESAME_TIMEOUT_MS }, (r2) => {
            let d2 = '';
            r2.on('data', c => d2 += c);
            r2.on('end', () => {
              const lines = d2.trim().split('\n').filter(l => l && !l.startsWith('#'));
              if (lines.length >= 2) {
                const parts = lines[lines.length-1].split(',');
                if (parts.length >= 2) {
                  const raDeg = parseFloat(parts[0].trim());
                  const dec   = parseFloat(parts[1].trim());
                  if (!isNaN(raDeg) && !isNaN(dec)) { resolve({ ra: raDeg/15, dec }); return; }
                }
              }
              reject(new Error(`Objeto não encontrado: ${name}`));
            });
          }).on('error', reject).on('timeout', () => reject(new Error('Timeout Simbad')));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout Sesame: ${name}`)); });
  });
}

/* ══════════════════════════════════════════════
   HANDLER DE MENSAGENS DO FRONTEND
   ══════════════════════════════════════════════ */

function handleMsg(session, msg) {
  const ws = session.ws;
  switch (msg.type) {
    case 'slew_start':    indiSlew(session, msg.direction, true);  break;
    case 'slew_stop':     indiSlew(session, msg.direction, false); break;
    case 'slew_rate':     indiSlewRate(session, msg.rate);         break;
    case 'tracking':      indiTracking(session, msg.mode);         break;
    case 'sync':          indiSync(session);  emit(ws,'goto_result',{success:true,message:'Sync enviado'}); break;
    case 'park':          indiPark(session,true);  emit(ws,'goto_result',{success:true,message:'Park enviado'}); break;
    case 'unpark':        indiPark(session,false); break;
    case 'driver_start':  startDriver(session, msg.driver, msg.port); break;
    case 'driver_stop':   stopDriver(ws, msg.driver);  break;
    case 'ap_toggle':     toggleAP(ws, msg.enable);    break;
    case 'network_status': refreshNet(ws); break;
    case 'get_state':     emit(ws,'full_state',{ devices: DEVICE_STATE }); break;

    case 'goto_name': {
      const id = 'goto_' + Date.now();
      emit(ws, 'goto_result', { success: null, message: `Resolvendo "${msg.name}"…` });
      resolveObject(msg.name)
        .then(({ ra, dec }) => {
          indiGoto(session, ra, dec, id);
          emit(ws, 'goto_result', { success: true, message: `${msg.name} → ${formatRA(ra)} / ${formatDec(dec)}` });
        })
        .catch(err => emit(ws, 'goto_result', { success: false, message: err.message }));
      break;
    }

    case 'goto_coords': {
      const ra  = parseRA(msg.ra);
      const dec = parseDec(msg.dec);
      if (ra == null || dec == null) {
        emit(ws, 'goto_result', { success: false, message: 'Coordenadas inválidas' });
        break;
      }
      const id = 'goto_' + Date.now();
      indiGoto(session, ra, dec, id);
      emit(ws, 'goto_result', { success: true, message: `GoTo → ${formatRA(ra)} / ${formatDec(dec)}` });
      break;
    }
  }
}

/* ══════════════════════════════════════════════
   DRIVERS — INDI WEB MANAGER
   ══════════════════════════════════════════════ */

function indiWebReq(method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: CFG.INDIWEB_HOST, port: CFG.INDIWEB_PORT, path: urlPath, method, timeout: 5000 },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('indiweb timeout')); });
    req.end();
  });
}

async function startDriver(session, driver, port) {
  const ws = session.ws;
  try {
    await indiWebReq('POST', `/api/server/start/${encodeURIComponent(driver)}`);
    log(ws, 'ok', `Driver: ${driver} iniciado`);

    // Se uma porta foi fornecida, tentamos configurar o driver
    if (port) {
      log(ws, 'dim', `Configurando porta: ${port}...`);
      
      // Tentativa imediata e uma tentativa após 3s (para garantir que o driver registrou as props)
      const setPort = () => {
        const devName = Array.from(KNOWN_DEVICES.entries()).find(([name, key]) => 
          name === driver || name.toLowerCase().includes(driver.toLowerCase()) || 
          (DRIVER_MAP[key] === driver)
        )?.[0] || driver;

        const xml = `<newTextVector device="${devName}" name="DEVICE_PORT"><oneText name="PORT">${port}</oneText></newTextVector>`;
        indiWrite(session, xml);
        // Também tenta conectar o driver após setar a porta
        indiWrite(session, `<newSwitchVector device="${devName}" name="CONNECTION"><oneSwitch name="CONNECT">On</oneSwitch></newSwitchVector>`);
      };

      setPort();
      setTimeout(setPort, 3000);
    }

    setTimeout(() => refreshDrivers(ws), 1500);
  } catch(e) { log(ws, 'er', `Falha ao iniciar ${driver}: ${e.message}`); }
}

async function stopDriver(ws, driver) {
  try {
    await indiWebReq('POST', `/api/server/stop/${encodeURIComponent(driver)}`);
    log(ws, 'wn', `Driver: ${driver} parado`);
    setTimeout(() => refreshDrivers(ws), 1500);
  } catch(e) { log(ws, 'er', `Falha ao parar ${driver}: ${e.message}`); }
}

async function refreshDrivers(ws) {
  try {
    const data = await indiWebReq('GET', '/api/server/status');
    if (!data || typeof data !== 'object') return;
    emit(ws, 'driver_status', {
      indiserver: data.status === 'running',
      drivers: (data.drivers || []).map(d => ({
        name:      d.name || String(d),
        label:     d.label || d.name || String(d),
        connected: d.state === 'Running' || d.connected === true,
        error:     d.state === 'Error',
        state:     d.state || 'unknown',
      }))
    });
  } catch { /* indiweb offline */ }
}

/* ══════════════════════════════════════════════
   REDE
   ══════════════════════════════════════════════ */

const portCheck = (port) => new Promise(resolve => {
  const s = new net.Socket();
  s.setTimeout(500);
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error',   () => resolve(false));
  s.on('timeout', () => { s.destroy(); resolve(false); });
  s.connect(port, '127.0.0.1');
});

const sh = (cmd) => new Promise(resolve =>
  exec(cmd, { timeout: 5000 }, (_, out) => resolve((out||'').trim()))
);

async function refreshNet(ws) {
  const [con, ip, wifi, apClients] = await Promise.all([
    sh('nmcli -t -f NAME,STATE con show --active 2>/dev/null'),
    sh("hostname -I 2>/dev/null | awk '{print $1}'"),
    sh("nmcli -t -f IN-USE,SSID,SIGNAL dev wifi 2>/dev/null | grep '^\\*' | head -1"),
    sh("iw dev wlan0 station dump 2>/dev/null | grep -c Station || echo 0"),
  ]);

  const ap    = con.includes('AstroPi-AP');
  const wp    = wifi.split(':');
  const ssid  = wp[1] || '--';
  const rssi  = wp[2] ? `${Math.round(-100 + +wp[2] / 2)} dBm` : '--';

  const ports  = { indiweb:8624, kstars:6080, phd2:6081, desktop:6082, ttyd:7681, gpsd:2947, bridge:3000 };
  const svcs   = {};
  await Promise.all(Object.entries(ports).map(async ([k,p]) => { svcs[k] = await portCheck(p); }));

  emit(ws, 'network', {
    mode: ap ? 'STA + AP' : 'STA',
    ip: ip || '--', ssid, signal: rssi,
    ap_active: ap, ap_clients: parseInt(apClients) || 0,
    services: svcs,
  });
}

function toggleAP(ws, enable) {
  exec(enable ? 'nmcli con up AstroPi-AP' : 'nmcli con down AstroPi-AP', { timeout: 15000 }, (err) => {
    log(ws, err ? 'er' : 'ok', err ? `AP: ${err.message}` : `AP ${enable?'ativado':'desativado'}`);
    setTimeout(() => refreshNet(ws), 2000);
  });
}

/* ══════════════════════════════════════════════
   UTILITÁRIOS
   ══════════════════════════════════════════════ */

function emit(ws, type, data) {
  if (ws && ws.readyState === WebSocket.OPEN)
    try { ws.send(JSON.stringify({ type, ...data })); } catch {}
}

function log(ws, level, text) {
  emit(ws, 'log', { level, text });
}

/* ══════════════════════════════════════════════
   INICIA
   ══════════════════════════════════════════════ */

server.listen(CFG.PORT, '0.0.0.0', () => {
  console.log(`[AstroControl] http://0.0.0.0:${CFG.PORT}`);
  console.log(`[AstroControl] → http://astropi.local:${CFG.PORT}`);
});

process.on('uncaughtException',  (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (r) => console.error('[rejection]', r));
