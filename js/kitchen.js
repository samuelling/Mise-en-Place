/* Mise en Place — kitchen simulation core (no DOM).
 *
 * The game is a set of attentional "threads": every soup on the stove and
 * every ticket on the rail has an onset and a deadline. The kitchen logs
 * each thread's outcome and the time-averaged number of threads that were
 * open alongside it, plus every action the chef takes, so models.js can
 * fit capacity, attention-field, switch-cost and bottleneck models.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Kitchen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAP = [
    '#TOM#BB##S##S#',
    '#............#',
    '#............#',
    'X...#S##S#...W',
    '#............#',
    '#............P',
    '##############',
  ];
  const W = MAP[0].length, H = MAP.length;
  const STOVES = [[9, 0], [12, 0], [5, 3], [8, 3]]; // unlock order
  const CRATE = { T: 'tomato', O: 'onion', M: 'mushroom' };
  const SOUPS = ['tomato', 'onion', 'mushroom'];

  const SHIFTS = [
    { name: 'Breakfast', stoves: 2, dur: 140, interval: 19, patience: 62, burn: 10 },
    { name: 'Lunch', stoves: 3, dur: 140, interval: 14, patience: 56, burn: 9 },
    { name: 'Dinner', stoves: 4, dur: 140, interval: 11, patience: 50, burn: 8 },
  ];
  const COOK = 7;       // s to cook once the third ingredient goes in
  const CHOP = 1.0;     // s of chopping per ingredient
  const SPEED = 4.3;    // tiles / s
  const RAD = 0.3;      // chef radius, tiles
  const MAX_TICKETS = 6;
  const URGENCY_TAU = 6; // s; drive of a pot = exp(-timeToBurn / tau)

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Kitchen {
    constructor(opt = {}) {
      this.seed = opt.seed || (Date.now() & 0xffffffff);
      this.rng = mulberry32(this.seed);
      this.shifts = opt.shifts || SHIFTS;
      this.t = 0;
      this.shiftIdx = -1;
      this.phase = 'ready'; // ready | play | break | done
      this.score = 0;
      this.nextId = 1;
      this.adapt = 1;
      this.events = [];
      this.log = {
        version: 1, seed: this.seed, startedAt: new Date().toISOString(),
        threads: [], actions: [], decisions: [], doneEvents: [], demandOnsets: [], shiftSummaries: [],
      };
      this.tiles = MAP.map((row) => row.split('').map((ch) => ({ ch, item: null })));
      this.stoves = STOVES.map(([x, y], i) => ({ i, x, y, active: false, pot: this.emptyPot() }));
      this.stoves.forEach((s) => { this.tiles[s.y][s.x].stove = s; });
      this.orders = [];
      this.active = []; // open threads
      this.player = { x: 6.5, y: 1.6, fx: 0, fy: -1, held: null, chopping: null };
      this.target = null;
      this.lastActionEnd = 0;
      this.firstMove = null;
      this.lastStove = null;
      this.snap = null;
      this.stats = null;
    }

    static get MAP() { return MAP; }
    static get W() { return W; }
    static get H() { return H; }
    static get SHIFTS() { return SHIFTS; }
    static get COOK() { return COOK; }
    static get CHOP() { return CHOP; }
    static get SOUPS() { return SOUPS; }
    static get CRATE() { return CRATE; }

    emptyPot() { return { contents: [], state: 'empty', t: 0, thread: null, recipe: null }; }
    get shift() { return this.shifts[this.shiftIdx]; }
    emit(type, data = {}) { this.events.push(Object.assign({ type, t: this.t }, data)); }
    drainEvents() { const e = this.events; this.events = []; return e; }

    // ------------------------------------------------------------ shifts
    startShift() {
      this.shiftIdx++;
      if (this.shiftIdx >= this.shifts.length) { this.phase = 'done'; return; }
      const sh = this.shift;
      this.phase = 'play';
      this.shiftT = 0;
      this.shiftStartScore = this.score;
      this.stats = { served: 0, expired: 0, burnt: 0, wrong: 0 };
      this.stoves.forEach((s, i) => { s.active = i < sh.stoves; s.pot = this.emptyPot(); });
      this.tiles.forEach((row) => row.forEach((tile) => { tile.item = null; }));
      this.orders = [];
      this.player.x = 6.5; this.player.y = 1.6; this.player.held = null; this.player.chopping = null;
      this.lastActionEnd = this.t; this.firstMove = null; this.lastStove = null;
      this.snap = this.snapshot();
      this.spawnOrder();
      this.nextOrderAt = this.t + 7;
      this.emit('shiftStart', { name: sh.name, idx: this.shiftIdx });
    }

    endShift() {
      // Unresolved threads are censored: the deadline never had a chance to arrive.
      for (const th of this.active) th.censored = true;
      this.active = [];
      if (this.player.chopping) this.stopChop();
      this.log.shiftSummaries.push(Object.assign({ name: this.shift.name, score: this.score - this.shiftStartScore }, this.stats));
      this.phase = this.shiftIdx + 1 >= this.shifts.length ? 'done' : 'break';
      this.emit('shiftEnd', { name: this.shift.name, idx: this.shiftIdx, stats: this.stats });
    }

    // ------------------------------------------------------------ threads
    openThread(type, stove, deadline) {
      const th = {
        id: this.nextId++, type, stove, shift: this.shiftIdx,
        onset: this.t, deadline, end: null, success: null, load: null, loadInt: 0, censored: false,
      };
      this.active.push(th);
      this.log.threads.push(th);
      return th;
    }
    resolveThread(th, success) {
      if (!th || th.end !== null) return;
      th.end = this.t; th.success = success;
      const dur = Math.max(1e-3, th.end - th.onset);
      th.load = th.loadInt / dur;
      this.active = this.active.filter((x) => x !== th);
      this.adapt = Math.min(1.35, Math.max(0.75, this.adapt * (success ? 0.98 : 1.05)));
    }

    // ------------------------------------------------------------ orders
    spawnOrder() {
      if (this.orders.length >= MAX_TICKETS) return;
      // Prefer a soup that is not already over-represented on the rail
      const counts = SOUPS.map((s) => this.orders.filter((o) => o.type === s).length);
      const w = counts.map((c) => 1 / (1 + c * c));
      let u = this.rng() * w.reduce((a, b) => a + b, 0), k = 0;
      for (; k < SOUPS.length - 1; k++) { u -= w[k]; if (u <= 0) break; }
      const o = { id: this.nextId++, type: SOUPS[k], onset: this.t, patience: this.shift.patience };
      o.deadline = this.t + o.patience;
      o.thread = this.openThread('order', null, o.deadline);
      this.orders.push(o);
      this.log.demandOnsets.push({ t: this.t, kind: 'order', shift: this.shiftIdx });
      this.emit('order', { order: o });
    }
    scheduleNextOrder() {
      const sh = this.shift;
      // Rush/lull cycle (period 50 s) so the load sweeps up and down within a shift
      const rush = 0.5 + 0.5 * Math.sin((2 * Math.PI * this.shiftT) / 50 - Math.PI / 2);
      const interval = (sh.interval * this.adapt) / (0.7 + 0.6 * rush);
      this.nextOrderAt = this.t + interval * (0.8 + 0.4 * this.rng());
    }

    // ------------------------------------------------------------ geometry
    solid(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return true;
      return this.tiles[y][x].ch !== '.';
    }
    collides(px, py) {
      for (let ty = Math.floor(py - RAD); ty <= Math.floor(py + RAD); ty++) {
        for (let tx = Math.floor(px - RAD); tx <= Math.floor(px + RAD); tx++) {
          if (!this.solid(tx, ty)) continue;
          const cx = Math.max(tx, Math.min(px, tx + 1)), cy = Math.max(ty, Math.min(py, ty + 1));
          if ((px - cx) ** 2 + (py - cy) ** 2 < RAD * RAD) return true;
        }
      }
      return false;
    }
    computeTarget() {
      const p = this.player;
      const tx = Math.floor(p.x + p.fx * 0.75), ty = Math.floor(p.y + p.fy * 0.75);
      if (this.solid(tx, ty) && tx >= 0 && ty >= 0 && tx < W && ty < H) {
        const tile = this.tiles[ty][tx];
        if (tile.stove && !tile.stove.active) return null;
        return { x: tx, y: ty };
      }
      return null;
    }

    // ------------------------------------------------------------ logging
    snapshot() {
      const p = this.player;
      return {
        t: this.t,
        held: p.held ? (p.held.kind === 'ing' ? (p.held.chopped ? 'chopped' : 'raw')
          : p.held.soup ? 'soup' : 'plate') : 'none',
        lastStove: this.lastStove,
        stoves: this.stoves.filter((s) => s.active).map((s) => ({
          i: s.i, x: s.x, y: s.y, state: s.pot.state, n: s.pot.contents.length,
          ttb: s.pot.state === 'cooking' ? COOK - s.pot.t + this.shift.burn
            : s.pot.state === 'done' ? this.shift.burn - s.pot.t : null,
        })),
        load: this.active.length,
      };
    }

    // Which stove did the chef go to, given what they were carrying and where
    // their attention last was? Candidate drives depend on the held item.
    buildDecision(stoveIdx) {
      const snap = this.snap;
      if (!snap || snap.lastStove === null) return;
      const last = this.stoves[snap.lastStove];
      let cands;
      if (snap.held === 'chopped') {
        cands = snap.stoves.filter((s) => s.state === 'empty' || s.state === 'filling')
          .map((s) => ({ i: s.i, E: (s.n + 1) / 3 }));
      } else if (snap.held === 'plate') {
        cands = snap.stoves.filter((s) => s.state === 'cooking' || s.state === 'done')
          .map((s) => ({ i: s.i, E: Math.exp(-Math.max(0, s.ttb) / URGENCY_TAU) }));
      } else if (snap.held === 'none') {
        cands = snap.stoves.filter((s) => s.state === 'burnt').map((s) => ({ i: s.i, E: 1 }));
      } else return;
      if (cands.length < 2) return;
      cands.forEach((c) => {
        const s = this.stoves[c.i];
        c.d = Math.hypot(s.x - last.x, s.y - last.y);
      });
      const choice = cands.findIndex((c) => c.i === stoveIdx);
      if (choice < 0) return;
      this.log.decisions.push({ t: this.t, shift: this.shiftIdx, held: snap.held, load: snap.load, cands, choice });
    }

    beginAction(kind, tx, ty, itemId, extra = {}) {
      const tile = this.tiles[ty][tx];
      const stove = tile.stove ? tile.stove.i : null;
      const moveT = this.firstMove !== null && this.firstMove <= this.t ? this.firstMove : this.t;
      const a = Object.assign({
        t: this.t, tEnd: this.t, kind, x: tx, y: ty, stove, itemId,
        stream: null, shift: this.shiftIdx, latency: moveT - this.lastActionEnd, moved: this.firstMove !== null,
      }, extra);
      if (stove !== null && kind !== 'blocked') this.buildDecision(stove);
      this.log.actions.push(a);
      return a;
    }
    endAction(a) {
      a.tEnd = this.t;
      this.lastActionEnd = this.t;
      this.firstMove = null;
      if (a.stove !== null) this.lastStove = a.stove;
      this.snap = this.snapshot();
    }
    attribute(itemId, stream) {
      for (const a of this.log.actions) if (a.itemId === itemId && a.stream === null) a.stream = stream;
    }
    act(kind, tx, ty, itemId, extra) { const a = this.beginAction(kind, tx, ty, itemId, extra); this.endAction(a); return a; }

    // ------------------------------------------------------------ interaction
    newItem(props) { return Object.assign({ id: this.nextId++ }, props); }

    grab() {
      const tg = this.target;
      if (!tg) return;
      const p = this.player, tile = this.tiles[tg.y][tg.x], ch = tile.ch, held = p.held;
      const stove = tile.stove;
      const toast = (msg) => this.emit('toast', { msg, x: tg.x, y: tg.y });

      if (!held) {
        if (CRATE[ch]) {
          p.held = this.newItem({ kind: 'ing', type: CRATE[ch], chopped: false, prog: 0 });
          this.act('fetch', tg.x, tg.y, p.held.id);
        } else if (ch === 'P') {
          p.held = this.newItem({ kind: 'plate', soup: null, stream: null });
          this.act('dish', tg.x, tg.y, p.held.id);
        } else if (stove && stove.pot.state === 'burnt') {
          stove.pot = this.emptyPot();
          const a = this.act('scrape', tg.x, tg.y, null);
          a.stream = stove.i;
          this.emit('scrape', { stove: stove.i });
        } else if (stove && stove.pot.state === 'done') {
          toast('Grab a plate');
        } else if (tile.item) {
          p.held = tile.item; tile.item = null;
          this.act('take', tg.x, tg.y, p.held.id);
        }
        return;
      }

      if (held.kind === 'ing') {
        if (stove) {
          const pot = stove.pot;
          if (!held.chopped) return toast('Chop it first');
          if (pot.state !== 'empty' && pot.state !== 'filling') return toast(pot.state === 'burnt' ? 'Scrape the pot' : 'Pot is busy');
          pot.contents.push(held.type);
          pot.state = 'filling';
          p.held = null;
          const a = this.act('cook', tg.x, tg.y, held.id);
          a.stream = stove.i;
          this.attribute(held.id, stove.i);
          if (pot.contents.length === 3) {
            pot.state = 'cooking'; pot.t = 0;
            pot.recipe = pot.contents.every((c) => c === pot.contents[0]) ? pot.contents[0] : 'mush';
            pot.thread = this.openThread('pot', stove.i, this.t + COOK + this.shift.burn);
            this.emit('cookStart', { stove: stove.i });
          }
        } else if (ch === 'X') {
          p.held = null;
          this.act('bin', tg.x, tg.y, held.id);
        } else if ((ch === '#' || ch === 'B') && !tile.item) {
          tile.item = held; p.held = null;
          this.act('place', tg.x, tg.y, held.id);
        }
        return;
      }

      // holding a plate
      if (stove) {
        const pot = stove.pot;
        if (held.soup) return toast('Plate is full');
        if (pot.state === 'done') {
          held.soup = pot.recipe; held.stream = stove.i;
          const th = pot.thread;
          if (pot.doneEvent) pot.doneEvent.success = true;
          stove.pot = this.emptyPot();
          const a = this.act('plate', tg.x, tg.y, held.id);
          a.stream = stove.i;
          this.attribute(held.id, stove.i);
          this.resolveThread(th, true);
          this.emit('plated', { stove: stove.i });
        } else if (pot.state === 'cooking') toast('Still cooking');
        else if (pot.state === 'burnt') toast('Scrape the pot');
        return;
      }
      if (ch === 'W') {
        if (!held.soup) return toast('Plate is empty');
        const match = this.orders.filter((o) => o.type === held.soup).sort((a, b) => a.deadline - b.deadline)[0];
        if (!match) {
          this.stats.wrong++;
          this.emit('wrong', { soup: held.soup });
          return toast(held.soup === 'mush' ? 'Nobody orders mush' : 'Nobody ordered that');
        }
        const remain = match.deadline - this.t;
        const tip = Math.round((remain / match.patience) * 10);
        this.score += 20 + tip;
        this.stats.served++;
        this.orders = this.orders.filter((o) => o !== match);
        this.resolveThread(match.thread, true);
        p.held = null;
        const a = this.act('serve', tg.x, tg.y, held.id);
        a.stream = held.stream;
        this.emit('serve', { order: match, tip });
        if (this.orders.length === 0) { this.spawnOrder(); }
        return;
      }
      if (ch === 'X') {
        if (held.soup) { held.soup = null; this.act('bin', tg.x, tg.y, held.id); }
        else { p.held = null; this.act('bin', tg.x, tg.y, held.id); }
        return;
      }
      if (ch === '#' && !tile.item) {
        tile.item = held; p.held = null;
        this.act('place', tg.x, tg.y, held.id);
      }
    }

    startChop(tg) {
      const tile = this.tiles[tg.y][tg.x];
      this.player.chopping = { x: tg.x, y: tg.y, item: tile.item, action: this.beginAction('chop', tg.x, tg.y, tile.item.id) };
    }
    stopChop() {
      const c = this.player.chopping;
      if (!c) return;
      c.action.complete = c.item.chopped;
      this.endAction(c.action);
      this.player.chopping = null;
    }

    // ------------------------------------------------------------ step
    step(dt, input = {}) {
      if (this.phase !== 'play') return;
      this.t += dt; this.shiftT += dt;
      const p = this.player, sh = this.shift;

      // movement
      let mx = input.mx || 0, my = input.my || 0;
      const m = Math.hypot(mx, my);
      if (m > 1) { mx /= m; my /= m; }
      if (m > 0.2) {
        if (this.firstMove === null) this.firstMove = this.t;
        if (Math.abs(mx) >= Math.abs(my)) { p.fx = Math.sign(mx); p.fy = 0; } else { p.fx = 0; p.fy = Math.sign(my); }
        const nx = p.x + mx * SPEED * dt;
        if (!this.collides(nx, p.y)) p.x = nx;
        const ny = p.y + my * SPEED * dt;
        if (!this.collides(p.x, ny)) p.y = ny;
      }
      this.target = this.computeTarget();

      // chopping (hold)
      const tg = this.target;
      const tgTile = tg && this.tiles[tg.y][tg.x];
      const canChop = tgTile && tgTile.ch === 'B' && tgTile.item && tgTile.item.kind === 'ing' && !tgTile.item.chopped;
      if (p.chopping && (!input.chop || !tg || tg.x !== p.chopping.x || tg.y !== p.chopping.y)) this.stopChop();
      if (input.chop && canChop && !p.chopping) this.startChop(tg);
      if (p.chopping) {
        const it = p.chopping.item;
        it.prog += dt;
        if (it.prog >= CHOP) { it.chopped = true; this.emit('chopped', { x: tg.x, y: tg.y }); this.stopChop(); }
      }

      if (input.grab && !p.chopping) this.grab();

      // pots
      for (const s of this.stoves) {
        if (!s.active) continue;
        const pot = s.pot;
        if (pot.state === 'cooking') {
          pot.t += dt;
          if (pot.t >= COOK) {
            pot.state = 'done'; pot.t = 0;
            const de = { t: this.t, stove: s.i, shift: this.shiftIdx, thread: pot.thread.id, success: null };
            pot.doneEvent = de;
            this.log.doneEvents.push(de);
            this.log.demandOnsets.push({ t: this.t, kind: 'pot', shift: this.shiftIdx });
            this.emit('ding', { stove: s.i });
          }
        } else if (pot.state === 'done') {
          pot.t += dt;
          if (pot.t >= sh.burn) {
            pot.state = 'burnt';
            if (pot.doneEvent) pot.doneEvent.success = false;
            this.resolveThread(pot.thread, false);
            this.stats.burnt++;
            this.score -= 5;
            this.emit('burnt', { stove: s.i });
          }
        }
      }

      // orders
      for (const o of this.orders.slice()) {
        if (this.t >= o.deadline) {
          this.orders = this.orders.filter((x) => x !== o);
          this.resolveThread(o.thread, false);
          this.stats.expired++;
          this.score -= 10;
          this.emit('expired', { order: o });
        }
      }
      if (this.t >= this.nextOrderAt) {
        this.spawnOrder();
        this.scheduleNextOrder();
      }
      if (this.orders.length === 0 && this.t + 4 < this.nextOrderAt) this.nextOrderAt = this.t + 4;

      // load integration: every open thread accrues the current number of open threads
      const n = this.active.length;
      for (const th of this.active) th.loadInt += n * dt;

      if (this.shiftT >= sh.dur) this.endShift();
    }

    // Clean, serialisable session record for analysis / export
    exportLog() {
      const L = this.log;
      return {
        version: L.version, seed: L.seed, startedAt: L.startedAt, endedAt: new Date().toISOString(),
        score: this.score, shiftSummaries: L.shiftSummaries,
        threads: L.threads.filter((t) => !t.censored && t.end !== null).map((t) => ({
          id: t.id, type: t.type, stove: t.stove, shift: t.shift, onset: +t.onset.toFixed(3),
          deadline: +t.deadline.toFixed(3), end: +t.end.toFixed(3), success: t.success, load: +t.load.toFixed(4),
        })),
        actions: L.actions.map((a) => ({
          t: +a.t.toFixed(3), tEnd: +a.tEnd.toFixed(3), kind: a.kind, stove: a.stove, stream: a.stream,
          shift: a.shift, latency: +a.latency.toFixed(3), moved: a.moved,
        })),
        decisions: L.decisions.map((d) => ({
          t: +d.t.toFixed(3), shift: d.shift, held: d.held, load: d.load, choice: d.choice,
          cands: d.cands.map((c) => ({ i: c.i, E: +c.E.toFixed(4), d: +c.d.toFixed(3) })),
        })),
        doneEvents: L.doneEvents.filter((d) => d.success !== null).map((d) => ({ t: +d.t.toFixed(3), stove: d.stove, shift: d.shift, success: d.success })),
        demandOnsets: L.demandOnsets.map((d) => ({ t: +d.t.toFixed(3), kind: d.kind, shift: d.shift })),
      };
    }
  }

  return Kitchen;
});
