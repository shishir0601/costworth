const OUTCOMES = ["completed", "partial", "wasted"];

/**
 * TOTAL spend (including wasted/partial sessions) divided by the count
 * of completed sessions. Deliberately not "spend on sessions that worked" —
 * failed attempts are part of the real cost of getting something done.
 * Returns null when nothing has completed yet, rather than dividing by zero.
 */
function costPerCompletedOutcome(sessions) {
  const completedCount = sessions.filter((s) => s.outcome === "completed").length;
  if (completedCount === 0) return null;
  const total = sessions.reduce((sum, s) => sum + s.cost, 0);
  return total / completedCount;
}

/**
 * Buckets spend by outcome and computes the wasted-spend percentage.
 * Throws on any outcome label outside the known set, so a bad value
 * surfaces immediately instead of silently vanishing from the totals.
 */
function spendByOutcome(sessions) {
  const totals = { completed: 0, partial: 0, wasted: 0 };
  for (const s of sessions) {
    if (!OUTCOMES.includes(s.outcome)) {
      throw new Error(`Invalid outcome: ${s.outcome}`);
    }
    totals[s.outcome] += s.cost;
  }
  const total = totals.completed + totals.partial + totals.wasted;
  const wastedPct = total > 0 ? totals.wasted / total : 0;
  return { ...totals, total, wastedPct };
}

/**
 * Per-category spend, plus cost-per-completed-outcome scoped to that
 * category (null if the category has no completed sessions yet).
 */
function spendByCategory(sessions) {
  const byCat = {};
  for (const s of sessions) {
    if (!byCat[s.category]) byCat[s.category] = { total: 0, completedCount: 0 };
    byCat[s.category].total += s.cost;
    if (s.outcome === "completed") byCat[s.category].completedCount += 1;
  }
  const result = {};
  for (const [name, v] of Object.entries(byCat)) {
    result[name] = {
      total: v.total,
      costPerCompleted: v.completedCount > 0 ? v.total / v.completedCount : null,
    };
  }
  return result;
}

/**
 * Ordinary least squares fit for points {x, y}.
 */
function linearRegression(points) {
  if (points.length < 2) throw new Error("linearRegression needs at least 2 points");
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Fits a line to daily cumulative spend and projects it out to targetDay
 * (e.g. the last day of the current month). Never returns a negative
 * projection — a downward-trending fit is floored at 0, not shown as
 * "you'll end the month owed money".
 */
function forecastMonthEnd(daily, targetDay) {
  if (daily.length < 2) return null;
  const points = daily.map((d) => ({ x: d.day, y: d.cumulative }));
  const { slope, intercept } = linearRegression(points);
  const projectedTotal = Math.max(0, slope * targetDay + intercept);
  return { dailyRate: slope, projectedTotal };
}

/**
 * Narrows a session list to a given month ("YYYY-MM"), outcome, and/or
 * category. Any filter left undefined is skipped. Category matching is
 * case-insensitive (sessions are stored with lowercased categories, so
 * this normalizes the filter value the same way).
 */
function filterSessions(sessions, { month, outcome, category } = {}) {
  return sessions.filter((s) => {
    if (month && !s.date.startsWith(month)) return false;
    if (outcome && s.outcome !== outcome) return false;
    if (category && s.category !== category.toLowerCase()) return false;
    return true;
  });
}

/**
 * Cumulative daily spend for one specific month ("YYYY-MM"), regardless
 * of the current date — unlike a "this month so far" view, this works
 * for any month you hand it, which is what makes past statements browsable.
 */
function dailySeriesForMonth(sessions, month) {
  const byDay = {};
  for (const s of sessions) {
    if (!s.date || !s.date.startsWith(month)) continue;
    const day = Number(s.date.slice(8, 10));
    byDay[day] = (byDay[day] || 0) + s.cost;
  }
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  let cumulative = 0;
  return days.map((day) => {
    cumulative += byDay[day];
    return { day, cumulative };
  });
}

/**
 * Serializes sessions to CSV (id, date, description, category, outcome, cost).
 * Quotes and escapes any field containing a comma, quote, or newline.
 */
function toCsv(sessions) {
  const columns = ["id", "date", "description", "category", "outcome", "cost"];
  const escapeCell = (value) => {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = sessions.map((s) => columns.map((c) => escapeCell(s[c])).join(","));
  return [columns.join(","), ...rows].join("\n") + "\n";
}

module.exports = {
  OUTCOMES,
  costPerCompletedOutcome,
  spendByOutcome,
  spendByCategory,
  linearRegression,
  forecastMonthEnd,
  filterSessions,
  dailySeriesForMonth,
  toCsv,
};
