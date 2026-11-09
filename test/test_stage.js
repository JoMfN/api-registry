/* Stage rules: every gate at its boundary, how feeds are combined, what a
 * reader is told, and the wallet pick. Plain Node, no dependencies, no network.
 *
 *   node test/test_stage.js
 */
"use strict";

const path = require("path");
const S = require(path.join(__dirname, "..", "web", "stage.js"));

const PASSED = [];
const FAILED = [];

function check(name, condition, detail = "") {
  if (condition) {
    PASSED.push(name);
    console.log(`  \x1b[32mpass\x1b[0m  ${name}`);
  } else {
    FAILED.push([name, detail]);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}  ${detail}`);
  }
}

const DAY = 86400;
const TODAY = 20_400;                 // a UTC day number, as the contract counts them
const NOW = TODAY * DAY + 43_200;     // midday
const CHAIN = { today: TODAY, thresholdBps: 9900 };

/* A record and metrics that pass every gate. Each case breaks one thing. */
const record = (overrides = {}) => ({
  id: 1, epoch: 1, kind: 0, verified: true, unreliable: false, lastAdverseDay: 0, ...overrides
});
const metrics = (overrides = {}) => ({
  feeds: 3, daysMeasured: 35, uptime24h: 9990, uptime7d: 9990, uptime30d: 9980,
  p95_7d: 200, throttled7d: 50, spread7d: 30, lagBlocks: 1, ...overrides
});
const run = (endpoint = {}, measured = {}, chain = CHAIN) =>
  S.stageOf(record(endpoint), measured === null ? null : metrics(measured), chain);
const stage = (endpoint, measured, chain) => run(endpoint, measured, chain).stage;

console.log("the ladder");
check("every gate passing is Preferred", stage() === 3);
check("an endpoint without proof of control is Listed whatever it measures", stage({ verified: false }) === 0);
check("Listed is told that proof of control comes next",
  run({ verified: false }).next.map((gate) => gate.id).join() === "control");
check("a quorum flag suspends the stage", stage({ unreliable: true }) === "flagged");
check("a flagged endpoint is not told a next gate", run({ unreliable: true }).next.length === 0);
check("the ladder level is still reported under a flag", run({ unreliable: true }).level === 3);
check("no verified feed stops at Verified", stage({}, null) === 1);
const unmeasured = run({}, null);
check("without a feed every open gate says so",
  unmeasured.next.length === 3 && unmeasured.next.every((gate) => /no verified feed/.test(gate.detail)),
  unmeasured.next.map((gate) => gate.detail).join(" | "));
check("there are eleven gates", run().gates.length === 11, String(run().gates.length));
check("every gate names where its evidence comes from",
  run().gates.every((gate) => gate.source === "chain" || gate.source === "feeds"));
check("stages are named", S.NAMES.join() === "Listed,Verified,Reliable,Preferred");

console.log("\nReliable, at each boundary");
// Ten days measured passes every Reliable gate and fails Preferred, so each
// case isolates one Reliable gate.
const week = (measured, endpoint = {}, chain) => stage(endpoint, { daysMeasured: 10, ...measured }, chain);
check("6.9 days measured is not enough", week({ daysMeasured: 6.9 }) === 1);
check("7 days measured is enough", week({ daysMeasured: 7 }) === 2);
check("7-day uptime under the target is not enough", week({ uptime7d: 9899 }) === 1);
check("7-day uptime at the target is enough", week({ uptime7d: 9900 }) === 2);
check("the target is the one read from the chain",
  week({ uptime7d: 9950 }, {}, { today: TODAY, thresholdBps: 9960 }) === 1);
check("11 blocks behind is out of sync", week({ lagBlocks: 11 }) === 1);
check("10 blocks behind is in sync", week({ lagBlocks: 10 }) === 2);
check("ahead of the median is in sync", week({ lagBlocks: -3 }) === 2);
check("an API type without a height passes the sync gate", week({ lagBlocks: null }) === 2);
check("flagged 7 days ago is still on probation", week({}, { lastAdverseDay: TODAY - 7 }) === 1);
check("flagged 8 days ago is Reliable again", week({}, { lastAdverseDay: TODAY - 8 }) === 2);
check("a missing uptime is not a pass", week({ uptime7d: null }) === 1);

console.log("\nPreferred, at each boundary");
check("29.9 days measured is not enough", stage({}, { daysMeasured: 29.9 }) === 2);
check("30 days measured is enough", stage({}, { daysMeasured: 30 }) === 3);
check("30-day uptime under 99.50% is not enough", stage({}, { uptime30d: 9949 }) === 2);
check("30-day uptime at 99.50% is enough", stage({}, { uptime30d: 9950 }) === 3);
check("flagged 30 days ago blocks Preferred", stage({ lastAdverseDay: TODAY - 30 }) === 2);
check("flagged 31 days ago allows Preferred", stage({ lastAdverseDay: TODAY - 31 }) === 3);
check("p95 over budget blocks Preferred", stage({}, { p95_7d: 1501 }) === 2);
check("p95 at budget is Preferred", stage({}, { p95_7d: 1500 }) === 3);
check("a missing latency is not a pass", stage({}, { p95_7d: null }) === 2);
check("snapshot services are exempt from the budget", stage({ kind: 7 }, { p95_7d: 9000 }) === 3);
check("one feed cannot make an endpoint Preferred", stage({}, { feeds: 1, spread7d: 0 }) === 2);
check("feeds 2.01 points apart block Preferred", stage({}, { spread7d: 201 }) === 2);
check("feeds 2 points apart agree", stage({}, { spread7d: 200 }) === 3);
check("rate-limited on over 5% of probes blocks Preferred", stage({}, { throttled7d: 501 }) === 2);
check("rate-limited on 5% of probes is Preferred", stage({}, { throttled7d: 500 }) === 3);

console.log("\nwhat a reader is told");
const slow = run({}, { p95_7d: 1840 });
check("the one open gate is named", slow.next.length === 1 && slow.next[0].id === "latency",
  slow.next.map((gate) => gate.id).join());
check("the open gate carries its measured value", slow.next[0]?.detail === "1,840 ms · budget 1,500 ms",
  slow.next[0]?.detail);
const young = run({}, { daysMeasured: 3.4 });
check("a young endpoint is told how much history it has",
  young.next.find((gate) => gate.id === "measured7")?.detail === "3 of 7 days",
  young.next.find((gate) => gate.id === "measured7")?.detail);
const probation = run({ lastAdverseDay: TODAY - 2 });
check("a recent flag is dated and the wait is stated",
  probation.next.find((gate) => gate.id === "clean7")?.detail === "last flagged 2 days ago · needs 7 clean days",
  probation.next.find((gate) => gate.id === "clean7")?.detail);
check("a recovered endpoint waits at Verified", probation.stage === 1);
check("an endpoint that was never flagged says so",
  run().gates.find((gate) => gate.id === "clean30").detail === "never flagged");
check("each stage has a meaning", S.MEANINGS.length === 4 && run().meaning === S.MEANINGS[3]);
check("the requirements list matches the gates",
  JSON.stringify(S.requirements().map((labels) => labels.length)) === "[0,1,4,6]");

console.log("\ncombining feeds");
const entry = (id, kind, height, overrides = {}) => ({
  id, epoch: 1, kind, first_seen: NOW - 35 * DAY,
  stats_1h: { latest_height: height },
  stats_24h: { uptime_bps: 9990, counted: 2400 },
  stats_7d: { uptime_bps: 9980, counted: 17_000, samples: 17_100, throttled: 100, latency_p95_ms: 200 },
  stats_30d: { uptime_bps: 9970, counted: 70_000 },
  ...overrides
});
const feedA = { endpoints: [
  entry(1, 0, 1000), entry(2, 0, 1004), entry(3, 1, 1002), entry(4, 2, 1001), entry(5, 4, null)
] };
// Written thirty blocks earlier than feed A, and measuring endpoint 1 lower.
const feedB = { endpoints: [
  entry(1, 0, 970, { stats_7d: { uptime_bps: 9940, counted: 16_000, samples: 16_000, throttled: 0, latency_p95_ms: 260 } }),
  entry(2, 0, 974), entry(3, 1, 972), entry(4, 2, 971), entry(5, 4, null)
] };
const m1 = S.metricsFromFeeds([feedA, feedB], { id: 1, epoch: 1, kind: 0 }, NOW);
check("both feeds count", m1.feeds === 2, String(m1.feeds));
check("uptime is the median of the feeds", m1.uptime7d === 9960, String(m1.uptime7d));
check("disagreement is the spread between feeds", m1.spread7d === 40, String(m1.spread7d));
check("latency is the median of the feeds", m1.p95_7d === 230, String(m1.p95_7d));
check("history is counted from first_seen", Math.abs(m1.daysMeasured - 35) < 1e-9, String(m1.daysMeasured));
check("the throttled share comes from the 7-day window",
  Math.abs(m1.throttled7d - (100 * 10_000 / 17_100) / 2) < 1e-6, String(m1.throttled7d));
check("a feed written earlier does not make an endpoint look behind", m1.lagBlocks === 2, String(m1.lagBlocks));
const m4 = S.metricsFromFeeds([feedA, feedB], { id: 4, epoch: 1, kind: 2 }, NOW);
check("Cosmos heights are compared with Cosmos heights", m4.lagBlocks === 0, String(m4.lagBlocks));
const m5 = S.metricsFromFeeds([feedA, feedB], { id: 5, epoch: 1, kind: 4 }, NOW);
check("an API type without a height has no lag", m5.lagBlocks === null && m5.feeds === 2, String(m5.lagBlocks));
const renamed = { endpoints: [entry(1, 0, 1000, { epoch: 2 })] };
check("a feed for another epoch is ignored",
  S.metricsFromFeeds([feedA, renamed], { id: 1, epoch: 1, kind: 0 }, NOW).feeds === 1);
const older = { endpoints: [{ ...entry(1, 0, 1000), stats_7d: undefined }] };
check("a feed from a checker older than 3.1.0 is not counted",
  S.metricsFromFeeds([older], { id: 1, epoch: 1, kind: 0 }, NOW).feeds === 0);
check("an endpoint no feed mentions has no metrics",
  S.metricsFromFeeds([feedA], { id: 99, epoch: 1, kind: 0 }, NOW).feeds === 0);
check("combined metrics feed straight into the stage",
  S.stageOf(record(), m1, CHAIN).stage === 3, JSON.stringify(S.stageOf(record(), m1, CHAIN).next));

console.log("\npicking endpoints");
const nodes = [
  { url: "a", kind: 0, stage: 3 }, { url: "b", kind: 0, stage: 3 }, { url: "c", kind: 0, stage: 2 },
  { url: "d", kind: 0, stage: 1 }, { url: "e", kind: 0, stage: "flagged" },
  { url: "f", kind: 0, stage: 3, belowTargetToday: true }, { url: "g", kind: 2, stage: 3 }
];
const sequence = (values) => { let index = 0; return () => values[index++ % values.length]; };
const picked = S.pickEndpoints(nodes, 0, 10, sequence([0.5])).map((node) => node.url);
check("Preferred endpoints come first", picked.slice(0, 2).sort().join() === "a,b", picked.join());
check("Reliable endpoints come next", picked[2] === "c" && picked.length === 3, picked.join());
check("Verified, flagged and below-target endpoints are never picked",
  !picked.some((url) => ["d", "e", "f"].includes(url)));
check("other API types are left out", !picked.includes("g"));
check("order inside a stage follows the random draw",
  S.pickEndpoints(nodes, 0, 1, sequence([0.9, 0.1, 0.5]))[0].url === "b"
  && S.pickEndpoints(nodes, 0, 1, sequence([0.1, 0.9, 0.5]))[0].url === "a");
check("three endpoints by default", S.pickEndpoints(nodes, 0).length === 3);

console.log("\npolicy");
check("the default policy is versioned", S.POLICY.version === "draft-1");
check("the default policy cannot be changed at run time", Object.isFrozen(S.POLICY));
const local = S.policy({ latencyBudgetMs: 2500 });
check("an override changes one threshold", local.latencyBudgetMs === 2500 && local.reliableDays === 7);
check("an override shows in the version", local.version === "draft-1+local", local.version);
check("a deployment can name its policy", S.policy({ version: "gl1-2026-11", maxLagBlocks: 20 }).version === "gl1-2026-11");
check("nonsense overrides are ignored", S.policy({ reliableDays: "soon", maxLagBlocks: -1 }).version === "draft-1");
check("the overridden budget is applied", S.stageOf(record(), metrics({ p95_7d: 1840 }), CHAIN, local).stage === 3);
check("labels follow the policy", S.requirements(S.policy({ preferredDays: 45 }))[3].includes("Measured for 45 days"));

console.log(`\n${"-".repeat(62)}`);
console.log(`${PASSED.length} passed, ${FAILED.length} failed`);
FAILED.forEach(([name, detail]) => console.log(`  FAILED: ${name} — ${detail}`));
process.exit(FAILED.length ? 1 : 0);
