/* Breakout Simulator UI: setup form, step-by-step playback, map overlay, charts, table. */
(function () {
  'use strict';

  const S = window.BreakoutSim;
  const N = S.N;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const PARAM_GROUPS = [
    {
      title: 'Country B economics', open: true, params: [
        { key: 'v_material', label: 'Materiel value', min: 0.5, max: 5, step: 0.1, dp: 1, help: 'Value of a unit of stockpile kept for future rounds. Falls linearly to zero by the deadline' },
        { key: 'heat_aversion', label: 'Heat aversion', min: 0, max: 0.5, step: 0.01, dp: 2, help: 'Each unit of heat B creates costs this many units of next round’s materiel value' },
        { key: 'c_trans', label: 'Transport cost', min: 0.01, max: 1, step: 0.01, dp: 2 },
        { key: 'import_amount', label: 'Imports per port', min: 0, max: 10, step: 1, dp: 0, help: 'Arrives each round at each of the port facilities 1–3' },
        { key: 'budget', label: 'Budget', min: 10, max: 300, step: 5, dp: 0, help: 'Max materiel B can put into research (open + covert) per round, across all facilities' },
      ],
    },
    {
      title: 'Country B risk attitude', open: true, params: [
        { key: 'risk_aversion', label: 'Caution', min: 0, max: 3, step: 0.1, dp: 1, help: 'When on schedule, B plans as if A’s threats were this many times as likely (1 = A’s real odds). Slides to 1 as B falls behind' },
        { key: 'comfort', label: 'Comfort threshold', min: 0.3, max: 0.95, step: 0.05, dp: 2, help: 'B is fully cautious while the pace it needs is under this share of its top pace (whole budget in open research), and drops all caution once it needs its top pace' },
      ],
    },
    {
      title: 'Research speed', open: true, params: [
        { key: 'alpha_open', label: 'Open speed', min: 0.5, max: 2, step: 0.1, dp: 1 },
        { key: 'alpha_covert', label: 'Covert speed', min: 0.05, max: 1, step: 0.05, dp: 2 },
      ],
    },
    {
      title: 'Detection & seizure', open: false, params: [
        { key: 'penalty_open', label: 'Open seizure rate', min: 0.2, max: 1, step: 0.05, dp: 2 },
        { key: 'penalty_covert', label: 'Covert seizure rate', min: 0, max: 0.5, step: 0.05, dp: 2 },
        { key: 'penalty_idle', label: 'Idle seizure rate', min: 0.1, max: 1, step: 0.05, dp: 2 },
        { key: 'cooling_rate', label: 'Heat cooling (λ)', min: 0.1, max: 0.9, step: 0.05, dp: 2, help: 'Fraction of heat that persists each round' },
      ],
    },
    {
      title: 'Country A strategy', open: true, params: [
        { key: 'allow_strikes', type: 'toggle', label: 'Allow strikes', help: 'A may forfeit all inspections to destroy everything at one facility' },
        { key: 'intel_confidence', label: 'Intel confidence', min: 0.05, max: 1, step: 0.05, dp: 2, help: 'How much A trusts heat as a guide to B’s materiel. Inspections and strikes are discounted by this; a blockade’s haul is certain' },
        { key: 'a_temp', label: 'Randomness', min: 0.05, max: 1, step: 0.05, dp: 2, help: 'How often A picks an action other than its best one. Near 0, A almost always takes the best. B knows these odds but not the draw' },
      ],
    },
    {
      title: 'Game length', open: false, params: [
        { key: 'rounds', label: 'Rounds', min: 5, max: 40, step: 1, dp: 0 },
        { key: 'breakout_goal', label: 'Breakout goal', min: 200, max: 5000, step: 100, dp: 0 },
      ],
    },
  ];
  const PARAM_DEFS = PARAM_GROUPS.flatMap((g) => g.params);

  // ---------- state ----------
  let applied = null;          // { params, stock }
  let sim = null;
  let view = 0;                // round currently displayed
  let selected = 5;
  let playing = false;
  let playTimer = null;
  let solveTarget = 0;
  let solverReady = false;

  const $ = (id) => document.getElementById(id);
  const fmt = (x, dp = 1) => (Math.abs(x) < 0.05 && dp > 0 ? 0 : x).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const svg = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  const maxRound = () => sim.params.rounds;
  const solvedRound = () => sim.history.length - 1;

  // ---------- setup form ----------
  function buildForm() {
    const grid = $('stock-grid');
    for (let i = 1; i <= N; i++) {
      const cell = document.createElement('div');
      cell.className = 'stock-cell';
      cell.innerHTML = `<label for="stock-${i}">F${i}</label>
        <input id="stock-${i}" type="number" inputmode="decimal" min="0" step="1" aria-label="Facility ${i} starting stockpile">`;
      grid.appendChild(cell);
    }

    const host = $('param-groups');
    PARAM_GROUPS.forEach((g) => {
      const d = document.createElement('details');
      d.className = 'group';
      d.open = g.open;
      d.innerHTML = `<summary class="group-toggle"><span>${g.title}</span><svg class="ic" aria-hidden="true"><use href="#i-chev"/></svg></summary>`;
      g.params.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'param';
        const helpId = p.help ? `help-${p.key}` : '';
        if (p.type === 'toggle') {
          row.classList.add('param-toggle');
          row.innerHTML = `
            <label for="p-${p.key}">${p.label}</label>
            <input type="checkbox" id="p-${p.key}" name="${p.key}"${helpId ? ` aria-describedby="${helpId}"` : ''}>
            ${p.help ? `<span class="help" id="${helpId}">${p.help}</span>` : ''}`;
          d.appendChild(row);
          return;
        }
        row.innerHTML = `
          <label for="p-${p.key}">${p.label}</label>
          <output id="o-${p.key}" for="p-${p.key}"></output>
          <input type="range" id="p-${p.key}" name="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}"${helpId ? ` aria-describedby="${helpId}"` : ''}>
          ${p.help ? `<span class="help" id="${helpId}">${p.help}</span>` : ''}`;
        d.appendChild(row);
      });
      host.appendChild(d);
    });

    setForm(Object.assign({}, S.DEFAULTS), S.randomStockpile(S.DEFAULTS.seed));

    $('setup-form').addEventListener('input', (e) => {
      if (e.target.type === 'range') syncRange(e.target);
      updateStockTotal();
      scheduleApply();
    });
    $('setup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      applyForm();
    });
    $('btn-random').addEventListener('click', () => {
      const seed = parseInt($('p-seed').value, 10) || 0;
      readStockInputs(S.randomStockpile(seed));
      updateStockTotal(); scheduleApply();
    });
    $('btn-even').addEventListener('click', () => {
      readStockInputs(new Array(N).fill(20));
      updateStockTotal(); scheduleApply();
    });
  }

  function syncRange(input) {
    const def = PARAM_DEFS.find((p) => `p-${p.key}` === input.id);
    const v = parseFloat(input.value);
    $(`o-${def.key}`).textContent = fmt(v, def.dp);
    const pct = ((v - def.min) / (def.max - def.min)) * 100;
    input.style.setProperty('--pct', pct + '%');
  }
  function readStockInputs(stock) {
    stock.forEach((v, i) => { $(`stock-${i + 1}`).value = Math.round(v * 10) / 10; });
  }
  function setForm(params, stock) {
    PARAM_DEFS.forEach((p) => {
      const el = $(`p-${p.key}`);
      if (p.type === 'toggle') { el.checked = !!params[p.key]; return; }
      el.value = params[p.key];
      syncRange(el);
    });
    $('p-seed').value = params.seed;
    readStockInputs(stock);
    updateStockTotal();
  }
  function readForm() {
    const params = { seed: parseInt($('p-seed').value, 10) || 0 };
    PARAM_DEFS.forEach((p) => {
      const el = $(`p-${p.key}`);
      params[p.key] = p.type === 'toggle' ? (el.checked ? 1 : 0) : parseFloat(el.value);
    });
    const stock = [];
    for (let i = 1; i <= N; i++) stock.push(Math.max(0, parseFloat($(`stock-${i}`).value) || 0));
    return { params, stock };
  }
  function updateStockTotal() {
    $('stock-total').textContent = `${fmt(sum(readForm().stock), 0)} units`;
  }
  // Changes apply as they're made: the game is re-run from scratch up to the round on screen
  let applyTimer = null;
  function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      if (JSON.stringify(readForm()) !== JSON.stringify(applied)) applyForm(view);
    }, 250);
  }
  function applyForm(keepRound = 0) {
    clearTimeout(applyTimer);
    stopPlay();
    applied = readForm();
    sim = S.createSim(applied.params, applied.stock);
    view = 0;
    solveTarget = 0;
    $('scrubber').max = maxRound();
    $('top-rounds').textContent = maxRound();
    render();
    if (keepRound > 0) goTo(keepRound);
  }

  // ---------- solving & playback ----------
  // One solve loop at a time; if the game is reset mid-loop it carries on with the new game.
  let solveRun = null;
  function ensureSolved(target) {
    solveTarget = Math.max(solveTarget, Math.min(target, maxRound()));
    if (!solveRun) solveRun = runSolves().finally(() => { solveRun = null; });
    return solveRun;
  }
  async function runSolves() {
    showOverlay(true);
    try {
      while (solvedRound() < solveTarget) {
        const current = sim;
        $('map-overlay-text').textContent = `Solving round ${solvedRound() + 1}…`;
        await S.stepSim(current);
        if (current !== sim) continue;
        updateScrubSolved();
        // Yield so the overlay paints between rounds
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (err) {
      console.error(err);
      stopPlay();
      showToast(`Couldn't solve the round: ${err.message}`);
      setSolverChip('error', 'Solver error');
    } finally {
      showOverlay(false);
    }
  }

  async function goTo(r) {
    if (!sim) return;
    const current = sim;
    r = Math.max(0, Math.min(maxRound(), r));
    if (r > solvedRound()) {
      await ensureSolved(r);
      // A reset while waiting starts its own navigation
      if (current !== sim) return;
      r = Math.min(r, solvedRound());
    }
    view = r;
    render();
  }

  function togglePlay() { playing ? stopPlay() : startPlay(); }
  function startPlay() {
    if (view >= maxRound()) view = 0;
    playing = true;
    updatePlayButton();
    tick();
  }
  async function tick() {
    if (!playing) return;
    await goTo(view + 1);
    if (!playing) return;
    if (view >= maxRound()) { stopPlay(); return; }
    playTimer = setTimeout(tick, parseInt($('speed').value, 10));
  }
  function stopPlay() {
    playing = false;
    clearTimeout(playTimer);
    updatePlayButton();
  }
  function updatePlayButton() {
    const b = $('btn-play');
    b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    b.querySelector('span').textContent = playing ? 'Pause' : 'Play';
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function showOverlay(on) {
    clearTimeout(showOverlay.t);
    // Only show the indicator if a solve takes noticeably long
    if (on) showOverlay.t = setTimeout(() => { $('map-overlay').hidden = false; }, 180);
    else $('map-overlay').hidden = true;
  }
  function setSolverChip(kind, text) {
    const c = $('solver-chip');
    c.classList.remove('ready', 'error');
    if (kind) c.classList.add(kind);
    c.querySelector('.chip-text').textContent = text;
    c.title = text;
  }
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ---------- map ----------
  const nodeEls = {};
  function buildMap() {
    const layer = $('layer-nodes');
    for (let i = 1; i <= N; i++) {
      const [cx, cy] = S.POSITIONS[i];
      const g = svg('g', { class: 'fac', tabindex: 0, role: 'button', 'data-id': i }, layer);
      svg('circle', { class: 'tint', cx, cy, r: 94, fill: 'var(--amber)', 'fill-opacity': 0 }, g);
      svg('circle', { class: 'heat-track', cx, cy, r: 112 }, g);
      const arc = svg('circle', {
        class: 'heat-arc', cx, cy, r: 112, pathLength: 100, 'stroke-dasharray': '0 100',
        transform: `rotate(-90 ${cx} ${cy})`,
      }, g);
      svg('circle', { class: 'sel-ring', cx, cy, r: 136 }, g);
      const mat = svg('text', { class: 'mat', x: cx, y: cy + 30 }, g);
      const heat = svg('text', { class: 'heat-txt', x: cx, y: cy + 68 }, g);
      svg('circle', { class: 'hit', cx, cy, r: 120 }, g);
      g.addEventListener('click', () => select(i));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); }
      });
      nodeEls[i] = { g, arc, mat, heat, tint: g.querySelector('.tint') };
    }
  }

  function tweenText(el, to, dp, suffix = '') {
    const from = el._val ?? to;
    el._val = to;
    cancelAnimationFrame(el._raf);
    if (reduceMotion.matches || from === to) { el.textContent = fmt(to, dp) + suffix; return; }
    const t0 = performance.now(), dur = 520;
    const stepFn = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e, dp) + suffix;
      if (k < 1) el._raf = requestAnimationFrame(stepFn);
    };
    el._raf = requestAnimationFrame(stepFn);
  }

  function renderMap(st) {
    for (let i = 1; i <= N; i++) {
      const el = nodeEls[i];
      const m = st.m[i - 1], h = st.h[i - 1];
      const hn = Math.min(1, h / 50);
      el.arc.setAttribute('stroke-dasharray', `${(hn * 100).toFixed(2)} 100`);
      el.tint.setAttribute('fill-opacity', (hn * 0.45).toFixed(3));
      tweenText(el.mat, m, 0);
      el.heat.textContent = `HEAT ${fmt(h, 1)}`;
      el.g.classList.toggle('selected', i === selected);
      const insp = st.inspections[i - 1] > 0;
      const hit = isStruck(st, i);
      el.g.setAttribute('aria-label',
        `Facility ${i}: ${fmt(m, 1)} units, heat ${fmt(h, 1)}${insp ? ', inspected this round' : ''}${hit ? ', struck this round' : ''}`);
      el.g.setAttribute('aria-pressed', i === selected ? 'true' : 'false');
    }

    // Flows + imports
    const flowLayer = $('layer-flows');
    flowLayer.replaceChildren();
    const labels = $('layer-labels');
    labels.replaceChildren();

    st.flows.forEach((f) => {
      const [x1, y1] = S.POSITIONS[f.from];
      const [x2, y2] = S.POSITIONS[f.to];
      const d = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / d, uy = (y2 - y1) / d;
      const sx = x1 + ux * 124, sy = y1 + uy * 124, ex = x2 - ux * 150, ey = y2 - uy * 150;
      const w = 7 + Math.min(12, f.amount / 2.5);
      const g = svg('g', { class: 'fade-in' }, flowLayer);
      svg('line', { class: 'flow-casing', x1: sx, y1: sy, x2: ex, y2: ey, 'stroke-width': w + 8 }, g);
      svg('line', {
        class: f.destroyed ? 'flow-line destroyed' : 'flow-line', x1: sx, y1: sy, x2: ex, y2: ey,
        'stroke-width': w, 'marker-end': f.destroyed ? 'url(#arrow-pink)' : 'url(#arrow-teal)',
      }, g);
      pill(labels, (sx + ex) / 2, (sy + ey) / 2, fmt(f.amount, 1), f.destroyed ? 'flow-pill destroyed' : 'flow-pill', 28);
    });

    S.IMPORT_NODES.forEach((i) => {
      const amt = st.blockade ? sim.params.import_amount : st.imports[i - 1];
      if (amt <= 0.05) return;
      const [cx, cy] = S.POSITIONS[i];
      const sx = Math.min(cx + 360, 2630), ex = cx + 150;
      const g = svg('g', { class: 'fade-in' }, flowLayer);
      svg('line', { class: 'flow-casing', x1: sx, y1: cy, x2: ex, y2: cy, 'stroke-width': 18 }, g);
      if (st.blockade) {
        // Blockaded imports never arrive
        svg('line', { class: 'flow-line destroyed', x1: sx, y1: cy, x2: ex, y2: cy, 'stroke-width': 10, 'marker-end': 'url(#arrow-pink)' }, g);
        pill(labels, (sx + ex) / 2 + 10, cy - 44, `BLOCKED ${fmt(amt, 0)}`, 'flow-pill destroyed', 26);
        return;
      }
      svg('line', { class: 'import-line', x1: sx, y1: cy, x2: ex, y2: cy, 'marker-end': 'url(#arrow-blue)' }, g);
      pill(labels, (sx + ex) / 2 + 10, cy - 44, `+${fmt(amt, 1)}`, 'import-pill', 26);
    });

    // A blockade parks a destroyer off each port
    if (st.blockade) BLOCKADE_SHIPS.forEach(([x, y, delay]) => destroyer(labels, x, y, delay));

    // Inspection reticles + badges
    for (let i = 1; i <= N; i++) {
      if (!(st.inspections[i - 1] > 0)) continue;
      const [cx, cy] = S.POSITIONS[i];
      const g = svg('g', { class: 'insp fade-in' }, labels);
      svg('circle', { class: 'pulse', cx, cy, r: 126 }, g);
      svg('circle', { class: 'reticle', cx, cy, r: 126 }, g);
      [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => {
        svg('line', { class: 'tick', x1: cx + dx * 112, y1: cy + dy * 112, x2: cx + dx * 146, y2: cy + dy * 146 }, g);
      });
      const loss = st.losses[i - 1];
      badge(labels, cx, cy - 176, loss > 0.05 ? `INSPECTED  −${fmt(loss, 1)}` : 'INSPECTED');
    }

    // Strike markers
    const sk = st.strike;
    if (sk && sk.kind === 'facility') {
      const [cx, cy] = S.POSITIONS[sk.id];
      const g = svg('g', { class: 'strike fade-in' }, labels);
      svg('circle', { class: 'blast', cx, cy, r: 132 }, g);
      [[-1, -1], [1, 1], [-1, 1], [1, -1]].forEach(([dx, dy]) => {
        svg('line', { class: 'x', x1: cx + dx * 40, y1: cy + dy * 40, x2: cx + dx * 150, y2: cy + dy * 150 }, g);
      });
      badge(labels, cx, cy - 176, `STRUCK  −${fmt(sk.destroyed, 1)}`, 'strike-badge');
    } else if (sk && sk.kind === 'route') {
      const [x1, y1] = S.POSITIONS[sk.u];
      const [x2, y2] = S.POSITIONS[sk.v];
      const g = svg('g', { class: 'strike fade-in' }, flowLayer);
      svg('line', { class: 'route-hit', x1, y1, x2, y2 }, g);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      [[-1, -1], [1, 1], [-1, 1], [1, -1]].forEach(([dx, dy]) => {
        svg('line', { class: 'x', x1: mx, y1: my, x2: mx + dx * 60, y2: my + dy * 60 }, g);
      });
      badge(labels, mx, my - 90, `ROUTE STRUCK  −${fmt(sk.destroyed, 1)}`, 'strike-badge');
    }
  }

  // Open water off ports 1, 2 and 3 (map pixels), with staggered bobbing so the ships don't move in step
  const BLOCKADE_SHIPS = [[2470, 470, 0], [2450, 990, -1.3], [2505, 1225, -2.4]];

  // A grey destroyer bobbing on the swell: the outer group places it, the inner one rocks
  function destroyer(parent, x, y, delay) {
    const place = svg('g', { class: 'fade-in', transform: `translate(${x} ${y}) scale(0.85)` }, parent);
    svg('ellipse', { class: 'ship-wake', cx: 0, cy: 14, rx: 150, ry: 12, style: `animation-delay:${delay}s` }, place);
    const ship = svg('g', { class: 'destroyer', style: `animation-delay:${delay}s` }, place);
    svg('path', { class: 'ship-hull', d: 'M-135 -16 L128 -16 L112 12 L-112 12 Z' }, ship);
    svg('path', { class: 'ship-stripe', d: 'M-128 -6 L124 -6 L121 0 L-121 0 Z' }, ship);
    svg('rect', { class: 'ship-deck', x: -40, y: -46, width: 84, height: 30, rx: 3 }, ship);
    svg('rect', { class: 'ship-deck', x: -18, y: -68, width: 40, height: 24, rx: 3 }, ship);
    svg('rect', { class: 'ship-window', x: -12, y: -62, width: 28, height: 6, rx: 2 }, ship);
    svg('rect', { class: 'ship-deck', x: 52, y: -40, width: 18, height: 24, rx: 2 }, ship);
    svg('line', { class: 'ship-mast', x1: 4, y1: -68, x2: 4, y2: -108 }, ship);
    svg('line', { class: 'ship-mast', x1: -10, y1: -94, x2: 18, y2: -94 }, ship);
    svg('path', { class: 'ship-flag', d: 'M4 -108 L30 -102 L4 -96 Z' }, ship);
    // Gun turrets fore and aft
    svg('rect', { class: 'ship-deck', x: -92, y: -28, width: 28, height: 12, rx: 4 }, ship);
    svg('line', { class: 'ship-gun', x1: -92, y1: -24, x2: -124, y2: -30 }, ship);
    svg('rect', { class: 'ship-deck', x: 80, y: -28, width: 28, height: 12, rx: 4 }, ship);
    svg('line', { class: 'ship-gun', x1: 108, y1: -24, x2: 136, y2: -30 }, ship);
  }

  function isStruck(st, i) {
    return !!st.strike && st.strike.kind === 'facility' && st.strike.id === i;
  }
  function strikeName(sk) {
    return sk.kind === 'facility' ? `Facility ${sk.id}` : `route ${sk.u}–${sk.v}`;
  }

  function pill(parent, x, y, text, cls, fs) {
    const g = svg('g', { class: `${cls} fade-in` }, parent);
    const w = text.length * fs * 0.62 + 28, h = fs + 18;
    svg('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: h / 2 }, g);
    const t = svg('text', { x, y: y + fs * 0.36 }, g);
    t.textContent = text;
  }
  function badge(parent, x, y, text, cls = '') {
    const g = svg('g', { class: `badge-svg fade-in ${cls}` }, parent);
    const w = text.length * 16 + 40, h = 46;
    svg('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 8 }, g);
    const t = svg('text', { x, y: y + 9 }, g);
    t.textContent = text;
  }

  // ---------- side panels ----------
  function listNodes(arr, dp = 0, min = 0.1) {
    const items = [];
    arr.forEach((v, i) => { if (v > min) items.push(`F${i + 1} ${fmt(v, dp)}`); });
    return items.length ? items.join(' · ') : '—';
  }

  function renderActions(st) {
    const badges = $('insp-badges');
    const b = $('b-actions');
    if (st.round === 0) {
      badges.innerHTML = '<span class="empty">No inspections yet. Press Step to solve round 1.</span>';
      b.innerHTML = '<dt>Status</dt><dd>Initial stockpile placed. Round 1 is solved when you step forward.</dd>';
      return;
    }
    const ids = [];
    st.inspections.forEach((v, i) => { if (v > 0) ids.push(i + 1); });
    const ev = st.a_eval;
    if (st.blockade) {
      badges.innerHTML = `<span class="badge badge-strike"><svg class="ic" aria-hidden="true"><use href="#i-bolt"/></svg>Blockade · ${fmt(st.blocked, 0)} units of imports stopped</span>`;
    } else if (st.strike) {
      badges.innerHTML = `<span class="badge badge-strike"><svg class="ic" aria-hidden="true"><use href="#i-bolt"/></svg>Strike on ${strikeName(st.strike)} · ${st.strike.destroyed > 0.05 ? `−${fmt(st.strike.destroyed, 1)} destroyed` : 'nothing there'}</span>`;
    } else {
      badges.innerHTML = ids.map((i) =>
        `<span class="badge"><svg class="ic" aria-hidden="true"><use href="#i-target"/></svg>Facility ${i} · ${st.losses[i - 1] > 0.05 ? `−${fmt(st.losses[i - 1], 1)} seized` : 'nothing seized'}</span>`).join('');
    }
    if (ev) {
      const kp = ev.kind_probs, pct = (x) => `${fmt(x * 100, 0)}%`;
      badges.innerHTML += `<p class="a-why">Confidence-weighted, A expected ${fmt(ev.inspect, 1)} from its best inspection` +
        (ev.best_strike ? `, ${fmt(ev.best_strike.value, 1)} from striking ${strikeName(ev.best_strike)}` : '') +
        `, and a certain ${fmt(sim.params.import_amount * S.IMPORT_NODES.length, 1)} from a blockade. ` +
        `Odds: inspect ${pct(kp.inspect)} · strike ${pct(kp.facility)} · blockade ${pct(kp.blockade)}; this exact pick ${pct(ev.choice_prob)}</p>`;
    }
    const flows = st.flows.length ? st.flows.map((f) => `${f.from}→${f.to} ${fmt(f.amount, 1)}`).join(' · ') : '—';
    const po = st.posture, p = sim.params;
    const mood = po.need <= 0 ? 'Broken out' : po.on_schedule >= 1 ? 'On schedule' : po.on_schedule <= 0 ? 'Desperate' : 'Pressing';
    b.innerHTML = `
      <dt>Posture</dt><dd>${mood} · threats weighted ×${fmt(po.gamma, 2)} · needs ${fmt(po.need, 0)} in ${po.rounds_left} round${po.rounds_left === 1 ? '' : 's'} (${fmt(po.required_pace, 0)}/round, ${fmt(po.urgency * 100, 0)}% of top pace)</dd>
      <dt>Imports</dt><dd>${listNodes(st.imports, 1, 0.05)}</dd>
      <dt>Open research</dt><dd>${listNodes(st.n_open)}</dd>
      <dt>Covert research</dt><dd>${listNodes(st.n_covert)}</dd>
      <dt>Transports</dt><dd>${flows}</dd>`;
  }

  function renderKpis(st) {
    const p = sim.params;
    tweenText($('kpi-progress'), st.cum_progress, 1);
    $('kpi-progress-d').textContent = `+${fmt(st.progress, 1)} this round`;
    tweenText($('kpi-seized'), st.cum_seized + st.cum_destroyed, 1);
    $('kpi-seized-d').textContent = `+${fmt(st.seized + st.destroyed, 1)} this round`;
    tweenText($('kpi-stock'), sum(st.m), 0);
    $('kpi-stock-d').textContent = st.round === 0 ? 'initial placement' : 'at start of round';
    const pct = Math.min(100, (st.cum_progress / p.breakout_goal) * 100);
    $('donut-bar').setAttribute('stroke-dasharray', `${pct.toFixed(2)} 100`);
    tweenText($('donut-value'), pct, 1, '%');
    $('donut-goal').textContent = `of ${fmt(p.breakout_goal, 0)} progress goal`;
  }

  function renderRanking(st) {
    const ol = $('ranking');
    const order = st.m.map((m, i) => [m, i + 1]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const max = Math.max(1, order[0][0]);
    // Reuse buttons keyed by facility so bar widths animate
    if (!ol.children.length) {
      for (let i = 1; i <= N; i++) {
        const li = document.createElement('li');
        li.innerHTML = `<button type="button" data-id="${i}"><span class="rk-name">F${i}</span><span class="rk-bar"><i></i></span><span class="rk-val"></span></button>`;
        li.querySelector('button').addEventListener('click', () => select(i));
        ol.appendChild(li);
      }
    }
    const byId = {};
    [...ol.children].forEach((li) => { byId[li.firstChild.dataset.id] = li; });
    order.forEach(([m, id]) => {
      const li = byId[id];
      ol.appendChild(li);
      const btn = li.firstChild;
      const insp = st.inspections[id - 1] > 0;
      const hit = isStruck(st, id);
      btn.querySelector('i').style.width = `${(m / max) * 100}%`;
      btn.querySelector('i').classList.toggle('insp', insp || hit);
      btn.querySelector('.rk-val').textContent = fmt(m, 0);
      btn.classList.toggle('selected', id === selected);
      btn.setAttribute('aria-label', `Facility ${id}: ${fmt(m, 1)} units${insp ? ', inspected' : ''}${hit ? ', struck' : ''}`);
    });
  }

  function renderDetail(st) {
    const i = selected - 1;
    $('detail-id').textContent = selected;
    const next = Math.max(0, st.m[i] - st.outflows[i] + st.inflows[i] - st.losses[i]) + st.imports[i];
    const insp = st.inspections[i] > 0;
    const rows = [
      ['Start stockpile', fmt(st.m[i], 1), ''],
      ['Open research', fmt(st.n_open[i], 1), 'blue'],
      ['Covert research', fmt(st.n_covert[i], 1), 'blue'],
      ['Idle', fmt(st.s_idle[i], 1), ''],
      ['Transport in / out', `+${fmt(st.inflows[i], 1)} / −${fmt(st.outflows[i], 1)}`, ''],
      ['Imports arriving', st.imports[i] > 0.05 ? `+${fmt(st.imports[i], 1)}` : '—', st.imports[i] > 0.05 ? 'pos' : ''],
      ['Heat', fmt(st.h[i], 1), ''],
      ['B\'s inspection risk', st.round === 0 ? '—' : `${fmt(st.pi_est[i] * 100, 0)}%`, ''],
      ['B\'s strike risk', st.round === 0 ? '—' : `${fmt(st.strike_est[i] * 100, 0)}%`, ''],
      ['Country A', isStruck(st, selected) ? 'Struck' : insp ? 'Inspected' : '—', isStruck(st, selected) || insp ? 'neg' : ''],
      [isStruck(st, selected) ? 'Destroyed' : 'Seized', fmt(st.losses[i], 1), st.losses[i] > 0.05 ? 'neg' : ''],
      ['Progress added', fmt(st.node_progress[i], 1), 'blue'],
      ['Next stockpile', st.round === 0 ? '—' : fmt(next, 1), 'pos'],
    ];
    $('detail').innerHTML = rows.map(([k, v, c]) => `<dt>${k}</dt><dd class="${c}">${v}</dd>`).join('');
  }

  function renderTable(st) {
    $('table-title').textContent = st.round === 0 ? 'Round 0 per-facility breakdown · initial setup' : `Round ${st.round} per-facility breakdown`;
    const rows = [];
    for (let i = 0; i < N; i++) {
      const insp = st.inspections[i] > 0;
      const hit = isStruck(st, i + 1);
      const net = st.inflows[i] - st.outflows[i];
      const intercepted = (insp && st.n_open[i] > 0.1) || (hit && st.n_open[i] + st.n_covert[i] > 0.1);
      const cls = [insp || hit ? 'inspected' : '', i + 1 === selected ? 'selected' : ''].join(' ');
      rows.push(`<tr class="${cls}" data-id="${i + 1}">
        <td class="fac-name">Facility ${i + 1}</td>
        <td class="num">${fmt(st.m[i], 1)}</td>
        <td class="num ${st.imports[i] > 0.05 ? 'c-teal' : 'c-dim'}">${st.imports[i] > 0.05 ? '+' + fmt(st.imports[i], 1) : '—'}</td>
        <td class="num">${fmt(st.n_open[i], 1)}</td>
        <td class="num">${fmt(st.n_covert[i], 1)}</td>
        <td class="num">${fmt(st.s_idle[i], 1)}</td>
        <td class="num ${Math.abs(net) > 0.05 ? 'c-teal' : 'c-dim'}">${net > 0.05 ? '+' : ''}${fmt(net, 1)}</td>
        <td class="num">${fmt(st.h[i], 1)}</td>
        <td class="num">${st.round === 0 ? '—' : fmt(st.pi_est[i] * 100, 0) + '%'}</td>
        <td>${hit ? '<span class="yes">Struck</span>' : insp ? '<span class="yes">Inspected</span>' : '<span class="no">—</span>'}</td>
        <td class="num ${st.losses[i] > 0.05 ? 'c-pink' : 'c-dim'}">${fmt(st.losses[i], 1)}</td>
        <td class="num c-blue">${fmt(st.node_progress[i], 1)}${intercepted ? ' <span class="c-pink">(intercepted)</span>' : ''}</td>
      </tr>`);
    }
    $('table-body').innerHTML = rows.join('');
  }

  // ---------- charts ----------
  function renderChart(id, series, colors, labelFn) {
    const el = $(id);
    el.replaceChildren();
    const W = 520, H = 180, L = 34, R = 8, T = 10, B = 22;
    const R_ = maxRound();
    const solved = sim.history.slice(1);
    const totals = solved.map((st) => series.reduce((s, f) => s + f(st), 0));
    const rawMax = Math.max(1, ...totals);
    const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const yMax = Math.ceil(rawMax / mag / (rawMax / mag > 5 ? 2 : 1)) * mag * (rawMax / mag > 5 ? 2 : 1);
    const y = (v) => T + (H - T - B) * (1 - v / yMax);
    const band = (W - L - R) / R_;
    const bw = Math.max(3, band * 0.58);

    const grid = svg('g', { class: 'grid' }, el);
    const axis = svg('g', { class: 'axis' }, el);
    for (let k = 0; k <= 4; k++) {
      const v = (yMax / 4) * k;
      svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v) }, grid);
      const t = svg('text', { x: L - 6, y: y(v) + 3, 'text-anchor': 'end' }, axis);
      t.textContent = v >= 100 ? Math.round(v) : +v.toFixed(1);
    }
    const labelEvery = R_ > 24 ? 5 : R_ > 12 ? 2 : 1;
    for (let r = 1; r <= R_; r++) {
      const x0 = L + band * (r - 1);
      const st = sim.history[r];
      const g = svg('g', { class: 'bar-col' + (r === view ? ' current' : '') }, el);
      svg('rect', { class: 'hover-bg', x: x0, y: T, width: band, height: H - T - B }, g);
      if (st) {
        let acc = 0;
        series.forEach((f, si) => {
          const v = f(st);
          if (v <= 0) return;
          svg('rect', { x: x0 + (band - bw) / 2, y: y(acc + v), width: bw, height: Math.max(0, y(acc) - y(acc + v)), fill: colors[si], rx: 1.5 }, g);
          acc += v;
        });
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', `Round ${r}: ${labelFn(st).replace(/<[^>]+>/g, ' ')}`);
        const show = (e) => showTip(e, `<b>Round ${r}</b>${labelFn(st)}`, g);
        g.addEventListener('mouseenter', show);
        g.addEventListener('mousemove', show);
        g.addEventListener('focus', show);
        g.addEventListener('mouseleave', hideTip);
        g.addEventListener('blur', hideTip);
        g.addEventListener('click', () => { stopPlay(); goTo(r); });
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stopPlay(); goTo(r); } });
      } else {
        svg('rect', { class: 'placeholder', x: x0 + (band - bw) / 2, y: y(0) - 8, width: bw, height: 8 }, g);
      }
      if (r % labelEvery === 0 || r === 1) {
        const t = svg('text', { x: x0 + band / 2, y: H - 6, 'text-anchor': 'middle' }, axis);
        t.textContent = r;
      }
    }
  }
  function showTip(e, html, target) {
    const tip = $('chart-tip');
    tip.innerHTML = html;
    tip.hidden = false;
    let x, yy;
    if (e.type === 'focus') {
      const r = target.getBoundingClientRect();
      x = r.left + r.width / 2; yy = r.top;
    } else { x = e.clientX; yy = e.clientY; }
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - tw - 8, Math.max(8, x - tw / 2)) + 'px';
    tip.style.top = (yy - tip.offsetHeight - 12) + 'px';
  }
  function hideTip() { $('chart-tip').hidden = true; }

  function renderCharts() {
    const openP = (st) => sum(st.prog_open);
    const covP = (st) => sum(st.prog_covert);
    renderChart('chart-progress', [openP, covP], ['var(--blue)', 'var(--blue-pale)'],
      (st) => `Open ${fmt(openP(st), 1)}<br>Covert ${fmt(covP(st), 1)}<br>Total ${fmt(st.progress, 1)}`);
    renderChart('chart-seized', [(st) => st.seized, (st) => st.destroyed, (st) => st.blocked], ['var(--pink)', 'var(--amber)', 'var(--teal)'],
      (st) => `Seized ${fmt(st.seized, 1)}<br>Destroyed ${fmt(st.destroyed, 1)}<br>Imports blocked ${fmt(st.blocked, 1)}${st.strike ? `<br>Strike: ${strikeName(st.strike)}` : ''}`);
  }

  // ---------- render orchestration ----------
  function updateScrubSolved() {
    const pct = (solvedRound() / maxRound()) * 100;
    $('scrub-solved').style.width = `${pct}%`;
    $('solved-count').textContent = solvedRound();
  }

  function render() {
    const st = sim.history[view];
    const R = maxRound();
    renderMap(st);
    renderActions(st);
    renderKpis(st);
    renderRanking(st);
    renderDetail(st);
    renderTable(st);
    renderCharts();

    $('top-round').textContent = view;
    $('scrub-value').textContent = view;
    const sc = $('scrubber');
    sc.value = view;
    sc.style.setProperty('--pct', `${(view / R) * 100}%`);
    sc.setAttribute('aria-valuetext', `Round ${view} of ${R}`);
    updateScrubSolved();

    const insp = [];
    st.inspections.forEach((v, i) => { if (v > 0) insp.push(i + 1); });
    $('round-caption').textContent = view === 0
      ? `Round 0 of ${R} · initial setup · ${fmt(sum(st.m), 0)} units placed`
      : st.blockade
        ? `Round ${view} of ${R} · Country A blockades the ports instead of inspecting`
        : st.strike
        ? `Round ${view} of ${R} · Country A strikes ${strikeName(st.strike)} instead of inspecting`
        : `Round ${view} of ${R} · Country A inspects ${insp.map((i) => 'F' + i).join(', ')}`;

    $('btn-prev').disabled = view === 0;
    $('btn-reset').disabled = view === 0;
    const atEnd = view >= R;
    $('btn-next').disabled = atEnd;
    $('next-label').textContent = atEnd ? 'Done' : view < solvedRound() ? 'Next' : 'Step';
    $('btn-next').title = view < solvedRound() ? 'Next round (→)' : 'Solve the next round (→)';
  }

  function select(i) {
    selected = i;
    if (sim) {
      const st = sim.history[view];
      for (let k = 1; k <= N; k++) {
        nodeEls[k].g.classList.toggle('selected', k === i);
        nodeEls[k].g.setAttribute('aria-pressed', k === i ? 'true' : 'false');
      }
      renderRanking(st);
      renderDetail(st);
      renderTable(st);
    }
  }

  // ---------- wiring ----------
  function wire() {
    $('btn-next').addEventListener('click', () => { stopPlay(); goTo(view + 1); });
    $('btn-prev').addEventListener('click', () => { stopPlay(); goTo(view - 1); });
    $('btn-reset').addEventListener('click', () => { stopPlay(); goTo(0); });
    $('btn-play').addEventListener('click', togglePlay);
    $('scrubber').addEventListener('input', (e) => {
      stopPlay();
      goTo(parseInt(e.target.value, 10));
    });
    $('table-body').addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr) select(parseInt(tr.dataset.id, 10));
    });
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'select', 'textarea', 'button', 'summary'].includes(tag) || e.target.closest('.fac, .bar-col')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); goTo(view + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); goTo(view - 1); }
      else if (e.key === 'Home') { e.preventDefault(); stopPlay(); goTo(0); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    });
    // Pause playback when the tab is hidden
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); });
  }

  function init() {
    buildForm();
    buildMap();
    wire();
    applyForm();
    S.loadSolver()
      .then(() => { solverReady = true; setSolverChip('ready', 'HiGHS solver ready'); })
      .catch((err) => {
        console.error(err);
        setSolverChip('error', 'Solver failed to load');
        showToast('The LP solver could not be loaded. Check your internet connection and reload the page.');
      });
  }

  init();
})();
