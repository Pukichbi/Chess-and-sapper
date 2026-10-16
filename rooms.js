'use strict';
/*
 * Комнаты онлайн-партий. Сервер — единственный источник правды:
 *  - хранит полное состояние партии, включая расположение мин;
 *  - клиентам отдаёт только то, что видно игрокам (открытые клетки и их цифры);
 *  - сам проверяет каждый ход по правилам движка, очерёдность, время и номер хода;
 *  - сам ведёт часы и завершает партию по времени, сдаче или уходу игрока.
 * Транспорт (HTTP/SSE) сюда не входит: клиентский «поток» — любой объект с методами send(event,data) и close().
 */
const crypto = require('crypto');
const E = require('./engine');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов: 0/O, 1/I
const CODE_LEN = 5;
const MINES_OK = [10, 15, 20];
const MINUTES_OK = [5, 15, 30, 60];
const PROMO_OK = 'qrbn';
const REACTIONS_OK = ['😃', '😭', '😠', '😮', '😎', '🧐', '👏', '❤️'];

const DEFAULTS = {
  abandonMs: 120000,          // сколько ждём вернувшегося игрока, прежде чем засчитать уход
  waitingTtlMs: 30 * 60000,   // комната без второго игрока живёт столько
  idleTtlMs: 60 * 60000,      // комната без подключений и активности
  overTtlMs: 10 * 60000,      // завершённая партия без подключений
  maxRooms: 500,
};

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RoomError(code, message); };

function randomCode() {
  const b = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
const newToken = () => crypto.randomBytes(24).toString('hex');
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
const isInt = (x) => Number.isInteger(x) && x >= 0 && x <= 7;
const other = (c) => (c === 'w' ? 'b' : 'w');

class Rooms {
  constructor(opts = {}) {
    this.opt = Object.assign({}, DEFAULTS, opts);
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  close() {
    clearInterval(this.sweeper);
    for (const r of this.rooms.values()) this._dispose(r);
    this.rooms.clear();
  }

  normCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* ---------- создание / вход ---------- */
  create({ mines, minutes, side }) {
    mines = Number(mines); minutes = Number(minutes);
    if (!MINES_OK.includes(mines)) fail('bad_settings', 'Недопустимое число мин.');
    if (!MINUTES_OK.includes(minutes)) fail('bad_settings', 'Недопустимое время партии.');
    if (!['w', 'b', 'r'].includes(side)) fail('bad_settings', 'Недопустимая сторона.');
    if (this.rooms.size >= this.opt.maxRooms) fail('busy', 'Сервер занят, попробуй позже.');
    let code;
    do { code = randomCode(); } while (this.rooms.has(code));
    const color = side === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : side;
    const token = newToken();
    const room = {
      code, settings: { mines, minutes }, status: 'waiting', creator: color,
      players: { w: null, b: null }, G: null, ply: 0, v: 1, fx: null,
      lastAction: null, lastReaction: { w: 0, b: 0 },
      createdAt: Date.now(), lastActive: Date.now(), finishedAt: 0, flagTimer: null,
    };
    room.players[color] = this._player(token);
    this.rooms.set(code, room);
    return { room, color, token };
  }

  join(codeRaw) {
    const room = this.rooms.get(this.normCode(codeRaw));
    if (!room) fail('not_found', 'Комната с таким кодом не найдена.');
    if (room.status !== 'waiting') fail('full', 'В этой комнате уже играют двое.');
    const color = other(room.creator);
    const token = newToken();
    room.players[color] = this._player(token);
    this._touch(room);
    this._start(room);
    this._broadcast(room);
    return { room, color, token };
  }

  _player(token) {
    return { token, streams: new Set(), offTimer: null, offSince: 0, left: false };
  }

  /* ---------- авторизация ---------- */
  auth(codeRaw, token) {
    const room = this.rooms.get(this.normCode(codeRaw));
    if (!room) fail('not_found', 'Партия не найдена или уже закрыта.');
    for (const c of ['w', 'b']) {
      const p = room.players[c];
      if (p && !p.left && sameToken(p.token, token)) { this._touch(room); return { room, color: c }; }
    }
    return fail('forbidden', 'Нет доступа к этой партии.');
  }

  _touch(room) { room.lastActive = Date.now(); }

  /* ---------- подключения (потоки) ---------- */
  attach(room, color, stream) {
    const p = room.players[color];
    p.streams.add(stream);
    if (p.offTimer) { clearTimeout(p.offTimer); p.offTimer = null; }
    p.offSince = 0;
    this._touch(room);
    stream.send('state', this.snapshot(room, color));
    // сопернику сообщаем, что игрок вернулся
    if (room.status === 'playing') this._sendTo(room, other(color));
  }

  detach(room, color, stream) {
    const p = room.players[color];
    if (!p) return;
    p.streams.delete(stream);
    if (p.streams.size === 0 && room.status === 'playing' && !p.left && !p.offTimer) {
      p.offSince = Date.now();
      p.offTimer = setTimeout(() => this._abandon(room, color), this.opt.abandonMs);
      this._sendTo(room, other(color));
    }
    this._touch(room);
  }

  _abandon(room, color) {
    const p = room.players[color];
    if (!p) return;
    p.offTimer = null;
    if (room.status !== 'playing' || p.streams.size > 0) return;
    this._endBy(room, color, `${E.sideName(color)} покинули партию`);
    this._broadcast(room);
  }

  /* ---------- ход игрока ---------- */
  move(room, color, ply, m) {
    if (room.status !== 'playing') fail('not_playing', 'Партия не идёт.');
    if (!m || typeof m !== 'object') fail('bad_move', 'Некорректный ход.');
    const key = [m.fr, m.fc, m.tr, m.tc, m.promo || ''].join(',');
    // повторная отправка уже принятого хода — не ошибка и не второй ход
    const la = room.lastAction;
    if (la && la.color === color && la.ply === ply && la.key === key && room.ply === ply + 1) {
      return { duplicate: true };
    }
    if (ply !== room.ply) fail('stale', 'Позиция уже изменилась.');
    const G = room.G;
    if (G.turn !== color) fail('not_your_turn', 'Сейчас не твой ход.');
    if (![m.fr, m.fc, m.tr, m.tc].every(isInt)) fail('bad_move', 'Некорректный ход.');
    if (m.promo !== undefined && !(typeof m.promo === 'string' && m.promo.length === 1 && PROMO_OK.includes(m.promo))) {
      fail('bad_move', 'Некорректное превращение.');
    }
    E.setG(G);
    if (E.remain(color) <= 0) { this._flag(room); this._broadcast(room); fail('time', 'Время истекло.'); }
    E.refreshLegal();
    const mv = G.legal.find((x) => x.fr === m.fr && x.fc === m.fc && x.tr === m.tr && x.tc === m.tc);
    if (!mv) fail('illegal', 'Такой ход недопустим.');
    if (mv.promo && m.promo === undefined) fail('bad_move', 'Нужно выбрать фигуру для превращения.');
    if (!E.applyMove(mv, mv.promo ? m.promo : undefined)) fail('illegal', 'Такой ход недопустим.');
    const f = E.getFx() || {};
    room.ply += 1;
    room.v += 1;
    room.fx = { ply: room.ply, boom: !!f.boom, cap: !!f.cap, check: !!f.check,
      br: f.boom && G.boom ? G.boom.r : -1, bc: f.boom && G.boom ? G.boom.c : -1 };
    room.lastAction = { color, ply, key };
    if (G.over) this._finish(room); else this._schedule(room);
    this._broadcast(room);
    return { duplicate: false };
  }

  resign(room, color) {
    if (room.status !== 'playing') fail('not_playing', 'Партия не идёт.');
    this._endBy(room, color, `${E.sideName(color)} сдались`);
    this._broadcast(room);
  }

  leave(room, color) {
    const p = room.players[color];
    if (room.status === 'waiting') {
      this._dispose(room);
      this.rooms.delete(room.code);
      return;
    }
    if (room.status === 'playing') {
      this._endBy(room, color, `${E.sideName(color)} покинули партию`);
      this._broadcast(room);
    }
    p.left = true;
    for (const s of p.streams) { try { s.close(); } catch (e) { /* ignore */ } }
    p.streams.clear();
  }

  reaction(room, color, emoji) {
    if (!REACTIONS_OK.includes(emoji)) fail('bad_reaction', 'Недопустимая реакция.');
    const now = Date.now();
    if (now - room.lastReaction[color] < 800) return;
    room.lastReaction[color] = now;
    const p = room.players[other(color)];
    if (p) for (const s of p.streams) s.send('reaction', { emoji });
  }

  /* ---------- завершение, часы ---------- */
  _endBy(room, loser, reason) {
    const G = room.G;
    E.setG(G);
    G.clock[G.turn] = Math.max(0, E.remain(G.turn)); G.turnAt = Date.now();
    E.setOver({ winner: other(loser), reason });
    room.v += 1;
    this._finish(room);
  }

  _finish(room) {
    room.status = 'over';
    room.finishedAt = Date.now();
    if (room.flagTimer) { clearTimeout(room.flagTimer); room.flagTimer = null; }
    for (const c of ['w', 'b']) {
      const p = room.players[c];
      if (p && p.offTimer) { clearTimeout(p.offTimer); p.offTimer = null; }
    }
  }

  _schedule(room) {
    if (room.flagTimer) clearTimeout(room.flagTimer);
    room.flagTimer = null;
    if (room.status !== 'playing') return;
    E.setG(room.G);
    const left = E.remain(room.G.turn);
    room.flagTimer = setTimeout(() => { this._flag(room); this._broadcast(room); }, Math.max(20, left + 20));
    if (room.flagTimer.unref) room.flagTimer.unref();
  }

  // Падение флажка: логика та же, что в локальной игре (tick в index.html)
  _flag(room) {
    if (room.status !== 'playing') return;
    const G = room.G;
    E.setG(G);
    if (E.remain(G.turn) > 0) { this._schedule(room); return; }
    const lose = G.turn, win = other(lose);
    G.clock[lose] = 0; G.turnAt = Date.now();
    E.setOver(E.hasMatingMaterial(G.board, win)
      ? { winner: win, reason: `время ${lose === 'w' ? 'белых' : 'чёрных'} истекло` }
      : { draw: true, reason: 'время вышло, но у соперника недостаточно материала для мата' });
    room.v += 1;
    this._finish(room);
  }

  _start(room) {
    const G = E.newState(room.settings.mines, room.settings.minutes);
    G.mode = 'online';
    G.turnAt = Date.now();
    E.refreshLegal();
    room.G = G;
    room.status = 'playing';
    room.ply = 0;
    room.v += 1;
    this._schedule(room);
  }

  /* ---------- что видят клиенты ---------- */
  snapshot(room, color) {
    const opp = room.players[other(color)];
    const oppConnected = !!(opp && opp.streams.size > 0);
    const out = {
      v: room.v, code: room.code, status: room.status, you: color, ply: room.ply,
      settings: room.settings, oppJoined: !!opp, oppConnected,
      oppAbandonIn: (opp && opp.offSince && room.status === 'playing')
        ? Math.max(0, this.opt.abandonMs - (Date.now() - opp.offSince)) : 0,
      fx: room.fx, g: null,
    };
    const G = room.G;
    if (G) {
      const over = !!G.over;
      out.g = {
        board: G.board.map((row) => row.map((p) => (p ? { t: p.t, c: p.c, m: !!p.m } : null))),
        turn: G.turn, N: G.N, placed: G.placed, ep: G.ep, last: G.last,
        revealed: G.revealed.map((r) => r.slice()),
        crater: G.crater.map((r) => r.slice()),
        // цифры отдаём только у открытых клеток; расположение мин — только когда партия окончена
        num: G.num.map((row, r) => row.map((n, c) => (G.revealed[r][c] ? n : 0))),
        mine: over ? G.mine.map((r) => r.slice()) : null,
        clock: { w: G.clock.w, b: G.clock.b },
        elapsed: over ? 0 : Math.max(0, Date.now() - G.turnAt),
        over: G.over, msg: G.msg,
      };
    }
    return out;
  }

  _sendTo(room, color) {
    const p = room.players[color];
    if (!p) return;
    for (const s of p.streams) { try { s.send('state', this.snapshot(room, color)); } catch (e) { /* поток закрыт */ } }
  }

  _broadcast(room) { this._sendTo(room, 'w'); this._sendTo(room, 'b'); }

  /* ---------- уборка ---------- */
  _connected(room) {
    return ['w', 'b'].some((c) => room.players[c] && room.players[c].streams.size > 0);
  }

  _dispose(room) {
    if (room.flagTimer) clearTimeout(room.flagTimer);
    for (const c of ['w', 'b']) {
      const p = room.players[c];
      if (!p) continue;
      if (p.offTimer) clearTimeout(p.offTimer);
      for (const s of p.streams) { try { s.close(); } catch (e) { /* ignore */ } }
      p.streams.clear();
    }
  }

  sweep() {
    const now = Date.now();
    for (const [code, r] of this.rooms) {
      const idle = now - r.lastActive;
      const conn = this._connected(r);
      let drop = false;
      if (r.status === 'waiting') drop = idle > this.opt.waitingTtlMs && !conn;
      else if (r.status === 'over') drop = (!conn && now - r.finishedAt > this.opt.overTtlMs) || now - r.finishedAt > this.opt.idleTtlMs;
      else drop = !conn && idle > this.opt.idleTtlMs;
      if (drop) { this._dispose(r); this.rooms.delete(code); }
    }
  }

  stats() {
    let playing = 0, waiting = 0;
    for (const r of this.rooms.values()) { if (r.status === 'playing') playing++; else if (r.status === 'waiting') waiting++; }
    return { rooms: this.rooms.size, playing, waiting };
  }
}

module.exports = { Rooms, RoomError, REACTIONS_OK, MINES_OK, MINUTES_OK };
