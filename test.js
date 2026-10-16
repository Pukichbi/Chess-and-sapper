'use strict';
/* Запуск: node test/e2e.js  — поднимает настоящий сервер и играет двумя независимыми клиентами по HTTP/SSE. */
const http = require('http');
const { createServer } = require('./server');
const E = require('./engine');

let pass = 0, failN = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { failN++; console.log('  ✗', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let BASE;
async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

// минимальный клиент SSE (как EventSource в браузере)
function openSse(code, token) {
  const c = { states: [], reactions: [], last: null, closed: false, status: 0 };
  c.ready = new Promise((resolve) => {
    const req = http.get(`${BASE}/api/stream?code=${code}&token=${token}`, (res) => {
      c.status = res.statusCode;
      if (res.statusCode !== 200) { res.resume(); c.closed = true; resolve(); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          const obj = JSON.parse(data);
          if (ev === 'state') { c.states.push(obj); c.last = obj; } else if (ev === 'reaction') c.reactions.push(obj);
        }
        resolve();
      });
      res.on('close', () => { c.closed = true; });
    });
    req.on('error', () => { c.closed = true; resolve(); });
    c.req = req;
  });
  c.close = () => { c.req.destroy(); };
  return c;
}
async function waitFor(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return true; await sleep(15); }
  return false;
}

function legalFromState(st) {
  const g = st.g;
  const board = g.board.map((r) => r.map((p) => (p ? { t: p.t, c: p.c, m: p.m } : null)));
  return E.legal(board, g.turn, g.ep);
}

async function newGame(opts = {}) {
  const cr = await post('/api/create', { mines: opts.mines || 15, minutes: opts.minutes || 15, side: opts.side || 'w' });
  const A = { code: cr.body.code, token: cr.body.token, color: cr.body.color };
  const sa = openSse(A.code, A.token);
  await sa.ready;
  const jr = await post('/api/join', { code: A.code });
  const B = { code: jr.body.code, token: jr.body.token, color: jr.body.color };
  const sb = openSse(B.code, B.token);
  await sb.ready;
  await waitFor(() => sa.last && sa.last.status === 'playing' && sb.last && sb.last.status === 'playing');
  return { A, B, sa, sb, cr, jr };
}

async function main() {
  const server = createServer({ rooms: { abandonMs: 500 }, createPerMin: 1000, joinPerMin: 1000, actPerMin: 100000, streamPerMin: 1000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log('Сервер на', BASE);

  /* ---- 1. создание и подключение ---- */
  console.log('\n1. Создание комнаты и подключение второго игрока');
  {
    const cr = await post('/api/create', { mines: 15, minutes: 15, side: 'w' });
    ok(cr.body.ok && /^[A-HJ-NP-Z2-9]{5}$/.test(cr.body.code), 'код из 5 знаков без похожих символов', cr.body.code);
    ok(cr.body.color === 'w', 'создатель получил выбранную сторону');
    const sa = openSse(cr.body.code, cr.body.token); await sa.ready;
    ok(sa.last && sa.last.status === 'waiting' && sa.last.oppJoined === false, 'создатель видит «ждём соперника»');
    const jr = await post('/api/join', { code: cr.body.code.toLowerCase() });
    ok(jr.body.ok && jr.body.color === 'b', 'второй игрок входит по коду (регистр не важен) и получает другую сторону');
    const sb = openSse(jr.body.code, jr.body.token); await sb.ready;
    ok(await waitFor(() => sa.last.status === 'playing'), 'у создателя партия стартует автоматически');
    ok(sb.last.status === 'playing' && sb.last.g.turn === 'w', 'у второго игрока партия идёт, ход белых');
    const j3 = await post('/api/join', { code: cr.body.code });
    ok(!j3.body.ok && j3.body.error === 'full', 'третий игрок не может войти');
    const j4 = await post('/api/join', { code: 'ZZZZZ' });
    ok(!j4.body.ok && j4.status === 404, 'несуществующий код → ошибка 404');
    const bad = await post('/api/create', { mines: 99, minutes: 15, side: 'w' });
    ok(!bad.body.ok, 'недопустимое число мин отклонено');
    const bad2 = await post('/api/create', { mines: 10, minutes: 7, side: 'w' });
    ok(!bad2.body.ok, 'недопустимое время отклонено');
    const rnd = new Set();
    for (let i = 0; i < 20; i++) { const r = await post('/api/create', { mines: 10, minutes: 5, side: 'r' }); rnd.add(r.body.color); }
    ok(rnd.has('w') && rnd.has('b'), 'сторона «случайно» даёт обе стороны');
    sa.close(); sb.close();
  }

  /* ---- 2. безопасность и очерёдность ---- */
  console.log('\n2. Очерёдность, запреты, защита от дублей');
  {
    const { A, B, sa, sb } = await newGame({ side: 'b' }); // создатель играет чёрными
    ok(A.color === 'b' && B.color === 'w', 'создатель выбрал чёрных → второй получил белых');
    const e2e4 = { fr: 6, fc: 4, tr: 4, tc: 4 };
    let r = await post('/api/move', { code: A.code, token: A.token, ply: 0, move: { fr: 1, fc: 4, tr: 3, tc: 4 } });
    ok(!r.body.ok && r.body.error === 'not_your_turn', 'чёрные не могут ходить первыми');
    r = await post('/api/move', { code: B.code, token: A.token + 'x', ply: 0, move: e2e4 });
    ok(r.status === 403, 'чужой/неверный токен отклонён');
    r = await post('/api/move', { code: B.code, token: B.token, ply: 0, move: { fr: 6, fc: 4, tr: 2, tc: 4 } });
    ok(!r.body.ok && r.body.error === 'illegal', 'недопустимый ход (e2→e6) отклонён');
    r = await post('/api/move', { code: B.code, token: B.token, ply: 0, move: { fr: 9, fc: 4, tr: 4, tc: 4 } });
    ok(!r.body.ok, 'координаты вне доски отклонены');
    r = await post('/api/move', { code: B.code, token: B.token, ply: 5, move: e2e4 });
    ok(!r.body.ok && r.body.error === 'stale', 'неверный номер хода отклонён (stale)');
    r = await post('/api/move', { code: B.code, token: B.token, ply: 0, move: e2e4 });
    ok(r.body.ok && r.body.state.ply === 1, 'e2–e4 принят');
    ok(await waitFor(() => sa.last.ply === 1 && sb.last.ply === 1), 'оба клиента получили новую позицию');
    ok(sa.last.g.turn === 'b' && sb.last.g.turn === 'b', 'очередь перешла к чёрным у обоих');
    r = await post('/api/move', { code: B.code, token: B.token, ply: 0, move: e2e4 });
    ok(r.body.ok && r.body.duplicate === true && r.body.state.ply === 1, 'повторная отправка того же хода не делает второй ход');
    r = await post('/api/move', { code: B.code, token: B.token, ply: 1, move: { fr: 7, fc: 1, tr: 5, tc: 2 } });
    ok(!r.body.ok && r.body.error === 'not_your_turn', 'белые не могут ходить дважды подряд');

    // утечка информации о минах
    const gA = sa.last.g;
    let leak = false;
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) if (!gA.revealed[rr][cc] && gA.num[rr][cc] !== 0) leak = true;
    ok(gA.mine === null && !leak, 'клиент не получает расположение мин и цифры закрытых клеток');
    ok(gA.placed && gA.revealed.flat().filter(Boolean).length >= 3, 'после первого хода открыта безопасная зона');
    ok(!JSON.stringify(sa.last).includes('"mine":[['), 'в сообщении нет массива мин');

    // реакции
    await post('/api/reaction', { code: A.code, token: A.token, emoji: '😎' });
    ok(await waitFor(() => sb.reactions.length === 1 && sb.reactions[0].emoji === '😎'), 'реакция доходит до соперника');
    const rr2 = await post('/api/reaction', { code: A.code, token: A.token, emoji: '<script>' });
    ok(!rr2.body.ok, 'посторонняя «реакция» отклонена');
    sa.close(); sb.close();
  }

  /* ---- 3. полная партия случайными ходами ---- */
  console.log('\n3. Полная партия до конца (два клиента, случайные допустимые ходы)');
  {
    let finished = 0, booms = 0, plies = 0, mates = 0;
    for (let game = 0; game < 6; game++) {
      const { A, B, sa, sb } = await newGame({ mines: [10, 15, 20][game % 3] });
      const P = { w: A.color === 'w' ? A : B, b: A.color === 'b' ? A : B };
      let guard = 0, desync = false;
      while (sa.last.status === 'playing' && guard++ < 2000) {
        const st = sa.last, turn = st.g.turn, who = P[turn];
        const moves = legalFromState(st);
        if (!moves.length) break;
        // предпочитаем взятия/случайные
        const m = moves[Math.floor(Math.random() * moves.length)];
        const mv = { fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc };
        if (m.promo) mv.promo = 'q';
        const r = await post('/api/move', { code: who.code, token: who.token, ply: st.ply, move: mv });
        if (!r.body.ok) { console.log('   отказ', r.body, mv); break; }
        await waitFor(() => sa.last.v >= r.body.state.v && sb.last.v >= r.body.state.v);
        if (JSON.stringify(sa.last.g.board) !== JSON.stringify(sb.last.g.board)) desync = true;
        if (sa.last.fx && sa.last.fx.boom) booms++;
      }
      plies += sa.last.ply;
      if (sa.last.status === 'over') {
        finished++;
        if (/мат/.test(sa.last.g.over.reason)) mates++;
        ok(sa.last.g.mine && sb.last.g.mine, `партия ${game + 1}: завершена (${sa.last.g.over.reason}), мины раскрыты`);
      } else ok(false, `партия ${game + 1}: не завершилась за 2000 ходов (ply=${sa.last.ply}, status=${sa.last.status})`);
      ok(!desync, `партия ${game + 1}: доски у клиентов совпадали на каждом ходу`);
      sa.close(); sb.close();
    }
    console.log(`   итого: завершено ${finished}/6, ходов ${plies}, взрывов ${booms}, матов ${mates}`);
  }

  /* ---- 4. разрыв и повторное подключение ---- */
  console.log('\n4. Отключение и повторное подключение');
  {
    const { A, B, sa, sb } = await newGame();
    const W = A.color === 'w' ? A : B;
    await post('/api/move', { code: W.code, token: W.token, ply: 0, move: { fr: 6, fc: 4, tr: 4, tc: 4 } });
    await waitFor(() => sa.last.ply === 1 && sb.last.ply === 1);
    sb.close();
    ok(await waitFor(() => sa.last.oppConnected === false), 'соперник видит, что игрок отключился');
    ok(sa.last.oppAbandonIn > 0, 'сообщается оставшееся время ожидания');
    const sb2 = openSse(B.code, B.token); await sb2.ready;
    ok(sb2.last && sb2.last.ply === 1 && sb2.last.status === 'playing', 'после возвращения игрок получает актуальную позицию');
    ok(await waitFor(() => sa.last.oppConnected === true), 'соперник видит, что игрок вернулся');
    await sleep(700);
    ok(sa.last.status === 'playing', 'возвращение до истечения ожидания не завершает партию');
    sa.close(); sb2.close();
  }
  {
    const { A, B, sa, sb } = await newGame();
    sb.close();
    ok(await waitFor(() => sa.last.status === 'over', 3000), 'если игрок не вернулся — партия завершается');
    ok(sa.last.g.over.winner === A.color && /покинули/.test(sa.last.g.over.reason), 'победа оставшемуся игроку', sa.last.g.over);
    const again = openSse(B.code, B.token); await again.ready;
    ok(again.last && again.last.status === 'over', 'ушедший при возвращении видит итог партии');
    sa.close(); again.close();
  }

  /* ---- 5. часы ---- */
  console.log('\n5. Часы и время');
  {
    const { A, B, sa, sb } = await newGame({ minutes: 5 });
    ok(sa.last.g.clock.w === 300000 && sa.last.g.clock.b === 300000, 'у каждого 5 минут');
    const room = server.rooms.rooms.get(A.code);
    const W = A.color === 'w' ? A : B;
    await post('/api/move', { code: W.code, token: W.token, ply: 0, move: { fr: 6, fc: 4, tr: 4, tc: 4 } });
    await waitFor(() => sa.last.ply === 1);
    ok(sa.last.g.clock.w <= 300000 && sa.last.g.clock.w > 299000, 'часы белых зафиксированы после хода');
    room.G.clock.b = 250; room.G.turnAt = Date.now(); server.rooms._schedule(room);
    ok(await waitFor(() => sa.last.status === 'over' && sb.last.status === 'over', 2000), 'время чёрных истекло → партия завершена сервером');
    ok(sa.last.g.over.winner === 'w' && /время чёрных/.test(sa.last.g.over.reason), 'победа белых по времени', sa.last.g.over);
    const Bk = A.color === 'b' ? A : B;
    const r = await post('/api/move', { code: Bk.code, token: Bk.token, ply: 1, move: { fr: 1, fc: 4, tr: 3, tc: 4 } });
    ok(!r.body.ok, 'после окончания партии ходы не принимаются');
    sa.close(); sb.close();
  }

  /* ---- 6. сдача, выход ---- */
  console.log('\n6. Сдача и выход');
  {
    const { A, B, sa, sb } = await newGame();
    const r = await post('/api/resign', { code: B.code, token: B.token });
    ok(r.body.ok && r.body.state.status === 'over', 'сдача завершает партию');
    ok(await waitFor(() => sa.last.status === 'over'), 'соперник сразу видит результат');
    ok(sa.last.g.over.winner === A.color && /сдались/.test(sa.last.g.over.reason), 'победа сопернику', sa.last.g.over);
    sa.close(); sb.close();
  }
  {
    const cr = await post('/api/create', { mines: 10, minutes: 5, side: 'w' });
    const l = await post('/api/leave', { code: cr.body.code, token: cr.body.token });
    ok(l.body.ok, 'создатель отменил комнату до подключения соперника');
    const j = await post('/api/join', { code: cr.body.code });
    ok(!j.body.ok && j.status === 404, 'отменённая комната недоступна');
  }
  {
    const { A, B, sa, sb } = await newGame();
    await post('/api/leave', { code: B.code, token: B.token });
    ok(await waitFor(() => sa.last.status === 'over'), 'выход из идущей партии = поражение выходящего');
    sa.close(); sb.close();
  }

  /* ---- 7. защита сервера ---- */
  console.log('\n7. Защита от злоупотреблений');
  {
    const big = await fetch(BASE + '/api/create', { method: 'POST', body: 'x'.repeat(10000) }).then((r) => r.status).catch(() => 0);
    ok(big === 413 || big === 0, 'слишком большое тело запроса отклоняется', big);
    const junk = await fetch(BASE + '/api/create', { method: 'POST', body: '{not json' }).then((r) => r.status);
    ok(junk === 400, 'некорректный JSON → 400', junk);
    const nf = await fetch(BASE + '/api/nothing', { method: 'POST', body: '{}' }).then((r) => r.status);
    ok(nf === 404 || nf === 403, 'неизвестный маршрут не падает', nf);
    const h = await fetch(BASE + '/healthz').then((r) => r.text());
    ok(h === 'ok', '/healthz отвечает');
    const idx = await fetch(BASE + '/').then((r) => r.status);
    ok(idx === 200, 'клиент отдаётся по /');
    const path = await fetch(BASE + '/..%2Fserver%2Frooms.js').then((r) => r.status);
    ok(path === 404, 'исходники сервера через веб недоступны', path);
    const o = await fetch(BASE + '/api/create', { method: 'OPTIONS' });
    ok(o.status === 204 && o.headers.get('access-control-allow-origin') === '*', 'CORS preflight для приложения работает');
  }
  {
    const s2 = createServer({ createPerMin: 3 });
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${s2.address().port}`;
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await fetch(base2 + '/api/create', { method: 'POST', body: JSON.stringify({ mines: 10, minutes: 5, side: 'w' }) })).status;
    ok(last === 429, 'частое создание комнат ограничивается (429)', last);
    s2.close();
  }

  server.close();
  console.log(`\nИтого: пройдено ${pass}, провалено ${failN}`);
  process.exit(failN ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
