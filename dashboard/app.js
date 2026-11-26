(() => {
  'use strict';
  const app = document.getElementById('app');
  const data = globalThis.RADAR_DATA;
  if (!data) {
    app.textContent = 'Run main.ts and open out/dashboard/index.html.';
    return;
  }
  const { snapshot, board, fingerprint } = data;
  const M = globalThis.RadarModel;
  const { ledger, model, scored, board: refit } = M.buildRadar(snapshot);
  const featured = scored.find(r => r.p.bucket === 'Watchlist' && r.plan.verdict === 'FARM' && r.plan.p25 > 0)
    || scored.find(r => r.p.bucket === 'Early' && r.plan.verdict === 'FARM' && r.plan.p25 > 0);
  const filtersDefault = { cohort: '', category: '', mode: 'worth', sort: 'rank', reverse: false, query: '', page: 0 };
  const state = { tab: 'Board', ...filtersDefault, ...M.DEFAULTS, expanded: featured?.p.slug };
  const categories = [...new Set(scored.map(r => r.p.category))].sort();
  const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const e = value => String(value).replace(/[&<>"]/g, c => escaped[c]);
  const cash = (value, digits = 0) => (value < 0 ? '−' : '') + '$' + Math.abs(value)
    .toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const signed = value => value >= 0 ? '+' + cash(value) : cash(value);
  const money = value => value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B`
    : value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : cash(value);
  const percent = (value, digits = 1) => (value * 100).toFixed(digits) + '%';
  const growth = n => n === null ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  const mult = n => '×' + n.toFixed(2);
  const tag = name => `<code>${name}()</code>`;
  const tone = n => n >= 0 ? 'positive' : 'negative';
  const badge = label => `<span class="badge ${label.toLowerCase()}">${label}</span>`;
  const heading = (title, name = '', right = '') => `<div class="heading"><h2>${title} ${name ? tag(name) : ''}</h2>${right}</div>`;
  const panel = (title, name, body) => `<section class="panel">${heading(title, name)}${body}</section>`;
  const metric = (label, value, note = '') => `<div class="metric"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
  const control = (action, label, value = '', pressed = false) => `<button type="button" data-action="${action}" data-value="${e(value)}"${pressed ? ' aria-pressed="true"' : ''}>${label}</button>`;
  const table = (labels, body, cls = '') => `<div class="tablebox"><table class="${cls}"><thead><tr>${labels.map(l => `<th>${l}`).join('')}<tbody>${body}</table></div>`;
  const tr = (cells, attrs = '') => `<tr ${attrs}>${cells.map(c => `<td>${c}`).join('')}</tr>`;
  const ledgerCount = Object.values(ledger).reduce((n, list) => n + list.length, 0);
  const watches = new Set(snapshot.watchlist);
  const covered = scored.filter(r => watches.has(r.p.slug)).length;
  const valueTotal = rows => rows.reduce((n, r) => n + r.implied_value_usd, 0);
  const identical = refit.rows.filter((r, i) => JSON.stringify(r) === JSON.stringify(board.rows[i])).length;
  const ledgerUnique = new Set(Object.values(ledger).flatMap(rows => rows.map(p => p.slug))).size;
  const checks = [
    [identical === refit.rows.length && identical === board.rows.length, `${identical}/${board.rows.length} rows = board.json`],
    [refit.rows.every((r, i, rows) => r.rank === i + 1 && (!i || r.implied_value_usd <= rows[i - 1].implied_value_usd)), 'Ranks contiguous · values never rise'],
    [valueTotal(refit.rows) === valueTotal(board.rows), `Totals ${money(valueTotal(refit.rows))}`],
    [M.checksum(refit) === fingerprint && M.checksum(board) === fingerprint, `${e(fingerprint)} ↔ main.ts`],
    [covered === watches.size, `Watchlist ${covered}/${watches.size}`],
    [ledgerCount === snapshot.protocols.length && ledgerUnique === ledgerCount, `Ledger ${ledgerCount}/${snapshot.protocols.length}`]
  ];

  function masthead() {
    return `<header class="mast"><div class="shell mast-inner"><div class="brand"><i aria-hidden="true"></i>Forward Window <sup>v4</sup></div>
      <nav aria-label="Dashboard">${['Board', 'Token trades', 'Method'].map(item => control('tab', item, item, state.tab === item)).join('')}</nav>
      <div class="stamp"><b>DEFILLAMA / SEALED</b><span>${e(snapshot.as_of)} UTC</span></div></div></header>`;
  }

  function integrity() {
    return `<div class="integrity"><b>REFIT ${checks.every(([pass]) => pass) ? 'PASSED' : 'FAILED'}</b>${checks.map(([pass, text]) => `<span>${pass ? '✓' : '✗'} ${text}</span>`).join('')}</div>`;
  }

  function prices() {
    return scored.map(row => ({ ...row, plan: state.ticket || state.drop !== M.DEFAULTS.drop || state.weeks !== M.DEFAULTS.weeks
      ? M.farmPlan(row.p, row.value, state) : row.plan }));
  }

  function summary(rows) {
    const counts = Object.groupBy(rows, r => r.plan.verdict);
    const [, walk] = model.audit;
    return `<div class="kpis">${metric('Watchlist covered', `${covered}<em> / ${watches.size}</em>`, `${scored.length} ranked · ${ledger.Early.length} early`)}
      ${metric('FARM candidates', counts.FARM?.length ?? 0, `${counts.MARGINAL?.length ?? 0} MARGINAL · ${counts.SKIP?.length ?? 0} SKIP`)}
      ${metric('Current-status Brier', model.odds.scores[0].toFixed(4), `${model.odds.scores[1].toFixed(4)} forward`)}
      ${metric('Cap log error', model.cap.scores[1].toFixed(3), `${model.cap.rows[0].scores[1].toFixed(3)} forward baseline`)}
      ${metric('Cap range hits · forward', `${percent(walk.inner, 0)}<em> / </em>${percent(walk.outer, 0)}`, `P25–75 / P10–90 · n=${walk.n}`)}
      ${metric('Inputs that move value', 'TVL × 7d × age', '5×5 + walk-forward evidence')}</div>`;
  }

  function hero() {
    return `<section class="hero"><div><h1>Token launch radar</h1><p>Ranks protocols that record no token.</p></div>
      <div class="hero-equation"><span>IMPLIED VALUE / USD</span><strong>Cap at launch × 24-month odds</strong><small>TVL · 7-day growth · time since listing</small></div></section>`;
  }

  function shortlist(rows) {
    const top = rows.filter(r => r.plan.verdict === 'FARM' && r.plan.p25 > 0).sort((a, b) => b.plan.hourly - a.plan.hourly || a.rank - b.rank).slice(0, 6);
    const stat = (label, n) => `<span>${label}<b>${n}</b></span>`;
    return `<section class="panel shortlist">${heading('Farm these first', 'farmPlan', '<small>Highest $/h · P25 above $0</small>')}
      <div class="picks">${top.map(({ p, rank, implied, plan }) => `<article class="pick"><div class="pick-head"><span class="rank">#${rank}</span>
      ${control('detail', e(p.name), p.slug)}${badge(plan.verdict)}</div><div class="pick-body">${stat('Implied', money(implied))}${stat('Ticket', cash(plan.ticket))}${stat('Net', signed(plan.net))}${stat('P25', signed(plan.p25))}<strong>${cash(plan.hourly)}<small>/h</small></strong></div></article>`).join('') || 'No plans clear the FARM threshold.'}</div></section>`;
  }

  function settings() {
    return `<div class="settings"><div><span class="label">TICKET PRESETS</span><div class="buttons">${[[0, 'Plan size'], [1000, '$1K'], [10000, '$10K'], [25000, '$25K']].map(([n, label]) => control('ticket', label, n, state.ticket === n)).join('')}</div></div>
      <label>DROP SHARE %<input id="drop" type="number" min="0" max="30" step="0.5" value="${state.drop * 100}"></label>
      <label>HOLD WEEKS<input id="weeks" type="number" min="2" max="26" step="1" value="${state.weeks}"></label></div>`;
  }

  function filters() {
    function menu(id, label, choices) {
      return `<select id="${id}" aria-label="${label}">${choices.map(choice => {
        const [value, text] = Array.isArray(choice) ? choice : [choice, choice];
        return `<option value="${e(value)}"${state[id] === value ? ' selected' : ''}>${e(text)}</option>`;
      }).join('')}</select>`;
    }
    return `<div class="filters"><input type="search" id="query" aria-label="Search protocol or chain" placeholder="Search" value="${e(state.query)}">
      ${menu('cohort', 'Cohort', [['', 'All cohorts'], ...M.BUCKETS.slice(0, 3)])}
      ${menu('category', 'Category', [['', 'All categories'], ...categories])}
      ${menu('mode', 'Verdict', [['worth', 'Worth farming'], ['all', 'All verdicts'], ['FARM', 'FARM only'], 'MARGINAL', 'SKIP'])}
      ${control('reset', 'Reset')}</div>`;
  }

  const sortKeys = {
    rank: r => r.rank, name: r => r.p.name.toLowerCase(), tvl: r => r.p.tvl_usd, growth: r => r.p.change_7d ?? -Infinity,
    implied: r => r.implied, ticket: r => r.plan.ticket, net: r => r.plan.net, p25: r => r.plan.p25, hourly: r => r.plan.hourly
  };
  const descending = key => key !== 'rank' && key !== 'name';

  function matching(rows) {
    const query = state.query.trim().toLowerCase();
    const key = sortKeys[state.sort];
    const priority = row => Number(state.mode === 'worth' && state.sort === 'rank' && row.plan.verdict === 'FARM');
    return rows.filter(({ p, plan }) => (!state.cohort || p.bucket === state.cohort) && (!state.category || p.category === state.category)
      && (!query || [p.name, p.slug, p.category, ...p.chains].join(' ').toLowerCase().includes(query))
      && (state.mode === 'all' || (state.mode === 'worth' ? plan.verdict !== 'SKIP' : plan.verdict === state.mode)))
      .sort((a, b) => priority(b) - priority(a) || (key(a) < key(b) ? -1 : Number(key(a) > key(b))) * (descending(state.sort) !== state.reverse ? -1 : 1) || a.rank - b.rank);
  }

  function sort(key, text) {
    const arrow = state.sort === key ? (descending(key) !== state.reverse ? ' ↓' : ' ↑') : '';
    return control('sort', `${text}${arrow}`, key, state.sort === key);
  }

  function inline({ p, plan }) {
    return `<tr class="expanded"><td colspan="10"><div class="inline"><div><b>${e(plan.book)} · ${e(plan.route)}</b> ${tag('farmPlan')}<p>${e(plan.steps[2].action)}</p></div>
      <div><b>Stop below ${cash(plan.stop)} TVL</b><p>${plan.days} days · ${cash(plan.cost, 2)} costs</p></div>
      <b class="${tone(plan.p25)}">${signed(plan.net)} net · ${signed(plan.p25)} P25</b>${control('detail', 'Full plan ↗', p.slug)}</div></td></tr>`;
  }

  function boardPanel(list, filtered) {
    const pageSize = filtered ? 12 : 6;
    const page = Math.min(state.page, Math.max(0, Math.ceil(list.length / pageSize) - 1));
    const from = page * pageSize;
    const visible = list.slice(from, from + pageSize);
    const headers = [['rank', 'Rank'], ['name', 'Protocol'], ['tvl', 'TVL'], ['growth', '7d'], ['implied', 'Implied value'], ['ticket', 'Ticket'], ['net', 'Net'], ['p25', 'P25 net'], ['hourly', '$/h']];
    const body = visible.map(row => {
      const { p, rank, implied, plan } = row;
      const open = state.expanded === p.slug;
      const name = `${control('expand', `${open ? '−' : '+'} &nbsp; ${e(p.name)}`, p.slug, open)}<small>${e(p.bucket)} · ${e(p.category)} · ${e(plan.route)}</small>`;
      const why = plan.verdict === 'SKIP' ? `<small class="negative">${e(plan.reason)}</small>` : '';
      return tr([`<span class="rank">${rank}</span>`, name + why, money(p.tvl_usd), growth(p.change_7d), `<b>${money(implied)}</b>`,
        cash(plan.ticket), signed(plan.net), `<b class="${tone(plan.p25)}">${signed(plan.p25)}</b>`, signed(plan.hourly), badge(plan.verdict)],
      `data-verdict="${plan.verdict}" class="${open ? 'active-row' : ''}"`) + (open ? inline(row) : '');
    }).join('');
    const priority = state.sort === 'rank' && state.mode === 'worth' ? ' · FARM first' : '';
    return `<section class="panel ranked">${heading('Ranked launch board', 'impliedValue', `<span class="legend">${list.length} matches · canonical ranks${priority}</span>`)}
      <div class="board-controls">${filters()}${settings()}</div>
      ${table([...headers.map(([k, t]) => sort(k, t)), 'Verdict'], body || '<tr><td colspan="10">No matches.</td></tr>', 'ranking')}
      <div class="pagination"><span>${visible.length ? `${from + 1}–${from + visible.length} of ${list.length}` : '0 matches'}</span><div>${page ? control('page', 'Previous', page - 1) : ''} ${from + pageSize < list.length ? control('page', 'Next', page + 1) : ''}</div></div></section>`;
  }

  function accounting(rows = []) {
    const labels = ['Watchlist', 'Early under $50M', 'Off-list / linked', 'Token trades', 'Recorded / unpriced', 'Excluded'];
    const skip = rows.find(r => r.plan.verdict === 'SKIP');
    return `<section class="panel">${heading('Protocol ledger', 'ledgerOf', `<small>${ledgerCount} disjoint records</small>`)}
      <div class="ledger-bar">${M.BUCKETS.map((k, i) => `<i class="b${i}" style="flex:${ledger[k].length}"></i>`).join('')}</div>
      <div class="ledger-keys">${M.BUCKETS.map((k, i) => `<span><i class="b${i}"></i><b>${ledger[k].length}</b> ${labels[i]}</span>`).join('')}</div>
      ${skip ? `<p class="skip-callout"><b>#${skip.rank} ${e(skip.p.name)} · SKIP</b> ${e(skip.plan.reason)}</p>` : ''}</section>`;
  }

  function drivers() {
    const targets = scored.filter(r => r.p.age && r.p.change_7d !== null && r.p.bucket !== 'Off-list');
    const ratios = targets.map(r => M.counterfactuals(r.p, model));
    const middle = i => mult(ratios.map(r => r[i].value).sort((a, b) => a - b)[Math.floor(ratios.length / 2)]);
    return `<section class="panel drivers">${heading('What drives implied value', 'impliedValue', control('tab', 'Full evidence ↗', 'Method'))}
      <div class="driver-grid">${metric('TVL ×', middle(0), 'Double TVL · cap fit')}${metric('7-day growth ×', middle(1), '+20 pp · ' + (model.scenarioCarry ? 'scenario carry' : 'retained fit'))}
      ${metric('No-token age ×', middle(2), '+365 days · conditional odds')}</div><small>Median effects over ${targets.length} rows. Cap held-out terms: ${model.cap.spec.terms.join(', ')}.</small></section>`;
  }

  function filteredIntro(list) {
    const eligible = list.filter(r => r.plan.verdict === 'FARM');
    return `<section class="hero filter-hero"><div><h1>${e(state.category)}</h1><p>${e(state.cohort)} · ${list.length} matches</p></div>
      <div class="filter-totals">${metric('Positive P25 FARM', eligible.length)}${metric('Best net / hr', list.length ? signed(Math.max(...list.map(r => r.plan.hourly))) : '—')}</div></section>`;
  }

  function renderBoard(rows) {
    const list = matching(rows);
    const filtered = Boolean(state.cohort && state.category);
    return `${filtered ? filteredIntro(list) : hero() + summary(rows)}${integrity()}
      ${filtered ? '' : shortlist(rows)}${boardPanel(list, filtered)}<div class="overview">${drivers()}${accounting(filtered ? [] : rows)}</div>`;
  }

  function rangeAudit() {
    return panel('Range honesty', 'fitModel', table(['Cap interval', 'Expected', '5×5', 'Walk-forward'],
      tr(['P25–P75', '50%', ...model.audit.map(a => percent(a.inner))]) + tr(['P10–P90', '80%', ...model.audit.map(a => percent(a.outer))])
      + tr(['Held-out predictions', '—', ...model.audit.map(a => a.n)]))
      + '<small>Nested selection. Forward bands use older cohorts.</small>');
  }

  function scatter() {
    const xs = n => 62 + (Math.log10(n) - 6.6) * 126.8;
    const ys = n => 257 - (Math.log10(n) - 4) * 34.7;
    const svg = `<svg viewBox="0 0 650 288" role="img" aria-label="Log-log market cap by TVL, USD">
      ${[7, 8, 9, 10, 11].map(i => `<path d="M${xs(10 ** i)} 14V257"/><text x="${xs(10 ** i)}" y="277" text-anchor="middle">${money(10 ** i)}</text>`).join('')}
      ${[4, 5, 6, 7, 8, 9, 10, 11].map(i => `<path d="M62 ${ys(10 ** i)}H620"/><text x="56" y="${ys(10 ** i) + 4}" text-anchor="end">${money(10 ** i)}</text>`).join('')}
      <line x1="${xs(5e6)}" y1="${ys(M.baselineCap(5e6, model))}" x2="${xs(1e11)}" y2="${ys(M.baselineCap(1e11, model))}"/>
      ${model.comps.map(p => `<circle cx="${xs(p.tvl_usd)}" cy="${ys(p.mcap_usd)}" r="3"><title>${e(p.name)}</title></circle>`).join('')}</svg>`;
    return `<section class="panel plot">${heading('Cap vs TVL', 'fitModel', 'LOG–LOG · USD')}${svg}<p>● ${model.comps.length} priced families · ━ pooled fit</p></section>`;
  }

  function method() {
    const tests = (key, title, loss) => panel(title, key === 'cap' ? 'fitModel' : 'tokenOdds',
      table(['Candidate', 'Decision', `5×5 ${loss}`, `Forward ${loss}`], model[key].rows.map(r => tr([r.label, r.state, ...r.scores.map(s => s.toFixed(5))])).join('')));
    return `<h1>Model evidence</h1>${integrity()}
      <section class="panel"><b>Selection rule</b><p>Keep at ≥1% mean relative loss reduction, with ≤1% increase on either split. Shuffled growth is the control.</p>
      <p>Brier tests current status. Forward odds use a listing-age survival scenario. ${model.scenarioCarry ? 'Growth failed selection. Cap carry = exp(0.085 × asinh(clipped relative 7d ÷ 12)).' : ''}</p></section>
      <div class="twocol">${tests('cap', 'Cap term selection', 'log MAE')}${tests('odds', 'Status term selection', 'Brier')}</div>
      <div class="twocol">${scatter()}${rangeAudit()}</div>
      ${panel('Coefficients · 96 seeded bootstrap refits', 'fitModel', table(['Fit', 'Coefficient', 'Estimate', 'Bootstrap s.e.'],
      model.coefficients.map(c => tr([c.key, e(c.name), c.value.toFixed(3), '± ' + c.se.toFixed(3)])).join('')))}`;
  }

  function tradeLedger() {
    const priced = [...ledger.Priced].sort((a, b) => b.mcap_usd - a.mcap_usd);
    return `<h1>Token trades</h1>${accounting()}${panel('Priced comparisons', 'ledgerOf',
      table(['Protocol', 'Category', 'TVL', '7d', 'Reported cap'], priced.map(p => tr([e(p.name), e(p.category), money(p.tvl_usd), growth(p.change_7d), money(p.mcap_usd)])).join('')))}`;
  }

  function detail(row) {
    const { p, rank, implied, value, plan } = row;
    const { base, stages } = M.waterfall(p, model);
    const sum = plan.steps.reduce((n, s) => n + s.cents, 0);
    const proved = sum === Math.round(plan.cost * 100) && sum === plan.steps.at(-1).running;
    const waterfall = `${metric('Reference', money(base.point), '$50M · pooled')}${stages.map(s => metric(s.name, mult(s.factor), `${mult(s.cap)} cap · ${mult(s.odds)} odds`)).join('')}`;
    const costs = table(['When', 'Action', 'Min', 'Cost', 'Running'], plan.steps.map(s =>
      tr([e(s.when), `<b>${e(s.title)}</b><small>${e(s.action)}</small>`, s.time, cash(s.cents / 100, 2), cash(s.running / 100, 2)])).join(''), 'steps');
    return `<div class="detail-title"><div><h1>${e(p.name)}</h1>
      <p>#${rank} · ${e(p.bucket)} · ${e(p.category)} · ${e(plan.route)} · ${p.recorded ? 'token recorded' : 'records no token'}</p></div>${control('tab', '← Board', 'Board')}</div>${integrity()}
      <section class="panel pricing">${heading('Implied value', 'impliedValue', tag('tokenOdds'))}
      <div class="kpis">${metric('TVL', money(p.tvl_usd))}${metric('Seven-day TVL change', growth(p.change_7d))}${metric('Days since listing', p.age ?? 'Unknown')}
      ${metric('Cap if launched', money(value.cap))}${metric('24-month scenario odds', percent(value.odds))}${metric('Implied value', money(implied))}</div>
      <div class="waterfall">${waterfall}</div><small>Reference × factors = implied value · P25–P75 ${money(value.range[1])}–${money(value.range[3])} · P10–P90 ${money(value.range[0])}–${money(value.range[4])}</small></section>
      <section class="panel execution">${heading('Timed execution plan', 'farmPlan', settings())}
      <div class="verdict-line">${badge(plan.verdict)} <b>7 steps over ${plan.days} days on ${cash(plan.ticket)}</b> · ${cash(plan.gross, 2)} expected − ${cash(plan.cost, 2)} costs = <b>${signed(plan.net)}</b> · P25 <b>${signed(plan.p25)}</b> · <b>${cash(plan.hourly)}/h</b></div>
      <small>${e(plan.reason)} · ${plan.minutes} active minutes · ${e(plan.route)} fees</small>
      <div class="execution-grid"><div>${costs}<div class="proof">${proved ? '✓' : '✗'} Σ steps ${cash(sum / 100, 2)} = plan cost ${cash(plan.cost, 2)}</div></div>
      ${sensitivity(row)}</div></section>
      <div class="twocol">${panel('What moves this value', 'impliedValue', table(['Change one input', 'Cap', 'Odds', 'Value'],
      M.counterfactuals(p, model).map(c => tr([`${c.label} · ${c.change}`, mult(c.cap), mult(c.odds), `<b>${mult(c.value)}</b>`])).join('')))}
      ${panel('Nearest priced peers', 'fitModel', table(['Priced peer', 'TVL', 'Market cap', 'Cap / TVL'],
      M.nearestPeers(p, model).map(q => tr([e(q.name), money(q.tvl_usd), money(q.mcap_usd), mult(q.mcap_usd / q.tvl_usd)])).join('')))}</div>`;
  }

  function sensitivity({ p, value, plan }) {
    const simulate = patch => M.farmPlan(p, value, { ...state, ticket: plan.ticket, ...patch });
    const cell = n => `<b class="${tone(n)}">${signed(n)}</b>`;
    const shares = [0.02, 0.04, 0.08, 0.12];
    return `<section class="sensitivity"><h3>Net by weeks held</h3>
      <div class="horizon">${[4, 8, 12, 16, 24].map(weeks => `<div><small>${weeks} wk</small>${cell(simulate({ weeks }).net)}</div>`).join('')}</div>
      <h3>Deposit × drop share</h3>${table(['Ticket', ...shares.map(x => percent(x, 0))], [1_000, 10_000, 25_000].map(ticket =>
        tr([cash(ticket), ...shares.map(drop => cell(simulate({ ticket, drop }).net))])).join(''))}
      <div class="proof"><b>Break-even</b><br>${percent(plan.shareBE, 2)} drop · ${plan.depositBE <= 25000 ? cash(plan.depositBE) : '>$25K'} deposit</div>
      <small>Eligible TVL ${money(plan.eligibleTvl)} (12%). P25 varies cap error and fits.</small></section>`;
  }

  function render() {
    const focused = document.activeElement?.id;
    const rows = prices();
    const page = state.tab === 'Method' ? method() : state.tab === 'Token trades' ? tradeLedger()
      : state.tab === 'Detail' ? detail(rows.find(r => r.p.slug === state.detail)) : renderBoard(rows);
    app.innerHTML = `${masthead()}<main class="shell content" id="content" tabindex="-1">${page}<footer>${e(snapshot.source)} · USD</footer></main>`;
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }

  app.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, value } = button.dataset;
    if (action === 'expand') state.expanded = state.expanded === value ? null : value;
    if (action === 'detail') Object.assign(state, { tab: 'Detail', detail: value });
    if (action === 'tab') state.tab = value;
    if (action === 'ticket') Object.assign(state, { ticket: Number(value), page: 0 });
    if (action === 'reset') Object.assign(state, filtersDefault);
    if (action === 'page') state.page = Number(value);
    if (action === 'sort') Object.assign(state, { reverse: state.sort === value && !state.reverse, sort: value, page: 0 });
    render();
    if (action === 'detail' || action === 'tab') {
      document.getElementById('content').focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } else {
      app.querySelector(`button[data-action="${action}"][data-value="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
    }
  });

  app.addEventListener('change', event => {
    const field = event.target;
    if (['query', 'cohort', 'category', 'mode'].includes(field.id)) state[field.id] = field.value;
    if (field.id === 'drop' && field.value !== '') state.drop = Math.max(0, Math.min(30, +field.value)) / 100;
    if (field.id === 'weeks' && field.value !== '') state.weeks = Math.max(2, Math.min(26, Math.round(+field.value)));
    state.page = 0;
    render();
  });

  render();
})();
