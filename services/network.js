'use strict';

const net = require('net');
const { exec } = require('child_process');

const { emit, log } = require('../utils/emit');

/* Helpers */
const portCheck = (port) => new Promise(resolve => {
  const s = new net.Socket();

  s.setTimeout(500);

  s.on('connect', () => {
    s.destroy();
    resolve(true);
  });

  s.on('error', () => resolve(false));

  s.on('timeout', () => {
    s.destroy();
    resolve(false);
  });

  s.connect(port, '127.0.0.1');
});

const sh = (cmd) => new Promise(resolve =>
  exec(cmd, { timeout: 5000 }, (_, out) =>
    resolve((out || '').trim())
  )
);

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/* Status */
async function refreshNet(ws) {
  const [con, ip, wifi, apClients] = await Promise.all([
    sh('nmcli -t -f NAME,STATE con show --active 2>/dev/null'),
    sh("hostname -I 2>/dev/null | awk '{print $1}'"),
    sh("nmcli -t -f IN-USE,SSID,SIGNAL dev wifi 2>/dev/null | grep '^\\*' | head -1"),
    sh("iw dev wlan0 station dump 2>/dev/null | grep -c Station || echo 0"),
  ]);

  const ap = con.includes('AstroPi-AP');

  const wp = wifi.split(':');
  const ssid = wp[1] || '--';
  const rssi = wp[2]
    ? `${Math.round(-100 + +wp[2] / 2)} dBm`
    : '--';

  const ports = {
    indiweb: 8624,
    kasmvnc: 8443,
    kstars: 8444,
    phd2: 4400,
    ttyd: 7681,
    gpsd: 2947,
    bridge: 3000
  };

  const svcs = {};

  await Promise.all(
    Object.entries(ports).map(async ([k, p]) => {
      svcs[k] = await portCheck(p);
    })
  );

  emit(ws, 'network', {
    mode: ap ? 'STA + AP' : 'STA',
    ip: ip || '--',
    ssid,
    signal: rssi,
    ap_active: ap,
    ap_clients: parseInt(apClients) || 0,
    services: svcs,
  });
}

/* Toggle AP */
function toggleAP(ws, enable) {
  exec(
    enable
      ? 'nmcli con up AstroPi-AP'
      : 'nmcli con down AstroPi-AP',
    { timeout: 15000 },
    (err) => {
      log(
        ws,
        err ? 'er' : 'ok',
        err
          ? `AP: ${err.message}`
          : `AP ${enable ? 'ativado' : 'desativado'}`
      );

      setTimeout(() => refreshNet(ws), 2000);
    }
  );
}

/* Modo descoberta para conectar a novas redes */
function discoveryMode(ws, enable) {
  if (enable) {
    // Verifica se AP está ativo
    exec('nmcli -t -f NAME,STATE con show --active', (err, stdout) => {
      const apActive = stdout.includes('AstroPi-AP');

      if (!apActive) {
        log(ws, 'dim', 'AP já está desativado - modo descoberta não necessário');
        return;
      }

      log(ws, 'ok', 'Iniciando modo descoberta com watchdog de segurança...');

      // Desativa AP temporariamente
      exec('nmcli con down AstroPi-AP', { timeout: 5000 }, (err) => {
        if (err) {
          log(ws, 'er', `Falha ao desativar AP: ${err.message}`);
          return;
        }

        log(ws, 'ok', 'AP desativado - watchdog monitorando conectividade (30s)');

        // Watchdog: monitora conectividade e reativa AP se necessário
        let watchdogAttempts = 0;
        const watchdog = () => {
          watchdogAttempts++;

          exec('nmcli -t -g DEVICE,STATE dev | grep ":connected"', (err, stdout) => {
            const hasConnection = stdout.trim().length > 0;

            if (hasConnection) {
              // Conectou! Cancela watchdog
              log(ws, 'ok', 'Conexão STA detectada - mantendo rede WiFi');
              refreshNet(ws);
              return;
            }

            if (watchdogAttempts >= 30) {
              // Timeout: reativa AP
              exec('nmcli con up AstroPi-AP', { timeout: 5000 }, (err2) => {
                if (!err2) {
                  log(ws, 'wn', 'Watchdog: Timeout sem conexão - AP reativado automaticamente');
                  refreshNet(ws);
                }
              });
              return;
            }

            // Continua monitorando
            setTimeout(watchdog, 1000);
          });
        };

        watchdog();
        refreshNet(ws);
      });
    });
  } else {
    // Reativa AP imediatamente
    toggleAP(ws, true);
  }
}

/* Conectar a rede WiFi */
function connectWifi(ws, ssid, password) {
  const escapedSsid = shellEscape(ssid);
  const escapedPw   = shellEscape(password);

  log(ws, 'dim', `Conectando a "${ssid}"…`);

  exec(
    `nmcli dev wifi connect ${escapedSsid} password ${escapedPw}`,
    { timeout: 20000 },
    (err) => {
      log(
        ws,
        err ? 'er' : 'ok',
        err ? `WiFi: ${err.message}` : `Conectado a "${ssid}"`
      );

      setTimeout(() => refreshNet(ws), 2000);
    }
  );
}

module.exports = {
  refreshNet,
  toggleAP,
  discoveryMode,
  connectWifi,
};
