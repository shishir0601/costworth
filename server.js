/**
 * CostWorth server — pure Node HTTP, zero runtime dependencies.
 * Routes:
 *   GET    /api/models
 *   GET    /api/sessions            ?month=YYYY-MM&outcome=...&category=...
 *   POST   /api/sessions
 *   PATCH  /api/sessions/:id
 *   DELETE /api/sessions/:id
 *   GET    /api/sessions/export.csv ?month=YYYY-MM&outcome=...&category=...
 *   GET    /api/analytics           ?month=YYYY-MM
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./lib/store");
const { PRICING, costFromTokens } = require("./lib/pricing");
const {
  OUTCOMES,
  costPerCompletedOutcome,
  spendByOutcome,
  spendByCategory,
  forecastMonthEnd,
  filterSessions,
  dailySeriesForMonth,
  toCsv,
} = require("./lib/analytics");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 60;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- small HTTP helpers ----------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const safePath = path.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(fullPath);
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream", "Cache-Control": cacheControl });
    res.end(data);
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  // Day 0 of next month = last day of this month. Computed in UTC to stay
  // consistent with todayISO(), which is also UTC-based.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Validates a "?month=YYYY-MM" query param. Returns null if absent, throws {status,message} if malformed. */
function parseMonthParam(raw) {
  if (!raw) return null;
  if (!MONTH_PATTERN.test(raw)) throw { status: 400, message: "month must be in YYYY-MM format" };
  return raw;
}

/** Validates a "?outcome=" query param. Returns null if absent, throws {status,message} if unrecognized. */
function parseOutcomeParam(raw) {
  if (!raw) return null;
  if (!OUTCOMES.includes(raw)) throw { status: 400, message: `outcome must be one of: ${OUTCOMES.join(", ")}` };
  return raw;
}

/** Parses and validates the shared month/outcome/category filter params used by sessions list + CSV export. */
function parseListFilters(url) {
  return {
    month: parseMonthParam(url.searchParams.get("month")),
    outcome: parseOutcomeParam(url.searchParams.get("outcome")),
    category: url.searchParams.get("category") || null,
  };
}

// ---------- validation ----------

function validateSessionInput(body) {
  const errors = [];
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";

  if (!description) errors.push("description is required");
  else if (description.length > MAX_DESCRIPTION_LENGTH) errors.push(`description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);

  if (!category) errors.push("category is required");
  else if (category.length > MAX_CATEGORY_LENGTH) errors.push(`category must be ${MAX_CATEGORY_LENGTH} characters or fewer`);

  if (!OUTCOMES.includes(body.outcome)) errors.push(`outcome must be one of: ${OUTCOMES.join(", ")}`);
  return errors;
}

/** Resolves the cost for a session, either from a direct $ amount or from tokens. Throws {status,message}. */
function resolveCost(body) {
  const hasDirectCost = body.cost !== undefined && body.cost !== null && body.cost !== "";
  if (hasDirectCost) {
    const cost = Number(body.cost);
    if (!Number.isFinite(cost) || cost < 0) throw { status: 400, message: "cost must be a non-negative number" };
    return { cost, model: undefined, inputTokens: undefined, outputTokens: undefined };
  }

  const inputTokens = Number(body.inputTokens);
  const outputTokens = Number(body.outputTokens);
  if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0) {
    throw { status: 400, message: "inputTokens and outputTokens must be non-negative numbers" };
  }
  if (!body.model || !PRICING[body.model]) {
    throw { status: 400, message: `Unknown model: ${body.model}` };
  }
  return { cost: costFromTokens(body.model, inputTokens, outputTokens), model: body.model, inputTokens, outputTokens };
}

function sortByDateDesc(sessions) {
  return [...sessions].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

function buildAnalytics(allSessions, monthParam) {
  const seriesMonth = monthParam || currentMonthStr();
  const scoped = monthParam ? filterSessions(allSessions, { month: monthParam }) : allSessions;
  const dailySeries = dailySeriesForMonth(allSessions, seriesMonth);
  const isCurrentMonth = seriesMonth === currentMonthStr();

  return {
    month: monthParam || null,
    isCurrentMonth,
    perCompleted: costPerCompletedOutcome(scoped),
    byOutcome: spendByOutcome(scoped),
    byCategory: spendByCategory(scoped),
    dailySeries,
    forecast: isCurrentMonth ? forecastMonthEnd(dailySeries, lastDayOfMonth(seriesMonth)) : null,
  };
}

// ---------- routes ----------

// Excludes "export.csv" so it doesn't get swallowed by the :id capture group below.
const SESSION_ID_PATTERN = /^\/api\/sessions\/(?!export\.csv$)([^/]+)$/;

const routes = [
  {
    method: "GET",
    pattern: /^\/api\/models$/,
    handle: (req, res) => sendJson(res, 200, PRICING),
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions$/,
    handle: (req, res, match, url) => {
      let filters;
      try {
        filters = parseListFilters(url);
      } catch (e) {
        return sendJson(res, e.status, { error: e.message });
      }
      const db = store.load();
      const sessions = filterSessions(Object.values(db.sessions), filters);
      sendJson(res, 200, sortByDateDesc(sessions));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/sessions\/export\.csv$/,
    handle: (req, res, match, url) => {
      let filters;
      try {
        filters = parseListFilters(url);
      } catch (e) {
        return sendJson(res, e.status, { error: e.message });
      }
      const db = store.load();
      const sessions = sortByDateDesc(filterSessions(Object.values(db.sessions), filters));
      const csv = toCsv(sessions);
      const scope = filters.month || "all-time";
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="costworth-${scope}.csv"`,
        "Cache-Control": "no-store",
      });
      res.end(csv);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/sessions$/,
    handle: async (req, res) => {
      const body = await readJsonBody(req);
      const errors = validateSessionInput(body);
      if (errors.length) return sendJson(res, 400, { error: errors.join("; ") });

      let costInfo;
      try {
        costInfo = resolveCost(body);
      } catch (e) {
        return sendJson(res, e.status || 400, { error: e.message });
      }

      const db = store.load();
      const id = store.newId();
      const session = {
        id,
        description: body.description.trim(),
        category: body.category.trim().toLowerCase(),
        outcome: body.outcome,
        cost: costInfo.cost,
        date: todayISO(),
        model: costInfo.model,
        inputTokens: costInfo.inputTokens,
        outputTokens: costInfo.outputTokens,
      };
      db.sessions[id] = session;
      store.save(db);
      sendJson(res, 201, session);
    },
  },
  {
    method: "PATCH",
    pattern: SESSION_ID_PATTERN,
    handle: async (req, res, match) => {
      const db = store.load();
      const id = match[1];
      const existing = db.sessions[id];
      if (!existing) return sendJson(res, 404, { error: "Session not found" });

      const body = await readJsonBody(req);
      const patch = {};

      if (body.description !== undefined) {
        const description = String(body.description).trim();
        if (!description) return sendJson(res, 400, { error: "description cannot be empty" });
        if (description.length > MAX_DESCRIPTION_LENGTH) {
          return sendJson(res, 400, { error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` });
        }
        patch.description = description;
      }

      if (body.category !== undefined) {
        const category = String(body.category).trim().toLowerCase();
        if (!category) return sendJson(res, 400, { error: "category cannot be empty" });
        if (category.length > MAX_CATEGORY_LENGTH) {
          return sendJson(res, 400, { error: `category must be ${MAX_CATEGORY_LENGTH} characters or fewer` });
        }
        patch.category = category;
      }

      if (body.outcome !== undefined) {
        if (!OUTCOMES.includes(body.outcome)) {
          return sendJson(res, 400, { error: `outcome must be one of: ${OUTCOMES.join(", ")}` });
        }
        patch.outcome = body.outcome;
      }

      const wantsCostChange = body.cost !== undefined || body.model !== undefined || body.inputTokens !== undefined || body.outputTokens !== undefined;
      if (wantsCostChange) {
        let costInfo;
        try {
          costInfo = resolveCost(body);
        } catch (e) {
          return sendJson(res, e.status || 400, { error: e.message });
        }
        patch.cost = costInfo.cost;
        patch.model = costInfo.model;
        patch.inputTokens = costInfo.inputTokens;
        patch.outputTokens = costInfo.outputTokens;
      }

      if (Object.keys(patch).length === 0) {
        return sendJson(res, 400, { error: "No valid fields to update" });
      }

      // Undefined values (e.g. clearing model/inputTokens/outputTokens when
      // switching a session to a direct $ cost) are dropped on this
      // round-trip, so what's stored and what's returned both stay clean.
      const updated = JSON.parse(JSON.stringify({ ...existing, ...patch }));
      db.sessions[id] = updated;
      store.save(db);
      sendJson(res, 200, updated);
    },
  },
  {
    method: "DELETE",
    pattern: SESSION_ID_PATTERN,
    handle: (req, res, match) => {
      const db = store.load();
      const id = match[1];
      if (!db.sessions[id]) return sendJson(res, 404, { error: "Session not found" });
      delete db.sessions[id];
      store.save(db);
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/analytics$/,
    handle: (req, res, match, url) => {
      let month;
      try {
        month = parseMonthParam(url.searchParams.get("month"));
      } catch (e) {
        return sendJson(res, e.status, { error: e.message });
      }
      const db = store.load();
      sendJson(res, 200, buildAnalytics(Object.values(db.sessions), month));
    },
  },
];

function allowedMethodsFor(pathname) {
  return [...new Set(routes.filter((r) => r.pattern.test(pathname)).map((r) => r.method))];
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  try {
    for (const route of routes) {
      if (req.method === route.method && route.pattern.test(pathname)) {
        const match = pathname.match(route.pattern);
        return await route.handle(req, res, match, url);
      }
    }

    if (pathname.startsWith("/api/")) {
      const allowed = allowedMethodsFor(pathname);
      if (allowed.length) {
        res.setHeader("Allow", allowed.join(", "));
        return sendJson(res, 405, { error: "Method not allowed" });
      }
      return sendJson(res, 404, { error: "Not found" });
    }

    serveStatic(res, pathname);
  } catch (err) {
    console.error("Unhandled request error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`CostWorth running at http://localhost:${PORT}`);
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = server;
