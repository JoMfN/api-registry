/* GenesisL1 Public API Registry — quality stages.
 *
 * One rule, shared by the directory, wallets and scripts. An endpoint's stage
 * is a pure function of its on-chain record and of checker feeds whose
 * signatures the caller has already verified. Nothing here fetches, signs or
 * stores anything, and no stage is ever written to the chain: the registry
 * anchors only adverse days, and a stage is a view over that record plus the
 * signed telemetry.
 *
 *   0  Listed     the record exists
 *   1  Verified   a quorum confirmed the operator controls the host
 *   2  Reliable   a clean week at or above the on-chain target, in sync
 *   3  Preferred  a clean month, fast, in sync, and the checkers agree
 *
 * A quorum flag suspends the stage until a healthy quorum clears it.
 *
 * Every requirement is a pass-or-fail gate that carries its measured value, so
 * a reader sees exactly what holds an endpoint where it is. An endpoint holds
 * the highest stage whose gates pass, together with every gate below it.
 *
 * Plain script, no build step, like the rest of web/. In a page it defines
 * window.GENESIS_STAGE; under Node, require() returns the same object.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.GENESIS_STAGE = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY = 86400;
  const KIND_SNAPSHOT = 7;

  /* Kinds that report a block height, grouped by the counter they report. On
   * GenesisL1 the EVM block number and the CometBFT height advance together;
   * comparing within a family keeps the gate fair if one family runs a block
   * behind by design, such as an RPC that reports its last indexed block. */
  const HEIGHT_FAMILY = { 0: "evm", 1: "evm", 2: "cosmos", 3: "cosmos" };

  const POLICY = Object.freeze({
    version: "draft-1",
    reliableDays: 7,           // measured history in this epoch, for Reliable
    preferredDays: 30,         // and for Preferred
    reliableCleanDays: 7,      // days since the last on-chain flagged day
    preferredCleanDays: 30,
    preferredUptimeBps: 9950,  // 99.50% over 30 days
    latencyBudgetMs: 1500,     // 7-day p95, median of feeds; snapshots exempt
    maxLagBlocks: 10,          // behind the median height of the same family
    minFeeds: 2,               // feeds with a 7-day window, for Preferred
    maxSpreadBps: 200,         // and they agree within 2 percentage points
    maxThrottledBps: 500       // rate-limited on at most 5% of probes
  });

  const NAMES = Object.freeze(["Listed", "Verified", "Reliable", "Preferred"]);
  const MEANINGS = Object.freeze([
    "Registered on-chain. Nobody has confirmed who runs it yet.",
    "The operator proved control of the host to a quorum of checkers. Too little history to judge quality.",
    "A clean week of independent measurement at or above the on-chain target, in sync with the chain.",
    "A clean month, fast and in sync, and the checkers agree."
  ]);
  const FLAGGED_MEANING =
    "A quorum of checkers anchored a day below the reliability target. The stage is suspended until a healthy quorum clears the flag.";

  /* Gate order is display order. Labels depend only on the policy. */
  const GATES = Object.freeze([
    ["control", 1, "chain", () => "Control proven by quorum"],
    ["clean7", 2, "chain", (p) => `No flagged day in ${p.reliableCleanDays} days`],
    ["measured7", 2, "feeds", (p) => `Measured for ${p.reliableDays} days`],
    ["uptime7", 2, "feeds", () => "7-day uptime at target"],
    ["sync", 2, "feeds", () => "Keeps up with the chain"],
    ["measured30", 3, "feeds", (p) => `Measured for ${p.preferredDays} days`],
    ["uptime30", 3, "feeds", (p) => `30-day uptime at ${percent(p.preferredUptimeBps)}`],
    ["clean30", 3, "chain", (p) => `No flagged day in ${p.preferredCleanDays} days`],
    ["latency", 3, "feeds", () => "p95 latency within budget"],
    ["agree", 3, "feeds", () => "Checkers agree"],
    ["throttle", 3, "feeds", () => "Rarely rate-limited"]
  ]);

  const EMPTY = Object.freeze({
    feeds: 0, daysMeasured: null, uptime24h: null, uptime7d: null, uptime30d: null,
    p95_7d: null, throttled7d: null, spread7d: null, lagBlocks: null
  });

  /* ---------------------------------------------------------------- helpers */

  /* null and undefined become NaN, so every comparison against a missing
   * value is false and a gate can never pass on data it does not have. */
  function num(value) {
    return value === null || value === undefined || value === "" ? NaN : Number(value);
  }
  const known = (value) => Number.isFinite(num(value));

  function median(values) {
    const list = values.filter(known).map(Number).sort((a, b) => a - b);
    if (!list.length) return null;
    const middle = Math.floor(list.length / 2);
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
  }

  function percent(bps) { return `${(Number(bps) / 100).toFixed(2)}%`; }
  function grouped(value) { return Math.round(Number(value)).toLocaleString("en-US"); }
  function plural(count, word) { return `${count} ${word}${count === 1 ? "" : "s"}`; }

  /* ----------------------------------------------------------------- policy */

  /* A deployment may tune thresholds. Unknown keys and nonsense values are
   * ignored rather than allowed to break the page, and a changed policy says
   * so in its version string. */
  function policy(overrides) {
    if (!overrides || typeof overrides !== "object") return POLICY;
    const merged = Object.assign({}, POLICY);
    let changed = false;
    for (const key of Object.keys(POLICY)) {
      if (key === "version" || overrides[key] === undefined) continue;
      const value = num(overrides[key]);
      if (!Number.isFinite(value) || value < 0) continue;
      if (value !== POLICY[key]) { merged[key] = value; changed = true; }
    }
    const named = typeof overrides.version === "string" ? overrides.version.trim() : "";
    merged.version = named || (changed ? `${POLICY.version}+local` : POLICY.version);
    return Object.freeze(merged);
  }

  /* What each stage adds, as labels, for legends and documentation. */
  function requirements(rules) {
    const p = rules || POLICY;
    return [0, 1, 2, 3].map((level) => GATES.filter((gate) => gate[1] === level).map((gate) => gate[3](p)));
  }

  /* ------------------------------------------------------------------ feeds */

  /* Feeds are treated as immutable once verified, so the per-feed lookups are
   * built once per document and reused for every endpoint. */
  const indexes = new WeakMap();
  const heights = new WeakMap();

  function indexOf(list) {
    let index = indexes.get(list);
    if (!index) {
      index = new Map();
      for (const entry of list) if (entry && entry.id !== undefined) index.set(String(entry.id), entry);
      indexes.set(list, index);
    }
    return index;
  }

  function familyHeights(list) {
    let result = heights.get(list);
    if (!result) {
      const groups = {};
      for (const entry of list) {
        const family = entry ? HEIGHT_FAMILY[Number(entry.kind)] : undefined;
        const height = entry && entry.stats_1h ? num(entry.stats_1h.latest_height) : NaN;
        if (!family || !Number.isFinite(height)) continue;
        (groups[family] = groups[family] || []).push(height);
      }
      result = {};
      for (const family of Object.keys(groups)) result[family] = median(groups[family]);
      heights.set(list, result);
    }
    return result;
  }

  /* Combine verified feeds for one endpoint by median, the way the directory
   * combines every other number. `feeds` are status.json documents whose
   * signatures the caller has checked; `endpoint` is the on-chain record;
   * `now` is in seconds. Height lag is measured inside each feed and only
   * then combined, so a feed written a few minutes earlier than another does
   * not make every node look behind. */
  function metricsFromFeeds(feeds, endpoint, now) {
    const rows = [];
    for (const feed of feeds || []) {
      const list = feed && Array.isArray(feed.endpoints) ? feed.endpoints : null;
      if (!list) continue;
      const entry = indexOf(list).get(String(endpoint.id));
      if (!entry) continue;
      // A measurement describes the epoch it was taken in. After a URL change
      // the old epoch's history says nothing about the new URL.
      if (known(entry.epoch) && known(endpoint.epoch) && num(entry.epoch) !== num(endpoint.epoch)) continue;
      // Feeds from checkers older than 3.1.0 carry no 7-day window.
      if (!entry.stats_7d || !(num(entry.stats_7d.counted) > 0)) continue;
      rows.push({ entry, week: entry.stats_7d, reference: familyHeights(list) });
    }
    if (!rows.length) return Object.assign({}, EMPTY);

    const family = HEIGHT_FAMILY[Number(endpoint.kind)];
    const weekly = rows.map((row) => num(row.week.uptime_bps)).filter(Number.isFinite);
    const firstSeen = median(rows.map((row) => row.entry.first_seen));
    return {
      feeds: rows.length,
      daysMeasured: firstSeen === null ? null : Math.max(0, (num(now) - firstSeen) / DAY),
      uptime24h: median(rows.map((row) => row.entry.stats_24h && row.entry.stats_24h.uptime_bps)),
      uptime7d: median(weekly),
      uptime30d: median(rows.map((row) => row.entry.stats_30d && row.entry.stats_30d.uptime_bps)),
      p95_7d: median(rows.map((row) => row.week.latency_p95_ms)),
      throttled7d: median(rows.map((row) => {
        const samples = num(row.week.samples);
        return samples > 0 ? (num(row.week.throttled) || 0) * 10000 / samples : null;
      })),
      spread7d: weekly.length > 1 ? Math.max(...weekly) - Math.min(...weekly) : 0,
      lagBlocks: family ? median(rows.map((row) => {
        const own = row.entry.stats_1h ? num(row.entry.stats_1h.latest_height) : NaN;
        const reference = num(row.reference[family]);
        return Number.isFinite(own) && Number.isFinite(reference) ? reference - own : null;
      })) : null
    };
  }

  /* ------------------------------------------------------------------ stage */

  /* The stage of one endpoint.
   *   endpoint  on-chain record: verified, unreliable, lastAdverseDay, kind
   *   metrics   metricsFromFeeds(...), or null when no verified feed has it
   *   chain     { today, thresholdBps }: the UTC day number and the registry's
   *             reliability target, which is read from the contract
   *   rules     optional policy(...) result; POLICY by default
   */
  function stageOf(endpoint, metrics, chain, rules) {
    const p = rules || POLICY;
    const m = metrics || EMPTY;
    const target = num(chain && chain.thresholdBps);
    const today = num(chain && chain.today);
    const flaggedOn = num(endpoint.lastAdverseDay);
    const sinceFlag = flaggedOn > 0 ? today - flaggedOn : null; // null: never flagged
    const measured = num(m.feeds) > 0;
    const family = HEIGHT_FAMILY[Number(endpoint.kind)];
    const noFeed = "no verified feed with a 7-day window";

    const clean = (days) => sinceFlag === null || sinceFlag > days;
    const flagDetail = (days) => {
      if (sinceFlag === null) return "never flagged";
      if (!Number.isFinite(sinceFlag)) return "flag date unknown";
      const when = sinceFlag <= 0 ? "flagged today" : `last flagged ${plural(sinceFlag, "day")} ago`;
      return sinceFlag > days ? when : `${when} · needs ${days} clean days`;
    };
    const daysDetail = (need) => {
      if (!measured) return noFeed;
      if (!known(m.daysMeasured)) return "start of measurement unknown";
      const days = Math.floor(num(m.daysMeasured));
      return days >= need ? `${plural(days, "day")} measured` : `${days} of ${need} days`;
    };

    const results = {
      control: [Boolean(endpoint.verified),
        endpoint.verified ? "DNS TXT or well-known file, confirmed by a quorum" : "not proven for this epoch"],
      clean7: [clean(p.reliableCleanDays), flagDetail(p.reliableCleanDays)],
      measured7: [measured && num(m.daysMeasured) >= p.reliableDays, daysDetail(p.reliableDays)],
      uptime7: [measured && num(m.uptime7d) >= target,
        measured ? `${percent(m.uptime7d)} · target ${percent(target)}` : noFeed],
      sync: [measured && !(num(m.lagBlocks) > p.maxLagBlocks),
        !measured ? noFeed
          : !known(m.lagBlocks) ? (family ? "no recent height to compare" : "this API type reports no height")
            : num(m.lagBlocks) <= 0 ? "level with the network"
              : `${plural(Math.round(num(m.lagBlocks)), "block")} behind · max ${p.maxLagBlocks}`],
      measured30: [measured && num(m.daysMeasured) >= p.preferredDays, daysDetail(p.preferredDays)],
      uptime30: [measured && num(m.uptime30d) >= p.preferredUptimeBps,
        !measured ? noFeed : known(m.uptime30d) ? `${percent(m.uptime30d)} · needs ${percent(p.preferredUptimeBps)}` : "no 30-day window"],
      clean30: [clean(p.preferredCleanDays), flagDetail(p.preferredCleanDays)],
      latency: [measured && (Number(endpoint.kind) === KIND_SNAPSHOT || num(m.p95_7d) <= p.latencyBudgetMs),
        !measured ? noFeed
          : Number(endpoint.kind) === KIND_SNAPSHOT ? "snapshot services are exempt"
            : known(m.p95_7d) ? `${grouped(m.p95_7d)} ms · budget ${grouped(p.latencyBudgetMs)} ms` : "no successful probe to time"],
      agree: [num(m.feeds) >= p.minFeeds && num(m.spread7d) <= p.maxSpreadBps,
        !(num(m.feeds) >= p.minFeeds) ? `${plural(num(m.feeds) || 0, "feed")} · needs ${p.minFeeds}`
          : `${m.feeds} feeds · ${(num(m.spread7d) / 100).toFixed(1)} points apart · max ${(p.maxSpreadBps / 100).toFixed(1)}`],
      throttle: [measured && num(m.throttled7d) <= p.maxThrottledBps,
        !measured ? noFeed
          : known(m.throttled7d) ? `${(num(m.throttled7d) / 100).toFixed(1)}% of probes · max ${(p.maxThrottledBps / 100).toFixed(1)}%`
            : "no probes counted"]
    };

    const gates = GATES.map(([id, level, source, label]) => ({
      id, level, source, label: label(p), ok: Boolean(results[id][0]), detail: results[id][1]
    }));

    let level = 0;
    for (let next = 1; next <= 3; next += 1) {
      if (!gates.every((gate) => gate.level !== next || gate.ok)) break;
      level = next;
    }
    const flagged = Boolean(endpoint.unreliable);
    return {
      stage: flagged ? "flagged" : level,
      level,
      flagged,
      name: flagged ? "Flagged" : NAMES[level],
      meaning: flagged ? FLAGGED_MEANING : MEANINGS[level],
      gates,
      next: flagged || level === 3 ? [] : gates.filter((gate) => gate.level === level + 1 && !gate.ok)
    };
  }

  /* ---------------------------------------------------------------- wallets */

  /* What a wallet or dApp should connect to: Preferred endpoints of one API
   * type first, then Reliable ones, never Listed or Verified ones, and none
   * that is below target today. Order inside a stage is random, so the best
   * endpoint does not take every user's traffic.
   *   nodes  [{ kind, stage, belowTargetToday, ... }]
   */
  function pickEndpoints(nodes, kind, count, random) {
    const draw = typeof random === "function" ? random : Math.random;
    const limit = count === undefined ? 3 : count;
    return (nodes || [])
      .filter((node) => node && Number(node.kind) === Number(kind)
        && typeof node.stage === "number" && node.stage >= 2 && !node.belowTargetToday)
      .map((node) => ({ node, order: draw() }))
      .sort((a, b) => b.node.stage - a.node.stage || a.order - b.order)
      .slice(0, limit)
      .map((item) => item.node);
  }

  return Object.freeze({
    POLICY, NAMES, MEANINGS, FLAGGED_MEANING,
    policy, requirements, metricsFromFeeds, stageOf, pickEndpoints, median
  });
}));
