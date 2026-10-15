/* Mise en Place — background model fits.
 *
 * Everything here is pure (no DOM) so it runs in the browser and in node for
 * parameter-recovery tests. Each fit is maximum likelihood with a multistart
 * Nelder–Mead, compared by BIC.
 *
 *  1. Capacity: P(thread serviced before its deadline | concurrent load N)
 *       slot      P = (1-λ_type)·[ min(1,K/N) + (1-min(1,K/N))·g ]
 *       resource  P = (1-λ_type) / (1 + (N/N50)^β)
 *  2. Normalization of attention (Reynolds & Heeger 2009, applied to triage):
 *       drive D_i = E_i · A(d_i),   A(d) = 1 + exp(-d²/2ω²)
 *       normalized R_i = D_i / (σ + Σ_j D_j)      choice = softmax(β·R)
 *       compared with unnormalized softmax(β·D) and urgency-only softmax(β·E)
 *  3. Voluntary stream-switch cost: latency to start the next action when the
 *     goal stream (which pot it serves) changes vs repeats.
 *  4. PRP / central bottleneck: RT to a pot-ready signal as a function of the
 *     SOA from the preceding demand.  RT = a + max(0, B − SOA)  vs  RT = a.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MEPModels = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPS = 1e-9;
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const logit = (p) => Math.log(p / (1 - p));
  // bounded parameter: x in R  ->  lo..hi on a log scale
  const bnd = (x, lo, hi) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * sig(x));
  const ubnd = (v, lo, hi) => logit((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
  const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

  // ---------- seeded RNG (for bootstraps and simulations) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Nelder–Mead ----------
  function nelderMead(f, x0, opt = {}) {
    const n = x0.length;
    const maxIt = opt.maxIter || 400 * n;
    const tol = opt.tol || 1e-7;
    const step = opt.step || 0.5;
    let simplex = [x0.slice()];
    for (let i = 0; i < n; i++) {
      const x = x0.slice(); x[i] += step; simplex.push(x);
    }
    let vals = simplex.map(f);
    for (let it = 0; it < maxIt; it++) {
      const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
      simplex = idx.map((i) => simplex[i]); vals = idx.map((i) => vals[i]);
      if (Math.abs(vals[n] - vals[0]) < tol * (1 + Math.abs(vals[0]))) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
      const xr = c.map((cj, j) => cj + (cj - simplex[n][j]));
      const fr = f(xr);
      if (fr < vals[0]) {
        const xe = c.map((cj, j) => cj + 2 * (cj - simplex[n][j]));
        const fe = f(xe);
        if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; }
      } else if (fr < vals[n - 1]) {
        simplex[n] = xr; vals[n] = fr;
      } else {
        const xc = c.map((cj, j) => cj + 0.5 * (simplex[n][j] - cj));
        const fc = f(xc);
        if (fc < vals[n]) { simplex[n] = xc; vals[n] = fc; }
        else {
          for (let i = 1; i <= n; i++) {
            simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
            vals[i] = f(simplex[i]);
          }
        }
      }
    }
    let best = 0;
    for (let i = 1; i <= n; i++) if (vals[i] < vals[best]) best = i;
    return { x: simplex[best], f: vals[best] };
  }

  function multistart(f, starts, opt) {
    let best = null;
    for (const s of starts) {
      let r = nelderMead(f, s, opt);
      r = nelderMead(f, r.x, Object.assign({}, opt, { step: 0.15 })); // restart polish
      if (!best || r.f < best.f) best = r;
    }
    return best;
  }

  const bic = (nll, k, n) => 2 * nll + k * Math.log(Math.max(1, n));

  function quantile(arr, q) {
    if (!arr.length) return NaN;
    const s = arr.slice().sort((a, b) => a - b);
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  const median = (a) => quantile(a, 0.5);

  // =====================================================================
  // 1. Capacity: slot vs resource
  // =====================================================================
  function slotP(N, K, g, lam) {
    const m = Math.min(1, K / N);
    return clampP((1 - lam) * (m + (1 - m) * g));
  }
  function resourceP(N, N50, beta, lam) {
    return clampP((1 - lam) / (1 + Math.pow(N / N50, beta)));
  }

  function capData(threads) {
    return threads
      .filter((t) => t.success !== null && t.success !== undefined && isFinite(t.load) && t.load > 0)
      .map((t) => ({ N: t.load, y: t.success ? 1 : 0, pot: t.type === 'pot' ? 1 : 0 }));
  }

  function slotNLL(th, d) {
    const K = bnd(th[0], 0.5, 15), g = sig(th[1]) * 0.9, lp = sig(th[2]) * 0.5, lo = sig(th[3]) * 0.5;
    let s = 0;
    for (const r of d) {
      const p = slotP(r.N, K, g, r.pot ? lp : lo);
      s -= r.y ? Math.log(p) : Math.log(1 - p);
    }
    return s;
  }
  function resourceNLL(th, d) {
    const N50 = bnd(th[0], 0.5, 30), b = bnd(th[1], 0.2, 15), lp = sig(th[2]) * 0.5, lo = sig(th[3]) * 0.5;
    let s = 0;
    for (const r of d) {
      const p = resourceP(r.N, N50, b, r.pot ? lp : lo);
      s -= r.y ? Math.log(p) : Math.log(1 - p);
    }
    return s;
  }

  function fitSlot(d) {
    const starts = [];
    for (const K of [1.5, 3, 5, 8]) for (const g of [-2, 0]) starts.push([ubnd(K, 0.5, 15), g, -3, -3]);
    const r = multistart((th) => slotNLL(th, d), starts);
    return {
      K: bnd(r.x[0], 0.5, 15), g: sig(r.x[1]) * 0.9,
      lapsePot: sig(r.x[2]) * 0.5, lapseOrder: sig(r.x[3]) * 0.5,
      nll: r.f, k: 4, bic: bic(r.f, 4, d.length), raw: r.x,
    };
  }
  function fitResource(d) {
    const starts = [];
    for (const N50 of [2, 4, 7, 12]) for (const b of [1, 3]) starts.push([ubnd(N50, 0.5, 30), ubnd(b, 0.2, 15), -3, -3]);
    const r = multistart((th) => resourceNLL(th, d), starts);
    return {
      N50: bnd(r.x[0], 0.5, 30), beta: bnd(r.x[1], 0.2, 15),
      lapsePot: sig(r.x[2]) * 0.5, lapseOrder: sig(r.x[3]) * 0.5,
      nll: r.f, k: 4, bic: bic(r.f, 4, d.length), raw: r.x,
    };
  }

  function binCapacity(d) {
    const bins = {};
    for (const r of d) {
      const b = Math.max(1, Math.round(r.N));
      (bins[b] = bins[b] || { N: b, n: 0, k: 0 }).n++;
      if (r.y) bins[b].k++;
    }
    return Object.values(bins).sort((a, b) => a.N - b.N).map((b) => Object.assign(b, { p: b.k / b.n }));
  }

  function fitCapacity(threads, opt = {}) {
    const d = capData(threads);
    const out = { n: d.length, bins: binCapacity(d), enough: d.length >= 12 };
    if (d.length < 6) return out;
    out.slot = fitSlot(d);
    out.resource = fitResource(d);
    out.deltaBIC = out.resource.bic - out.slot.bic; // >0 favours slot
    out.preferred = out.deltaBIC > 2 ? 'slot' : out.deltaBIC < -2 ? 'resource' : 'tie';
    out.loadRange = [Math.min(...d.map((r) => r.N)), Math.max(...d.map((r) => r.N))];
    const B = opt.bootstrap === undefined ? 60 : opt.bootstrap;
    if (B > 0) {
      const rng = mulberry32(opt.seed || 7);
      const Ks = [];
      for (let b = 0; b < B; b++) {
        const s = d.map(() => d[Math.floor(rng() * d.length)]);
        const r = nelderMead((th) => slotNLL(th, s), out.slot.raw);
        Ks.push(bnd(r.x[0], 0.5, 15));
      }
      out.slot.K_ci = [quantile(Ks, 0.1), quantile(Ks, 0.9)]; // 80% CI
    }
    return out;
  }

  // =====================================================================
  // 2. Normalization model of attention (triage across stoves)
  // =====================================================================
  const field = (d, w) => 1 + Math.exp(-(d * d) / (2 * w * w));

  function softmaxLogP(vals, beta, choice) {
    let m = -Infinity;
    for (const v of vals) m = Math.max(m, beta * v);
    let z = 0;
    for (const v of vals) z += Math.exp(beta * v - m);
    return beta * vals[choice] - m - Math.log(z);
  }

  function normResponses(c, w, sigma) {
    const D = c.map((x) => x.E * field(x.d, w));
    const pool = D.reduce((a, b) => a + b, 0);
    return { D, R: D.map((v) => v / (sigma + pool)), pool };
  }

  const ATT_MODELS = {
    normalized: {
      k: 3,
      nll(th, data) {
        const w = bnd(th[0], 0.2, 12), sg = bnd(th[1], 1e-3, 50), b = bnd(th[2], 0.01, 300);
        let s = 0;
        for (const e of data) s -= softmaxLogP(normResponses(e.cands, w, sg).R, b, e.choice);
        return s;
      },
      starts: () => {
        const S = [];
        for (const w of [0.7, 2, 5]) for (const sg of [0.2, 1, 5]) S.push([ubnd(w, 0.2, 12), ubnd(sg, 1e-3, 50), ubnd(6, 0.01, 300)]);
        return S;
      },
      unpack: (x) => ({ omega: bnd(x[0], 0.2, 12), sigma: bnd(x[1], 1e-3, 50), beta: bnd(x[2], 0.01, 300) }),
    },
    unnormalized: {
      k: 2,
      nll(th, data) {
        const w = bnd(th[0], 0.2, 12), b = bnd(th[1], 0.01, 300);
        let s = 0;
        for (const e of data) s -= softmaxLogP(e.cands.map((x) => x.E * field(x.d, w)), b, e.choice);
        return s;
      },
      starts: () => [0.7, 2, 5].map((w) => [ubnd(w, 0.2, 12), ubnd(2, 0.01, 300)]),
      unpack: (x) => ({ omega: bnd(x[0], 0.2, 12), beta: bnd(x[1], 0.01, 300) }),
    },
    urgencyOnly: {
      k: 1,
      nll(th, data) {
        const b = Math.exp(th[0]);
        let s = 0;
        for (const e of data) s -= softmaxLogP(e.cands.map((x) => x.E), b, e.choice);
        return s;
      },
      starts: () => [[0], [1.5]],
      unpack: (x) => ({ beta: Math.exp(x[0]) }),
    },
  };

  function fitAttention(decisions) {
    const data = decisions.filter((e) => e.cands && e.cands.length >= 2 && e.choice >= 0);
    const out = { n: data.length, enough: data.length >= 15 };
    if (data.length < 6) return out;
    for (const [name, M] of Object.entries(ATT_MODELS)) {
      const r = multistart((th) => M.nll(th, data), M.starts());
      out[name] = Object.assign(M.unpack(r.x), { nll: r.f, k: M.k, bic: bic(r.f, M.k, data.length), raw: r.x });
    }
    out.deltaBIC_norm = out.unnormalized.bic - out.normalized.bic; // >0 favours normalization
    out.deltaBIC_field = out.urgencyOnly.bic - out.unnormalized.bic; // >0 favours a spatial field
    // Share of each response removed by the suppressive pool, averaged over decisions
    const p = out.normalized;
    out.normalizationIndex = data.reduce((a, e) => {
      const { pool } = normResponses(e.cands, p.omega, p.sigma);
      return a + pool / (p.sigma + pool);
    }, 0) / data.length;
    // Accuracy of the urgency-only rule at picking the most urgent option, by load
    out.mostUrgentRate = data.reduce((a, e) => {
      let bi = 0;
      e.cands.forEach((c, i) => { if (c.E > e.cands[bi].E) bi = i; });
      return a + (bi === e.choice ? 1 : 0);
    }, 0) / data.length;
    return out;
  }

  // =====================================================================
  // 3. Voluntary stream-switch cost
  // =====================================================================
  function switchCost(actions, opt = {}) {
    const rep = [], sw = [];
    for (let i = 1; i < actions.length; i++) {
      const a = actions[i], p = actions[i - 1];
      if (a.stream == null || p.stream == null) continue;
      if (!(a.latency > 0.03 && a.latency < 4)) continue;
      if (a.shift !== p.shift) continue;
      (a.stream === p.stream ? rep : sw).push(a.latency);
    }
    const out = { nRepeat: rep.length, nSwitch: sw.length, enough: rep.length >= 8 && sw.length >= 8 };
    if (rep.length < 3 || sw.length < 3) return out;
    out.repeatMedian = median(rep);
    out.switchMedian = median(sw);
    out.cost = out.switchMedian - out.repeatMedian;
    const rng = mulberry32(opt.seed || 11);
    const B = opt.bootstrap || 500, costs = [];
    for (let b = 0; b < B; b++) {
      const r = rep.map(() => rep[Math.floor(rng() * rep.length)]);
      const s = sw.map(() => sw[Math.floor(rng() * sw.length)]);
      costs.push(median(s) - median(r));
    }
    out.ci = [quantile(costs, 0.025), quantile(costs, 0.975)];
    out.repeat = rep; out.switch = sw;
    return out;
  }

  // =====================================================================
  // 4. PRP / central bottleneck
  // =====================================================================
  function gaussNLL(res, s) {
    let n = 0;
    for (const r of res) n += 0.5 * Math.log(2 * Math.PI * s * s) + (r * r) / (2 * s * s);
    return n;
  }
  function fitPRP(events) {
    const d = events.filter((e) => isFinite(e.soa) && isFinite(e.rt) && e.rt >= 0 && e.rt < 20 && e.soa >= 0);
    const out = { n: d.length, enough: d.length >= 12, points: d };
    if (d.length < 5) return out;
    const flat = multistart((th) => gaussNLL(d.map((e) => e.rt - th[0]), Math.exp(th[1])),
      [[median(d.map((e) => e.rt)), 0]]);
    const bott = multistart((th) => {
      const B = Math.exp(th[1]);
      return gaussNLL(d.map((e) => e.rt - (th[0] + Math.max(0, B - e.soa))), Math.exp(th[2]));
    }, [0.5, 1, 2, 4].map((B) => [quantile(d.map((e) => e.rt), 0.25), Math.log(B), 0]));
    out.flat = { a: flat.x[0], s: Math.exp(flat.x[1]), nll: flat.f, k: 2, bic: bic(flat.f, 2, d.length) };
    out.bottleneck = {
      a: bott.x[0], B: Math.exp(bott.x[1]), s: Math.exp(bott.x[2]),
      nll: bott.f, k: 3, bic: bic(bott.f, 3, d.length),
    };
    out.deltaBIC = out.flat.bic - out.bottleneck.bic; // >0 favours a bottleneck
    return out;
  }

  // Build PRP events from a session log: RT to each pot-ready signal = time to
  // the first action in that pot's goal stream; SOA = time since the previous
  // demand onset (another pot ready, or a new ticket).
  function prpEvents(log) {
    const onsets = log.demandOnsets.slice().sort((a, b) => a.t - b.t);
    const ev = [];
    for (const de of log.doneEvents) {
      if (!de.success) continue;
      let prev = null;
      for (const o of onsets) { if (o.t < de.t - 1e-6 && o.shift === de.shift) prev = o; else if (o.t >= de.t) break; }
      if (!prev) continue;
      const resp = log.actions.find((a) => a.t >= de.t && a.stream === de.stove && a.shift === de.shift);
      if (!resp) continue;
      ev.push({ soa: de.t - prev.t, rt: resp.t - de.t, stove: de.stove });
    }
    return ev;
  }

  function analyze(log, opt = {}) {
    return {
      capacity: fitCapacity(log.threads, opt),
      attention: fitAttention(log.decisions),
      switching: switchCost(log.actions, opt),
      prp: fitPRP(prpEvents(log)),
    };
  }

  return {
    nelderMead, multistart, mulberry32, quantile, median, bic,
    slotP, resourceP, field, normResponses, softmaxLogP,
    fitCapacity, fitAttention, switchCost, fitPRP, prpEvents, analyze,
  };
});
