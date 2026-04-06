Project Root: D:\Documentos\PlatformIO\Projects\Astrocontrol
Project Structure:
```
.
|-- .gitattributes
|-- README.md
|-- astrocontrol.service
|-- bridge.py
|-- deploy.sh
|-- install.md
|-- novnc-services.md
|-- package.json
|-- prompt_astrocontrol_claude.md
|-- public
    |-- alignment.js
    |-- app.js
    |-- index.html
    |-- manifest.json
    |-- style.css
    |-- sw.js
|-- server.js
|-- setup-novnc.sh
|-- teste

```

---
## File: bridge.py

```py
#!/usr/bin/env python3
"""
AstroControl — bridge.py  v1.0

Sensor Bridge: ADXL345 (SPI) + Compass HMC/QMC (I2C) + GPSD → WebSocket :8765

Arquitetura — Single Source of Truth:
  GPSD é o único processo que acessa /dev/ttyAMA0 diretamente.
  Este script, o driver indi_gpsd e o Chrony são CLIENTES do GPSD via socket TCP.

Fluxo de inicialização (Estratégia de Snapshot):
  1. Conecta ao GPSD via localhost:2947
  2. Aguarda GPS mode >= 3 (3D Fix)
  3. Coleta 5 amostras de lat/lon, descarta extremos (min/max), tira média das 3 restantes
  4. Calcula Declinação Magnética via pyIGRF (WMM)
  5. Persiste resultado em /dev/shm/astro_env.json (RAM — acesso instantâneo)
  6. Publica dados em loop via WebSocket :8765 para o frontend PWA

Watchdog:
  Se o GPSD não responder por GPS_WATCHDOG_SECS, reinicia o serviço via systemctl.
  Requer entrada no sudoers para o usuário samu192:
    samu192 ALL=(ALL) NOPASSWD: /bin/systemctl restart gpsd
"""

import asyncio
import json
import logging
import math
import os
import subprocess
import threading
import time
from datetime import datetime, timezone

# ── Dependências externas (pip install) ──
import gps          # gpsd-py3
import smbus2       # smbus2
import spidev       # spidev
import websockets   # websockets

try:
    import pyIGRF
    HAS_IGRF = True
except ImportError:
    HAS_IGRF = False

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('bridge')

# ── Configuração ──
CFG = {
    'WS_HOST':           '0.0.0.0',
    'WS_PORT':           8765,
    'GPSD_HOST':         '127.0.0.1',
    'GPSD_PORT':         2947,
    'GPS_SAMPLES':       5,        # Amostras para snapshot (descarta 2 extremos)
    'GPS_WATCHDOG_SECS': 60,       # Tempo sem update → restart gpsd
    'CACHE_FILE':        '/dev/shm/astro_env.json',
    'PUBLISH_HZ':        10,       # Frequência de publicação WebSocket
    'I2C_BUS':           1,
    'SPI_BUS':           0,
    'SPI_DEVICE':        0,        # CE0 → ADXL345
    'COMPASS_ADDR_HMC':  0x1E,    # HMC5883L
    'COMPASS_ADDR_QMC':  0x0D,    # QMC5883L
}

# ── Estado global compartilhado ──
STATE = {
    'gps':         {'lat': None, 'lon': None, 'alt': None, 'fix': False, 'sats': 0, 'mode': 0},
    'mag_dec':     None,       # Declinação magnética (°, + = Leste)
    'heading':     None,       # Rumo magnético bruto (°)
    'true_heading': None,      # Rumo verdadeiro = heading + mag_dec (°)
    'pitch':       None,       # Ângulo de inclinação (°)
    'roll':        None,       # Ângulo de rolamento (°)
    'accel':       {'x': None, 'y': None, 'z': None},
    'ts':          None,
}
STATE_LOCK = threading.Lock()
CLIENTS    = set()

# ══════════════════════════════════════════════
#  GPSD CLIENT
# ══════════════════════════════════════════════

class GPSClient:
    """Cliente do GPSD. Único ponto de acesso aos dados GPS."""

    def __init__(self):
        self._session      = None
        self._last_update  = time.monotonic()
        self._samples      = []
        self._snap_done    = False

    def connect(self):
        try:
            self._session = gps.gps(
                host=CFG['GPSD_HOST'],
                port=CFG['GPSD_PORT'],
                mode=gps.WATCH_ENABLE | gps.WATCH_NEWSTYLE,
            )
            log.info(f"GPSD conectado em {CFG['GPSD_HOST']}:{CFG['GPSD_PORT']}")
        except Exception as e:
            log.error(f"Falha ao conectar ao GPSD: {e}")

    def poll(self):
        """Lê o próximo report do GPSD (bloqueante — chamar em thread separada)."""
        if not self._session:
            time.sleep(5)
            self.connect()
            return

        try:
            report = self._session.next()

            if report['class'] == 'TPV':
                mode = getattr(report, 'mode', 0)
                lat  = getattr(report, 'lat',  None)
                lon  = getattr(report, 'lon',  None)
                alt  = getattr(report, 'alt',  None)

                with STATE_LOCK:
                    STATE['gps'].update({
                        'lat':  lat,
                        'lon':  lon,
                        'alt':  alt,
                        'mode': mode,
                        'fix':  mode >= 2,
                    })

                if lat is not None and lon is not None:
                    self._last_update = time.monotonic()

                    # Acumula amostras apenas com 3D Fix e antes do snapshot
                    if mode >= 3 and not self._snap_done:
                        self._samples.append((lat, lon, alt or 0))
                        log.info(
                            f"Amostra GPS {len(self._samples)}/{CFG['GPS_SAMPLES']}: "
                            f"lat={lat:.5f} lon={lon:.5f}"
                        )
                        if len(self._samples) >= CFG['GPS_SAMPLES']:
                            self._compute_snapshot()

            elif report['class'] == 'SKY':
                sats = len([s for s in getattr(report, 'satellites', [])
                            if getattr(s, 'used', False)])
                with STATE_LOCK:
                    STATE['gps']['sats'] = sats

        except StopIteration:
            log.warning("GPSD stream encerrado — reconectando…")
            time.sleep(3)
            self.connect()
        except Exception as e:
            log.error(f"GPSD poll error: {e}")
            time.sleep(1)

    def _compute_snapshot(self):
        """
        Snapshot anti-ruído:
        - 5 amostras → ordena → descarta min e max (1 de cada)
        - Média das 3 centrais
        - Calcula declinação magnética (WMM/pyIGRF)
        - Cache em /dev/shm/astro_env.json
        """
        samples = self._samples[:]
        lats = sorted(s[0] for s in samples)
        lons = sorted(s[1] for s in samples)
        alts = sorted(s[2] for s in samples)

        # Descarta extremo inferior e superior
        lat_avg = sum(lats[1:-1]) / len(lats[1:-1])
        lon_avg = sum(lons[1:-1]) / len(lons[1:-1])
        alt_avg = sum(alts[1:-1]) / len(alts[1:-1])

        log.info(f"Snapshot GPS: lat={lat_avg:.5f} lon={lon_avg:.5f} alt={alt_avg:.1f}m")

        mag_dec = None
        if HAS_IGRF:
            try:
                now  = datetime.now(timezone.utc)
                year = now.year + now.timetuple().tm_yday / 365.0
                # igrf_variation(lat, lon, alt_km, year) → (D, I, H, X, Y, Z, F)
                result  = pyIGRF.igrf_variation(lat_avg, lon_avg, alt_avg / 1000.0, year)
                mag_dec = round(result[0], 2)
                log.info(f"Declinação magnética: {mag_dec:+.2f}°")
            except Exception as e:
                log.error(f"pyIGRF error: {e}")
        else:
            log.warning("pyIGRF indisponível — declinação não calculada")

        env = {
            'lat':          round(lat_avg, 6),
            'lon':          round(lon_avg, 6),
            'alt_m':        round(alt_avg, 1),
            'mag_dec':      mag_dec,
            'computed_at':  datetime.now(timezone.utc).isoformat(),
        }
        try:
            with open(CFG['CACHE_FILE'], 'w') as f:
                json.dump(env, f, indent=2)
            log.info(f"Cache salvo em {CFG['CACHE_FILE']}")
        except Exception as e:
            log.error(f"Erro ao salvar cache: {e}")

        with STATE_LOCK:
            STATE['mag_dec'] = mag_dec

        self._snap_done = True

    def watchdog(self):
        """Reinicia gpsd se sem atualização por GPS_WATCHDOG_SECS."""
        elapsed = time.monotonic() - self._last_update
        if elapsed > CFG['GPS_WATCHDOG_SECS']:
            log.warning(f"GPSD sem update há {int(elapsed)}s — reiniciando…")
            try:
                subprocess.run(
                    ['sudo', 'systemctl', 'restart', 'gpsd'],
                    timeout=15, check=False,
                )
            except Exception as e:
                log.error(f"Falha ao reiniciar gpsd: {e}")
            self._last_update = time.monotonic()


# ══════════════════════════════════════════════
#  ADXL345 — ACELERÔMETRO (SPI CE0)
# ══════════════════════════════════════════════

class ADXL345:
    _REG_DATA_FORMAT = 0x31
    _REG_POWER_CTL   = 0x2D
    _REG_DATAX0      = 0x32
    _READ            = 0x80
    _MULTI           = 0x40
    _SCALE           = 0.004  # g/LSB em ±16g full-res

    def __init__(self, bus=CFG['SPI_BUS'], device=CFG['SPI_DEVICE']):
        self._spi = spidev.SpiDev()
        self._spi.open(bus, device)
        self._spi.max_speed_hz = 5_000_000
        self._spi.mode = 3
        self._write(self._REG_DATA_FORMAT, 0x0B)  # ±16g, full resolution
        self._write(self._REG_POWER_CTL,   0x08)  # Measurement mode

    def _write(self, reg, val):
        self._spi.xfer2([reg & 0x7F, val])

    def _read_bytes(self, reg, n):
        cmd = [reg | self._READ | (self._MULTI if n > 1 else 0)] + [0x00] * n
        return self._spi.xfer2(cmd)[1:]

    def read(self):
        raw = self._read_bytes(self._REG_DATAX0, 6)

        def s16(lo, hi):
            v = lo | (hi << 8)
            return v - 65536 if v > 32767 else v

        ax = s16(raw[0], raw[1]) * self._SCALE
        ay = s16(raw[2], raw[3]) * self._SCALE
        az = s16(raw[4], raw[5]) * self._SCALE

        pitch = math.degrees(math.atan2(ax, math.sqrt(ay**2 + az**2)))
        roll  = math.degrees(math.atan2(ay, az))

        return {
            'x': round(ax, 3), 'y': round(ay, 3), 'z': round(az, 3),
            'pitch': round(pitch, 2), 'roll': round(roll, 2),
        }


# ══════════════════════════════════════════════
#  COMPASS — HMC5883L ou QMC5883L (I2C)
# ══════════════════════════════════════════════

class CompassHMC5883L:
    _ADDR = 0x1E

    def __init__(self, bus=CFG['I2C_BUS']):
        self._bus = smbus2.SMBus(bus)
        self._bus.write_byte_data(self._ADDR, 0x00, 0x70)  # 8 samples, 15Hz
        self._bus.write_byte_data(self._ADDR, 0x01, 0x20)  # Gain 1.3 Ga
        self._bus.write_byte_data(self._ADDR, 0x02, 0x00)  # Continuous mode

    def read(self, declination=0.0):
        d = self._bus.read_i2c_block_data(self._ADDR, 0x03, 6)

        def s16(hi, lo):
            v = (hi << 8) | lo
            return v - 65536 if v > 32767 else v

        x = s16(d[0], d[1])
        z = s16(d[2], d[3])  # noqa: F841 (unused but keeps byte alignment)
        y = s16(d[4], d[5])

        hdg = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0
        return {'heading': round(hdg, 1), 'true_heading': round((hdg + declination) % 360.0, 1)}


class CompassQMC5883L:
    _ADDR = 0x0D

    def __init__(self, bus=CFG['I2C_BUS']):
        self._bus = smbus2.SMBus(bus)
        self._bus.write_byte_data(self._ADDR, 0x0B, 0x01)  # Reset
        time.sleep(0.05)
        self._bus.write_byte_data(self._ADDR, 0x09, 0x0D)  # Cont, 10Hz, 2G, OSR=512

    def read(self, declination=0.0):
        d = self._bus.read_i2c_block_data(self._ADDR, 0x00, 6)

        def s16(lo, hi):
            v = (hi << 8) | lo
            return v - 65536 if v > 32767 else v

        x = s16(d[0], d[1])
        y = s16(d[2], d[3])

        hdg = (math.degrees(math.atan2(y, x)) + 360.0) % 360.0
        return {'heading': round(hdg, 1), 'true_heading': round((hdg + declination) % 360.0, 1)}


def detect_compass():
    """Auto-detecta HMC5883L (0x1E) ou QMC5883L (0x0D) no barramento I2C."""
    bus = smbus2.SMBus(CFG['I2C_BUS'])
    for addr, cls, name in [
        (CFG['COMPASS_ADDR_HMC'], CompassHMC5883L, 'HMC5883L'),
        (CFG['COMPASS_ADDR_QMC'], CompassQMC5883L, 'QMC5883L'),
    ]:
        try:
            bus.read_byte(addr)
            log.info(f"Compass detectado: {name} (0x{addr:02X})")
            bus.close()
            return cls()
        except OSError:
            pass
    bus.close()
    log.warning("Nenhum compass encontrado no I2C (0x1E / 0x0D)")
    return None


# ══════════════════════════════════════════════
#  WEBSOCKET SERVER
# ══════════════════════════════════════════════

async def ws_handler(websocket):
    CLIENTS.add(websocket)
    log.info(f"[WS] +cliente {websocket.remote_address}")
    try:
        with STATE_LOCK:
            snapshot = dict(STATE)
        await websocket.send(json.dumps({'type': 'full_state', **snapshot}))
        await websocket.wait_closed()
    finally:
        CLIENTS.discard(websocket)
        log.info(f"[WS] -cliente {websocket.remote_address}")


async def broadcast():
    if not CLIENTS:
        return
    with STATE_LOCK:
        snapshot = dict(STATE)
    snapshot['ts'] = datetime.now(timezone.utc).isoformat()
    msg = json.dumps({'type': 'sensor_update', **snapshot})
    await asyncio.gather(*(ws.send(msg) for ws in list(CLIENTS)), return_exceptions=True)


# ══════════════════════════════════════════════
#  GPS POLLING THREAD (bloqueante → thread separada)
# ══════════════════════════════════════════════

def gps_thread(client: GPSClient):
    last_watchdog = time.monotonic()
    while True:
        client.poll()
        if time.monotonic() - last_watchdog > 10:
            client.watchdog()
            last_watchdog = time.monotonic()


# ══════════════════════════════════════════════
#  LOOP DE SENSORES (ADXL345 + Compass)
# ══════════════════════════════════════════════

async def sensor_loop(accel: ADXL345 | None, compass):
    interval = 1.0 / CFG['PUBLISH_HZ']
    while True:
        t0 = time.monotonic()

        if accel:
            try:
                a = accel.read()
                with STATE_LOCK:
                    STATE['pitch'] = a['pitch']
                    STATE['roll']  = a['roll']
                    STATE['accel'] = {'x': a['x'], 'y': a['y'], 'z': a['z']}
            except Exception as e:
                log.debug(f"ADXL345 error: {e}")

        if compass:
            try:
                with STATE_LOCK:
                    dec = STATE['mag_dec'] or 0.0
                h = compass.read(declination=dec)
                with STATE_LOCK:
                    STATE['heading']      = h['heading']
                    STATE['true_heading'] = h['true_heading']
            except Exception as e:
                log.debug(f"Compass error: {e}")

        await broadcast()
        await asyncio.sleep(max(0, interval - (time.monotonic() - t0)))


# ══════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════

async def main():
    log.info("AstroControl Bridge v1.0 iniciando…")

    # Carrega cache de sessão anterior (mag_dec já calculada)
    if os.path.exists(CFG['CACHE_FILE']):
        try:
            with open(CFG['CACHE_FILE']) as f:
                env = json.load(f)
            mag_dec = env.get('mag_dec')
            with STATE_LOCK:
                STATE['mag_dec'] = mag_dec
            log.info(
                f"Cache carregado: mag_dec={mag_dec:+.2f}°" if mag_dec is not None
                else "Cache carregado (sem declinação)"
            )
        except Exception as e:
            log.warning(f"Falha ao carregar cache: {e}")

    # GPS (thread bloqueante)
    gps_client = GPSClient()
    gps_client.connect()
    t = threading.Thread(target=gps_thread, args=(gps_client,), daemon=True)
    t.start()

    # Acelerômetro
    accel = None
    try:
        accel = ADXL345()
        log.info("ADXL345 inicializado via SPI")
    except Exception as e:
        log.warning(f"ADXL345 não disponível: {e}")

    # Compass
    compass = None
    try:
        compass = detect_compass()
    except Exception as e:
        log.warning(f"Compass não disponível: {e}")

    # WebSocket + sensor loop
    async with websockets.serve(ws_handler, CFG['WS_HOST'], CFG['WS_PORT']):
        log.info(f"WebSocket servindo em ws://0.0.0.0:{CFG['WS_PORT']}")
        await sensor_loop(accel, compass)


if __name__ == '__main__':
    asyncio.run(main())

```
---
## File: public/app.js

```js
/**
 * AstroControl — app.js
 * Estado central → render via rAF
 * WebSocket com backoff e heartbeat
 * Fila de comandos offline
 * Auth segura do terminal via POST
 * Fullscreen para abas noVNC
 */

'use strict';

/* ══════════════════════════════════════════════
   ESTADO CENTRAL
   ══════════════════════════════════════════════ */

const STATE = {
  wsConnected:   false,
  indiConnected: false,
  devices: {
    mount:       { connected:false, state:'disconnected', ra:null, dec:null, alt:null, az:null, tracking:null, parked:false, slewing:false },
    camera:      { connected:false, state:'disconnected', exposure:null, gain:null, capturing:false },
    focuser:     { connected:false, state:'disconnected', position:null, moving:false },
    filterwheel: { connected:false, state:'disconnected', slot:null, filter:null, filterNames:[] },
    rotator:     { connected:false, state:'disconnected', angle:null },
    gps:         { connected:false, state:'disconnected', lat:null, lon:null, fix:false, sats:0 },
  },
  currentTab:  'mount',
  slewRate:    16,
  tracking:    null,
  gotoStatus:  null,
  network:     { mode:'--', ip:'--', ssid:'--', signal:'--', ap_active:false, ap_clients:0, services:{} },
  drivers:     [],
  indiserver:  false,
  logs:        [],
};

let rafPending = false;

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

  setDot('pi',   STATE.wsConnected);
  setDot('indi', STATE.indiConnected);
  setDot('gps',  STATE.devices.gps.fix, !STATE.devices.gps.fix && STATE.devices.gps.sats > 0);
  setDot('ap',   STATE.network.ap_active);

  if (STATE.currentTab === 'mount')   renderMount();
  if (STATE.currentTab === 'drivers') renderDrivers();
  if (STATE.currentTab === 'network') renderNetwork();

  renderGotoStatus();
}

function renderMount() {
  const m = STATE.devices.mount;
  setText('m-ra',  m.ra  || '--');
  setText('m-dec', m.dec || '--');
  setText('m-alt', m.alt != null ? m.alt + '°' : '--');
  setText('m-az',  m.az  != null ? m.az  + '°' : '--');

  const badge = $('mount-state-badge');
  if (badge) {
    const labels = {
      disconnected:'Desconectado', idle:'Pronto',
      tracking:'Rastreando', slewing:'Slewing…',
      parked:'Park', error:'Erro',
    };
    badge.textContent = labels[m.state] || m.state;
    badge.className   = 'mount-badge mount-badge-' + (m.state || 'disconnected');
  }

  document.querySelectorAll('.trk button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === STATE.tracking);
  });
}

function renderDrivers() {
  const KEYS = ['mount','camera','focuser','filterwheel','rotator','gps'];
  KEYS.forEach(key => {
    const dev = STATE.devices[key];
    if (!dev) return;
    const dot = $('dot-' + key);
    const tog = $('tog-' + key);
    if (dot) dot.className = 'dot ' +
      (dev.state === 'error' ? 'dr' : dev.connected ? 'dg' : dev.state !== 'disconnected' ? 'da' : 'dx');
    if (tog) tog.classList.toggle('on', dev.connected);
  });

  const logEl = $('indi-log');
  if (logEl && logEl.dataset.logLen !== String(STATE.logs.length)) {
    const frag = document.createDocumentFragment();
    STATE.logs.forEach(({ level, text }) => {
      const div = document.createElement('div');
      const span = document.createElement('span');
      span.className   = level;
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

function renderNetwork() {
  const n = STATE.network;
  setText('net-mode',   n.mode);
  setText('net-ip',     n.ip);
  setText('net-ssid',   n.ssid);
  setText('net-signal', n.signal);

  const tog    = $('ap-tog');
  const sub    = $('ap-sub');
  const detail = $('ap-info');
  if (tog) tog.classList.toggle('on', n.ap_active);
  if (sub) sub.textContent = n.ap_active
    ? `Ativo · AstroPi · ${n.ap_clients} cliente(s)`
    : 'Desativado · sobe automaticamente sem WiFi';
  if (detail) detail.classList.toggle('visible', n.ap_active);
  setText('ap-clients', String(n.ap_clients));

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
   WEBSOCKET — BACKEND
   ══════════════════════════════════════════════ */

const WS_HOST = window.location.hostname || 'astropi.local';
const WS_PORT = parseInt(window.location.port) || 3000;
const WS_URL  = `ws://${WS_HOST}:${WS_PORT}/ws`;

let ws        = null;
let wsBackoff = 1000;
let wsTimer   = null;
let wsAlive   = false;
let hbTimer   = null;
const CMD_Q   = [];

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
    sendWS({ type:'get_state' });
    sendWS({ type:'network_status' });
    addLog('ok','Bridge conectado');
  };

  ws.onmessage = (evt) => { try { handleMsg(JSON.parse(evt.data)); } catch {} };
  ws.onerror   = () => {};
  ws.onclose   = () => {
    stopHB();
    setState({ wsConnected:false, indiConnected:false });
    wsTimer = setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 1.5, 30000);
  };
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
  return false;
}

function sendCmd(msg, queue = true) {
  if (!sendWS(msg) && queue) { CMD_Q.push(msg); addLog('wn','Na fila: ' + msg.type); }
}

function flushQ() {
  while (CMD_Q.length && ws && ws.readyState === WebSocket.OPEN) {
    addLog('ok','Reenviado: ' + CMD_Q[0].type); sendWS(CMD_Q.shift());
  }
}

function startHB() {
  stopHB();
  hbTimer = setInterval(() => {
    if (!wsAlive) { ws && ws.close(); return; }
    wsAlive = false; sendWS({ type:'ping', ts:Date.now() });
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
          if (g.lat) applyAlignData({ lat:g.lat, lon:g.lon, fix:g.fix, sats:g.sats });
        }
        scheduleRender();
      }
      break;

    case 'indi_status':
      setState({ indiConnected: !!msg.connected });
      if (!msg.connected) {
        Object.keys(STATE.devices).forEach(k => {
          STATE.devices[k].connected = false;
          STATE.devices[k].state     = 'disconnected';
        });
        scheduleRender();
      }
      break;

    case 'driver_status':
      setState({ indiserver:!!msg.indiserver, drivers:msg.drivers||[] });
      if (msg.drivers) {
        msg.drivers.forEach(d => {
          const key = driverKey(d.name);
          if (key && STATE.devices[key]) {
            STATE.devices[key].connected = d.connected;
            STATE.devices[key].state     = d.error ? 'error' : d.connected ? 'idle' : 'disconnected';
          }
        });
        scheduleRender();
      }
      break;

    case 'goto_result':
      setState({ gotoStatus:{ success:msg.success, message:msg.message } });
      if (msg.success !== null) setTimeout(() => setState({ gotoStatus:null }), 8000);
      break;

    case 'network': {
      /* Remove msg.type antes de salvar no STATE */
      const { type:_t, ...net } = msg;
      setState({ network: net });
      break;
    }

    case 'log':
      addLog(msg.level, msg.text);
      break;
  }
}

function driverKey(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('eqmod')||n.includes('telescope')||n.includes('mount')) return 'mount';
  if (n.includes('ccd')||n.includes('camera')||n.includes('canon'))       return 'camera';
  if (n.includes('moonlite')||n.includes('focuser'))                       return 'focuser';
  if (n.includes('efw')||n.includes('filter'))                             return 'filterwheel';
  if (n.includes('rotat'))                                                  return 'rotator';
  if (n.includes('gps'))                                                    return 'gps';
  return null;
}

function addLog(level, text) {
  STATE.logs.push({ level, text });
  if (STATE.logs.length > 200) STATE.logs.splice(0, 100);
  if (STATE.currentTab === 'drivers') scheduleRender();
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
      const d = JSON.parse(evt.data);
      if (typeof applyAlignData === 'function') applyAlignData(d);
      setDot('gps', d.fix, !d.fix && (d.sats||0) > 0);
    } catch {}
  };

  sensorWs.onclose = () => {
    setDot('gps', false);
    if (typeof updateSensorBanner === 'function') updateSensorBanner(false);
    sensorBackoff = Math.min(sensorBackoff * 1.5, 30000);
    setTimeout(connectSensors, sensorBackoff);
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
  if (el)    el.classList.add('active');

  STATE.currentTab = id;
  scheduleRender();

  if (id === 'align')   { if (typeof renderAlign === 'function') renderAlign(); }
  if (id === 'network') sendCmd({ type:'network_status' }, false);
  if (id === 'drivers') sendCmd({ type:'get_state' },      false);
}

/* ══════════════════════════════════════════════
   FULLSCREEN — todas as abas
   ══════════════════════════════════════════════ */

/**
 * Tenta fullscreen nativo (oculta barra de endereço).
 * Se não disponível, cria overlay que cobre toda a tela.
 *
 * Para abas noVNC usa o frame existente.
 * Para abas nativas (mount, align, drivers, network) clona o conteúdo.
 */
function enterFullscreen(panelId) {
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

  /* Para painéis noVNC: move o iframe para o overlay */
  const frameId = panelId === 'p-kstars'   ? 'vnc-k-frame' :
                  panelId === 'p-phd2'     ? 'vnc-p-frame' :
                  panelId === 'p-desktop'  ? 'vnc-d-frame' :
                  panelId === 'p-terminal' ? 'term-frame'  : null;

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
    /* Remove o botão de fullscreen do clone para não aninha */
    clone.querySelectorAll('.bp-fs').forEach(b => b.style.display = 'none');
    overlay.appendChild(clone);
  }

  document.body.appendChild(overlay);

  /* Tenta também o Fullscreen nativo no overlay */
  const fn = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
  if (fn) fn.call(overlay).catch(() => {});
}

function requestFullscreenPanel(frameId) {
  /* Atalho para abas noVNC — mantém compatibilidade */
  const map = {
    'vnc-k-frame': 'p-kstars', 'vnc-p-frame': 'p-phd2',
    'vnc-d-frame': 'p-desktop', 'term-frame': 'p-terminal',
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
  sendCmd({ type:'slew_rate', rate });
}

function jp(dir) { $('j'+dir)?.classList.add('pr');    sendCmd({ type:'slew_start', direction:dir, rate:STATE.slewRate }); }
function jr(dir) { $('j'+dir)?.classList.remove('pr'); sendCmd({ type:'slew_stop',  direction:dir }); }
function jStop() {
  ['N','S','E','W'].forEach(d => { $('j'+d)?.classList.remove('pr'); sendCmd({ type:'slew_stop', direction:d }, false); });
}

function setTrk(el, mode) {
  document.querySelectorAll('.trk button').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  STATE.tracking = mode === 'None' ? null : mode;
  sendCmd({ type:'tracking', mode });
}

function doGotoName() {
  const name = ($('goto-name')?.value || '').trim();
  if (!name) return;
  setState({ gotoStatus:{ success:null, message:`Resolvendo "${name}"…` } });
  sendCmd({ type:'goto_name', name });
}

function doGotoCoords() {
  const ra  = ($('goto-ra')?.value  || '').trim();
  const dec = ($('goto-dec')?.value || '').trim();
  if (!ra || !dec) return;
  sendCmd({ type:'goto_coords', ra, dec });
}

function syncMount() { sendCmd({ type:'sync' }); }
function parkMount() { sendCmd({ type:'park' }); }

/* ══════════════════════════════════════════════
   DRIVERS
   ══════════════════════════════════════════════ */

const DRIVER_MAP = {
  mount:'indi_eqmod_telescope', camera:'indi_canon_ccd',
  focuser:'indi_moonlite', filterwheel:'indi_efw',
  rotator:'indi_simulator_rotator', gps:'indi_gpsd', adxl:'python_bridge',
};

function toggleDriver(key) {
  const tog = $('tog-' + key);
  if (!tog) return;
  sendCmd({ type: tog.classList.contains('on') ? 'driver_stop' : 'driver_start', driver: DRIVER_MAP[key] || key });
}

/* ══════════════════════════════════════════════
   noVNC / TERMINAL
   ══════════════════════════════════════════════ */

function connectVNC(frameId, statusId, port) {
  const frame  = $(frameId);
  const status = $(statusId);
  if (!frame) return;
  const url = `http://${WS_HOST}:${port}/vnc_lite.html?autoconnect=1&reconnect=1&resize=scale`;
  frame.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none;background:#000" allow="fullscreen"></iframe>`;
  if (status) status.textContent = 'Conectado';
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
    const pwd  = $('pwd-terminal')?.value  || '';
    if (!user || !pwd) { if (errEl) errEl.textContent = 'Preencha usuário e senha.'; return; }
    try {
      const res = await fetch(`http://${WS_HOST}:${WS_PORT}/api/auth/terminal`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ user, password:pwd }),
      });
      if (!res.ok) { if (errEl) errEl.textContent = 'Credenciais inválidas.'; return; }
      const { token } = await res.json();
      const frame  = $('term-frame');
      const status = $('term-status');
      frame.innerHTML = `<iframe src="http://${WS_HOST}:7681/?token=${token}" style="width:100%;height:100%;border:none;background:#000" allow="fullscreen"></iframe>`;
      if (status) status.textContent = 'Conectado';
    } catch (e) {
      if (errEl) errEl.textContent = 'Erro: ' + e.message;
    }

  } else if (type === 'desktop') {
    const pwd = $('pwd-desktop')?.value || '';
    if (!pwd) { if (errEl) errEl.textContent = 'Digite a senha VNC.'; return; }
    const frame  = $('vnc-d-frame');
    const status = $('vnc-d-status');
    const url = `http://${WS_HOST}:6082/vnc_lite.html?autoconnect=1&reconnect=1&resize=scale&password=${encodeURIComponent(pwd)}`;
    frame.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none;background:#000" allow="fullscreen"></iframe>`;
    if (status) status.textContent = 'Conectado';
  }
}

/* ══════════════════════════════════════════════
   REDE
   ══════════════════════════════════════════════ */

function toggleAP() {
  sendCmd({ type:'ap_toggle', enable:!STATE.network.ap_active });
}

/* ══════════════════════════════════════════════
   RELÓGIO UTC
   ══════════════════════════════════════════════ */

function tickClock() {
  const d  = new Date();
  const el = $('utc');
  if (el) {
    el.textContent =
      String(d.getUTCHours()).padStart(2,'0') + ':' +
      String(d.getUTCMinutes()).padStart(2,'0') + ':' +
      String(d.getUTCSeconds()).padStart(2,'0') + ' UTC';
  }
  requestAnimationFrame(tickClock);
}

/* ══════════════════════════════════════════════
   UTILITÁRIOS
   ══════════════════════════════════════════════ */

function $(id)          { return document.getElementById(id); }
function setText(id, t) { const e=$(id); if(e && e.textContent!==t) e.textContent=t; }

/* ══════════════════════════════════════════════
   SERVICE WORKER
   ══════════════════════════════════════════════ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

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
```
---
## File: public/index.html

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"/>
  <meta name="apple-mobile-web-app-capable" content="yes"/>
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
  <meta name="mobile-web-app-capable" content="yes"/>
  <meta name="theme-color" content="#080c18"/>
  <title>AstroControl</title>
  <link rel="manifest" href="manifest.json"/>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>

  <!-- TOPBAR -->
  <header class="topbar">
    <div class="topbar-left">
      <span class="topbar-title">AstroControl</span>
      <div class="status-row">
        <span class="si" id="st-pi"><span class="dot dx"></span><span class="si-label">Pi</span></span>
        <span class="si" id="st-indi"><span class="dot dx"></span><span class="si-label">INDI</span></span>
        <span class="si" id="st-gps"><span class="dot dx"></span><span class="si-label">GPS</span></span>
        <span class="si" id="st-ap"><span class="dot dx"></span><span class="si-label">AP</span></span>
      </div>
    </div>
    <span class="utc-clock" id="utc"></span>
  </header>

  <!-- TABS -->
  <nav class="tabs">
    <div class="tab active" onclick="sw('mount',this)" title="Montagem">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5"/><line x1="7" y1="2" x2="7" y2="12"/><line x1="2" y1="7" x2="12" y2="7"/></svg>
      <span class="tab-label">Montagem</span>
    </div>
    <div class="tab" onclick="sw('align',this)" title="Polar">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><line x1="7" y1="1" x2="7" y2="3"/><line x1="7" y1="11" x2="7" y2="13"/><line x1="1" y1="7" x2="3" y2="7"/><line x1="11" y1="7" x2="13" y2="7"/></svg>
      <span class="tab-label">Polar</span>
    </div>
    <div class="tab" onclick="sw('kstars',this)" title="KStars/Ekos">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="2" width="12" height="9" rx="1.5"/><line x1="1" y1="5" x2="13" y2="5"/><circle cx="4" cy="3.5" r="0.8" fill="currentColor"/><circle cx="6.5" cy="3.5" r="0.8" fill="currentColor"/></svg>
      <span class="tab-label">KStars</span>
    </div>
    <div class="tab" onclick="sw('phd2',this)" title="PHD2 Guiding">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><polyline points="1,10 3,6 5,8 7,4 9,7 11,5 13,9"/></svg>
      <span class="tab-label">PHD2</span>
    </div>
    <div class="tab" onclick="sw('desktop',this)" title="Desktop XFCE">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="2" width="12" height="8" rx="1"/><line x1="5" y1="12" x2="9" y2="12"/><line x1="7" y1="10" x2="7" y2="12"/></svg>
      <span class="tab-label">Desktop</span>
    </div>
    <div class="tab" onclick="sw('terminal',this)" title="Terminal SSH">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="2" width="12" height="10" rx="1.5"/><polyline points="3,6 5,8 3,10"/><line x1="6" y1="10" x2="11" y2="10"/></svg>
      <span class="tab-label">Terminal</span>
    </div>
    <div class="tab" onclick="sw('drivers',this)" title="Drivers INDI">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>
      <span class="tab-label">Drivers</span>
    </div>
    <div class="tab" onclick="sw('network',this)" title="Rede">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M7 11C4.8 11 3 9.2 3 7s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z"/><path d="M7 3c-1.1 1.3-1.7 2.6-1.7 4S5.9 9.7 7 11"/><path d="M7 3c1.1 1.3 1.7 2.6 1.7 4S8.1 9.7 7 11"/><line x1="3" y1="7" x2="11" y2="7"/></svg>
      <span class="tab-label">Rede</span>
    </div>
  </nav>

  <!-- CONTENT AREA — único container de abas -->
  <main class="content">

    <!-- ══════════ MONTAGEM ══════════ -->
    <div id="p-mount" class="panel active">

      <!-- Barra de painel com fullscreen -->
      <div class="panel-bar">
        <span class="panel-bar-title">Montagem</span>
        <button class="bp-fs" onclick="enterFullscreen('p-mount')" title="Tela cheia">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"/></svg>
        </button>
      </div>

      <div class="mount-body">
        <!-- Bloco esquerdo / superior: posição + GoTo + ações -->
        <div class="mount-info">
          <div class="sec">Posição atual</div>
          <div class="g2">
            <div class="card"><div class="clabel">AR</div><div class="cval small" id="m-ra">--</div></div>
            <div class="card"><div class="clabel">Dec</div><div class="cval small" id="m-dec">--</div></div>
            <div class="card"><div class="clabel">Altitude</div><div class="cval" id="m-alt">--</div></div>
            <div class="card"><div class="clabel">Azimute</div><div class="cval" id="m-az">--</div></div>
          </div>

          <div class="mount-state-row">
            <span class="mount-badge mount-badge-disconnected" id="mount-state-badge">Desconectado</span>
          </div>

          <div class="sec">Rastreamento</div>
          <div class="trk">
            <button onclick="setTrk(this,'Sidereal')" data-mode="Sidereal" class="active">Sideral</button>
            <button onclick="setTrk(this,'Lunar')"    data-mode="Lunar">Lunar</button>
            <button onclick="setTrk(this,'Solar')"    data-mode="Solar">Solar</button>
            <button onclick="setTrk(this,'None')"     data-mode="None" class="off-btn">Off</button>
          </div>

          <div class="sec">GoTo</div>
          <div class="row">
            <input class="inp" type="text" id="goto-name" placeholder="Objeto (M42…)" autocomplete="off" autocorrect="off" spellcheck="false"/>
            <button class="bp bp-p" onclick="doGotoName()">Ir</button>
          </div>
          <div class="row">
            <input class="inp" type="text" id="goto-ra"  placeholder="AR (05h 34m)" autocomplete="off"/>
            <input class="inp" type="text" id="goto-dec" placeholder="Dec (-05°)" autocomplete="off"/>
            <button class="bp bp-s" onclick="doGotoCoords()">Ir</button>
          </div>
          <div id="goto-status" class="goto-status"></div>

          <div class="mount-actions">
            <button class="bp-full" onclick="syncMount()">Sync posição atual</button>
            <button class="bp-full bp-full-sec" onclick="parkMount()">Park</button>
          </div>
        </div>

        <!-- Bloco direito / inferior: joystick -->
        <div class="mount-ctrl">
          <div class="sec ctrl-sec">Velocidade</div>
          <!-- RATES em grade 3×2 -->
          <div class="rates" id="rates-bar">
            <div class="rb" onclick="setRate(this,1)">1×</div>
            <div class="rb" onclick="setRate(this,2)">2×</div>
            <div class="rb" onclick="setRate(this,8)">8×</div>
            <div class="rb active" onclick="setRate(this,16)">16×</div>
            <div class="rb" onclick="setRate(this,64)">64×</div>
            <div class="rb" onclick="setRate(this,0)">Máx</div>
          </div>
          <div class="joy-wrap">
            <div class="joy">
              <div class="jb jb-n" id="jN" onpointerdown="jp('N')" onpointerup="jr('N')" onpointercancel="jr('N')"><svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1,8 6,3 11,8"/></svg></div>
              <div class="jb jb-s" id="jS" onpointerdown="jp('S')" onpointerup="jr('S')" onpointercancel="jr('S')"><svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1,4 6,9 11,4"/></svg></div>
              <div class="jb jb-w" id="jW" onpointerdown="jp('W')" onpointerup="jr('W')" onpointercancel="jr('W')"><svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="8,1 3,6 8,11"/></svg></div>
              <div class="jb jb-e" id="jE" onpointerdown="jp('E')" onpointerup="jr('E')" onpointercancel="jr('E')"><svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4,1 9,6 4,11"/></svg></div>
              <div class="jb jb-stop" onpointerdown="jStop()">STOP</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ ALINHAMENTO POLAR ══════════ -->
    <div id="p-align" class="panel">

      <!-- Barra de painel com fullscreen -->
      <div class="panel-bar">
        <span class="panel-bar-title">Alinhamento polar</span>
        <button class="bp-fs" onclick="enterFullscreen('p-align')" title="Tela cheia">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"/></svg>
        </button>
      </div>

      <div class="align-gps-row">
        <div class="card align-gps-card"><div class="clabel">Latitude</div><div class="cval small" id="a-lat">--</div></div>
        <div class="card align-gps-card"><div class="clabel">Decl. mag.</div><div class="cval small" id="a-decmag">--</div></div>
        <div class="card align-gps-card"><div class="clabel">Norte real</div><div class="cval small" id="a-north">--</div></div>
        <div class="card align-gps-card"><div class="clabel">Satélites</div><div class="cval small" id="a-sats">--</div></div>
      </div>

      <div class="sensor-banner" id="sensor-banner">
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5"/><line x1="7" y1="4" x2="7" y2="7.5"/><circle cx="7" cy="9.5" r="0.7" fill="currentColor" stroke="none"/></svg>
        <span id="sensor-banner-txt">Aguardando Python bridge :8765…</span>
      </div>

      <!-- Grade simplificada: barra de latitude + nível 2D + feedback -->
      <div class="align-grid">

        <!-- Barra vertical latitude -->
        <div class="vis-box align-lat-box">
          <div class="vis-t">Inclinação polar (Pitch)</div>
          <canvas id="cv-bar-lat" width="28" height="160"></canvas>
          <div class="bar-val" id="lat-bar-val">--</div>
        </div>

        <!-- Nível 2D — peça central -->
        <div class="vis-box align-nivel-box">
          <div class="vis-t">Nível do tripé</div>
          <div class="nivel-inner">
            <canvas id="cv-nivel" width="96" height="96"></canvas>
            <div class="nivel-info">
              <div class="nivel-row">Pitch: <span id="pitch-val">--</span></div>
              <div class="nivel-row">Roll: <span id="roll-val">--</span></div>
              <div id="nivel-status" class="nivel-status">--</div>
            </div>
          </div>
        </div>

        <!-- Feedback de alinhamento -->
        <div class="fb align-fb-box" id="a-fb">
          <div class="fb-dot" id="a-dot"></div>
          <div class="fb-txt" id="a-txt">Aguardando sensores…</div>
        </div>

      </div>

      <!-- Canvas mantidos no DOM mas ocultos — alignment.js ainda os referencia -->
      <canvas id="cv-bar-dec"  width="1" height="1" style="display:none"></canvas>
      <canvas id="cv-compass"  width="1" height="1" style="display:none"></canvas>
      <span   id="dec-bar-val"                      style="display:none"></span>
    </div>

    <!-- ══════════ KSTARS ══════════ -->
    <div id="p-kstars" class="panel panel-vnc">
      <div class="novnc-bar">
        <div class="novnc-bar-left">
          <span class="novnc-title">KStars / Ekos</span>
          <span class="badge badge-green" id="vnc-k-status">Desconectado</span>
        </div>
        <div class="novnc-bar-right">
          <button class="bp bp-s sm" onclick="requestFullscreenPanel('vnc-k-frame')">⛶ Tela cheia</button>
          <button class="bp bp-p sm" onclick="connectVNC('vnc-k-frame','vnc-k-status',6080)">Conectar</button>
        </div>
      </div>
      <!-- Aviso de rotação em portrait -->
      <div class="rotate-hint" id="rotate-kstars">
        <div class="rotate-hint-inner">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#5DCAA5" stroke-width="1.5"><rect x="4" y="10" width="40" height="28" rx="3"/><line x1="4" y1="20" x2="44" y2="20"/><circle cx="10" cy="15" r="2" fill="#5DCAA5"/><circle cx="16" cy="15" r="2" fill="#5DCAA5"/></svg>
          <p>Gire o dispositivo para paisagem</p>
          <p class="rotate-sub">KStars requer modo horizontal</p>
          <button class="bp bp-p" style="margin-top:12px" onclick="connectVNC('vnc-k-frame','vnc-k-status',6080)">Conectar assim mesmo</button>
        </div>
      </div>
      <div class="novnc-frame" id="vnc-k-frame">
        <div class="nvph">
          <svg width="40" height="40" viewBox="0 0 44 44" fill="none" stroke="#374151" stroke-width="1.5"><rect x="3" y="7" width="38" height="26" rx="2.5"/><line x1="3" y1="15" x2="41" y2="15"/><circle cx="7" cy="11" r="1.5" fill="#374151"/><circle cx="12" cy="11" r="1.5" fill="#374151"/><line x1="16" y1="37" x2="28" y2="37"/><line x1="22" y1="33" x2="22" y2="37"/></svg>
          <p>KStars / Ekos</p>
          <p class="nvph-sub">astropi.local:6080</p>
          <button class="bp bp-p nvph-btn" onclick="connectVNC('vnc-k-frame','vnc-k-status',6080)">Conectar</button>
        </div>
      </div>
    </div>

    <!-- ══════════ PHD2 ══════════ -->
    <div id="p-phd2" class="panel panel-vnc">
      <div class="novnc-bar">
        <div class="novnc-bar-left">
          <span class="novnc-title">PHD2 Guiding</span>
          <span class="badge badge-amber" id="vnc-p-status">Desconectado</span>
        </div>
        <div class="novnc-bar-right">
          <button class="bp bp-s sm" onclick="requestFullscreenPanel('vnc-p-frame')">⛶ Tela cheia</button>
          <button class="bp sm" style="background:#633806;color:#FAC775" onclick="connectVNC('vnc-p-frame','vnc-p-status',6081)">Conectar</button>
        </div>
      </div>
      <div class="rotate-hint" id="rotate-phd2">
        <div class="rotate-hint-inner">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#EF9F27" stroke-width="1.5"><polyline points="2,36 10,22 18,30 26,14 34,24 42,18"/><circle cx="26" cy="14" r="3" fill="#EF9F27" stroke="none"/></svg>
          <p>Gire o dispositivo para paisagem</p>
          <p class="rotate-sub">PHD2 requer modo horizontal</p>
          <button class="bp sm" style="background:#633806;color:#FAC775;margin-top:12px" onclick="connectVNC('vnc-p-frame','vnc-p-status',6081)">Conectar assim mesmo</button>
        </div>
      </div>
      <div class="novnc-frame" id="vnc-p-frame">
        <div class="nvph">
          <svg width="40" height="40" viewBox="0 0 44 44" fill="none" stroke="#374151" stroke-width="1.5"><polyline points="2,32 8,20 14,26 20,14 26,22 32,16 42,28"/><circle cx="20" cy="14" r="3" stroke="#EF9F27"/></svg>
          <p>PHD2 Guiding</p>
          <p class="nvph-sub">astropi.local:6081</p>
          <button class="bp nvph-btn" style="background:#633806;color:#FAC775" onclick="connectVNC('vnc-p-frame','vnc-p-status',6081)">Conectar</button>
        </div>
      </div>
    </div>

    <!-- ══════════ DESKTOP ══════════ -->
    <div id="p-desktop" class="panel panel-vnc">
      <div class="novnc-bar">
        <div class="novnc-bar-left">
          <span class="novnc-title">Desktop XFCE</span>
          <span class="badge badge-purple" id="vnc-d-status">Desconectado</span>
        </div>
        <div class="novnc-bar-right">
          <button class="bp bp-s sm" onclick="requestFullscreenPanel('vnc-d-frame')">⛶ Tela cheia</button>
          <button class="bp bp-s sm" onclick="showAuth('desktop')">Conectar</button>
        </div>
      </div>
      <div class="rotate-hint" id="rotate-desktop">
        <div class="rotate-hint-inner">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#AFA9EC" stroke-width="1.5"><rect x="4" y="10" width="40" height="28" rx="3"/><line x1="4" y1="20" x2="44" y2="20"/><circle cx="10" cy="15" r="2" fill="#AFA9EC"/><circle cx="16" cy="15" r="2" fill="#AFA9EC"/></svg>
          <p>Gire o dispositivo para paisagem</p>
          <p class="rotate-sub">Desktop requer modo horizontal</p>
          <button class="bp bp-s sm" style="margin-top:12px" onclick="showAuth('desktop')">Conectar assim mesmo</button>
        </div>
      </div>
      <div class="novnc-frame" id="vnc-d-frame">
        <div class="auth-box" id="auth-desktop">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="#374151" stroke-width="1.5" style="margin:0 auto 10px;display:block"><rect x="2" y="4" width="28" height="20" rx="2"/><line x1="2" y1="11" x2="30" y2="11"/><line x1="10" y1="28" x2="22" y2="28"/><line x1="16" y1="24" x2="16" y2="28"/></svg>
          <h3>Desktop XFCE</h3>
          <p>astropi.local:6082</p>
          <input class="auth-inp" type="password" id="pwd-desktop" placeholder="Senha VNC" onkeydown="if(event.key==='Enter')doAuth('desktop')"/>
          <button class="auth-btn" onclick="doAuth('desktop')">Conectar</button>
          <div class="auth-error" id="err-desktop"></div>
        </div>
      </div>
    </div>

    <!-- ══════════ TERMINAL ══════════ -->
    <div id="p-terminal" class="panel panel-vnc">
      <div class="novnc-bar">
        <div class="novnc-bar-left">
          <span class="novnc-title">Terminal SSH</span>
          <span class="badge badge-green" id="term-status">Desconectado</span>
        </div>
        <div class="novnc-bar-right">
          <button class="bp bp-s sm" onclick="requestFullscreenPanel('term-frame')">⛶ Tela cheia</button>
          <button class="bp bp-s sm" onclick="showAuth('terminal')">Conectar</button>
        </div>
      </div>
      <div class="novnc-frame" id="term-frame">
        <div class="auth-box" id="auth-terminal">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" stroke="#374151" stroke-width="1.5" style="margin:0 auto 10px;display:block"><rect x="2" y="4" width="28" height="24" rx="2"/><polyline points="6,12 10,16 6,20"/><line x1="12" y1="20" x2="26" y2="20"/></svg>
          <h3>Terminal SSH</h3>
          <p>astropi.local:7681</p>
          <input class="auth-inp" type="text"     id="user-terminal" placeholder="Usuário" value="samu192" autocomplete="username"/>
          <input class="auth-inp" type="password" id="pwd-terminal"  placeholder="Senha"   autocomplete="current-password" onkeydown="if(event.key==='Enter')doAuth('terminal')"/>
          <button class="auth-btn" onclick="doAuth('terminal')">Conectar</button>
          <div class="auth-error" id="err-terminal"></div>
        </div>
      </div>
    </div>

    <!-- ══════════ DRIVERS ══════════ -->
    <div id="p-drivers" class="panel panel-scroll">
      <div class="panel-bar panel-bar-scroll">
        <span class="panel-bar-title">Drivers INDI</span>
        <button class="bp-fs" onclick="enterFullscreen('p-drivers')" title="Tela cheia">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"/></svg>
        </button>
      </div>
      <div class="sec">Dispositivos INDI</div>
      <div class="drv-row"><span class="dot dx" id="dot-mount"></span><div class="drv-txt"><div class="drv-name">Montagem equatorial 3D</div><div class="drv-sub">EQMod · /dev/ttyUSB0</div></div><div class="tog" id="tog-mount" onclick="toggleDriver('mount')"></div></div>
      <div class="drv-row"><span class="dot dx" id="dot-camera"></span><div class="drv-txt"><div class="drv-name">Canon EOS (DSLR)</div><div class="drv-sub">indi_canon_ccd · USB</div></div><div class="tog" id="tog-camera" onclick="toggleDriver('camera')"></div></div>
      <div class="drv-row"><span class="dot dx" id="dot-focuser"></span><div class="drv-txt"><div class="drv-name">Focalizador eletrônico</div><div class="drv-sub">indi_moonlite · /dev/ttyUSB1</div></div><div class="tog" id="tog-focuser" onclick="toggleDriver('focuser')"></div></div>
      <div class="drv-row"><span class="dot dx" id="dot-filterwheel"></span><div class="drv-txt"><div class="drv-name">Roda de filtros</div><div class="drv-sub">indi_efw</div></div><div class="tog" id="tog-filterwheel" onclick="toggleDriver('filterwheel')"></div></div>
      <div class="drv-row"><span class="dot dx" id="dot-rotator"></span><div class="drv-txt"><div class="drv-name">Rotacionador de campo</div><div class="drv-sub">Sem driver</div></div><div class="tog" id="tog-rotator" onclick="toggleDriver('rotator')"></div></div>
      <div class="drv-row"><span class="dot dx" id="dot-gps"></span><div class="drv-txt"><div class="drv-name">GPS M8N + Compass</div><div class="drv-sub">NMEA · /dev/ttyAMA0</div></div><div class="tog" id="tog-gps" onclick="toggleDriver('gps')"></div></div>
      <div class="drv-row"><span class="dot dx" id="dot-adxl"></span><div class="drv-txt"><div class="drv-name">ADXL345 (acelerômetro)</div><div class="drv-sub">SPI · Python bridge :8765</div></div><div class="tog" id="tog-adxl" onclick="toggleDriver('adxl')"></div></div>
      <div class="log" id="indi-log"><div><span class="dim">[--]</span> Aguardando conexão…</div></div>
    </div>

    <!-- ══════════ REDE ══════════ -->
    <div id="p-network" class="panel panel-scroll">
      <div class="panel-bar panel-bar-scroll">
        <span class="panel-bar-title">Rede</span>
        <button class="bp-fs" onclick="enterFullscreen('p-network')" title="Tela cheia">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"/></svg>
        </button>
      </div>
      <div class="sec">Status de rede</div>
      <div class="net-grid">
        <div class="net-card"><div class="net-label">Modo</div><div class="net-val" id="net-mode">--</div></div>
        <div class="net-card"><div class="net-label">IP</div><div class="net-val" id="net-ip">--</div></div>
        <div class="net-card"><div class="net-label">Rede WiFi</div><div class="net-val" id="net-ssid">--</div></div>
        <div class="net-card"><div class="net-label">Sinal</div><div class="net-val" id="net-signal">--</div></div>
      </div>

      <div class="sec">Access Point</div>
      <div class="ap-row">
        <div>
          <div class="ap-title">AstroPi AP</div>
          <div class="ap-sub" id="ap-sub">Verificando…</div>
        </div>
        <div class="tog" id="ap-tog" onclick="toggleAP()"></div>
      </div>
      <div class="net-grid ap-detail" id="ap-info">
        <div class="net-card"><div class="net-label">SSID</div><div class="net-val">AstroPi</div></div>
        <div class="net-card"><div class="net-label">IP AP</div><div class="net-val">10.0.0.1</div></div>
        <div class="net-card"><div class="net-label">Canal</div><div class="net-val">6 · 2.4 GHz</div></div>
        <div class="net-card"><div class="net-label">Clientes</div><div class="net-val" id="ap-clients">0</div></div>
      </div>

      <div class="sec">Serviços</div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-indiweb"></span><div class="drv-txt"><div class="drv-name">INDI Web Manager</div><div class="drv-sub">:8624</div></div><a href="http://astropi.local:8624" target="_blank" class="bp bp-s sm">Abrir</a></div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-kstars"></span><div class="drv-txt"><div class="drv-name">noVNC · KStars</div><div class="drv-sub">:6080</div></div></div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-phd2"></span><div class="drv-txt"><div class="drv-name">noVNC · PHD2</div><div class="drv-sub">:6081</div></div></div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-desktop"></span><div class="drv-txt"><div class="drv-name">noVNC · Desktop XFCE</div><div class="drv-sub">:6082</div></div></div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-ttyd"></span><div class="drv-txt"><div class="drv-name">ttyd · Terminal</div><div class="drv-sub">:7681</div></div></div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-gpsd"></span><div class="drv-txt"><div class="drv-name">gpsd</div><div class="drv-sub">:2947</div></div></div>
      <div class="drv-row"><span class="dot dx" id="svc-dot-bridge"></span><div class="drv-txt"><div class="drv-name">Node.js bridge</div><div class="drv-sub">:3000</div></div></div>
    </div>

  </main><!-- /content -->

  <script src="alignment.js"></script>
  <script src="app.js"></script>
</body>
</html>
```
---
## File: public/style.css

```css
/* ═══════════════════════════════════════════════════
   AstroControl — style.css  (versão final)

   Layout:
     body (flex column, 100dvh)
       header.topbar      (altura fixa)
       nav.tabs           (altura fixa)
       main.content       (flex:1, position:relative, overflow:hidden)
         .panel           (position:absolute; inset:0; display:none)
         .panel.active    (display:flex — único painel visível)
   ═══════════════════════════════════════════════════ */

*, *::before, *::after {
  box-sizing: border-box; margin: 0; padding: 0;
  -webkit-tap-highlight-color: transparent;
}

:root {
  --bg0: #080c18; --bg1: #0a0f1e; --bg2: #0f1628; --bg3: #040810;
  --border: rgba(255,255,255,0.07); --border-mid: rgba(255,255,255,0.13);
  --text: #e8eaf0; --muted: #6b7280; --dim: #374151;
  --green: #1D9E75; --green-l: #5DCAA5; --green-d: #0F6E56;
  --amber: #EF9F27; --red: #E24B4A; --blue: #378ADD; --purple: #7F77DD;
  --topbar-h: 42px; --tabs-h: 48px;
  --joy: 144px; --jb: 46px;
}

@media (max-width: 360px)                             { :root { --joy: 124px; --jb: 38px; } }
@media (max-height: 420px) and (orientation: landscape) { :root { --topbar-h: 34px; --tabs-h: 40px; --joy: 116px; --jb: 36px; } }

/* ── Raiz ── */
html { height: 100%; -webkit-text-size-adjust: 100%; }

body {
  display: flex; flex-direction: column;
  height: 100dvh; overflow: hidden;
  background: var(--bg0); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 13px; line-height: 1.4;
  -webkit-font-smoothing: antialiased;
}
@supports not (height: 100dvh) { body { height: 100vh; } }

/* ══════════════════════════════════════
   TOPBAR
   ══════════════════════════════════════ */
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 max(12px, env(safe-area-inset-left));
  padding-right: max(12px, env(safe-area-inset-right));
  padding-top: env(safe-area-inset-top, 0px);
  height: var(--topbar-h); flex-shrink: 0;
  background: var(--bg1); border-bottom: 0.5px solid var(--border); gap: 8px;
}
.topbar-left  { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.topbar-title { font-size: 13px; font-weight: 600; letter-spacing: .02em; white-space: nowrap; }
.status-row   { display: flex; gap: 8px; align-items: center; }
.si { font-size: 10px; color: #9ca3b0; display: flex; align-items: center; gap: 3px; white-space: nowrap; }
@media (max-width: 380px) { .si-label { display: none; } .topbar-title { font-size: 12px; } }
.utc-clock { font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; font-family: 'SF Mono', Monaco, monospace; white-space: nowrap; flex-shrink: 0; }
@media (max-width: 479px) { .utc-clock { display: none; } }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transition: background .3s; }
.dg { background: var(--green); } .da { background: var(--amber); }
.dr { background: var(--red); }   .dx { background: var(--dim); }

/* ══════════════════════════════════════
   TABS
   ══════════════════════════════════════ */
.tabs {
  display: flex; height: var(--tabs-h); flex-shrink: 0;
  background: var(--bg1); border-bottom: 0.5px solid var(--border);
  overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  flex: 1; min-width: 44px; padding: 5px 3px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  font-size: 9px; color: var(--dim); cursor: pointer;
  border-bottom: 2px solid transparent; transition: color .15s;
  user-select: none; white-space: nowrap;
}
.tab svg { width: 15px; height: 15px; flex-shrink: 0; }
.tab.active { color: var(--green-l); border-bottom-color: var(--green); }
.tab-label { font-size: 9px; line-height: 1; }
@media (min-width: 600px) { .tab { min-width: 60px; } .tab-label { font-size: 10px; } }
@media (max-width: 340px) { .tab-label { display: none; } .tab { min-width: 34px; } }

/* ══════════════════════════════════════
   CONTENT — container das abas
   ══════════════════════════════════════ */
.content {
  flex: 1; min-height: 0;
  position: relative; overflow: hidden;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* ══════════════════════════════════════
   PAINÉIS — modelo position:absolute
   ══════════════════════════════════════ */
.panel {
  display: none;
  position: absolute; inset: 0;
  overflow: hidden;
  background: var(--bg0); /* fundo opaco — elimina transparência entre painéis */
  flex-direction: column;
}
.panel.active { display: flex; }

/* Painel com scroll simples (Drivers, Rede) */
.panel-scroll {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 10px 10px;
  gap: 6px;
}

/* ══════════════════════════════════════
   BARRA DE PAINEL + BOTÃO FULLSCREEN
   ══════════════════════════════════════ */
.panel-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; background: var(--bg1);
  border-bottom: 0.5px solid var(--border);
  flex-shrink: 0; gap: 8px;
}

/* Sticky para painéis com scroll */
.panel-bar-scroll {
  position: sticky; top: 0; z-index: 5;
  margin: 0 -10px; padding: 6px 10px;
  width: calc(100% + 20px);
}

.panel-bar-title {
  font-size: 10px; font-weight: 500; color: var(--muted);
  letter-spacing: .05em; text-transform: uppercase;
}

.bp-fs {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  background: transparent; border: 0.5px solid var(--border-mid);
  border-radius: 6px; color: var(--muted); cursor: pointer;
  transition: all .15s; flex-shrink: 0; padding: 0;
}
.bp-fs:active { background: var(--bg2); color: var(--text); }

/* ══════════════════════════════════════
   OVERLAY DE TELA CHEIA (abas nativas)
   Criado dinamicamente pelo JS
   ══════════════════════════════════════ */
.fs-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: var(--bg0);
  display: flex; flex-direction: column; overflow: hidden;
}

.fs-exit-btn {
  position: absolute; top: 10px; right: 10px; z-index: 10000;
  display: flex; align-items: center; gap: 6px;
  padding: 7px 12px;
  background: rgba(8,12,24,.88);
  border: 0.5px solid var(--border-mid); border-radius: 8px;
  color: var(--muted); font-size: 11px; cursor: pointer;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  font-family: inherit;
}
.fs-exit-btn:active { background: var(--bg2); color: var(--text); }

/* ══════════════════════════════════════
   ABA MONTAGEM
   ══════════════════════════════════════ */
   
.mount-body {
  display: flex; flex: 1; min-height: 0; gap: 10px; padding: 10px;
}

/* Portrait: empilhado com scroll */
@media (orientation: portrait) {
  .mount-body { flex-direction: column; overflow-y: auto; -webkit-overflow-scrolling: touch; }
}

/* Landscape / tablet: duas colunas */
@media (orientation: landscape) {
  .mount-body { flex-direction: row; overflow: hidden; }
  .mount-info { flex: 1.3; min-width: 0; overflow-y: auto; height: 100%; }
  .mount-ctrl { flex: 1; min-width: 160px; overflow-y: auto; height: 100%; }
}

.mount-info { display: flex; flex-direction: column; gap: 8px; }
.mount-ctrl { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ctrl-sec   { align-self: flex-start; width: 100%; }

/* ── Rates 3×2 ── */
.rates {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  width: 100%;
}

.rb {
  padding: 9px 4px;
  background: var(--bg2); border: 0.5px solid rgba(255,255,255,.08);
  border-radius: 7px; color: var(--muted); font-size: 11px; font-weight: 500;
  cursor: pointer; text-align: center; transition: all .1s;
  user-select: none; -webkit-user-select: none;
}
.rb.active { background: #0a1a10; border-color: var(--green); color: var(--green-l); }

/* ── Joystick ── */
.joy-wrap { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.joy { position: relative; width: var(--joy); height: var(--joy); flex-shrink: 0; }
.jb {
  position: absolute; background: #111827; border: 0.5px solid rgba(255,255,255,.1);
  color: var(--muted); display: flex; align-items: center; justify-content: center;
  cursor: pointer; border-radius: 50%; transition: background .1s;
  user-select: none; -webkit-user-select: none; touch-action: none;
}
.jb:active, .jb.pr { background: var(--green); color: #fff; border-color: var(--green); }
.jb-n { top:0;    left:50%;  transform:translateX(-50%);  width:var(--jb); height:var(--jb); }
.jb-s { bottom:0; left:50%;  transform:translateX(-50%);  width:var(--jb); height:var(--jb); }
.jb-w { top:50%;  left:0;    transform:translateY(-50%);  width:var(--jb); height:var(--jb); }
.jb-e { top:50%;  right:0;   transform:translateY(-50%);  width:var(--jb); height:var(--jb); }
.jb-stop {
  top:50%; left:50%; transform:translate(-50%,-50%);
  width:calc(var(--jb) - 4px); height:calc(var(--jb) - 4px);
  background:#160808; border-color:rgba(226,75,74,.4); color:var(--red); font-size:8px; font-weight:600;
}
.jb-stop:active { background:var(--red); color:#fff; }

/* ── Estado da montagem ── */
.mount-state-row { margin: 2px 0 4px; }
.mount-badge { display:inline-flex; align-items:center; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:500; }
.mount-badge-disconnected { background:rgba(55,65,81,.3);   color:var(--muted);  border:.5px solid var(--dim); }
.mount-badge-idle         { background:rgba(29,158,117,.12); color:var(--green-l);border:.5px solid var(--green); }
.mount-badge-tracking     { background:rgba(29,158,117,.2);  color:var(--green-l);border:.5px solid var(--green); }
.mount-badge-slewing      { background:rgba(239,159,39,.2);  color:var(--amber);  border:.5px solid var(--amber); }
.mount-badge-parked       { background:rgba(55,138,221,.15); color:#85B7EB;       border:.5px solid var(--blue); }
.mount-badge-error        { background:rgba(226,75,74,.15);  color:var(--red);    border:.5px solid var(--red); }

/* ── Rastreamento ── */
.trk { display:flex; gap:5px; }
.trk button {
  flex:1; min-width:0; padding:8px 3px;
  background:var(--bg2); border:.5px solid rgba(255,255,255,.08);
  border-radius:6px; color:var(--muted); font-size:10px;
  cursor:pointer; transition:all .1s; font-family:inherit;
}
.trk button.active        { background:#0a1628; border-color:var(--blue); color:#85B7EB; }
.trk button.off-btn.active { background:#160a0a; border-color:var(--red);  color:var(--red); }

/* ── Inputs / Botões ── */
.row { display:flex; align-items:center; gap:7px; margin-bottom:6px; }
.inp {
  flex:1; min-width:60px; background:var(--bg2); border:.5px solid rgba(255,255,255,.1);
  border-radius:7px; color:var(--text); padding:10px; outline:none; font-family:inherit;
  font-size:16px; /* evita zoom iOS */
}
@media (min-width: 480px) { .inp { font-size:13px; padding:8px 10px; } }
.inp::placeholder { color:var(--dim); }
.inp:focus { border-color:var(--green); }

.bp { padding:9px 14px; border:none; border-radius:7px; font-size:12px; cursor:pointer; white-space:nowrap; font-family:inherit; transition:all .1s; flex-shrink:0; }
.bp.sm { padding:6px 10px; font-size:10px; }
.bp-p { background:var(--green-d); color:#9FE1CB; }
.bp-p:active { background:var(--green); }
.bp-s { background:#111827; border:.5px solid rgba(255,255,255,.1); color:#9ca3b0; }
.bp-s:active { background:#1a2235; }

.bp-full { width:100%; padding:11px; border:none; border-radius:8px; background:var(--green-d); color:#9FE1CB; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; transition:background .1s; }
.bp-full:active { background:var(--green); }
.bp-full-sec { background:var(--bg2); border:.5px solid var(--border-mid); color:var(--muted); }
.bp-full-sec:active { background:#1a2235; }

.mount-actions { display:flex; flex-direction:column; gap:5px; }
.goto-status { font-size:11px; min-height:16px; font-variant-numeric:tabular-nums; }

/* ══════════════════════════════════════
   SECTION LABELS + CARDS
   ══════════════════════════════════════ */
.sec { font-size:10px; letter-spacing:.07em; color:var(--dim); text-transform:uppercase; margin-bottom:4px; margin-top:2px; flex-shrink:0; }
.card { background:var(--bg2); border:.5px solid var(--border); border-radius:9px; padding:9px 10px; }
.g2 { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.g3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
.clabel { font-size:10px; color:var(--muted); margin-bottom:2px; }
.cval   { font-size:15px; font-weight:500; font-variant-numeric:tabular-nums; }
.cval.small { font-size:12px; }

/* ══════════════════════════════════════
   ABA ALINHAMENTO POLAR (simplificada)
   Mantém: barra de latitude + nível 2D + feedback
   Remove: barra de declinação e bússola
   ══════════════════════════════════════ */
#p-align { overflow-y: auto; -webkit-overflow-scrolling: touch; }

.align-gps-row {
  display:flex; gap:6px; flex-shrink:0;
  overflow-x:auto; scrollbar-width:none;
  padding: 10px 10px 0;
}
.align-gps-row::-webkit-scrollbar { display:none; }
.align-gps-card { flex:1; min-width:66px; }

.sensor-banner {
  display:flex; align-items:center; gap:7px; flex-shrink:0;
  padding:8px 10px; border-radius:8px; font-size:11px; color:var(--muted);
  background:rgba(55,65,81,.25); border:.5px solid var(--dim);
  margin: 8px 10px 0;
}
.sensor-banner svg { flex-shrink:0; }
.sensor-banner.active { background:rgba(29,158,117,.1); border-color:var(--green); color:var(--green-l); }
.sensor-banner.error  { background:rgba(226,75,74,.1);  border-color:var(--red);   color:var(--red); }

/* Grade de visualização */
.align-grid {
  display: flex;
  gap: 10px;
  padding: 10px;
  flex: 1;
  min-height: 0;
}

/* Portrait: coluna única scrollável */
@media (orientation: portrait) {
  .align-grid { flex-direction: column; overflow-y: visible; }
  .align-lat-box canvas { width: 22px !important; height: 128px !important; }
}

/* Landscape: linha — lat | nível | feedback */
@media (orientation: landscape) {
  .align-grid    { flex-direction: row; overflow: hidden; }
  .align-lat-box   { flex: 0 0 70px; }
  .align-nivel-box { flex: 1; }
  .align-fb-box    { flex: 0 0 220px; }
}

.align-lat-box {
  display: flex; align-items: center; gap: 10px; padding: 12px;
}
@media (orientation: portrait)  { .align-lat-box { flex-direction: row; } }
@media (orientation: landscape) { .align-lat-box { flex-direction: column; justify-content: center; } }

.align-nivel-box { padding: 12px; }
.align-fb-box    { flex-shrink: 0; }

/* ── Vis boxes ── */
.vis-box { background:var(--bg3); border:.5px solid rgba(255,255,255,.06); border-radius:9px; }
.vis-t   { font-size:10px; color:var(--dim); margin-bottom:6px; display:block; }
.bar-val { font-size:10px; color:var(--muted); text-align:center; font-variant-numeric:tabular-nums; margin-top:4px; }

/* ── Nível ── */
.nivel-inner { display:flex; align-items:center; gap:10px; width:100%; }
.nivel-info  { display:flex; flex-direction:column; gap:5px; min-width:0; }
.nivel-row   { font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
.nivel-row span { font-weight:500; }
.nivel-status { font-size:11px; margin-top:3px; font-weight:500; }

/* ── Feedback ── */
.fb { display:flex; align-items:flex-start; gap:9px; padding:10px 12px; border-radius:9px; border:.5px solid rgba(255,255,255,.06); background:var(--bg2); transition:all .3s; }
.fb-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; margin-top:3px; background:var(--dim); transition:background .3s; }
.fb-txt { font-size:11px; line-height:1.5; color:var(--muted); }

/* ══════════════════════════════════════
   ABAS noVNC (KStars, PHD2, Desktop, Terminal)
   ══════════════════════════════════════ */
.novnc-bar {
  display:flex; align-items:center; justify-content:space-between;
  padding:8px 12px; background:var(--bg1); border-bottom:.5px solid var(--border);
  flex-shrink:0; gap:8px;
}
.novnc-bar-left  { display:flex; align-items:center; gap:8px; min-width:0; }
.novnc-bar-right { display:flex; align-items:center; gap:6px; flex-shrink:0; }
.novnc-title { font-size:12px; color:#9ca3b0; white-space:nowrap; }

.novnc-frame {
  flex:1; min-height:0; background:var(--bg3);
  display:flex; align-items:center; justify-content:center; overflow:hidden;
  position:relative;
}
.novnc-frame iframe { width:100%; height:100%; border:none; background:#000; }

/* Aviso de rotação — portrait only */
.rotate-hint {
  display:none; position:absolute; inset:0;
  background:rgba(8,12,24,.93); z-index:20;
  align-items:center; justify-content:center;
}
@media (orientation: portrait) { .rotate-hint { display:flex; } }
.rotate-hint-inner { display:flex; flex-direction:column; align-items:center; gap:8px; padding:24px; text-align:center; max-width:280px; }
.rotate-hint-inner p { font-size:14px; color:var(--text); }
.rotate-sub { font-size:11px; color:var(--muted) !important; }

.nvph { text-align:center; padding:24px 16px; }
.nvph p { font-size:12px; color:var(--muted); margin-top:8px; }
.nvph-sub { font-size:11px; color:var(--dim) !important; }
.nvph-btn { margin-top:14px; font-size:12px; padding:10px 22px; }

/* ── Auth box ── */
.auth-box { background:var(--bg2); border:.5px solid rgba(255,255,255,.08); border-radius:12px; padding:24px 20px; width:min(300px,92vw); text-align:center; }
.auth-box h3 { font-size:14px; font-weight:500; margin-bottom:4px; }
.auth-box p  { font-size:11px; color:var(--muted); margin-bottom:16px; }
.auth-inp { width:100%; background:var(--bg0); border:.5px solid rgba(255,255,255,.1); border-radius:7px; color:var(--text); padding:12px 10px; font-size:16px; outline:none; margin-bottom:8px; font-family:inherit; display:block; }
@media (min-width: 480px) { .auth-inp { font-size:13px; padding:9px 10px; } }
.auth-inp:focus { border-color:var(--green); }
.auth-btn { width:100%; padding:11px; background:var(--green-d); border:none; border-radius:7px; color:#9FE1CB; font-size:13px; font-weight:500; cursor:pointer; margin-top:4px; font-family:inherit; }
.auth-btn:active { background:var(--green); }
.auth-error { font-size:11px; color:var(--red); margin-top:8px; min-height:16px; }

/* ── Badges ── */
.badge { font-size:10px; padding:2px 8px; border-radius:10px; white-space:nowrap; }
.badge-green  { background:#0a1a10; border:.5px solid var(--green);  color:var(--green-l); }
.badge-amber  { background:#0a1000; border:.5px solid var(--amber);  color:#FAC775; }
.badge-purple { background:#0a0a1a; border:.5px solid var(--purple); color:#AFA9EC; }

/* ══════════════════════════════════════
   DRIVERS
   ══════════════════════════════════════ */
.drv-row { display:flex; align-items:center; gap:8px; padding:9px 10px; background:var(--bg2); border:.5px solid var(--border); border-radius:8px; }
.drv-txt  { flex:1; min-width:0; }
.drv-name { font-size:11px; color:var(--text); }
.drv-sub  { font-size:10px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.tog { width:34px; height:19px; border-radius:10px; flex-shrink:0; background:#1a2235; border:.5px solid rgba(255,255,255,.1); cursor:pointer; position:relative; transition:background .2s; }
.tog.on { background:var(--green-d); border-color:var(--green); }
.tog::after { content:''; position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; transition:transform .2s; }
.tog.on::after { transform:translateX(15px); }

.log { background:var(--bg3); border:.5px solid rgba(255,255,255,.06); border-radius:7px; padding:8px; font-size:10px; font-family:'SF Mono',Monaco,'Courier New',monospace; color:var(--dim); line-height:1.9; max-height:200px; overflow-y:auto; -webkit-overflow-scrolling:touch; flex-shrink:0; }
.log .ok { color:var(--green); } .log .wn { color:var(--amber); }
.log .er { color:var(--red);   } .log .dim { color:var(--dim); }

/* ══════════════════════════════════════
   REDE
   ══════════════════════════════════════ */
.net-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.net-card { background:var(--bg2); border:.5px solid var(--border); border-radius:9px; padding:9px 10px; }
.net-label { font-size:10px; color:var(--muted); margin-bottom:3px; }
.net-val   { font-size:12px; font-weight:500; color:var(--text); }

.ap-row { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:var(--bg2); border:.5px solid var(--border); border-radius:9px; }
.ap-title { font-size:12px; color:var(--text); }
.ap-sub   { font-size:10px; color:var(--dim); margin-top:2px; }
.ap-detail { opacity:0.3; transition:opacity .3s; }
.ap-detail.visible { opacity:1; }

/* ══════════════════════════════════════
   SCROLLBAR + SAFE AREA
   ══════════════════════════════════════ */
::-webkit-scrollbar { width:3px; height:3px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:var(--dim); border-radius:2px; }
```
---
