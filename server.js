'use strict';

/**
 * AstroControl — server.js (modular)
 */

const express = require('express');
const http    = require('http');

const CFG            = require('./config/config');
const routes         = require('./api/routes');
const setupWebSocket = require('./core/websocket');

/* ══════════════════════════════════════════════
   EXPRESS
   ══════════════════════════════════════════════ */

const app = express();

app.use(express.json());
app.use(express.static(CFG.PUBLIC_DIR));

/* Rotas REST + SPA fallback */
app.use('/', routes);

/* ══════════════════════════════════════════════
   HTTP SERVER
   ══════════════════════════════════════════════ */

const server = http.createServer(app);

/* ══════════════════════════════════════════════
   WEBSOCKET
   ══════════════════════════════════════════════ */

setupWebSocket(server);

/* ══════════════════════════════════════════════
   START
   ══════════════════════════════════════════════ */

server.listen(CFG.PORT, '0.0.0.0', () => {
  console.log(`[AstroControl] http://0.0.0.0:${CFG.PORT}`);
  console.log(`[AstroControl] → http://astropi.local:${CFG.PORT}`);
});

/* ══════════════════════════════════════════════
   ERROS GLOBAIS
   ══════════════════════════════════════════════ */

process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e.message);
});

process.on('unhandledRejection', (r) => {
  console.error('[rejection]', r);
});