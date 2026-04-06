/**
 * AstroControl — alignment.js
 *
 * Visualização de alinhamento polar.
 * Não contém simulação — aguarda dados reais do Python bridge via WebSocket.
 * Ponto de entrada: applyAlignData(data)
 *
 * data = {
 *   pitch:  number,   // graus, inclinação frontal
 *   roll:   number,   // graus, inclinação lateral
 *   heading: number,  // graus, norte magnético (0-360)
 *   lat:    number,   // latitude GPS (graus decimais)
 *   lon:    number,   // longitude GPS
 *   decMag: number,   // declinação magnética calculada
 *   fix:    boolean,  // GPS tem fix
 *   sats:   number,   // número de satélites
 * }
 */

'use strict';

/* ══════════════════════════════════════════════
   ESTADO INTERNO
   ══════════════════════════════════════════════ */

const ALIGN = {
  /* Valores suavizados (exibidos nos canvas) */
  pitch:   0,
  roll:    0,
  heading: 0,

  /* Valores brutos do sensor (entrada para smoothing) */
  _rawPitch:   null,
  _rawRoll:    null,
  _rawHeading: null,

  /* Referências GPS/magnéticas */
  lat:    null,
  lon:    null,
  decMag: null,
  fix:    false,
  sats:   0,

  /* Controle de render */
  hasData: false,   // true quando ao menos 1 leitura real chegou
  _dirty:  false,
  _rafId:  null,
};

/* Coeficiente de suavização exponencial (0 = sem suav., 1 = instantâneo) */
const ALPHA = 0.12;

/* ══════════════════════════════════════════════
   PONTO DE ENTRADA — chamado por app.js
   ══════════════════════════════════════════════ */

/**
 * Recebe dados reais do Python bridge e atualiza o estado.
 * Chamado sempre que o WebSocket de sensores recebe uma mensagem.
 */
function applyAlignData(data) {
  if (data.pitch   !== undefined) ALIGN._rawPitch   = data.pitch;
  if (data.roll    !== undefined) ALIGN._rawRoll    = data.roll;
  if (data.heading !== undefined) ALIGN._rawHeading = data.heading;
  if (data.lat     !== undefined) ALIGN.lat         = data.lat;
  if (data.lon     !== undefined) ALIGN.lon         = data.lon;
  if (data.decMag  !== undefined) ALIGN.decMag      = data.decMag;
  if (data.fix     !== undefined) ALIGN.fix         = data.fix;
  if (data.sats    !== undefined) ALIGN.sats        = data.sats;

  ALIGN.hasData = true;
  ALIGN._dirty  = true;

  updateSensorBanner(true);
  updateAlignTexts();
  scheduleAlignRender();
}

/* ══════════════════════════════════════════════
   LOOP DE RENDER — requestAnimationFrame
   ══════════════════════════════════════════════ */

function scheduleAlignRender() {
  if (!ALIGN._rafId) {
    ALIGN._rafId = requestAnimationFrame(alignRenderLoop);
  }
}

function alignRenderLoop() {
  ALIGN._rafId = null;

  /* Smoothing exponencial — só quando há dados reais */
  if (ALIGN.hasData) {
    if (ALIGN._rawPitch !== null)
      ALIGN.pitch = lerp(ALIGN.pitch, ALIGN._rawPitch, ALPHA);
    if (ALIGN._rawRoll !== null)
      ALIGN.roll = lerp(ALIGN.roll, ALIGN._rawRoll, ALPHA);
    if (ALIGN._rawHeading !== null)
      ALIGN.heading = lerpAngle(ALIGN.heading, ALIGN._rawHeading, ALPHA);
  }

  /* Renderiza apenas se a aba está visível */
  const panel = document.getElementById('p-align');
  if (panel && panel.classList.contains('active')) {
    drawBarLat();
    drawBarDec();
    drawNivel2D();
    drawCompass();
    updateFeedback();
  }

  /* Continua o loop enquanto há dados chegando (suavização em progresso) */
  if (ALIGN._dirty) {
    ALIGN._dirty = false;
    /* Agenda mais um frame para completar o smoothing */
    ALIGN._rafId = requestAnimationFrame(alignRenderLoop);
  }
}

/* ══════════════════════════════════════════════
   FUNÇÕES DE CÁLCULO
   ══════════════════════════════════════════════ */

function getNorthTrue() {
  if (ALIGN.decMag === null || ALIGN._rawHeading === null) return null;
  return ((ALIGN.heading - ALIGN.decMag) % 360 + 360) % 360;
}

function getAzError() {
  const nt = getNorthTrue();
  if (nt === null) return null;
  let err = nt % 360;
  if (err > 180) err -= 360;
  return err;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  /* Interpolação de ângulo pelo caminho mais curto */
  let diff = ((b - a) % 360 + 540) % 360 - 180;
  return (a + diff * t + 360) % 360;
}

function feedbackColor(abs, ok, warn) {
  if (abs < ok)   return '#1D9E75';
  if (abs < warn) return '#EF9F27';
  return '#E24B4A';
}

/* ══════════════════════════════════════════════
   ATUALIZAÇÃO DE TEXTOS
   ══════════════════════════════════════════════ */

function updateAlignTexts() {
  const nt = getNorthTrue();
  setText('a-lat',    ALIGN.lat    !== null ? ALIGN.lat.toFixed(4) + '°' : '--');
  setText('a-decmag', ALIGN.decMag !== null ? ALIGN.decMag.toFixed(1) + '°' : '--');
  setText('a-north',  nt           !== null ? Math.round(nt) + '°' : '--');
  setText('a-sats',   ALIGN.fix ? String(ALIGN.sats) + ' ✓' : (ALIGN.sats ? String(ALIGN.sats) : '--'));
}

function updateSensorBanner(connected) {
  const banner = document.getElementById('sensor-banner');
  const txt    = document.getElementById('sensor-banner-txt');
  if (!banner || !txt) return;

  if (!connected) {
    banner.className = 'sensor-banner';
    txt.textContent = 'Aguardando Python bridge na porta 8765…';
    return;
  }

  if (!ALIGN.fix) {
    banner.className = 'sensor-banner';
    txt.textContent = `Sensores conectados · GPS buscando fix (${ALIGN.sats} sat)`;
  } else {
    banner.className = 'sensor-banner active';
    txt.textContent  = `Sensores ativos · GPS fix · ${ALIGN.sats} satélites`;
  }
}

function updateFeedback() {
  const fb  = getAlignFeedback();
  const bar = document.getElementById('a-fb');
  const dot = document.getElementById('a-dot');
  const txt = document.getElementById('a-txt');
  if (!bar || !dot || !txt) return;
  bar.style.background  = fb.bg;
  bar.style.borderColor = fb.bc + '55';
  dot.style.background  = fb.c;
  txt.style.color       = fb.c;
  txt.textContent       = fb.t;
}

function getAlignFeedback() {
  if (!ALIGN.hasData) {
    return { c:'#374151', bg:'var(--bg2)', bc:'#374151', t:'Aguardando dados dos sensores…' };
  }

  if (!ALIGN.fix) {
    return { c:'#EF9F27', bg:'#120e00', bc:'#EF9F27', t:'GPS sem fix — dados de posição imprecisos' };
  }

  const azErr = getAzError();
  const p     = Math.abs(ALIGN.pitch);
  const r     = Math.abs(ALIGN.roll);

  if (azErr === null) {
    return { c:'#374151', bg:'var(--bg2)', bc:'#374151', t:'Calculando norte real…' };
  }

  const az = Math.abs(azErr);

  /* Excelente */
  if (p < 0.3 && r < 0.3 && az < 1.0) {
    return { c:'#1D9E75', bg:'#06120a', bc:'#1D9E75',
      t: 'Alinhamento excelente — pode iniciar plate solve.' };
  }

  /* Bom — só ajuste fino */
  if (p < 1.5 && r < 1.5 && az < 5.0) {
    const parts = [];
    if (az >= 1.0) parts.push(`azimute ${azHint(azErr)}`);
    if (p  >= 0.3) parts.push(`pitch ${ALIGN.pitch > 0 ? '▼' : '▲'} ${p.toFixed(1)}°`);
    if (r  >= 0.3) parts.push(`roll ${ALIGN.roll  > 0 ? '►' : '◄'} ${r.toFixed(1)}°`);
    return { c:'#EF9F27', bg:'#120e00', bc:'#EF9F27',
      t: 'Quase lá — ' + parts.join(' · ') };
  }

  /* Fora */
  const parts = [];
  if (az >= 5.0) parts.push(`Gire ${azHint(azErr)}`);
  if (p  >= 1.5) parts.push(`Incline ${ALIGN.pitch > 0 ? 'frente ▼' : 'trás ▲'} ${p.toFixed(1)}°`);
  if (r  >= 1.5) parts.push(`Nível ${ALIGN.roll > 0 ? '►' : '◄'} ${r.toFixed(1)}°`);
  return { c:'#E24B4A', bg:'#120606', bc:'#E24B4A', t: parts.join(' · ') };
}

function azHint(err) {
  const abs = Math.abs(err);
  const dir = err > 0 ? 'horário ↻' : 'anti-horário ↺';
  return `${dir} ${abs.toFixed(1)}°`;
}

/* ══════════════════════════════════════════════
   DRAW — BARRA VERTICAL (LATITUDE / PITCH)
   ══════════════════════════════════════════════ */

function drawBarLat() {
  const c = document.getElementById('cv-bar-lat');
  if (!c) return;
  const ctx = c.getContext('2d');

  /* HiDPI */
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || c.width;
  const cssH = c.clientHeight || c.height;
  if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
    c.width = cssW * dpr;
    c.height = cssH * dpr;
  }
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  const W = cssW, H = cssH;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, tw = 10, tt = 20, tb = H - 20, th = tb - tt;
  const cy = tt + th / 2;

  /* Trilho */
  ctx.fillStyle = '#0a0f1e';
  roundRect(ctx, cx - tw/2, tt, tw, th, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  /* Linha de referência (alvo = latitude GPS) */
  ctx.beginPath();
  ctx.moveTo(cx - tw/2 - 12, cy);
  ctx.lineTo(cx + tw/2 + 12, cy);
  ctx.strokeStyle = '#1d9e75';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 2]);
  ctx.stroke();
  ctx.setLineDash([]);

  /* Label do Alvo */
  if (ALIGN.lat !== null) {
    ctx.fillStyle = '#1d9e75';
    ctx.font = 'bold 9px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('ALVO', cx + tw/2 + 15, cy - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '9px system-ui';
    ctx.fillText(ALIGN.lat.toFixed(2) + '°', cx + tw/2 + 15, cy + 8);
  }

  /* Marcador — só se há dados */
  if (!ALIGN.hasData) {
    const valEl = document.getElementById('lat-bar-val');
    if (valEl) { valEl.textContent = '--'; valEl.style.color = 'var(--muted)'; }
    return;
  }

  const range = 20;
  const off   = Math.max(-1, Math.min(1, ALIGN.pitch / range)) * th / 2;
  const my    = Math.max(tt + 10, Math.min(tb - 10, cy + off));
  const col   = feedbackColor(Math.abs(ALIGN.pitch), 0.3, 1.5);

  /* Sombra/Brilho do marcador */
  ctx.shadowBlur = 10;
  ctx.shadowColor = col + '60';

  ctx.fillStyle = col + '40';
  ctx.beginPath(); ctx.arc(cx, my, 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, my, 6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, my, 2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();

  ctx.shadowBlur = 0;

  /* Label do Atual */
  const angleAt = (ALIGN.lat || 0) + ALIGN.pitch;
  ctx.fillStyle = col;
  ctx.font = 'bold 9px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText('ATUAL', cx - tw/2 - 15, my - 2);
  ctx.fillStyle = '#fff';
  ctx.font = '9px system-ui';
  ctx.fillText(angleAt.toFixed(2) + '°', cx - tw/2 - 15, my + 8);

  const valEl = document.getElementById('lat-bar-val');
  if (valEl && ALIGN.lat !== null) {
    valEl.textContent = angleAt.toFixed(3) + '°';
    valEl.style.color = col;
  }
}

/* ══════════════════════════════════════════════
   DRAW — BARRA HORIZONTAL (DECLINAÇÃO / AZIMUTE)
   ══════════════════════════════════════════════ */

function drawBarDec() {
  const c = document.getElementById('cv-bar-dec');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);

  const cy = H / 2, th = 10, tl = 8, tr = W - 8, tw = tr - tl;
  const cx = tl + tw / 2;

  /* Trilho */
  ctx.fillStyle = '#0a0f1e';
  roundRect(ctx, tl, cy - th/2, tw, th, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  /* Linha de referência */
  ctx.beginPath();
  ctx.moveTo(cx, cy - th/2 - 5);
  ctx.lineTo(cx, cy + th/2 + 5);
  ctx.strokeStyle = 'rgba(29,158,117,0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  /* Label */
  if (ALIGN.decMag !== null) {
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '7px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(ALIGN.decMag.toFixed(1) + '°', cx + 14, cy - 7);
  }

  /* Marcador */
  const valEl = document.getElementById('dec-bar-val');
  const azErr = getAzError();

  if (!ALIGN.hasData || azErr === null) {
    if (valEl) { valEl.textContent = '--'; valEl.style.color = 'var(--muted)'; }
    return;
  }

  const range = 30;
  const off   = Math.max(-1, Math.min(1, azErr / range)) * tw / 2;
  const mx    = Math.max(tl + 7, Math.min(tr - 7, cx + off));
  const col   = feedbackColor(Math.abs(azErr), 1.0, 5.0);

  ctx.fillStyle = col + '30';
  ctx.beginPath(); ctx.arc(mx, cy, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(mx, cy, 5, 0, Math.PI * 2); ctx.fill();

  if (valEl) {
    const sign = azErr >= 0 ? '+' : '';
    valEl.textContent = `desvio: ${sign}${azErr.toFixed(2)}°`;
    valEl.style.color = col;
  }
}

/* ══════════════════════════════════════════════
   DRAW — NÍVEL DE BOLHA 2D
   ══════════════════════════════════════════════ */

function drawNivel2D() {
  const c = document.getElementById('cv-nivel');
  if (!c) return;
  const ctx = c.getContext('2d');

  /* HiDPI para nitidez total */
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || c.width;
  const cssH = c.clientHeight || c.height;
  if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
    c.width = cssW * dpr;
    c.height = cssH * dpr;
  }
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  const W = cssW, H = cssH;
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 4;

  ctx.clearRect(0, 0, W, H);

  /* Fundo */
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0f1e'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.stroke();

  /* Anéis de referência */
  for (let i = 1; i <= 3; i++) {
    ctx.beginPath(); ctx.arc(cx, cy, R * i / 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5; ctx.stroke();
  }

  /* Cruza de fundo */
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

  /* PONTO CENTRAL (Target) — Redesenhado para nitidez extrema */
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(29,158,117,0.3)'; ctx.lineWidth = 3; ctx.stroke();
  
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.strokeStyle = '#1d9e75'; ctx.lineWidth = 1.5; ctx.stroke();

  /* Crosshair central micro */
  ctx.beginPath();
  ctx.moveTo(cx - 2, cy); ctx.lineTo(cx + 2, cy);
  ctx.moveTo(cx, cy - 2); ctx.lineTo(cx, cy + 2);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();

  if (!ALIGN.hasData) {
    /* Estado de espera — texto centralizado */
    ctx.fillStyle = 'rgba(55,65,81,0.5)';
    ctx.font = '8px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('--', cx, cy);
    ctx.textBaseline = 'alphabetic';
    setText('pitch-val', '--'); setText('roll-val', '--');
    const ns = document.getElementById('nivel-status');
    if (ns) { ns.textContent = 'Aguardando…'; ns.style.color = 'var(--dim)'; }
    return;
  }

  const range = 15;
  const bx    = cx + Math.max(-1, Math.min(1, ALIGN.roll  / range)) * R * 0.75;
  const by    = cy + Math.max(-1, Math.min(1, ALIGN.pitch / range)) * R * 0.75;
  const dist  = Math.sqrt(ALIGN.pitch ** 2 + ALIGN.roll ** 2);
  const col   = feedbackColor(dist, 0.4, 2.0);

  /* Bolha */
  ctx.shadowBlur = 10;
  ctx.shadowColor = col + '40';
  
  ctx.fillStyle = col + '22';
  ctx.beginPath(); ctx.arc(bx, by, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.fill();
  
  /* Ponto de luz na bolha para volume */
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath(); ctx.arc(bx - 3, by - 3, 2, 0, Math.PI * 2); ctx.fill();

  ctx.shadowBlur = 0;

  setText('pitch-val', ALIGN.pitch.toFixed(2) + '°');
  setText('roll-val',  ALIGN.roll.toFixed(2)  + '°');
  colorEl('pitch-val', col);
  colorEl('roll-val',  col);

  const ns = document.getElementById('nivel-status');
  if (ns) {
    ns.textContent = dist < 0.4 ? 'Nivelado' : dist < 2 ? 'Quase nivelado' : 'Fora de nível';
    ns.style.color = col;
  }
}

/* ══════════════════════════════════════════════
   DRAW — BÚSSOLA POLAR
   ══════════════════════════════════════════════ */

function drawCompass() {
  const c = document.getElementById('cv-compass');
  if (!c) return;
  const ctx = c.getContext('2d');

  /* Canvas com DPR para nitidez em telas retina */
  const dpr    = window.devicePixelRatio || 1;
  const cssW   = c.clientWidth  || c.width;
  const cssH   = c.clientHeight || c.height;
  const size   = Math.min(cssW, cssH);

  /* Só redimensiona se necessário */
  if (c.width !== size * dpr || c.height !== size * dpr) {
    c.width  = size * dpr;
    c.height = size * dpr;
    ctx.scale(dpr, dpr);
  }

  const W  = size, H = size;
  const cx = W / 2, cy = H / 2;
  const R  = Math.min(W, H) / 2 - 8;

  ctx.clearRect(0, 0, W * dpr, H * dpr);

  /* Fundo */
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0f1e'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1; ctx.stroke();

  /* Graduações e labels */
  const DIRS = ['N','NE','L','SE','S','SO','O','NO'];
  for (let i = 0; i < 8; i++) {
    const a  = (i * 45 - 90) * Math.PI / 180;
    const r1 = R - 3, r2 = i % 2 === 0 ? R - 13 : R - 8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
    ctx.lineWidth = i % 2 === 0 ? 1 : 0.5;
    ctx.stroke();

    if (i % 2 === 0) {
      const lr = R - 24;
      ctx.fillStyle = i === 0 ? '#E24B4A' : 'rgba(255,255,255,0.28)';
      ctx.font = (i === 0 ? '500 ' : '') + '9px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(DIRS[i], cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
    }
  }

  /* Estado sem dados */
  if (!ALIGN.hasData) {
    ctx.fillStyle = 'rgba(55,65,81,0.4)';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Aguardando sensores', cx, cy);
    ctx.textBaseline = 'alphabetic';
    return;
  }

  /* Seta norte magnético (âmbar) */
  drawArrow(ctx, cx, cy, ALIGN.heading, R * 0.72, '#EF9F27', '#374151');

  /* Norte verdadeiro (verde) */
  const nt = getNorthTrue();
  if (nt !== null) {
    /* Linha tracejada */
    const ta = (nt - 90) * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(ta);
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, -R * 0.65); ctx.lineTo(0, R * 0.65);
    ctx.strokeStyle = 'rgba(29,158,117,0.2)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    drawArrow(ctx, cx, cy, nt, R * 0.82, '#1D9E75', null);

    /* Ponto do polo celeste */
    const pax = cx + Math.cos(ta) * R * 0.48;
    const pay = cy + Math.sin(ta) * R * 0.48;
    ctx.beginPath(); ctx.arc(pax, pay, 5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.beginPath(); ctx.arc(pax, pay, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fill();
  }

  /* Centro */
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();

  /* Legenda */
  const fSz = Math.max(8, Math.min(10, W / 22));
  ctx.font = `${fSz}px system-ui`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#EF9F27';
  ctx.fillText(`▲ N mag ${Math.round(ALIGN.heading)}°`, 5, H - 18);
  if (nt !== null) {
    ctx.fillStyle = '#1D9E75';
    ctx.fillText(`▲ N real ${Math.round(nt)}°`, 5, H - 5);
    const azErr = getAzError();
    if (azErr !== null) {
      ctx.textAlign = 'right';
      ctx.fillStyle = feedbackColor(Math.abs(azErr), 1.0, 5.0);
      ctx.fillText(`Δ ${azErr > 0 ? '+' : ''}${azErr.toFixed(1)}°`, W - 5, H - 5);
    }
  }
}

function drawArrow(ctx, cx, cy, headingDeg, len, colorHead, colorTail) {
  const a = (headingDeg - 90) * Math.PI / 180;
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(0, -len);
  ctx.lineTo(6, -len + 18); ctx.lineTo(0, -len + 13); ctx.lineTo(-6, -len + 18);
  ctx.closePath();
  ctx.fillStyle = colorHead; ctx.fill();
  if (colorTail) {
    ctx.beginPath();
    ctx.moveTo(0, len);
    ctx.lineTo(5, len - 14); ctx.lineTo(0, len - 9); ctx.lineTo(-5, len - 14);
    ctx.closePath();
    ctx.fillStyle = colorTail; ctx.fill();
  }
  ctx.restore();
}

/* ══════════════════════════════════════════════
   FUNÇÃO PÚBLICA — render quando muda de aba
   ══════════════════════════════════════════════ */

function renderAlign() {
  updateAlignTexts();
  updateSensorBanner(ALIGN.hasData);
  ALIGN._dirty = true;
  scheduleAlignRender();
}

/* ══════════════════════════════════════════════
   UTILITÁRIOS
   ══════════════════════════════════════════════ */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function setText(id, t) {
  const e = document.getElementById(id);
  if (e && e.textContent !== t) e.textContent = t;
}

function colorEl(id, color) {
  const e = document.getElementById(id);
  if (e) e.style.color = color;
}
