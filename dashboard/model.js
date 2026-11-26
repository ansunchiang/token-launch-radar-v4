(function (surface) {
  'use strict';

  const DAY = 86_400_000;
  const YEAR = 365.25;
  const BOOTSTRAPS = 96;
  const DEFAULTS = Object.freeze({ ticket: 0, drop: 0.08, weeks: 12 });
  const BUCKETS = ['Watchlist', 'Early', 'Off-list', 'Priced', 'Unpriced', 'Excluded'];
  const bounds = (n, min, max) => Math.max(min, Math.min(max, n));
  const order = (a, b) => a < b ? -1 : Number(a > b);
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  const mean = xs => xs.length ? sum(xs) / xs.length : 0;
  const ascending = xs => [...xs].sort((a, b) => a - b);
  const logit = p => Math.log(p / (1 - p));
  const logistic = x => 1 / (1 + Math.exp(-x));
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');

  function quantile(sorted, q) {
    const index = (sorted.length - 1) * q;
    const lower = sorted[Math.floor(index)] ?? 0;
    const upper = sorted[Math.ceil(index)] ?? lower;
    return lower + (upper - lower) * (index % 1);
  }

  function randomStream(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function shuffle(values, random) {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  const isStableReceipt = c => /^(Stablecoin Wrapper|Stablecoin Issuer|Dual-Token Stablecoin|Algo-Stables|Reserve Currency|CDP)$/.test(c);
  const isStructural = p => /Bridge$|^(Liquid Staking|Liquid Restaking|Restaked BTC|CEX|Anchor BTC|Decentralized BTC)$/.test(p.category)
    || /\b(wrapped|staked|staking)\b|\s(?:v\d+(?:\.\d+)*|\d+\.\d+)$/i.test(p.name)
    || /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name);
  const hasRecord = p => Boolean(p.gecko_id || p.symbol || p.mcap_usd > 0);

  function ledgerOf(snapshot) {
    const ledger = Object.fromEntries(BUCKETS.map(key => [key, []]));
    const watch = new Set(snapshot.watchlist);
    const recordedSlugs = new Set(snapshot.protocols.filter(hasRecord).map(p => p.slug));
    const asOf = Date.parse(snapshot.as_of);
    for (const p of snapshot.protocols) {
      const category = p.category || 'Unclassified';
      const age = p.listed_at ? Math.max(1, Math.round((asOf - Date.parse(p.listed_at)) / DAY)) : null;
      const recorded = hasRecord(p);
      const usable = p.mcap_usd > 0 && !isStableReceipt(category);
      const parentHint = p.slug.split('-').slice(0, -1).some((_, i, parts) =>
        recordedSlugs.has(parts.slice(0, i + 1).join('-')));
      const bucket = watch.has(p.slug) ? 'Watchlist' : isStructural(p) ? 'Excluded'
        : recorded ? (usable ? 'Priced' : 'Unpriced')
        : p.tvl_usd >= snapshot.floor_usd || parentHint ? 'Off-list' : 'Early';
      ledger[bucket].push({ ...p, category, age, recorded, bucket, parentHint });
    }
    return ledger;
  }

  function tokenFamilies(rows) {
    const chosen = new Map();
    for (const p of rows) {
      const key = p.gecko_id ? 'id:' + p.gecko_id : p.symbol ? 'ticker:' + p.symbol.toLowerCase() : p.slug;
      if (!chosen.has(key) || chosen.get(key).tvl_usd < p.tvl_usd) chosen.set(key, p);
    }
    return [...chosen.values()];
  }

  const CAP_FEATURES = ['Log TVL', 'Category', 'Log chain count', 'Log days listed', 'Relative 7d', 'Category TVL share', 'Size × age'];
  const ODDS_FEATURES = ['Category', 'Log TVL', 'Relative 7d', 'Log chain count', 'Category TVL share', 'Size × age'];
  const TYPICAL_SIZE = 50e6;

  function design(rows) {
    const totals = new Map();
    for (const p of rows) totals.set(p.category, (totals.get(p.category) || 0) + p.tvl_usd);
    return {
      market: quantile(ascending(rows.flatMap(p => p.change_7d ?? [])), 0.5),
      age: quantile(ascending(rows.flatMap(p => p.age ?? [])), 0.5) || YEAR,
      totals, members: new Set(rows.map(p => p.slug))
    };
  }

  function features(p, context) {
    const size = bounds(Math.log(p.tvl_usd / TYPICAL_SIZE), -4, 7);
    const age = Math.log((p.age ?? context.age) / context.age);
    const growth = p.change_7d === null ? 0 : Math.asinh(bounds(p.change_7d - context.market, -80, 80) / 12);
    const peers = Math.max(0, (context.totals.get(p.category) || 0) - (context.members.has(p.slug) ? p.tvl_usd : 0));
    const share = p.tvl_usd / (peers + p.tvl_usd);
    return {
      'Log TVL': size, 'Log chain count': Math.log(Math.max(1, p.chains.length)),
      'Log days listed': bounds(age, -4, 3), 'Relative 7d': growth,
      'Category TVL share': Math.log1p(20 * share) - Math.log(2),
      'Size × age': size * bounds(age, -3, 2) / 3, 'Shuffled 7d': p.control || 0
    };
  }

  function forwardSplits(rows) {
    const dated = rows.filter(p => p.age !== null).sort((a, b) => b.age - a.age || order(a.slug, b.slug));
    const boundaries = [...new Set([0.40, 0.52, 0.64, 0.76, 0.88].map(q => dated[Math.floor(q * dated.length)]?.age))];
    return boundaries.map((start, i) => ({
      train: dated.filter(p => p.age > start),
      test: dated.filter(p => p.age <= start && p.age > (boundaries[i + 1] ?? -1))
    })).filter(split => split.train.length >= 12 && split.test.length);
  }

  function randomSplits(rows, repeats, parts = 5) {
    const random = randomStream(162097);
    return Array.from({ length: repeats }, () => {
      const mixed = shuffle(rows, random);
      return Array.from({ length: parts }, (_, index) => ({
        train: mixed.filter((_, j) => j % parts !== index), test: mixed.filter((_, j) => j % parts === index)
      }));
    }).flat().filter(split => split.train.length >= 7 && split.test.length);
  }

  function coordinates(records, terms) {
    const columns = [{ name: 'Intercept', group: null, x: records.map(() => 1), penalty: 0 }];
    for (const name of terms) {
      if (name === 'Category') {
        for (const group of new Set(records.map(r => r.p.category))) {
          columns.push({ name, group, x: records.map(r => Number(r.p.category === group)), penalty: 9 });
        }
      } else {
        columns.push({ name, group: null, x: records.map(r => r.x[name]), penalty: name === 'Log TVL' ? 3 : 7 });
      }
    }
    return columns;
  }

  // Current status is eligibility × exposure under an assumed cure curve.
  const exposureAt = (days, c) => -Math.expm1(-((days / (YEAR * c.scale)) ** c.shape));
  const AGE_CURVE = { name: 'Declining hazard', shape: 0.72, scale: 2.5 };
  const OTHER_CURVES = [
    { name: 'Constant hazard', shape: 1, scale: 2.5 },
    { name: 'Front-loaded hazard', shape: 0.55, scale: 1.6 }
  ];

  function fit(rows, terms, curve, kind) {
    const context = design(rows);
    const observations = rows.map(p => ({ p, x: features(p, context) }));
    const cap = kind === 'cap';
    const exposure = cap ? [] : rows.map(p => curve ? exposureAt(p.age ?? context.age, curve) : 1);
    const y = cap ? rows.map(p => Math.log(p.mcap_usd) - Math.log(p.tvl_usd)) : rows.map(p => Number(p.recorded));
    const columns = coordinates(observations, terms);
    const offset = cap ? quantile(ascending(y), 0.5) : logit(bounds(mean(y) / (mean(exposure) || 1), 0.05, 0.95));
    const eta = new Float64Array(rows.length).fill(offset);
    const beta = new Float64Array(columns.length);
    beta[0] = offset;
    // Damped Huber or Bernoulli coordinate updates.
    for (let pass = 0; pass < 13; pass++) {
      for (let j = 0; j < columns.length; j++) {
        const { x, penalty } = columns[j];
        let score = -penalty * beta[j];
        let weight = penalty + 1e-8;
        for (let i = 0; i < y.length; i++) {
          if (!x[i]) continue;
          if (cap) {
            score += x[i] * bounds(y[i] - eta[i], -1.35, 1.35);
            weight += x[i] ** 2;
          } else {
            const a = logistic(eta[i]);
            const p = bounds(a * exposure[i], 1e-7, 1 - 1e-7);
            const d = exposure[i] * a * (1 - a);
            score += x[i] * d * (y[i] - p) / (p * (1 - p));
            weight += x[i] ** 2 * d ** 2 / (p * (1 - p));
          }
        }
        const step = bounds(score / weight, -0.7, 0.7) * 0.85;
        beta[j] += step;
        for (let i = 0; i < eta.length; i++) eta[i] += x[i] * step;
      }
    }
    const effects = new Map();
    const slopes = {};
    columns.forEach(({ name, group }, i) => {
      if (group) effects.set(group, beta[i]);
      else if (i) slopes[name] = beta[i];
    });
    return { intercept: beta[0], slopes, effects, context, curve };
  }

  function scoreLinear(p, fit, x) {
    return fit.intercept + (fit.effects.get(p.category) || 0)
      + sum(Object.keys(fit.slopes).map(key => fit.slopes[key] * x[key]));
  }

  function capLog(p, fitted, x = features(p, fitted.context)) {
    return Math.log(p.tvl_usd) + scoreLinear(p, fitted, x);
  }

  function tokenOdds(p, fitted, x = features(p, fitted.context)) {
    const a = logistic(scoreLinear(p, fitted, x));
    const { curve } = fitted;
    if (!curve) return { current: a };
    const days = p.age ?? fitted.context.age;
    const current = a * exposureAt(days, curve);
    return { current, forward: (a * exposureAt(days + 2 * YEAR, curve) - current) / (1 - current) };
  }

  function heldOut(splits, spec, kind) {
    return splits.flatMap(({ train, test }) => {
      const fitted = fit(train, spec.terms, spec.curve, kind);
      return test.map(p => kind === 'cap' ? Math.log(p.mcap_usd) - capLog(p, fitted)
        : tokenOdds(p, fitted).current - Number(p.recorded));
    });
  }

  function select(splits, kind, control = true) {
    const cap = kind === 'cap';
    const compare = spec => splits.map(group => mean(heldOut(group, spec, kind).map(cap ? Math.abs : e => e * e)));
    let spec = { terms: [], curve: cap ? null : AGE_CURVE };
    let scores = compare(spec);
    const rows = [];
    if (!cap) rows.push({ label: 'Pooled status rate', state: 'Baseline', scores: compare({ terms: [], curve: null }) });
    rows.push({ label: cap ? 'Unit TVL elasticity' : AGE_CURVE.name, state: cap ? 'Baseline' : 'Scenario', scores });
    const candidates = cap ? CAP_FEATURES : [...OTHER_CURVES, ...ODDS_FEATURES];
    for (const term of candidates) {
      const curve = typeof term === 'object';
      const candidate = curve ? { ...spec, curve: term } : { ...spec, terms: [...spec.terms, term] };
      const next = compare(candidate);
      // Equal weight for the two split families.
      const ratios = next.map((loss, i) => scores[i] ? loss / scores[i] : Infinity);
      const keep = mean(ratios) <= 0.99 && ratios.every(r => r <= 1.01);
      rows.push({ label: curve ? term.name : term, state: keep ? 'Kept' : 'Failed', scores: next });
      if (keep) {
        spec = candidate;
        scores = next;
      }
    }
    if (control) rows.push({ label: 'Shuffled 7d', state: 'Control', scores: compare({ ...spec, terms: [...spec.terms, 'Shuffled 7d'] }) });
    return { spec, scores, rows };
  }

  function placebos(rows, seed) {
    const context = design(rows);
    const mixed = shuffle(rows.map(p => features(p, context)['Relative 7d']), randomStream(seed));
    return rows.map((p, i) => ({ ...p, control: mixed[i] }));
  }

  function intervalAudit(splits, forward) {
    let n = 0;
    let inner = 0;
    let outer = 0;
    for (const { train, test } of splits) {
      const calibration = forward ? forwardSplits(train) : randomSplits(train, 1);
      const extra = forward ? randomSplits(train, 1) : forwardSplits(train);
      const { spec } = select(forward ? [extra, calibration] : [calibration, extra], 'cap', false);
      const residuals = ascending(heldOut(calibration, spec, 'cap'));
      if (!residuals.length) continue;
      const [p10, p25, p75, p90] = [0.10, 0.25, 0.75, 0.90].map(q => {
        const index = (residuals.length + 1) * q;
        return residuals[bounds((q < 0.5 ? Math.floor(index) : Math.ceil(index)) - 1, 0, residuals.length - 1)];
      });
      for (const e of heldOut([{ train, test }], spec, 'cap')) {
        n++;
        inner += Number(e >= p25 && e <= p75);
        outer += Number(e >= p10 && e <= p90);
      }
    }
    return { n, inner: inner / n, outer: outer / n };
  }

  function fitModel(ledger) {
    const comps = placebos(tokenFamilies(ledger.Priced), 44291);
    const recorded = tokenFamilies([...ledger.Priced, ...ledger.Unpriced].filter(p => p.age && !isStableReceipt(p.category)));
    const peers = placebos([...recorded, ...ledger.Watchlist, ...ledger.Early].filter(p => p.age && !isStableReceipt(p.category)), 88561);
    const capSplits = [randomSplits(comps, 5), forwardSplits(comps)];
    const oddsSplits = [randomSplits(peers, 5), forwardSplits(peers)];
    const cap = select(capSplits, 'cap');
    const odds = select(oddsSplits, 'odds');
    const pointCap = fit(comps, cap.spec.terms, null, 'cap');
    const pointOdds = fit(peers, odds.spec.terms, odds.spec.curve, 'odds');
    const residuals = capSplits.map(splits => ascending(heldOut(splits, cap.spec, 'cap')));
    const random = randomStream(958283);
    const resample = rows => rows.map(() => rows[Math.floor(random() * rows.length)]);
    const draws = Array.from({ length: BOOTSTRAPS }, (_, i) => ({
      cap: fit(resample(comps), cap.spec.terms, null, 'cap'),
      odds: fit(resample(peers), odds.spec.terms, odds.spec.curve, 'odds'),
      residual: quantile(residuals[i % 2], (((i >> 1) * 17 % 48) + 0.5) / 48)
    }));
    const coefficients = [];
    for (const [key, fitted] of [['cap', pointCap], ['odds', pointOdds]]) {
      const report = (name, get) => {
        const sample = draws.map(d => get(d[key]));
        const center = mean(sample);
        coefficients.push({ key, name, value: get(fitted), se: Math.sqrt(sum(sample.map(x => (x - center) ** 2)) / (sample.length - 1)) });
      };
      if (key === 'cap') report('TVL elasticity', f => 1 + (f.slopes['Log TVL'] || 0));
      for (const name of Object.keys(fitted.slopes)) {
        if (key !== 'cap' || name !== 'Log TVL') report(name, f => f.slopes[name]);
      }
      for (const group of [...fitted.effects.keys()].sort()) report(group, f => f.effects.get(group) || 0);
    }
    return { comps, cap, odds, pointCap, pointOdds, draws, coefficients,
      scenarioCarry: !cap.spec.terms.includes('Relative 7d') && !odds.spec.terms.includes('Relative 7d'),
      audit: capSplits.map((splits, i) => intervalAudit(splits, i === 1)) };
  }

  function valuation(p, capFit, oddsFit, scenarioCarry) {
    const x = features(p, capFit.context);
    const carry = scenarioCarry ? Math.exp(0.085 * x['Relative 7d']) : 1;
    const cap = Math.exp(capLog(p, capFit, x)) * carry;
    const independent = p.parentHint ? 0.30 : p.bucket === 'Off-list' ? 0.60 : isStableReceipt(p.category) ? 0.40 : 1;
    const odds = tokenOdds(p, oddsFit).forward * independent;
    return { cap, odds, point: cap * odds };
  }

  function impliedValue(p, model, includeRange = true) {
    const value = valuation(p, model.pointCap, model.pointOdds, model.scenarioCarry);
    if (!includeRange) return value;
    const predictive = ascending(model.draws.map(draw =>
      valuation(p, draw.cap, draw.odds, model.scenarioCarry).point * Math.exp(draw.residual)));
    return { ...value, range: [.10, .25, .50, .75, .90].map(q => quantile(predictive, q)) };
  }

  function counterfactuals(p, model) {
    const actual = impliedValue(p, model, false);
    const growth = p.change_7d ?? model.pointCap.context.market;
    const age = p.age ?? model.pointOdds.context.age;
    const changes = [
      ['TVL', 'Double TVL', { tvl_usd: 2 * p.tvl_usd, slug: '' }],
      ['7-day growth', '+20 pp', { change_7d: growth + 20 }],
      ['No-token age', '+365 days', { age: age + 365 }]
    ];
    return changes.map(([label, change, patch]) => {
      const next = impliedValue({ ...p, ...patch }, model, false);
      return { label, change, cap: next.cap / actual.cap, odds: next.odds / actual.odds, value: next.point / actual.point };
    });
  }

  function waterfall(p, model) {
    let row = { ...p, slug: '', tvl_usd: TYPICAL_SIZE, change_7d: null, age: model.pointOdds.context.age,
      category: 'Pooled', chains: ['Reference'], bucket: 'Early', parentHint: false };
    const base = impliedValue(row, model, false);
    let previous = base;
    const changes = [
      ['TVL', { tvl_usd: p.tvl_usd }], ['7-day growth', { change_7d: p.change_7d }],
      ['No-token age', { age: p.age }], ['Category', { category: p.category, slug: p.slug }],
      ['Chains', { chains: p.chains }], ['Independence', { parentHint: p.parentHint, bucket: p.bucket }]
    ];
    const stages = changes.map(([name, patch]) => {
      row = { ...row, ...patch };
      const next = impliedValue(row, model, false);
      const step = { name, factor: next.point / previous.point, cap: next.cap / previous.cap, odds: next.odds / previous.odds };
      previous = next;
      return step;
    });
    return { base, stages };
  }

  function nearestPeers(p, model) {
    const target = features(p, model.pointCap.context);
    return model.comps.map(q => {
      const x = features(q, model.pointCap.context);
      const distance = (x['Log TVL'] - target['Log TVL']) ** 2 + 0.15 * (x['Relative 7d'] - target['Relative 7d']) ** 2
        + 0.2 * (x['Log days listed'] - target['Log days listed']) ** 2 + Number(q.category !== p.category);
      return { q, distance };
    }).sort((a, b) => a.distance - b.distance).slice(0, 4).map(r => r.q);
  }

  function baselineCap(tvl, model) {
    const fit = model.pointCap;
    return Math.exp(Math.log(tvl) + fit.intercept + (fit.slopes['Log TVL'] || 0) * bounds(Math.log(tvl / TYPICAL_SIZE), -4, 7));
  }

  // Funding leg, entry, exit, weekly reserve (USD), then bps per leg.
  const GAS = {
    Ethereum: [8, 4.4, 6.2, 0.55, 2], Bitcoin: [8, 5, 7, 0.7, 2.5],
    Base: [1.1, 0.20, 0.35, 0.05, 0.8], Arbitrum: [1.5, 0.32, 0.55, 0.07, 0.9],
    Optimism: [1.4, 0.25, 0.42, 0.06, 0.9], Ink: [1.2, 0.28, 0.40, 0.07, 0.9],
    Monad: [1.5, 0.37, 0.53, 0.07, 1.0], Plasma: [1.5, 0.27, 0.51, 0.07, 1.0],
    Solana: [1.3, 0.18, 0.29, 0.04, 0.9], Sui: [1.5, 0.22, 0.32, 0.05, 1.0],
    Aptos: [1.7, 0.24, 0.41, 0.05, 1.0], Binance: [1.4, 0.28, 0.48, 0.08, 0.9],
    Avalanche: [1.8, 0.48, 0.73, 0.12, 1.1], Polygon: [1.4, 0.22, 0.32, 0.06, 0.9],
    Flare: [2.2, 0.37, 0.57, 0.10, 1.1], Stellar: [1.8, 0.21, 0.34, 0.05, 1.2],
    Hyperliquid: [2.0, 0.45, 0.75, 0.09, 1.2], 'Hyperliquid L1': [2.2, 0.5, 0.8, 0.1, 1.2],
    Algorand: [2.1, 0.24, 0.44, 0.06, 1.2], Bittensor: [3.5, 1.1, 1.7, 0.22, 2.0],
    Tron: [3.9, 2.0, 2.6, 0.21, 1.8]
  };
  const UNKNOWN_FEES = [3.9, 1.3, 2.1, 0.24, 1.8];

  const PLAYBOOKS = [
    [/lend|collateral market|collateral management/i, 'Supply only', false,
      'Require utilisation under 85%, zero reported bad debt and a verified oracle.',
      'Supply a stable asset and test a 5% withdrawal before scaling. Keep borrowing disabled.',
      'Track utilisation and idle liquidity. Exit at 90% utilisation or any reported bad debt.',
      'Redeem supply receipt and revoke approval.'],
    [/^Dexs$|liquidity manager/i, 'Stable-pair LP', false,
      'Verify eligible stable pair and round-trip liquidity.',
      'Test 5% in the deepest eligible pool. Start a concentrated LP at ±2%.',
      'Exit outside range, at 1% peg drift or above 1% impermanent loss.',
      'Remove both legs, collect fees and compare proceeds with holding.'],
    [/rwa|stablecoin|stables|^cdp|reserve currency/i, 'Mint & redeem', true,
      'Check mint/redemption terms, reserves, minimum lot, fees and access.',
      'Complete a minimum-lot mint and redemption before scaling.',
      'Stop at 1% peg discount, reserve shortfall or longer settlement.',
      'Redeem ahead of cut-off. Record settlement and issuer fees.'],
    [/perp|derivative|basis|synthetic|option/i, 'Collateral only', true,
      'Verify idle collateral qualifies for points and is withdrawable.',
      'Fund isolated collateral. Keep leverage, positions and orders at zero.',
      'Exit if trades or leverage become mandatory.',
      'Confirm zero open orders and withdraw collateral.'],
    [/vault|allocator|curator|yield|^farm$/i, 'Liquid vault', false,
      'Check allocation, fees and an unlocked share class with a ≤48h queue.',
      'Deposit a stable asset, redeem a test lot and log the vault share price.',
      'Check share-price drift and liquidity. Request exit if the queue exceeds 48h.',
      'Redeem ahead of the queue. Reconcile shares burned and proceeds.'],
  ];
  const ACCESS_CHECK = [null, 'Access audit', true, 'Verify access and exit terms.',
    'Hold funds idle until a qualifying position is documented.', 'Recheck eligibility and withdrawal terms.',
    'Close any test and reconcile its cost.'];
  const cent = value => Math.round(value * 100);

  function farmVerdict(net, p25, hourly, locked) {
    if (net <= 0) return 'SKIP';
    if (locked || p25 <= 0 || hourly < 25) return 'MARGINAL';
    return 'FARM';
  }

  function farmPlan(p, value, settings = DEFAULTS) {
    const route = [...p.chains].sort((a, b) => {
      const cost = chain => sum((GAS[chain] || UNKNOWN_FEES).slice(0, 3));
      return cost(a) - cost(b) || order(a, b);
    })[0] || 'Unlisted';
    const [transfer, enter, exit, weekly, bps] = GAS[route] || UNKNOWN_FEES;
    const [, book, gated, check, open, checkWeekly, unwind] = PLAYBOOKS.find(([pattern]) => pattern.test(p.category)) || ACCESS_CHECK;
    const locked = gated || p.recorded || p.parentHint || !GAS[route] || p.bucket === 'Off-list';
    const weeks = bounds(Math.round(settings.weeks), 2, 26);
    const days = weeks * 7;
    const drop = bounds(settings.drop, 0, 0.30);
    const shock = p.change_7d !== null && p.change_7d < -12;
    const stop = Math.round(p.tvl_usd * (shock ? 0.86 : (p.age ?? 180) < 180 ? 0.82 : 0.76));
    const minutesPerCheck = shock ? 7 : 5;
    const minutes = 12 + 10 + 14 + minutesPerCheck * weeks + 4 + 12;
    const timeShare = 1 - Math.exp(-weeks / 7);
    const eligibleTvl = p.tvl_usd * 0.12;
    const ticketShare = ticket => ticket / (eligibleTvl + ticket);
    const amounts = ticket => [0, cent(transfer + ticket * bps / 1e4), cent(enter), cent(weekly * weeks),
      0, cent(exit + transfer + ticket * bps / 1e4), cent(0.04 * days / YEAR * ticket)];
    const grossAt = (mark, ticket, allocation) => mark * timeShare * allocation * ticketShare(ticket);
    const lowMark = value.range[1];
    const costsOf = ticket => sum(amounts(ticket)) / 100;
    const netAt = (ticket, mark) => grossAt(mark, ticket, drop) - costsOf(ticket);
    const breakEven = (mark, hurdle = 0) => {
      if (netAt(25_000, mark) < hurdle) return Infinity;
      let lo = 0;
      let hi = 25_000;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (netAt(mid, mark) >= hurdle) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const goal = Math.max(breakEven(lowMark, 5), breakEven(value.point, 25 * minutes / 60));
    const typical = bounds(Math.round(p.tvl_usd * 0.00010 / 100) * 100, 1_000, 25_000);
    const sizing = Math.min(25_000, Math.max(typical, Math.ceil(goal / 100) * 100));
    const ticket = settings.ticket ? bounds(Math.round(settings.ticket), 100, 25_000) : sizing;
    const stepCosts = amounts(ticket);
    const cost = sum(stepCosts) / 100;
    const gross = grossAt(value.point, ticket, drop);
    const net = gross - cost;
    const p25 = netAt(ticket, lowMark);
    const hourly = net * 60 / minutes;
    const shareBE = cost / grossAt(value.point, ticket, 1);
    const depositBE = breakEven(value.point);
    const verdict = farmVerdict(net, p25, hourly, locked);
    const maxShareBE = costsOf(25_000) / grossAt(value.point, 25_000, 1);
    const reason = verdict === 'FARM' ? 'P25 > $0 and net ≥ $25/hour.'
      : verdict === 'SKIP' && maxShareBE > drop ? `Needs ${(maxShareBE * 100).toFixed(1)}% drop share at $25K.`
      : verdict === 'SKIP' ? 'Expected proceeds fall short at this ticket.'
      : locked ? 'Verify eligibility and independent token rights.'
      : p25 <= 0 ? 'P25 loses money after fees and carry.' : 'Net below $25 per active hour.';
    const tasks = [
      ['Day 0', 'Check entry & exit', `Verify ${p.name} on ${route}. ${check}`, 12],
      ['Day 0', 'Fund test wallet', `Budget ${usd(ticket)} plus fees. Confirm the asset contract and test transfer.`, 10],
      ['Day 0', book, open, 14],
      [`Weekly ×${weeks}`, 'Keep a position log', checkWeekly, minutesPerCheck * weeks],
      ['Any day', 'Enforce stop', `Use the reserved exit below ${usd(stop)} TVL, on withdrawal pauses or on changed eligibility.`, 4],
      [`Day ${days}`, 'Settle & reconcile', `${unwind} Verify claim eligibility after exit.`, 12],
      [`Days 1–${days}`, 'Capital carry', `${usd(ticket)} tied up for ${days} days at a 4% annual charge.`, 0]
    ];
    let running = 0;
    const steps = tasks.map(([when, title, action, time], i) => {
      running += stepCosts[i];
      return { when, title, action, time, cents: stepCosts[i], running };
    });
    return { route, ticket, days, gross, net, p25, hourly, cost, minutes, stop, shareBE, depositBE,
      verdict, reason, steps, eligibleTvl, book };
  }

  function buildRadar(snapshot) {
    const ledger = ledgerOf(snapshot);
    const model = fitModel(ledger);
    const scored = [...ledger.Watchlist, ...ledger.Early, ...ledger['Off-list']].map(p => {
      const value = impliedValue(p, model);
      return { p, value, plan: farmPlan(p, value), implied: Math.max(1, Math.round(value.point)) };
    }).sort((a, b) => b.implied - a.implied || order(a.p.slug, b.p.slug));
    const rows = scored.map((row, i) => {
      row.rank = i + 1;
      return {
        rank: row.rank, slug: row.p.slug, name: row.p.name, cohort: row.p.bucket,
        token_status: row.p.recorded ? 'watchlist record exception' : 'records no token',
        implied_value_usd: row.implied,
        farm_steps: row.plan.steps.map(s => `${s.when} · ${s.title}. ${s.action} Cost $${(s.cents / 100).toFixed(2)}. Time ${s.time} min. Running $${(s.running / 100).toFixed(2)}.`)
      };
    });
    return { ledger, model, scored, board: { rows } };
  }

  // FNV-1a over the serialized board.
  function checksum(board) {
    let hash = 2166136261;
    for (const byte of new TextEncoder().encode(JSON.stringify(board))) hash = Math.imul(hash ^ byte, 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  const api = { BUCKETS, DEFAULTS, ledgerOf, fitModel, tokenOdds, impliedValue, farmPlan, farmVerdict, buildRadar,
    counterfactuals, waterfall, nearestPeers, baselineCap, checksum };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else surface.RadarModel = api;
})(globalThis);
