/**
 * INDI Interpreter — AstroControl
 * Interpreta mensagens XML já parseadas
 * (equivalente ao parseIndiMessage do server original)
 */

'use strict';

const { DEVICE_STATE, patchDevice, KNOWN_DEVICES, deviceKey } = require('./state');
const { emit, log } = require('../utils/emit');
const { formatRA, formatDec } = require('../utils/format');

/* ══════════════════════════════════════════════
   HELPERS XML
   ══════════════════════════════════════════════ */

function xAttr(xml, name) {
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*?)"|\'([^\']*?)\')');
  const m  = re.exec(xml);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function parseAttrs(str) {
  const obj = {};
  const re  = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)')/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    obj[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return obj;
}

function xChildren(xml, ...tags) {
  const res = [];

  for (const tag of tags) {
    const reOpen = new RegExp(`<${tag}((?:\\s[^>]*?)?)\\s*>([\\s\\S]*?)<\\/${tag}>`, 'g');
    let m;
    while ((m = reOpen.exec(xml))) {
      res.push({ ...parseAttrs(m[1]), value: m[2].trim() });
    }

    const reSelf = new RegExp(`<${tag}((?:\\s[^>]*?)?)\\s*/>`, 'g');
    while ((m = reSelf.exec(xml))) {
      const attrs = parseAttrs(m[1]);
      res.push({ ...attrs, value: attrs.value || '' });
    }
  }

  return res;
}

/* ══════════════════════════════════════════════
   INTERPRETADOR
   ══════════════════════════════════════════════ */

function interpret(xml, tag, session) {
  const ws     = session.ws;
  const device = xAttr(xml, 'device');
  const name   = xAttr(xml, 'name');
  const state  = xAttr(xml, 'state');

  const key = device ? (KNOWN_DEVICES.get(device) || deviceKey(device)) : null;

  if (device && key && !KNOWN_DEVICES.has(device)) {
    KNOWN_DEVICES.set(device, key);
  }

  switch (tag) {

    /* ═══════════════════════════════
       NUMBER VECTOR
       ═══════════════════════════════ */
    case 'defNumberVector':
    case 'setNumberVector': {
      const nums = {};
      for (const el of xChildren(xml, 'oneNumber', 'defNumber')) {
        const v = parseFloat(el.value || '0');
        if (!isNaN(v)) nums[el.name] = v;
      }

      /* MOUNT RA/DEC */
      if (name === 'EQUATORIAL_EOD_COORD' || name === 'EQUATORIAL_COORD') {
        const ra = nums.RA, dec = nums.DEC;
        if (ra != null && dec != null) {
          patchDevice('mount', {
            ra: formatRA(ra),
            dec: formatDec(dec),
            ra_raw: ra,
            dec_raw: dec,
            slewing: state === 'Busy',
            state: state === 'Busy' ? 'slewing'
                 : DEVICE_STATE.mount.tracking ? 'tracking'
                 : 'idle',
          });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      /* ALT/AZ */
      if (name === 'HORIZONTAL_COORD') {
        if (nums.ALT != null && nums.AZ != null) {
          patchDevice('mount', {
            alt: nums.ALT.toFixed(2),
            az:  nums.AZ.toFixed(2),
          });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      /* FOCUSER */
      if ((name === 'ABS_FOCUS_POSITION' || name === 'FOCUS_ABSOLUTE_POSITION') && key === 'focuser') {
        const pos = nums.FOCUS_ABSOLUTE_POSITION ?? nums.FOCUS_TICKS;
        if (pos != null) {
          patchDevice('focuser', {
            position: Math.round(pos),
            moving: state === 'Busy',
          });
          emit(ws, 'device_update', { key: 'focuser', data: DEVICE_STATE.focuser });
        }
      }

      /* ROTATOR */
      if (name === 'ABS_ROTATOR_ANGLE' && key === 'rotator') {
        if (nums.ANGLE != null) {
          patchDevice('rotator', {
            angle: nums.ANGLE.toFixed(2),
            moving: state === 'Busy',
          });
          emit(ws, 'device_update', { key: 'rotator', data: DEVICE_STATE.rotator });
        }
      }

      /* FILTER */
      if (name === 'FILTER_SLOT' && key === 'filterwheel') {
        const slot = Math.round(nums.FILTER_SLOT_VALUE);
        const fname = DEVICE_STATE.filterwheel.filterNames[slot - 1] || null;

        patchDevice('filterwheel', { slot, filter: fname });
        emit(ws, 'device_update', { key: 'filterwheel', data: DEVICE_STATE.filterwheel });
      }

      /* CAMERA */
      if (name === 'CCD_EXPOSURE' && key === 'camera') {
        if (nums.CCD_EXPOSURE_VALUE != null) {
          patchDevice('camera', {
            exposure: nums.CCD_EXPOSURE_VALUE,
            capturing: state === 'Busy',
          });
          emit(ws, 'device_update', { key: 'camera', data: DEVICE_STATE.camera });
        }
      }

      if (name === 'CCD_GAIN' && key === 'camera') {
        if (nums.GAIN != null) {
          patchDevice('camera', { gain: nums.GAIN });
          emit(ws, 'device_update', { key: 'camera', data: DEVICE_STATE.camera });
        }
      }

      /* GPS */
      if ((name === 'GEOGRAPHIC_COORD' || name === 'GPS_GEOGRAPHIC_COORD') && key === 'gps') {
        patchDevice('gps', {
          lat: nums.LAT,
          lon: nums.LONG,
          fix: true,
        });
        emit(ws, 'device_update', { key: 'gps', data: DEVICE_STATE.gps });
      }

      break;
    }

    /* ═══════════════════════════════
       SWITCH VECTOR
       ═══════════════════════════════ */
    case 'defSwitchVector':
    case 'setSwitchVector': {
      const sw = {};
      for (const el of xChildren(xml, 'oneSwitch', 'defSwitch')) {
        sw[el.name] = el.value === 'On';
      }

      /* CONNECTION */
      if (name === 'CONNECTION' && key) {
        const connected = sw.CONNECT === true;

        patchDevice(key, {
          connected,
          state: connected ? 'idle' : 'disconnected',
        });

        emit(ws, 'device_update', { key, data: DEVICE_STATE[key] });

        log(ws, connected ? 'ok' : 'wn',
          `${device || key} ${connected ? 'conectado' : 'desconectado'}`);
      }

      /* PIER SIDE */
      if (name === 'TELESCOPE_PIER_SIDE' && key === 'mount') {
        const side = sw.PIER_WEST ? 'W' : sw.PIER_EAST ? 'E' : null;
        if (side) {
          patchDevice('mount', { pierSide: side });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      /* PARK */
      if (name === 'TELESCOPE_PARK' && key === 'mount') {
        const parked = sw.PARK === true;
        patchDevice('mount', {
          parked,
          state: parked ? 'parked' : 'idle',
        });
        emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
      }

      /* TRACK MODE */
      if (name === 'TELESCOPE_TRACK_MODE' && key === 'mount') {
        const map = {
          TRACK_SIDEREAL:'Sidereal',
          TRACK_SOLAR:'Solar',
          TRACK_LUNAR:'Lunar',
          TRACK_CUSTOM:'Custom',
        };
        const active = Object.entries(sw).find(([,v]) => v);
        if (active) {
          patchDevice('mount', { tracking: map[active[0]] || active[0] });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      /* TRACK STATE */
      if (name === 'TELESCOPE_TRACK_STATE' && key === 'mount') {
        const on = sw.TRACK_ON === true;
        patchDevice('mount', {
          tracking: on ? (DEVICE_STATE.mount.tracking || 'Sidereal') : null,
          state: on ? 'tracking' : DEVICE_STATE.mount.state,
        });
        emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
      }

      /* SLEW RATE */
      if (name === 'TELESCOPE_SLEW_RATE' && key === 'mount') {
        const map = {
          SLEW_GUIDE:'Guide',
          SLEW_CENTERING:'Centering',
          SLEW_FIND:'Find',
          SLEW_MAX:'Max',
        };
        const active = Object.entries(sw).find(([,v]) => v);
        if (active) {
          patchDevice('mount', { slewRate: map[active[0]] });
          emit(ws, 'device_update', { key: 'mount', data: DEVICE_STATE.mount });
        }
      }

      /* FOCUSER */
      if ((name === 'FOCUS_MOTION' || name === 'FOCUSER_MOTION') && key === 'focuser') {
        const moving = sw.FOCUS_INWARD || sw.FOCUS_OUTWARD;
        patchDevice('focuser', { moving: !!moving });
        emit(ws, 'device_update', { key: 'focuser', data: DEVICE_STATE.focuser });
      }

      /* GPS STATUS */
      if (name === 'GPS_STATUS' && key === 'gps') {
        patchDevice('gps', { fix: sw.GPS_FIX === true });
        emit(ws, 'device_update', { key: 'gps', data: DEVICE_STATE.gps });
      }

      break;
    }

    /* ═══════════════════════════════
       TEXT VECTOR
       ═══════════════════════════════ */
    case 'defTextVector':
    case 'setTextVector': {
      const texts = {};
      for (const el of xChildren(xml, 'oneText', 'defText')) {
        texts[el.name] = el.value;
      }

      if (name === 'FILTER_NAME' && key === 'filterwheel') {
        const names = Object.values(texts).filter(Boolean);
        const slot = DEVICE_STATE.filterwheel.slot;

        patchDevice('filterwheel', {
          filterNames: names,
          filter: slot != null ? names[slot - 1] : null,
        });

        emit(ws, 'device_update', { key: 'filterwheel', data: DEVICE_STATE.filterwheel });
      }

      if (name === 'GPS_UTC' && key === 'gps') {
        patchDevice('gps', { connected: true, state: 'idle' });
        emit(ws, 'device_update', { key: 'gps', data: DEVICE_STATE.gps });
      }

      break;
    }

    /* ═══════════════════════════════
       LIGHT VECTOR
       ═══════════════════════════════ */
    case 'defLightVector':
    case 'setLightVector': {
      if (state === 'Alert') {
        log(ws, 'er', `${device || '?'}/${name || '?'}: Alert`);
      }
      break;
    }

    /* ═══════════════════════════════
       BLOB (IMAGEM)
       ═══════════════════════════════ */
    case 'setBLOBVector': {
      if (key !== 'camera') break;

      const blobMatch = xml.match(/<oneBlob[^>]*>([\s\S]*?)<\/oneBlob>/i);
      if (!blobMatch) break;

      const raw = blobMatch[1].replace(/\s/g, '');
      if (!raw || raw.length < 100) break;

      const fmt = (xAttr(xml, 'format') || 'fits').replace('.', '').toLowerCase();
      const sendFmt = ['jpg','jpeg','png'].includes(fmt) ? fmt : 'fits';

      emit(ws, 'camera_image', {
        data: raw,
        format: sendFmt,
        device: device || '',
      });

      patchDevice('camera', { capturing: false });
      emit(ws, 'device_update', { key: 'camera', data: DEVICE_STATE.camera });

      break;
    }

    /* ═══════════════════════════════
       MESSAGE
       ═══════════════════════════════ */
    case 'message': {
      const txt = xAttr(xml, 'message');
      const ts  = xAttr(xml, 'timestamp');

      if (txt && txt.trim()) {
        const lvl = /error|falha/i.test(txt) ? 'er' : 'dim';
        log(ws, lvl, `[${ts||'--'}] ${device ? device + ': ' : ''}${txt}`);
      }
      break;
    }

    /* ═══════════════════════════════
       REMOVE DEVICE
       ═══════════════════════════════ */
    case 'delProperty': {
      if (key) {
        KNOWN_DEVICES.delete(device);
        patchDevice(key, { connected: false, state: 'disconnected' });
        emit(ws, 'device_update', { key, data: DEVICE_STATE[key] });
      }
      break;
    }
  }
}

module.exports = { interpret };