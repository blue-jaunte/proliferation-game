/*
 * Breakout simulation engine — a browser port of run_simulation() in bokeh_simul.ipynb.
 *
 * Each round:
 *   Country A estimates where B's materiel is from heat, values each of its pure actions
 *   (inspect any 3 facilities, strike one facility, or blockade the ports) by the materiel it
 *   expects to remove or deny, and picks one with a logit (softmax) rule.
 *   Country B knows A's resulting probabilities (not the draw) and solves a linear program
 *   (HiGHS compiled to WebAssembly) to split each facility's stock between open research, covert
 *   research, idle storage and transport. It prices the heat its research creates and gets more
 *   desperate as the deadline nears.
 * Rounds are solved one at a time so the UI can step through them.
 */
(function (global) {
  'use strict';

  const N = 10;

  // Undirected network (same topology as the notebook).
  const EDGES = [
    [1, 5], [2, 5], [3, 4], [4, 5], [4, 7], [5, 6],
    [7, 8], [7, 9], [8, 9], [8, 10], [9, 10],
  ];
  const DIRECTED = EDGES.concat(EDGES.map(([u, v]) => [v, u]));
  const NEIGHBORS = Array.from({ length: N + 1 }, () => []);
  EDGES.forEach(([u, v]) => { NEIGHBORS[u].push(v); NEIGHBORS[v].push(u); });

  // Facility circle centers in countryB.jpeg pixel space (2642 x 1600).
  const POSITIONS = {
    1: [1898, 366], 2: [2043, 852], 3: [2332, 1346], 4: [1460, 1346], 5: [1313, 742],
    6: [1170, 250], 7: [879, 1346], 8: [733, 738], 9: [297, 1346], 10: [586, 248],
  };
  // Each port receives `import_amount` units of imports per round
  const IMPORT_NODES = [1, 2, 3];

  const DEFAULTS = {
    rounds: 20,
    budget: 80,
    import_amount: 5,           // per port, per round
    c_trans: 0.10,
    alpha_open: 1.0,
    alpha_covert: 0.35,
    penalty_open: 0.85,
    penalty_covert: 0.10,
    penalty_idle: 0.60,
    v_material: 2.5,
    heat_aversion: 0.05,
    intel_confidence: 0.2,
    risk_aversion: 1.0,
    comfort: 0.5,
    cooling_rate: 0.55,
    breakout_goal: 1000,
    allow_strikes: 1,
    a_temp: 0.25,
    seed: 42,
  };
  // Heat from one unit of covert research, relative to one unit of open research
  const HEAT_COVERT = 0.15;

  // Seeded PRNG (mulberry32). Not bit-identical to numpy, but deterministic per seed.
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 20 blocks of 10 units dropped onto random facilities, as in the notebook.
  function randomStockpile(seed) {
    const rng = makeRng(seed);
    const m = new Array(N).fill(0);
    for (let b = 0; b < 20; b++) m[Math.floor(rng() * N)] += 10;
    return m;
  }

  const zeros = () => new Array(N).fill(0);
  const sum = (arr) => arr.reduce((s, x) => s + x, 0);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function createSim(params, initialStock) {
    const p = Object.assign({}, DEFAULTS, params);
    const m0 = initialStock.map((x) => Math.max(0, +x || 0));
    return {
      params: p,
      // Random stream for Country A's draws, seeded separately from the stockpile.
      rng: makeRng((p.seed * 7919 + 17) >>> 0),
      curr_m: m0.slice(),
      curr_h: zeros(),
      cum_p: 0,
      cum_s: 0,
      cum_d: 0,
      cum_b: 0,
      history: [{
        round: 0,
        m: m0.slice(),
        h: zeros(),
        pi_est: zeros(),
        strike_est: zeros(),
        posture: null,
        n_open: zeros(),
        n_covert: zeros(),
        s_idle: m0.slice(),
        prog_open: zeros(),
        prog_covert: zeros(),
        imports: zeros(),
        losses: zeros(),
        inspections: zeros(),
        strike: null,
        blockade: false,
        blocked: 0,
        a_eval: null,
        destroyed: 0,
        cum_destroyed: 0,
        cum_blocked: 0,
        node_progress: zeros(),
        flows: [],
        inflows: zeros(),
        outflows: zeros(),
        progress: 0,
        seized: 0,
        cum_progress: 0,
        cum_seized: 0,
      }],
    };
  }

  // Softmax with temperature relative to the largest value, so `temp` is scale-free:
  // an option worth (1 - temp) of the best one gets weight e^-1 relative to it.
  function softmax(values, temp) {
    const vmax = Math.max(...values);
    const T = Math.max(1e-6, temp * Math.max(vmax, 1e-6));
    const w = values.map((v) => Math.exp((v - vmax) / T));
    const tot = sum(w);
    return w.map((x) => x / tot);
  }

  function sample(probs, rng) {
    let r = rng();
    for (let i = 0; i < probs.length; i++) { r -= probs[i]; if (r <= 0) return i; }
    return probs.length - 1;
  }

  // All 120 ways to pick 3 of the 10 facilities (0-based)
  const TRIPLES = [];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) for (let c = b + 1; c < N; c++) TRIPLES.push([a, b, c]);

  // ---- Country A: logit choice over its 131 pure actions ----
  // A knows B's total stock M (initial + imports - what A removed) and estimates each facility's
  // share by its share of heat: m_hat_i = M h_i / sum_j h_j. Heat is only a hint, so A discounts
  // the actions that depend on it by its intel confidence phi:
  //   inspect S (3 facilities): phi * delta_idle * sum_{i in S} m_hat_i
  //   strike facility j:        phi * m_hat_j
  //   blockade:                 the imports it stops, which is certain
  // A picks action a with probability proportional to exp(V(a) / (a_temp * max V)); as a_temp
  // goes to 0 it always takes the single best action.
  function assessA(sim) {
    const p = sim.params, h = sim.curr_h;
    const M = sum(sim.curr_m);
    const H = sum(h);
    const m_hat = h.map((x) => (H > 1e-6 ? M * x / H : M / N));
    const phi = p.intel_confidence;

    const actions = TRIPLES.map((S) => ({ kind: 'inspect', set: S, value: phi * p.penalty_idle * sum(S.map((i) => m_hat[i])) }));
    if (p.allow_strikes) m_hat.forEach((m, j) => actions.push({ kind: 'facility', id: j + 1, value: phi * m }));
    actions.push({ kind: 'blockade', value: p.import_amount * IMPORT_NODES.length });
    const probs = softmax(actions.map((a) => a.value), p.a_temp);
    actions.forEach((a, k) => { a.prob = probs[k]; });

    // What B plans against: each facility's chance of being inspected or struck this round
    const pi = zeros(), atk = zeros();
    actions.forEach((a) => {
      if (a.kind === 'inspect') a.set.forEach((i) => { pi[i] += a.prob; });
      else if (a.kind === 'facility') atk[a.id - 1] += a.prob;
    });
    return { m_hat, actions, pi, atk };
  }

  // ---- Country B: one linear program per round (CPLEX LP format, read by HiGHS) ----
  const num = (x) => {
    const s = Math.abs(x).toFixed(10).replace(/\.?0+$/, '');
    return s === '' ? '0' : s;
  };
  function terms(list) {
    // list of [coef, varName]; returns "+ 1.5 x - 0.2 y ..." split over lines
    const out = [];
    for (const [c, v] of list) {
      if (Math.abs(c) < 1e-12) continue;
      out.push(`${c < 0 ? '-' : '+'} ${num(c)} ${v}`);
    }
    if (!out.length) return '0 ' + list[0][1];
    const lines = [];
    for (let i = 0; i < out.length; i += 6) lines.push(out.slice(i, i + 6).join(' '));
    return lines.join('\n   ');
  }
  const fv = (u, v) => `f_${u}_${v}`;

  /*
   *   max  Q + v * (materiel B expects to keep) - c * (units shipped) - heatCost * (heat added)
   *   s.t. o_i + k_i + s_i + sum_j f_ij = m_i                 (use all stock at i)
   *        sum_i (o_i + k_i) <= budget                         (research budget)
   *        Q <= sum_i (1 - pi_i - atk_i) a_o o_i + (1 - atk_i) a_k k_i,  Q <= need
   *                                                            (expected progress that counts)
   * A strike lands at the start of the round, before convoys leave, so all of i's stock is exposed
   * to it. A unit used as u at facility i is kept with probability 1 - atk_i - pi_i d_u (A inspects
   * or strikes, never both). A unit shipped j -> i is lost if j is struck and is seized like idle
   * stock if i is inspected: kept with probability 1 - atk_j - pi_i d_idle.
   * pi and atk are A's probabilities, already inflated by B's caution.
   */
  function buildLP(p, m, pi, atk, { v, heatCost, need }) {
    const obj = [[1, 'Q']];
    const prog = [[1, 'Q']];
    const bud = [];
    const cons = [];
    for (let i = 1; i <= N; i++) {
      const r = pi[i - 1], a = atk[i - 1];
      const keep = (d) => Math.max(0, 1 - a - r * d);
      obj.push([v * keep(p.penalty_open) - heatCost, `o_${i}`]);
      obj.push([v * keep(p.penalty_covert) - heatCost * HEAT_COVERT, `k_${i}`]);
      obj.push([v * keep(p.penalty_idle), `s_${i}`]);
      NEIGHBORS[i].forEach((j) => obj.push([v * Math.max(0, 1 - atk[j - 1] - r * p.penalty_idle) - p.c_trans, fv(j, i)]));
      // Open work is lost to an inspection or a strike, covert work only to a strike
      prog.push([-Math.max(0, 1 - r - a) * p.alpha_open, `o_${i}`], [-(1 - a) * p.alpha_covert, `k_${i}`]);
      bud.push([1, `o_${i}`], [1, `k_${i}`]);
      const use = [[1, `o_${i}`], [1, `k_${i}`], [1, `s_${i}`]];
      NEIGHBORS[i].forEach((j) => use.push([1, fv(i, j)]));
      cons.push(`stock_${i}: ${terms(use)} = ${num(m[i - 1])}`);
    }
    cons.push(`budget: ${terms(bud)} <= ${num(p.budget)}`);
    cons.push(`progress: ${terms(prog)} <= 0`);
    return `Maximize\n obj: ${terms(obj)}\nSubject To\n ${cons.join('\n ')}\n` +
      `Bounds\n Q <= ${num(Math.max(0, need))}\nEnd\n`;
  }

  // ---- Solver loading (HiGHS via WebAssembly) ----
  const HIGHS_BASE = 'https://cdn.jsdelivr.net/npm/highs@1.8.0/build/';
  let highsPromise = null;
  function loadSolver() {
    if (!highsPromise) {
      highsPromise = (async () => {
        if (typeof global.Module !== 'function') throw new Error('HiGHS script failed to load');
        return global.Module({ locateFile: (f) => HIGHS_BASE + f });
      })();
      highsPromise.catch(() => { highsPromise = null; });
    }
    return highsPromise;
  }

  async function solveLP(lp) {
    let highs = await loadSolver();
    try {
      return highs.solve(lp);
    } catch (err) {
      // highs-js can corrupt its heap after many solves; re-instantiate once and retry.
      highsPromise = null;
      highs = await loadSolver();
      return highs.solve(lp);
    }
  }

  // ---- One round ----
  async function stepSim(sim) {
    const p = sim.params;
    const t = sim.history.length;
    if (t > p.rounds) return null;
    const { curr_m, curr_h } = sim;

    // Country A draws one action from its mixed strategy
    const { m_hat, actions, pi, atk } = assessA(sim);
    const choice = actions[sample(actions.map((a) => a.prob), sim.rng)];
    const insp = zeros();
    if (choice.kind === 'inspect') choice.set.forEach((i) => { insp[i] = 1; });
    const strike = choice.kind === 'facility' ? { kind: 'facility', id: choice.id } : null;
    const blockade = choice.kind === 'blockade';

    // ---- Country B's round parameters ----
    const T = p.rounds;
    const need = Math.max(0, p.breakout_goal - sim.cum_p);
    const roundsLeft = T - t + 1;                              // including this one
    // Leftover materiel is worth v_material per unit at the start, falling to 0 at the deadline
    const worth = (round) => p.v_material * Math.max(0, T - round) / Math.max(1, T - 1);
    const v = worth(t);
    // Each unit of heat costs heat_aversion units of next round's materiel value
    const heatCost = p.heat_aversion * worth(t + 1);
    // Urgency: the pace B needs as a share of its top possible pace (whole budget in open research).
    // B plans as if A's threats were gamma times as likely: the full caution setting while
    // u <= comfort, sliding to A's real odds (gamma = 1) once u >= 1.
    const urgency = need / (roundsLeft * p.alpha_open * p.budget);
    const comfort = clamp(p.comfort, 0, 0.99);
    const gamma = 1 + (p.risk_aversion - 1) * clamp((1 - urgency) / (1 - comfort), 0, 1);
    const inflate = (x) => Math.min(1, gamma * x);

    const result = await solveLP(buildLP(p, curr_m, pi.map(inflate), atk.map(inflate), { v, heatCost, need }));
    if (result.Status !== 'Optimal') throw new Error(`Round ${t}: solver returned "${result.Status}"`);
    const col = (name) => (result.Columns[name] ? result.Columns[name].Primal : 0);
    const clean = (x) => (Math.abs(x) < 1e-9 ? 0 : x);

    const n_open = zeros(), n_covert = zeros(), s_idle = zeros();
    for (let i = 1; i <= N; i++) {
      n_open[i - 1] = clean(col(`o_${i}`));
      n_covert[i - 1] = clean(col(`k_${i}`));
      s_idle[i - 1] = clean(col(`s_${i}`));
    }
    const imports = zeros();
    // A blockade stops this round's imports
    if (!blockade) IMPORT_NODES.forEach((i) => { imports[i - 1] = p.import_amount; });
    const blocked = blockade ? p.import_amount * IMPORT_NODES.length : 0;

    // A strike lands first: the facility's whole stock is destroyed before any convoy leaves, so
    // nothing B planned there happens. Convoys arriving later in the round get through.
    const struckId = strike ? strike.id - 1 : -1;
    const flows = [];
    const inflows = zeros(), outflows = zeros();
    DIRECTED.forEach(([u, w]) => {
      const x = clean(col(fv(u, w)));
      if (x <= 0) return;
      const hit = u - 1 === struckId;
      if (!hit) {
        outflows[u - 1] += x;
        inflows[w - 1] += x;
      }
      if (x > 0.1) flows.push({ from: u, to: w, amount: x, destroyed: hit });
    });
    if (struckId >= 0) {
      n_open[struckId] = 0;
      n_covert[struckId] = 0;
      s_idle[struckId] = 0;
    }

    // Open research at an inspected facility is intercepted; covert research survives.
    // Inspections seize a share of each use; arrivals are seized like idle stock.
    const prog_open = n_open.map((o, i) => (1 - insp[i]) * p.alpha_open * o);
    const prog_covert = n_covert.map((k) => p.alpha_covert * k);
    const node_progress = prog_open.map((x, i) => x + prog_covert[i]);
    const losses = insp.map((s, i) => s * (
      p.penalty_open * n_open[i] + p.penalty_covert * n_covert[i] +
      p.penalty_idle * (s_idle[i] + inflows[i])));
    const seized = sum(losses);
    let destroyed = 0;
    if (strike) {
      losses[struckId] = curr_m[struckId];
      destroyed = losses[struckId];
      strike.destroyed = destroyed;
    }
    const progress = sum(node_progress);
    sim.cum_p += progress;
    sim.cum_s += seized;
    sim.cum_d += destroyed;
    sim.cum_b += blocked;

    const bestBy = (kind) => actions.filter((a) => a.kind === kind).reduce((b, a) => (!b || a.value > b.value ? a : b), null);
    const kindProb = (kind) => sum(actions.filter((a) => a.kind === kind).map((a) => a.prob));
    const state = {
      round: t,
      m: curr_m.slice(),
      h: curr_h.slice(),
      pi_est: pi,
      strike_est: atk,
      posture: {
        gamma, urgency, need, rounds_left: roundsLeft,
        on_schedule: clamp((1 - urgency) / (1 - comfort), 0, 1),
        required_pace: need / roundsLeft, v, heat_cost: heatCost,
      },
      n_open, n_covert, s_idle, prog_open, prog_covert, imports, losses,
      inspections: insp,
      strike,
      blockade,
      blocked,
      a_eval: {
        inspect: bestBy('inspect').value, best_strike: bestBy('facility'), m_hat,
        kind_probs: { inspect: kindProb('inspect'), facility: kindProb('facility'), blockade: kindProb('blockade') },
        choice_prob: choice.prob,
      },
      destroyed,
      cum_destroyed: sim.cum_d,
      cum_blocked: sim.cum_b,
      node_progress, flows, inflows, outflows,
      progress, seized,
      cum_progress: sim.cum_p,
      cum_seized: sim.cum_s,
    };
    sim.history.push(state);

    sim.curr_m = curr_m.map((m, i) => Math.max(0, m - outflows[i] + inflows[i] - losses[i]) + imports[i]);
    sim.curr_h = curr_h.map((h, i) => p.cooling_rate * h + n_open[i] + HEAT_COVERT * n_covert[i]);
    // A struck facility is gutted, so its heat signature drops to zero instantly
    if (strike) sim.curr_h[struckId] = 0;
    return state;
  }

  global.BreakoutSim = {
    N, EDGES, POSITIONS, IMPORT_NODES, DEFAULTS,
    randomStockpile, createSim, stepSim, loadSolver, buildLP,
  };
})(window);
