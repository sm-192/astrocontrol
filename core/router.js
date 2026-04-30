'use strict';

/* ── Commands INDI ── */
const {
  indiSlew,
  indiSlewRate,
  indiGoto,
  indiSync,
  indiPark,
  indiTracking,
  indiSlewHome,
  indiMeridianFlip,
} = require('../indi/commands/mount');

const {
  indiFocusMove,
  indiFocusStop,
  indiFocusGoto,
} = require('../indi/commands/focuser');

const {
  indiCameraCapture,
  indiCameraAbort,
} = require('../indi/commands/camera');

const { indiFilterSet }   = require('../indi/commands/filterwheel');
const { indiRotatorGoto } = require('../indi/commands/rotator');

/* ── Services ── */
const { resolveObject } = require('../services/resolver');
const {
  startDriver,
  stopDriver,
  refreshDrivers,
} = require('../services/drivers');

const {
  refreshNet,
  toggleAP,
  discoveryMode,
  connectWifi,
} = require('../services/network');

const {
  refreshPHD2,
  phd2Guide,
  phd2Loop,
  phd2Stop,
  phd2Dither,
} = require('../services/phd2');

/* ── Utils ── */
const { emit } = require('../utils/emit');
const {
  parseRA,
  parseDec,
  formatRA,
  formatDec,
} = require('../utils/format');

/* ── Estado ── */
const { DEVICE_STATE } = require('../indi/state');


/* ══════════════════════════════════════════════
   HANDLER PRINCIPAL (ex-handleMsg do server.js)
   ══════════════════════════════════════════════ */

function handleMsg(session, msg) {
  const ws = session.ws;

  switch (msg.type) {

    /* ── Montagem ── */
    case 'slew_start':
      indiSlew(session, msg.direction, true);
      break;

    case 'slew_stop':
      indiSlew(session, msg.direction, false);
      break;

    case 'slew_rate':
      indiSlewRate(session, msg.rate);
      break;

    case 'tracking':
      indiTracking(session, msg.mode);
      break;

    case 'sync':
      indiSync(session);
      emit(ws,'goto_result',{ success:true, message:'Sync enviado' });
      break;

    case 'park':
      indiPark(session, true);
      emit(ws,'goto_result',{ success:true, message:'Park enviado' });
      break;

    case 'unpark':
      indiPark(session, false);
      break;

    case 'slew_home':
      indiSlewHome(session);
      break;

    case 'meridian_flip':
      indiMeridianFlip(session);
      break;


    /* ── Focuser ── */
    case 'focus_move':
      indiFocusMove(session, msg.steps);
      break;

    case 'focus_stop':
      indiFocusStop(session);
      break;

    case 'focus_goto':
      indiFocusGoto(session, msg.position);
      break;


    /* ── Filtros / Rotator ── */
    case 'filter_set':
      indiFilterSet(session, msg.slot);
      break;

    case 'rotator_goto':
      indiRotatorGoto(session, msg.angle);
      break;


    /* ── Câmera ── */
    case 'camera_capture':
      indiCameraCapture(session, msg.exposure, msg.gain);
      break;

    case 'camera_abort':
      indiCameraAbort(session);
      break;


    /* ── Guiding / PHD2 ── */
    case 'phd2_status':
      refreshPHD2(ws);
      break;

    case 'phd2_loop':
      phd2Loop(ws, msg.exposureMs);
      break;

    case 'phd2_guide':
      phd2Guide(ws, msg);
      break;

    case 'phd2_stop':
      phd2Stop(ws);
      break;

    case 'phd2_dither':
      phd2Dither(ws, msg);
      break;


    /* ── Drivers ── */
    case 'driver_start':
      startDriver(session, msg.driver, msg.port);
      break;

    case 'driver_stop':
      stopDriver(ws, msg.driver);
      break;


    /* ── Rede ── */
    case 'ap_toggle':
      toggleAP(ws, msg.enable);
      break;

    case 'network_status':
      refreshNet(ws);
      break;

    case 'discovery_mode':
      discoveryMode(ws, msg.enable);
      break;

    case 'wifi_connect':
      connectWifi(ws, msg.ssid, msg.password);
      break;

    /* ── Estado ── */
    case 'get_state':
      emit(ws,'full_state',{ devices: DEVICE_STATE });
      break;


    /* ── GOTO por nome ── */
    case 'goto_name': {
      const id = 'goto_' + Date.now();

      emit(ws, 'goto_result', {
        success: null,
        message: `Resolvendo "${msg.name}"…`
      });

      resolveObject(msg.name)
        .then(({ ra, dec }) => {
          indiGoto(session, ra, dec, id);

          emit(ws, 'goto_result', {
            success: true,
            message: `${msg.name} → ${formatRA(ra)} / ${formatDec(dec)}`
          });
        })
        .catch(err => {
          emit(ws, 'goto_result', {
            success: false,
            message: err.message
          });
        });

      break;
    }


    /* ── GOTO por coordenadas ── */
    case 'goto_coords': {
      const ra  = parseRA(msg.ra);
      const dec = parseDec(msg.dec);

      if (ra == null || dec == null) {
        emit(ws, 'goto_result', {
          success: false,
          message: 'Coordenadas inválidas'
        });
        break;
      }

      const id = 'goto_' + Date.now();

      indiGoto(session, ra, dec, id);

      emit(ws, 'goto_result', {
        success: true,
        message: `GoTo → ${formatRA(ra)} / ${formatDec(dec)}`
      });

      break;
    }
  }
}

module.exports = {
  handleMsg,
};
