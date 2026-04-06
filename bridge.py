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

    def read_raw(self):
        """Retorna (x, y, z) brutos do magnetômetro."""
        d = self._bus.read_i2c_block_data(self._ADDR, 0x03, 6)

        def s16(hi, lo):
            v = (hi << 8) | lo
            return v - 65536 if v > 32767 else v

        return s16(d[0], d[1]), s16(d[4], d[5]), s16(d[2], d[3])

    def read(self, declination=0.0, pitch_deg=0.0, roll_deg=0.0):
        x, y, z = self.read_raw()
        return tilt_compensated_heading(x, y, z, pitch_deg, roll_deg, declination)


class CompassQMC5883L:
    _ADDR = 0x0D

    def __init__(self, bus=CFG['I2C_BUS']):
        self._bus = smbus2.SMBus(bus)
        self._bus.write_byte_data(self._ADDR, 0x0B, 0x01)  # Reset
        time.sleep(0.05)
        self._bus.write_byte_data(self._ADDR, 0x09, 0x0D)  # Cont, 10Hz, 2G, OSR=512

    def read_raw(self):
        """Retorna (x, y, z) brutos do magnetômetro."""
        d = self._bus.read_i2c_block_data(self._ADDR, 0x00, 6)

        def s16(lo, hi):
            v = (hi << 8) | lo
            return v - 65536 if v > 32767 else v

        return s16(d[0], d[1]), s16(d[2], d[3]), s16(d[4], d[5])

    def read(self, declination=0.0, pitch_deg=0.0, roll_deg=0.0):
        x, y, z = self.read_raw()
        return tilt_compensated_heading(x, y, z, pitch_deg, roll_deg, declination)


def tilt_compensated_heading(mx, my, mz, pitch_deg, roll_deg, declination_deg):
    """
    Compensação de tilt para magnetômetro.

    Com o sensor inclinado (pitch ≠ 0 ou roll ≠ 0), o campo magnético
    não está no plano horizontal — o heading calculado com atan2(y,x) acumula erro.

    Esta função projeta os vetores magnéticos no plano horizontal usando
    pitch e roll medidos pelo ADXL345, eliminando o erro de inclinação.

    Ref: ST AN4246 / Honeywell AN-203
        Xh = mx·cos(pitch) + mz·sin(pitch)
        Yh = mx·sin(roll)·sin(pitch) + my·cos(roll) − mz·sin(roll)·cos(pitch)
    """
    pitch = math.radians(pitch_deg)
    roll  = math.radians(roll_deg)

    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll),  math.sin(roll)

    # Projeção no plano horizontal
    xh = mx * cp + mz * sp
    yh = mx * sr * sp + my * cr - mz * sr * cp

    # Heading magnético compensado
    heading_mag = (math.degrees(math.atan2(yh, xh)) + 360.0) % 360.0

    # Heading verdadeiro aplicando declinação magnética
    heading_true = (heading_mag + declination_deg) % 360.0

    return {'heading': round(heading_mag, 1), 'true_heading': round(heading_true, 1)}


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
                    dec   = STATE['mag_dec'] or 0.0
                    pitch = STATE['pitch']   or 0.0
                    roll  = STATE['roll']    or 0.0
                h = compass.read(declination=dec, pitch_deg=pitch, roll_deg=roll)
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
