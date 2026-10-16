'use strict';
/*
 * Сервер онлайн-режима «Шахмат и сапёр».
 * Транспорт: Server-Sent Events (сервер → клиент, поток событий) + обычные POST-запросы (клиент → сервер, команды).
 * Без внешних зависимостей: достаточно Node.js 18+.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Rooms, RoomError } = require('./rooms');

const PUBLIC_DIR = __dirname;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/server-config.js': ['server-config.js', 'application/javascript; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
};
const MAX_BODY = 4096;
const KEEPALIVE_MS = 20000;

/* ---------- ограничение частоты запросов ---------- */
function makeLimiter(limit, windowMs) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();
  return (key) => {
    const now = Date.now();
    let v = hits.get(key);
    if (!v || now - v.t > windowMs) { v = { t: now, n: 0 }; hits.set(key, v); }
    v.n += 1;
    return v.n <= limit;
  };
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function createServer(options = {}) {
  const rooms = new Rooms(options.rooms);
  const limitCreate = makeLimiter(options.createPerMin || 12, 60000);
  const limitJoin = makeLimiter(options.joinPerMin || 30, 60000);
  const limitAct = makeLimiter(options.actPerMin || 240, 60000);
  const limitStream = makeLimiter(options.streamPerMin || 60, 60000);

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    }, CORS));
    res.end(body);
  }
  const err = (res, status, code, message) => json(res, status, { ok: false, error: code, message });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new RoomError('too_big', 'Слишком большой запрос.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch (e) { reject(new RoomError('bad_json', 'Некорректный запрос.')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, entry) {
    const [file, type] = entry;
    fs.readFile(path.join(PUBLIC_DIR, file), (e, data) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  }

  /* ---------- SSE ---------- */
  function openStream(req, res, url) {
    const ip = clientIp(req);
    if (!limitStream(ip)) return err(res, 429, 'rate', 'Слишком много подключений, подожди минуту.');
    let a;
    try { a = rooms.auth(url.searchParams.get('code'), url.searchParams.get('token')); }
    catch (e) { if (e instanceof RoomError) return err(res, e.code === 'not_found' ? 404 : 403, e.code, e.message); throw e; }
    const { room, color } = a;
    res.writeHead(200, Object.assign({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }, CORS));
    if (req.socket.setNoDelay) req.socket.setNoDelay(true);
    if (req.socket.setTimeout) req.socket.setTimeout(0);
    res.write('retry: 2000\n\n');
    let closed = false;
    const stream = {
      send(event, data) { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
      close() { if (!closed) { closed = true; clearInterval(ka); res.end(); } },
    };
    const ka = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, KEEPALIVE_MS);
    req.on('close', () => {
      if (closed) return;
      closed = true; clearInterval(ka);
      rooms.detach(room, color, stream);
    });
    rooms.attach(room, color, stream);
  }

  /* ---------- API ---------- */
  async function api(req, res, url) {
    const route = url.pathname;
    const ip = clientIp(req);
    const b = await readBody(req);
    if (route === '/api/create') {
      if (!limitCreate(ip)) return err(res, 429, 'rate', 'Слишком много попыток, подожди минуту.');
      const r = rooms.create({ mines: b.mines, minutes: b.minutes, side: b.side });
      console.log(`[room ${r.room.code}] создана (мин ${b.mines}, ${b.minutes} мин)`);
      return json(res, 200, { ok: true, code: r.room.code, token: r.token, color: r.color });
    }
    if (route === '/api/join') {
      if (!limitJoin(ip)) return err(res, 429, 'rate', 'Слишком много попыток, подожди минуту.');
      const r = rooms.join(b.code);
      console.log(`[room ${r.room.code}] второй игрок вошёл, партия началась`);
      return json(res, 200, { ok: true, code: r.room.code, token: r.token, color: r.color });
    }
    // остальные команды требуют код и токен
    if (!limitAct(String(b.token || ip))) return err(res, 429, 'rate', 'Слишком много запросов.');
    const { room, color } = rooms.auth(b.code, b.token);
    switch (route) {
      case '/api/move': {
        const ply = Number(b.ply);
        if (!Number.isInteger(ply)) return err(res, 400, 'bad_move', 'Некорректный ход.');
        const r = rooms.move(room, color, ply, b.move);
        return json(res, 200, { ok: true, duplicate: r.duplicate, state: rooms.snapshot(room, color) });
      }
      case '/api/resign':
        rooms.resign(room, color);
        return json(res, 200, { ok: true, state: rooms.snapshot(room, color) });
      case '/api/leave':
        rooms.leave(room, color);
        return json(res, 200, { ok: true });
      case '/api/reaction':
        rooms.reaction(room, color, b.emoji);
        return json(res, 200, { ok: true });
      case '/api/ping':
        return json(res, 200, { ok: true, status: room.status, v: room.v });
      default:
        return err(res, 404, 'not_found', 'Неизвестный запрос.');
    }
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); res.end(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      try { openStream(req, res, url); } catch (e) { console.error('stream error', e); if (!res.headersSent) err(res, 500, 'server', 'Ошибка сервера.'); }
      return;
    }
    if (req.method === 'GET' && STATIC[url.pathname]) return serveStatic(req, res, STATIC[url.pathname]);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e) => {
        if (e instanceof RoomError) {
          const st = { not_found: 404, forbidden: 403, rate: 429, busy: 503, too_big: 413 }[e.code] || 400;
          if (!res.headersSent) err(res, st, e.code, e.message);
        } else {
          console.error('api error', e);
          if (!res.headersSent) err(res, 500, 'server', 'Ошибка сервера.');
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.rooms = rooms;
  const origClose = server.close.bind(server);
  server.close = (cb) => { rooms.close(); if (server.closeAllConnections) server.closeAllConnections(); return origClose(cb); };
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => console.log(`Шахмат и сапёр: сервер запущен на порту ${port}`));
  process.on('uncaughtException', (e) => console.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
  const stop = () => { console.log('Останавливаюсь…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
