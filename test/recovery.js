// Parameter recovery on synthetic data generated from each model.
// Run: node test/recovery.js
const M = require('../js/models.js');

function sim(seed) {
  const rng = M.mulberry32(seed);
  const res = {};

  // --- capacity: slot truth and resource truth, 90 threads each (≈ one session)
  const mkThreads = (n, pfun) => Array.from({ length: n }, () => {
    const N = 1.5 + rng() * 7, pot = rng() < 0.45;
    return { type: pot ? 'pot' : 'order', load: N, success: rng() < pfun(N, pot) };
  });
  const slotTruth = { K: 2 + rng() * 3, g: 0.3 };
  const tS = mkThreads(+process.env.NT||90, (N, pot) => M.slotP(N, slotTruth.K, slotTruth.g, pot ? 0.04 : 0.08));
  const fS = M.fitCapacity(tS, { bootstrap: 0 });
  res.slotK = [slotTruth.K, fS.slot.K, fS.deltaBIC];

  const tR = mkThreads(+process.env.NT||90, (N, pot) => M.resourceP(N, 4, 2.2, pot ? 0.04 : 0.08));
  const fR = M.fitCapacity(tR, { bootstrap: 0 });
  res.resource = [fR.resource.N50, fR.resource.beta, fR.deltaBIC];

  // --- attention: normalized truth, 70 decisions
  const truth = { omega: 1 + rng() * 3, sigma: 0.4, beta: 9 };
  const dec = Array.from({ length: +process.env.ND||70 }, () => {
    const k = 2 + Math.floor(rng() * 3);
    const cands = Array.from({ length: k }, () => ({ E: rng(), d: rng() * 7 }));
    const R = M.normResponses(cands, truth.omega, truth.sigma).R;
    const ex = R.map((r) => Math.exp(truth.beta * r));
    const z = ex.reduce((a, b) => a + b, 0);
    let u = rng() * z, choice = 0;
    for (; choice < k - 1; choice++) { u -= ex[choice]; if (u <= 0) break; }
    return { cands, choice };
  });
  const fA = M.fitAttention(dec);
  res.omega = [truth.omega, fA.normalized.omega, fA.deltaBIC_norm, fA.deltaBIC_field];

  // --- PRP: bottleneck truth
  const B = 1.5 + rng() * 2;
  const prp = Array.from({ length: 30 }, () => {
    const soa = rng() * 8;
    const g = Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
    return { soa, rt: 1.2 + Math.max(0, B - soa) + 0.6 * g };
  });
  const fP = M.fitPRP(prp);
  res.B = [B, fP.bottleneck.B, fP.deltaBIC];
  return res;
}

const rows = [];
for (let s = 1; s <= 25; s++) rows.push(sim(s * 101));
const corr = (a, b) => {
  const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
  let n = 0, da = 0, db = 0;
  a.forEach((v, i) => { n += (v - ma) * (b[i] - mb); da += (v - ma) ** 2; db += (b[i] - mb) ** 2; });
  return n / Math.sqrt(da * db);
};
const med = (a) => M.median(a);
const fmt = (x) => x.toFixed(2);
console.log('Slot K recovery   r =', fmt(corr(rows.map((r) => r.slotK[0]), rows.map((r) => r.slotK[1]))),
  '| median |err| =', fmt(med(rows.map((r) => Math.abs(r.slotK[0] - r.slotK[1])))),
  '| slot preferred (ΔBIC>0) in', rows.filter((r) => r.slotK[2] > 0).length, '/ 25');
console.log('Resource truth    resource preferred (ΔBIC<0) in', rows.filter((r) => r.resource[2] < 0).length, '/ 25',
  '| median N50 =', fmt(med(rows.map((r) => r.resource[0]))), '(true 4)',
  '| median β =', fmt(med(rows.map((r) => r.resource[1]))), '(true 2.2)');
console.log('Attention ω       r =', fmt(corr(rows.map((r) => r.omega[0]), rows.map((r) => r.omega[1]))),
  '| median |err| =', fmt(med(rows.map((r) => Math.abs(r.omega[0] - r.omega[1])))),
  '| normalized preferred in', rows.filter((r) => r.omega[2] > 0).length, '/ 25',
  '| spatial field preferred in', rows.filter((r) => r.omega[3] > 0).length, '/ 25');
console.log('PRP bottleneck B  r =', fmt(corr(rows.map((r) => r.B[0]), rows.map((r) => r.B[1]))),
  '| median |err| =', fmt(med(rows.map((r) => Math.abs(r.B[0] - r.B[1])))),
  '| bottleneck preferred in', rows.filter((r) => r.B[2] > 0).length, '/ 25');
