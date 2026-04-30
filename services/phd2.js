'use strict';

const net = require('net');

const { emit, log } = require('../utils/emit');

const PHD2_HOST = '127.0.0.1';
const PHD2_PORT = 4400;
const PHD2_TIMEOUT_MS = 5000;

let rpcId = 1;

function phd2Rpc(method, params) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      err ? reject(err) : resolve(value);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(PHD2_TIMEOUT_MS);

    socket.on('connect', () => {
      const payload = { method, id: rpcId++ };
      if (params !== undefined) payload.params = params;
      socket.write(JSON.stringify(payload) + '\r\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) return;

      const line = buffer.slice(0, lineEnd).trim();
      if (!line) return;

      try {
        const msg = JSON.parse(line);
        if (msg.error) {
          finish(new Error(msg.error.message || 'Erro PHD2'));
        } else {
          finish(null, msg.result);
        }
      } catch (e) {
        finish(e);
      }
    });

    socket.on('timeout', () => finish(new Error('Timeout PHD2')));
    socket.on('error', finish);
    socket.connect(PHD2_PORT, PHD2_HOST);
  });
}

async function refreshPHD2(ws) {
  try {
    const [appState, connected, equipment, exposure] = await Promise.all([
      phd2Rpc('get_app_state').catch(() => 'unknown'),
      phd2Rpc('get_connected').catch(() => false),
      phd2Rpc('get_current_equipment').catch(() => null),
      phd2Rpc('get_exposure').catch(() => null),
    ]);

    emit(ws, 'phd2_status', {
      online: true,
      appState,
      connected: !!connected,
      equipment,
      exposure,
    });
  } catch (e) {
    emit(ws, 'phd2_status', {
      online: false,
      connected: false,
      appState: 'offline',
      error: e.message,
    });
  }
}

async function phd2Guide(ws, options = {}) {
  const settle = {
    pixels: Number(options.pixels) || 1.5,
    time: Number(options.time) || 8,
    timeout: Number(options.timeout) || 60,
  };

  try {
    await phd2Rpc('guide', {
      settle,
      recalibrate: !!options.recalibrate,
    });
    log(ws, 'ok', 'PHD2: guiding iniciado');
    refreshPHD2(ws);
  } catch (e) {
    log(ws, 'er', `PHD2 guide: ${e.message}`);
    refreshPHD2(ws);
  }
}

async function phd2Loop(ws, exposureMs) {
  try {
    if (exposureMs) await phd2Rpc('set_exposure', [Number(exposureMs)]);
    await phd2Rpc('loop');
    log(ws, 'ok', 'PHD2: looping iniciado');
    refreshPHD2(ws);
  } catch (e) {
    log(ws, 'er', `PHD2 loop: ${e.message}`);
    refreshPHD2(ws);
  }
}

async function phd2Stop(ws) {
  try {
    await phd2Rpc('stop_capture');
    log(ws, 'wn', 'PHD2: captura/guiagem parada');
    refreshPHD2(ws);
  } catch (e) {
    log(ws, 'er', `PHD2 stop: ${e.message}`);
    refreshPHD2(ws);
  }
}

async function phd2Dither(ws, options = {}) {
  try {
    await phd2Rpc('dither', {
      amount: Number(options.amount) || 3,
      raOnly: !!options.raOnly,
      settle: {
        pixels: Number(options.pixels) || 1.5,
        time: Number(options.time) || 8,
        timeout: Number(options.timeout) || 60,
      },
    });
    log(ws, 'ok', 'PHD2: dither enviado');
    refreshPHD2(ws);
  } catch (e) {
    log(ws, 'er', `PHD2 dither: ${e.message}`);
    refreshPHD2(ws);
  }
}

module.exports = {
  refreshPHD2,
  phd2Guide,
  phd2Loop,
  phd2Stop,
  phd2Dither,
};
