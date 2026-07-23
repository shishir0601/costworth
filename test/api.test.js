const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

process.env.COSTWORTH_DB = path.join(__dirname, "test-data.json");
const server = require("../server");

let base;

test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.COSTWORTH_DB, { force: true });
});

test.beforeEach(() => {
  require("../lib/store").save({ sessions: {} });
});

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method, headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

/** Like api(), but for endpoints that don't return JSON (e.g. the CSV export). */
async function apiRaw(method, p) {
  const res = await fetch(base + p, { method });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

test("logging a session with tokens computes cost from the pricing table", async () => {
  const { status, data } = await api("POST", "/api/sessions", {
    description: "Refactor auth module", outcome: "completed", category: "coding",
    model: "claude-sonnet", inputTokens: 1_000_000, outputTokens: 100_000,
  });
  assert.equal(status, 201);
  assert.ok(Math.abs(data.cost - 4.5) < 1e-9); // 3 + 1.5
});

test("logging a session with a direct cost skips the pricing lookup", async () => {
  const { status, data } = await api("POST", "/api/sessions", {
    description: "Subscription usage", outcome: "wasted", category: "misc", cost: 2.5,
  });
  assert.equal(status, 201);
  assert.equal(data.cost, 2.5);
});

test("validation: rejects missing outcome or category", async () => {
  const bad = await api("POST", "/api/sessions", { description: "x", cost: 1 });
  assert.equal(bad.status, 400);
});

test("analytics: aggregates cost-per-completed-outcome across sessions", async () => {
  await api("POST", "/api/sessions", { description: "a", outcome: "completed", category: "coding", cost: 2 });
  await api("POST", "/api/sessions", { description: "b", outcome: "wasted", category: "coding", cost: 3 });
  const { data } = await api("GET", "/api/analytics");
  assert.equal(data.perCompleted, 5); // (2+3)/1 completed
  assert.equal(data.byOutcome.total, 5);
});

test("deleting a session removes it from analytics", async () => {
  const { data: s } = await api("POST", "/api/sessions", { description: "temp", outcome: "completed", category: "x", cost: 10 });
  await api("DELETE", `/api/sessions/${s.id}`);
  const { data: list } = await api("GET", "/api/sessions");
  assert.equal(list.length, 0);
});

test("unknown model in token-based session returns 400, not a crash", async () => {
  const res = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y", model: "fake-model",
    inputTokens: 100, outputTokens: 100,
  });
  assert.equal(res.status, 400);
});

test("validation: rejects negative token counts", async () => {
  const res = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y", model: "claude-sonnet",
    inputTokens: -1000, outputTokens: 500,
  });
  assert.equal(res.status, 400);
});

test("analytics on an empty store returns null perCompleted, not NaN or a crash", async () => {
  const { status, data } = await api("GET", "/api/analytics");
  assert.equal(status, 200);
  assert.equal(data.perCompleted, null);
  assert.equal(data.byOutcome.wastedPct, 0);
  assert.equal(data.forecast, null);
});

test("validation: rejects a description over the length limit", async () => {
  const res = await api("POST", "/api/sessions", {
    description: "x".repeat(501), outcome: "completed", category: "y", cost: 1,
  });
  assert.equal(res.status, 400);
});

test("PATCH updates description, category, and outcome", async () => {
  const { data: created } = await api("POST", "/api/sessions", {
    description: "Original", outcome: "wasted", category: "coding", cost: 1,
  });
  const { status, data } = await api("PATCH", `/api/sessions/${created.id}`, {
    description: "Fixed description", category: "writing", outcome: "completed",
  });
  assert.equal(status, 200);
  assert.equal(data.description, "Fixed description");
  assert.equal(data.category, "writing");
  assert.equal(data.outcome, "completed");
  assert.equal(data.cost, 1); // untouched, since no cost fields were sent
});

test("PATCH recomputes cost when tokens/model are sent", async () => {
  const { data: created } = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y", cost: 99,
  });
  const { status, data } = await api("PATCH", `/api/sessions/${created.id}`, {
    model: "claude-sonnet", inputTokens: 1_000_000, outputTokens: 100_000,
  });
  assert.equal(status, 200);
  assert.ok(Math.abs(data.cost - 4.5) < 1e-9);
});

test("PATCH on an unknown id returns 404", async () => {
  const res = await api("PATCH", "/api/sessions/does-not-exist", { description: "x" });
  assert.equal(res.status, 404);
});

test("PATCH with no recognized fields returns 400", async () => {
  const { data: created } = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y", cost: 1,
  });
  const res = await api("PATCH", `/api/sessions/${created.id}`, { nonsense: true });
  assert.equal(res.status, 400);
});

test("GET /api/sessions filters by outcome and category", async () => {
  await api("POST", "/api/sessions", { description: "a", outcome: "completed", category: "coding", cost: 1 });
  await api("POST", "/api/sessions", { description: "b", outcome: "wasted", category: "coding", cost: 1 });
  await api("POST", "/api/sessions", { description: "c", outcome: "completed", category: "writing", cost: 1 });

  const byOutcome = await api("GET", "/api/sessions?outcome=completed");
  assert.equal(byOutcome.data.length, 2);

  const byCategory = await api("GET", "/api/sessions?category=coding");
  assert.equal(byCategory.data.length, 2);

  const both = await api("GET", "/api/sessions?outcome=completed&category=coding");
  assert.equal(both.data.length, 1);
  assert.equal(both.data[0].description, "a");
});

test("GET /api/sessions rejects an invalid outcome filter", async () => {
  const res = await api("GET", "/api/sessions?outcome=banana");
  assert.equal(res.status, 400);
});

test("GET /api/sessions rejects a malformed month filter", async () => {
  const res = await api("GET", "/api/sessions?month=not-a-month");
  assert.equal(res.status, 400);
});

test("GET /api/analytics?month scopes totals to that month and echoes isCurrentMonth", async () => {
  await api("POST", "/api/sessions", { description: "a", outcome: "completed", category: "x", cost: 5 });
  const { data } = await api("GET", `/api/analytics?month=${thisMonth()}`);
  assert.equal(data.month, thisMonth());
  assert.equal(data.isCurrentMonth, true);
  assert.equal(data.byOutcome.total, 5);
  assert.ok(data.forecast === null || typeof data.forecast === "object");
});

test("GET /api/analytics?month for a month with no sessions returns zeroed totals, not a crash", async () => {
  const { status, data } = await api("GET", "/api/analytics?month=2020-01");
  assert.equal(status, 200);
  assert.equal(data.perCompleted, null);
  assert.equal(data.byOutcome.total, 0);
  assert.equal(data.isCurrentMonth, false);
  assert.equal(data.forecast, null);
});

test("GET /api/sessions/export.csv returns a CSV with a header and matching rows", async () => {
  await api("POST", "/api/sessions", { description: "Fix bug", outcome: "completed", category: "coding", cost: 2.5 });
  const res = await apiRaw("GET", "/api/sessions/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment/);
  const lines = res.text.trim().split("\n");
  assert.equal(lines[0], "id,date,description,category,outcome,cost");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /Fix bug,coding,completed,2\.5$/);
});

test("unsupported method on a known route returns 405 with an Allow header", async () => {
  const res = await fetch(`${base}/api/sessions`, { method: "PUT" });
  assert.equal(res.status, 405);
  assert.ok(res.headers.get("allow"));
});

test("logging by tokens persists the model/token breakdown, not just the derived cost", async () => {
  const { data } = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y",
    model: "claude-sonnet", inputTokens: 1_000_000, outputTokens: 100_000,
  });
  assert.equal(data.model, "claude-sonnet");
  assert.equal(data.inputTokens, 1_000_000);
  assert.equal(data.outputTokens, 100_000);
});

test("logging by direct cost stores no model/token fields", async () => {
  const { data } = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y", cost: 3,
  });
  assert.equal(data.model, undefined);
  assert.equal(data.inputTokens, undefined);
  assert.equal(data.outputTokens, undefined);
});

test("PATCHing a token-based session to a direct cost clears the stale breakdown", async () => {
  const { data: created } = await api("POST", "/api/sessions", {
    description: "x", outcome: "completed", category: "y",
    model: "claude-sonnet", inputTokens: 1_000_000, outputTokens: 100_000,
  });
  const { data: updated } = await api("PATCH", `/api/sessions/${created.id}`, { cost: 9 });
  assert.equal(updated.cost, 9);
  assert.equal(updated.model, undefined);
  assert.equal(updated.inputTokens, undefined);
});
