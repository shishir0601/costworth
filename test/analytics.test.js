const test = require("node:test");
const assert = require("node:assert/strict");
const { costFromTokens } = require("../lib/pricing");
const {
  costPerCompletedOutcome,
  spendByOutcome,
  spendByCategory,
  linearRegression,
  forecastMonthEnd,
  filterSessions,
  dailySeriesForMonth,
  toCsv,
} = require("../lib/analytics");

test("costFromTokens: computes blended input/output cost correctly", () => {
  // sonnet: $3/M input, $15/M output
  const cost = costFromTokens("claude-sonnet", 1_000_000, 100_000);
  assert.ok(Math.abs(cost - (3 + 1.5)) < 1e-9);
});

test("costFromTokens: throws on unknown model", () => {
  assert.throws(() => costFromTokens("nonexistent-model", 1000, 1000));
});

test("costPerCompletedOutcome: divides TOTAL spend (incl. waste) by completed count", () => {
  const sessions = [
    { cost: 2, outcome: "completed", category: "debug", date: "2026-07-01" },
    { cost: 3, outcome: "wasted", category: "debug", date: "2026-07-02" },
    { cost: 1, outcome: "completed", category: "debug", date: "2026-07-03" },
  ];
  // total = 6, completed = 2 -> 3 per completed outcome (wasted spend counted in)
  assert.equal(costPerCompletedOutcome(sessions), 3);
});

test("costPerCompletedOutcome: returns null when nothing has completed", () => {
  const sessions = [{ cost: 5, outcome: "wasted", category: "x", date: "2026-07-01" }];
  assert.equal(costPerCompletedOutcome(sessions), null);
});

test("spendByOutcome: buckets correctly and computes wasted percentage", () => {
  const sessions = [
    { cost: 4, outcome: "completed", category: "a", date: "d" },
    { cost: 2, outcome: "wasted", category: "a", date: "d" },
    { cost: 4, outcome: "partial", category: "a", date: "d" },
  ];
  const result = spendByOutcome(sessions);
  assert.equal(result.completed, 4);
  assert.equal(result.wasted, 2);
  assert.equal(result.partial, 4);
  assert.equal(result.total, 10);
  assert.ok(Math.abs(result.wastedPct - 0.2) < 1e-9);
});

test("spendByOutcome: rejects an invalid outcome label", () => {
  assert.throws(() => spendByOutcome([{ cost: 1, outcome: "banana", category: "a", date: "d" }]));
});

test("spendByCategory: computes per-category cost-per-completed", () => {
  const sessions = [
    { cost: 2, outcome: "completed", category: "debug", date: "d" },
    { cost: 2, outcome: "wasted", category: "debug", date: "d" },
    { cost: 5, outcome: "completed", category: "writing", date: "d" },
  ];
  const result = spendByCategory(sessions);
  assert.equal(result.debug.total, 4);
  assert.equal(result.debug.costPerCompleted, 4); // (2+2)/1 completed
  assert.equal(result.writing.costPerCompleted, 5);
});

test("linearRegression: recovers exact slope/intercept for a perfect line", () => {
  const points = [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]; // y = 2x + 1
  const { slope, intercept } = linearRegression(points);
  assert.ok(Math.abs(slope - 2) < 1e-9);
  assert.ok(Math.abs(intercept - 1) < 1e-9);
});

test("linearRegression: throws with fewer than 2 points", () => {
  assert.throws(() => linearRegression([{ x: 0, y: 1 }]));
});

test("forecastMonthEnd: projects flat daily spend forward correctly", () => {
  // $5/day cumulative for 4 days -> day 30 projection should be ~$150
  const daily = [
    { day: 1, cumulative: 5 },
    { day: 2, cumulative: 10 },
    { day: 3, cumulative: 15 },
    { day: 4, cumulative: 20 },
  ];
  const forecast = forecastMonthEnd(daily, 30);
  assert.ok(Math.abs(forecast.dailyRate - 5) < 1e-9);
  assert.ok(Math.abs(forecast.projectedTotal - 150) < 1e-6);
});

test("forecastMonthEnd: never projects a negative total", () => {
  const daily = [{ day: 1, cumulative: 5 }, { day: 2, cumulative: 0 }];
  const forecast = forecastMonthEnd(daily, 30);
  assert.ok(forecast.projectedTotal >= 0);
});

test("filterSessions: narrows by month, outcome, and category independently", () => {
  const sessions = [
    { cost: 1, outcome: "completed", category: "coding", date: "2026-06-01" },
    { cost: 2, outcome: "wasted", category: "coding", date: "2026-07-01" },
    { cost: 3, outcome: "completed", category: "writing", date: "2026-07-02" },
  ];
  assert.equal(filterSessions(sessions, { month: "2026-07" }).length, 2);
  assert.equal(filterSessions(sessions, { outcome: "completed" }).length, 2);
  assert.equal(filterSessions(sessions, { category: "coding" }).length, 2);
  assert.equal(filterSessions(sessions, { month: "2026-07", category: "writing" }).length, 1);
});

test("filterSessions: category matching is case-insensitive", () => {
  const sessions = [{ cost: 1, outcome: "completed", category: "coding", date: "d" }];
  assert.equal(filterSessions(sessions, { category: "CODING" }).length, 1);
});

test("filterSessions: with no filters returns everything unchanged", () => {
  const sessions = [{ cost: 1, outcome: "completed", category: "a", date: "d" }];
  assert.equal(filterSessions(sessions, {}).length, 1);
  assert.equal(filterSessions(sessions).length, 1);
});

test("dailySeriesForMonth: only includes the requested month and accumulates in day order", () => {
  const sessions = [
    { cost: 2, outcome: "completed", category: "a", date: "2026-06-30" }, // excluded, wrong month
    { cost: 3, outcome: "completed", category: "a", date: "2026-07-05" },
    { cost: 1, outcome: "completed", category: "a", date: "2026-07-01" },
  ];
  const series = dailySeriesForMonth(sessions, "2026-07");
  assert.deepEqual(series, [
    { day: 1, cumulative: 1 },
    { day: 5, cumulative: 4 },
  ]);
});

test("dailySeriesForMonth: empty when nothing matches the month", () => {
  const sessions = [{ cost: 1, outcome: "completed", category: "a", date: "2026-06-01" }];
  assert.deepEqual(dailySeriesForMonth(sessions, "2026-07"), []);
});

test("toCsv: includes a header row and one row per session", () => {
  const sessions = [
    { id: "1", date: "2026-07-01", description: "Fix bug", category: "coding", outcome: "completed", cost: 2.5 },
  ];
  const csv = toCsv(sessions);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "id,date,description,category,outcome,cost");
  assert.equal(lines[1], "1,2026-07-01,Fix bug,coding,completed,2.5");
});

test("toCsv: quotes and escapes fields containing commas or quotes", () => {
  const sessions = [
    { id: "1", date: "2026-07-01", description: 'Debug "auth", then ship', category: "coding", outcome: "completed", cost: 1 },
  ];
  const csv = toCsv(sessions);
  const lines = csv.trim().split("\n");
  assert.equal(lines[1], '1,2026-07-01,"Debug ""auth"", then ship",coding,completed,1');
});
