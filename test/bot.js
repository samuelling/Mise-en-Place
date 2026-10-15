// Headless smoke test: a greedy bot cooks through all three shifts, then the
// session log goes through every model fit. Run: node test/bot.js [seed]
const Kitchen = require('../js/kitchen.js');
const M = require('../js/models.js');

function bfs(k, sx, sy, goals) {
  const key = (x, y) => y * Kitchen.W + x;
  const prev = new Map([[key(sx, sy), null]]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    if (goals.some(([gx, gy]) => gx === x && gy === y)) {
      const path = []; let c = [x, y];
      while (c) { path.unshift(c); c = prev.get(key(c[0], c[1])); }
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (k.solid(nx, ny) || prev.has(key(nx, ny))) continue;
      prev.set(key(nx, ny), [x, y]); q.push([nx, ny]);
    }
  }
  return null;
}

class Bot {
  constructor(k, rng) { this.k = k; this.rng = rng; this.goal = null; this.think = 0; }
  stands(tx, ty) {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [tx + dx, ty + dy]).filter(([x, y]) => !this.k.solid(x, y));
  }
  find(pred) {
    const out = [];
    this.k.tiles.forEach((row, y) => row.forEach((t, x) => { if (pred(t, x, y)) out.push([x, y]); }));
    return out;
  }
  choose() {
    const k = this.k, h = k.player.held, act = k.stoves.filter((s) => s.active);
    const S = (st) => act.filter((s) => st.includes(s.pot.state));
    if (h && h.kind === 'plate' && h.soup) {
      const ok = k.orders.some((o) => o.type === h.soup);
      return ok ? { t: this.find((t) => t.ch === 'W')[0], op: 'grab' } : { t: this.find((t) => t.ch === 'X')[0], op: 'grab' };
    }
    if (h && h.kind === 'plate') {
      const done = S(['done']).sort((a, b) => b.pot.t - a.pot.t)[0];
      if (done) return { t: [done.x, done.y], op: 'grab' };
      const ck = S(['cooking']).sort((a, b) => b.pot.t - a.pot.t)[0];
      if (ck) return { t: [ck.x, ck.y], op: 'wait' };
      return { t: this.find((t) => t.ch === '#' && !t.item && !t.stove)[0], op: 'grab' };
    }
    if (h && h.kind === 'ing' && h.chopped) {
      const st = S(['filling']).find((s) => s.pot.contents[0] === h.type) || S(['empty', 'filling'])[0];
      if (st) return { t: [st.x, st.y], op: 'grab' };
      return { t: this.find((t) => t.ch === 'X')[0], op: 'grab' };
    }
    if (h && h.kind === 'ing') {
      const b = this.find((t) => t.ch === 'B' && !t.item)[0];
      return b ? { t: b, op: 'grab' } : { t: this.find((t) => t.ch === 'X')[0], op: 'grab' };
    }
    const burnt = S(['burnt'])[0];
    if (burnt) return { t: [burnt.x, burnt.y], op: 'grab' };
    if (S(['done']).length || (S(['cooking']).some((s) => s.pot.t > 5))) return { t: this.find((t) => t.ch === 'P')[0], op: 'grab' };
    const raw = this.find((t) => t.ch === 'B' && t.item && !t.item.chopped)[0];
    if (raw) return { t: raw, op: 'chop' };
    const ch = this.find((t) => t.ch === 'B' && t.item && t.item.chopped)[0];
    if (ch) return { t: ch, op: 'grab' };
    const fill = S(['filling'])[0] || S(['empty'])[0];
    if (fill) {
      let type = fill.pot.contents[0];
      if (!type) {
        const covered = act.map((s) => s.pot.recipe || s.pot.contents[0]).filter(Boolean);
        const o = k.orders.slice().sort((a, b) => a.deadline - b.deadline).find((o) => !covered.includes(o.type));
        type = o ? o.type : Kitchen.SOUPS[Math.floor(this.rng() * 3)];
      }
      const letter = Object.keys(Kitchen.CRATE).find((c) => Kitchen.CRATE[c] === type);
      return { t: this.find((t) => t.ch === letter)[0], op: 'grab' };
    }
    return null;
  }
  input(dt) {
    const k = this.k, p = k.player;
    if (this.think > 0) { this.think -= dt; return {}; }
    if (!this.goal) {
      this.goal = this.choose();
      if (!this.goal) return {};
      this.think = 0.15 + this.rng() * 0.35; // decision time
      const [tx, ty] = this.goal.t;
      this.path = bfs(k, Math.floor(p.x), Math.floor(p.y), this.stands(tx, ty));
      if (!this.path) { this.goal = null; return {}; }
      return {};
    }
    const [tx, ty] = this.goal.t;
    if (this.path.length) {
      const [cx, cy] = this.path[0];
      const dx = cx + 0.5 - p.x, dy = cy + 0.5 - p.y;
      if (Math.hypot(dx, dy) < 0.12) { this.path.shift(); return {}; }
      const m = Math.hypot(dx, dy); return { mx: dx / m, my: dy / m };
    }
    const fx = tx + 0.5 - p.x, fy = ty + 0.5 - p.y;
    const tg = k.target;
    if (!tg || tg.x !== tx || tg.y !== ty) return { mx: Math.abs(fx) > Math.abs(fy) ? Math.sign(fx) : 0, my: Math.abs(fx) > Math.abs(fy) ? 0 : Math.sign(fy) };
    if (this.goal.op === 'wait') {
      const st = k.tiles[ty][tx].stove;
      if (st && st.pot.state === 'done') { this.goal = null; return { grab: true }; }
      if (!st || st.pot.state !== 'cooking') this.goal = null;
      return {};
    }
    if (this.goal.op === 'chop') {
      const it = k.tiles[ty][tx].item;
      if (!it || it.chopped) { this.goal = null; return {}; }
      return { chop: true };
    }
    this.goal = null;
    return { grab: true };
  }
}

module.exports = { Bot };
if (require.main === module) {
const seed = +process.argv[2] || 42;
const k = new Kitchen({ seed });
const bot = new Bot(k, M.mulberry32(seed + 1));
const dt = 1 / 30;
k.startShift();
let frames = 0;
while (k.phase !== 'done') {
  if (k.phase === 'break') k.startShift();
  k.step(dt, bot.input(dt));
  k.drainEvents();
  if (++frames > 30 * 60 * 20) throw new Error('runaway');
}
const log = k.exportLog();
console.log('score', log.score, JSON.stringify(log.shiftSummaries));
console.log('threads', log.threads.length, 'success', log.threads.filter((t) => t.success).length,
  '| actions', log.actions.length, 'with stream', log.actions.filter((a) => a.stream !== null).length,
  '| decisions', log.decisions.length, '| ready events', log.doneEvents.length);
const r = M.analyze(log, { bootstrap: 20 });
const c = r.capacity;
console.log('capacity n', c.n, 'K', c.slot && c.slot.K.toFixed(2), 'ΔBIC', c.deltaBIC && c.deltaBIC.toFixed(2), 'range', c.loadRange);
console.log('bins', JSON.stringify(c.bins.map((b) => [b.N, b.n, +b.p.toFixed(2)])));
const a = r.attention;
console.log('attention n', a.n, a.normalized ? JSON.stringify({ w: a.normalized.omega.toFixed(2), s: a.normalized.sigma.toFixed(2), dN: a.deltaBIC_norm.toFixed(2), dF: a.deltaBIC_field.toFixed(2) }) : '');
const s = r.switching;
console.log('switch', s.nRepeat, s.nSwitch, s.cost !== undefined ? s.cost.toFixed(3) : '-');
const q = r.prp;
console.log('prp n', q.n, q.bottleneck ? q.bottleneck.B.toFixed(2) + ' ΔBIC ' + q.deltaBIC.toFixed(2) : '');
require('fs').writeFileSync(__dirname + '/bot-session.json', JSON.stringify(log));
}
