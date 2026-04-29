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
    kstars: 6080,
    phd2: 6081,
    desktop: 6082,
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

      log(ws, 'ok', 'Iniciando modo descoberta...');

      // Desativa AP temporariamente
      exec('nmcli con down AstroPi-AP', { timeout: 5000 }, (err) => {
        if (err) {
          log(ws, 'er', `Falha ao desativar AP: ${err.message}`);
          return;
        }

        log(ws, 'ok', 'AP desativado - você tem 30 segundos para conectar a uma rede');

        // Timer para reativar AP automaticamente
        const reactivationTimer = setTimeout(() => {
          exec('nmcli con up AstroPi-AP', { timeout: 5000 }, (err2) => {
            if (!err2) {
              log(ws, 'dim', 'Modo descoberta expirado - AP reativado automaticamente');
              refreshNet(ws);
            }
          });
        }, 30000); // 30 segundos

        // Monitora conexão STA por 30 segundos
        let attempts = 0;
        const checkConnection = () => {
          attempts++;
          exec('nmcli -t -g DEVICE,STATE dev | grep "^wlan0:connected"', (err, stdout) => {
            if (stdout.trim()) {
              // Conectou! Cancela timer e mantém STA
              clearTimeout(reactivationTimer);
              log(ws, 'ok', 'Conexão STA detectada - mantendo rede WiFi');
              refreshNet(ws);
            } else if (attempts < 30) {
              setTimeout(checkConnection, 1000);
            }
          });
        };

        checkConnection();
        refreshNet(ws);
      });
    });
  } else {
    // Reativa AP imediatamente
    toggleAP(ws, true);
  }
}

module.exports = {
  refreshNet,
  toggleAP,
  discoveryMode,
};