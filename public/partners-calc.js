/**
 * Single source of truth for every financial number shown on partners.html —
 * hero mock, "revenue per client", calculator, demo dashboard, FAQ answers.
 *
 * Every value below is either a REAL, currently-live product rule (cited
 * inline, next to the backend file it mirrors) or explicitly left `null` and
 * flagged REQUIRES_BUSINESS_DECISION. Never invent a number here to make a
 * UI block look complete — ship it honestly undefined instead and let the
 * page hide or soften that block.
 *
 * Loaded by partners.html via <script src="/partners-calc.js">, and required
 * directly by its Node test (public/__tests__/partnersCalc.test.js) — same
 * file, same logic, so the page and its tests can never drift apart. Pure
 * functions only: no DOM, no fetch, works identically in a browser or Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EnmaPartnerCalc = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Real plan prices ────────────────────────────────────────────────────
  // api/payment/[action].js SBP_PRICES, duplicated in src/subscription.ts
  // (kept in sync there). This is a static page with no server call to fetch
  // them live, so they're mirrored here — update both places together.
  var PLANS = [
    { key: 'pro',     label: 'Pro',     month: 750,  year: 7200 },
    { key: 'premium', label: 'Premium', month: 1000, year: 9600 },
  ];
  var DEFAULT_PLAN_KEY = 'pro';
  var DEFAULT_PERIOD = 'month';

  // Default commission/discount for a self-service partner — see
  // findOrCreatePartnerByTelegram() in api/_lib/referral/partners.js and the
  // ?? 30 / ?? 10 fallbacks in api/_lib/referral/influencer.js. A specific
  // partner's real rate can be overridden by an admin per-record — this is
  // only the DEFAULT every new self-service partner actually gets today.
  var COMMISSION_RATE = 0.30;
  var DISCOUNT_PERCENT = 10;

  // Attribution persistence — users.referredByInfluencer is written once and
  // never expires; there is no TTL field or cleanup job anywhere in
  // api/_lib/referral/influencer.js. api/payment/[action].js auto-resolves
  // this stored attribution on every later checkout that doesn't explicitly
  // pass a referralCode, so a recurring customer keeps crediting the same
  // partner on every future payment. This is real, current backend
  // behavior — not a promise about what will always remain true.
  var ATTRIBUTION_HAS_TIME_LIMIT = false;
  var ATTRIBUTION_LIMIT_MONTHS = null; // only meaningful if the flag above flips true

  // Refund/cancellation clawback window — CANCEL_WINDOW_DAYS in
  // api/_lib/referral/influencer.js. A commission can be reversed if the
  // underlying payment is cancelled within this many days of being charged.
  var HOLD_DAYS = 7;

  // Payouts — handleAdminReferrals('payout') in api/ai/[action].js. There is
  // no cron/schedule and no minimum enforced in code today; these two labels
  // describe the REAL current mechanism honestly rather than inventing a
  // schedule that doesn't exist yet.
  var MIN_PAYOUT_RUB = 0;
  var PAYOUT_SCHEDULE_LABEL = 'По запросу — обрабатывается вручную командой Enma';
  var PAYOUT_METHOD_LABEL = 'Уточняется индивидуально при первой выплате';

  // Founding Partners — architecture only (see partners.html section). Every
  // number here must come from this config, never be hand-written into page
  // copy. While ENABLED is false the whole block renders nothing at all.
  // REQUIRES_BUSINESS_DECISION before flipping this on.
  var FOUNDING_PARTNERS = {
    ENABLED: false,
    LIMIT: null,
    COMMISSION_PERCENT: null,  // e.g. an elevated rate for the first N partners
    DURATION_MONTHS: null,     // how long the elevated rate lasts
    TITLE: 'Founding Partners',
    DESCRIPTION: '',
  };

  function planByKey(key) {
    for (var i = 0; i < PLANS.length; i++) { if (PLANS[i].key === key) return PLANS[i]; }
    return PLANS[0];
  }

  function priceFor(planKey, period) {
    var plan = planByKey(planKey);
    return period === 'year' ? plan.year : plan.month;
  }

  function round(n) { return Math.round(n); }

  // Commission Enma pays the partner on ONE payment of `price` rubles.
  function commissionPerPayment(price, rate) {
    rate = rate == null ? COMMISSION_RATE : rate;
    return round(price * rate);
  }

  // The 1×/3×/6×/12× recurring-payments table. Only meaningful to show
  // because ATTRIBUTION_HAS_TIME_LIMIT is false today — an unlimited number
  // of future payments from the same user keep crediting the partner.
  function recurringTable(price, rate, counts) {
    counts = counts || [1, 3, 6, 12];
    var per = commissionPerPayment(price, rate);
    return counts.map(function (n) { return { payments: n, total: per * n }; });
  }

  // Largest-remainder split of an integer `total` across `weights` (array of
  // fractions summing to ~1) — every bucket is a whole number and the
  // buckets always sum to exactly `total` (no silent rounding drift between
  // a demo dataset's per-source rows and its own displayed totals).
  function splitProportionally(total, weights) {
    var raw = weights.map(function (w) { return total * w; });
    var floors = raw.map(Math.floor);
    var used = floors.reduce(function (a, b) { return a + b; }, 0);
    var remainder = total - used;
    var order = raw
      .map(function (v, i) { return { i: i, frac: v - floors[i] }; })
      .sort(function (a, b) { return b.frac - a.frac; });
    var out = floors.slice();
    for (var k = 0; k < remainder; k++) { out[order[k % order.length].i] += 1; }
    return out;
  }

  // Full funnel: audience -> reach -> clicks -> registrations -> paying
  // users -> payments -> partner income. Percentages are each relative to
  // the PREVIOUS stage (not to audience), matching how a real publication
  // funnel narrows stage by stage.
  //   reachPct — % of the audience that actually sees the publication
  //   clickPct — % of reach that opens the partner link in Telegram
  //   regPct   — % of clicks that complete Enma sign-up (click ≠ registration)
  //   buyPct   — % of registrations that become a paying user
  //   recurring + avgPayments — only used when modelling repeat payments;
  //     avgPayments must be an explicit user input, never an assumed default
  //     baked into the model (see the mandatory "this is a model, not a
  //     forecast" disclaimer on the page).
  function computeFunnel(input) {
    var audience = Math.max(0, input.audience || 0);
    var reachPct = Math.max(0, Math.min(100, input.reachPct != null ? input.reachPct : 100));
    var clickPct = Math.max(0, Math.min(100, input.clickPct || 0));
    var regPct   = Math.max(0, Math.min(100, input.regPct != null ? input.regPct : 100));
    var buyPct   = Math.max(0, Math.min(100, input.buyPct || 0));
    var price    = Math.max(0, input.price || 0);
    var rate     = input.rate == null ? COMMISSION_RATE : input.rate;
    var recurring = !!input.recurring;
    var avgPayments = Math.max(1, input.avgPayments || 1);

    var reach         = audience * (reachPct / 100);
    var clicks        = reach * (clickPct / 100);
    var registrations = clicks * (regPct / 100);
    var payers        = registrations * (buyPct / 100);
    var payments       = recurring ? payers * avgPayments : payers;
    var revenue         = payments * price;
    var commission      = revenue * rate;

    return {
      reach: reach, clicks: clicks, registrations: registrations,
      payers: payers, payments: payments, revenue: revenue, commission: commission,
    };
  }

  // Fixed, deterministic demo dataset for the hero mock + dashboard mock.
  // Every number is derived from ONE payments count × ONE real plan price ×
  // the default commission rate — the hero tile, the dashboard tiles and the
  // per-source table all read from this same object, so they can never
  // disagree with each other again.
  function buildDemoDataset() {
    var planKey = DEFAULT_PLAN_KEY;
    var period  = DEFAULT_PERIOD;
    var price   = priceFor(planKey, period);
    var rate    = COMMISSION_RATE;

    var clicks        = 1284;
    var registrations = 403;
    var payments       = 37; // distinct charged payments in the displayed period (some payers paid more than once)
    var revenue         = payments * price;
    var partnerRevenue  = round(revenue * rate);

    var weights = [0.60, 0.25, 0.15]; // Telegram channel / Shorts / other — illustrative mix, not a claim about real traffic shares
    var clicksSplit = splitProportionally(clicks, weights);
    var regsSplit   = splitProportionally(registrations, weights);
    var paysSplit   = splitProportionally(payments, weights);

    var sourceMeta = [
      { id: 'tg', label: 'Telegram Channel', icon: 'i-plane' },
      { id: 'yt', label: 'Shorts',           icon: 'i-play'  },
      { id: 'src', label: 'Другое',          icon: 'i-globe' },
    ];
    var sources = sourceMeta.map(function (m, i) {
      return {
        id: m.id, label: m.label, icon: m.icon,
        clicks: clicksSplit[i], registrations: regsSplit[i], payments: paysSplit[i],
        commission: paysSplit[i] * price * rate,
      };
    });

    // Lifetime payout history is a separate bucket by definition (money
    // already paid out from PRIOR periods) — it isn't derived from the
    // current period's numbers above, same as the real referrers/{code}
    // schema keeps totalEarned/pendingPayout/paidOut as independent
    // running totals rather than one computed from another.
    var paidOutHistorical = 14200;

    return {
      planKey: planKey, period: period, price: price, rate: rate,
      clicks: clicks, registrations: registrations, payments: payments,
      revenue: revenue, partnerRevenue: partnerRevenue,
      pendingPayout: partnerRevenue,
      paidOutHistorical: paidOutHistorical,
      totalEarnedAllTime: partnerRevenue + paidOutHistorical,
      sources: sources,
    };
  }

  return {
    PLANS: PLANS,
    DEFAULT_PLAN_KEY: DEFAULT_PLAN_KEY,
    DEFAULT_PERIOD: DEFAULT_PERIOD,
    COMMISSION_RATE: COMMISSION_RATE,
    DISCOUNT_PERCENT: DISCOUNT_PERCENT,
    ATTRIBUTION_HAS_TIME_LIMIT: ATTRIBUTION_HAS_TIME_LIMIT,
    ATTRIBUTION_LIMIT_MONTHS: ATTRIBUTION_LIMIT_MONTHS,
    HOLD_DAYS: HOLD_DAYS,
    MIN_PAYOUT_RUB: MIN_PAYOUT_RUB,
    PAYOUT_SCHEDULE_LABEL: PAYOUT_SCHEDULE_LABEL,
    PAYOUT_METHOD_LABEL: PAYOUT_METHOD_LABEL,
    FOUNDING_PARTNERS: FOUNDING_PARTNERS,
    planByKey: planByKey,
    priceFor: priceFor,
    commissionPerPayment: commissionPerPayment,
    recurringTable: recurringTable,
    splitProportionally: splitProportionally,
    computeFunnel: computeFunnel,
    buildDemoDataset: buildDemoDataset,
  };
}));
