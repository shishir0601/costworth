# CostWorth

Cost-per-token tells you what you spent. **Cost-per-outcome tells you what it was worth.**

Log LLM usage sessions with an outcome (completed / partial / wasted), and CostWorth computes the metric that actually matters: how much you're really paying per thing you get done — because wasted spend is part of the true cost, not a separate line item to ignore.

**Zero runtime dependencies.**

## Run it

```bash
git clone https://github.com/<your-username>/costworth.git
cd costworth
node server.js
# → http://localhost:3000
```

No `npm install` needed — the server and frontend have zero runtime dependencies.

## Run the tests

```bash
npm test    # 41 tests: analytics/pricing/filtering unit tests + API integration tests
```

## The idea

Every existing Claude/LLM usage tracker (there are dozens on GitHub) shows tokens and dollars. None of them ask the more useful question: **what did that money actually buy you?**

A session that burned $2 and shipped a fix is good value. A session that burned $2 going in circles is bad value — even though the dashboard would show the same "$2 spent" either way. CostWorth tags every session with an outcome and makes that distinction visible.

## Core metric

```
cost per completed outcome = TOTAL spend (including wasted/partial) / count of COMPLETED sessions
```

Deliberately dividing by total spend, not just the spend on sessions that worked — because the failed attempts are part of the real cost of getting something done. See [`lib/analytics.js`](lib/analytics.js), fully unit-tested.

## Also included

- **Monthly statements, not just a running total** — the ledger is browsable month to month (like an actual statement), with the current month showing a live forecast and past months showing a closed summary.
- **Category breakdown** — see whether "debugging" or "writing" sessions have worse cost-per-completed-outcome, so you know where the waste concentrates.
- **Month-end spend forecast** — ordinary least squares linear regression fit to daily cumulative spend, projected to month-end. Simple, honest, and the math is fully unit-tested (`lib/analytics.js: linearRegression`, `forecastMonthEnd`).
- **Two ways to log cost** — either raw token counts (auto-priced from a lookup table covering Claude/GPT/Gemini models) or a direct dollar amount (for subscription-plan usage where there's no per-token price). Editing a session round-trips correctly either way, because the original model/token breakdown is preserved, not just the derived cost.
- **Editable entries** — fix a typo without deleting and re-logging.
- **Filtering + CSV export** — filter the session list by outcome/category, and export exactly what you're looking at.

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/models` | Pricing table for supported models |
| `POST` | `/api/sessions` | Log a session (by tokens or direct cost) |
| `GET` | `/api/sessions` | List sessions — optional `?month=YYYY-MM&outcome=&category=` |
| `PATCH` | `/api/sessions/:id` | Edit a session (any subset of description/category/outcome/cost or model+tokens) |
| `DELETE` | `/api/sessions/:id` | Remove a session |
| `GET` | `/api/sessions/export.csv` | CSV export — same optional filters as the list route |
| `GET` | `/api/analytics` | Breakdown by outcome/category, cost-per-completed, daily spend series, forecast. Omit `?month` for all-time totals with the current month's forecast; pass `?month=YYYY-MM` to scope everything to one statement |

Unknown routes return `404`; known routes called with the wrong HTTP method return `405` with an `Allow` header.

## Architecture

```
server.js          pure-Node HTTP server: routing, validation, static file serving
lib/pricing.js      per-model token pricing lookup + cost calculation
lib/analytics.js    cost-per-outcome math, filtering, CSV, linear regression forecast (pure functions, tested)
lib/store.js        JSON-file persistence (write-then-rename, so a crash never leaves a half-written file)
public/             vanilla JS frontend
test/                41 tests
```

Data persists to `data.json` in the project root (override the path with the `COSTWORTH_DB` env var, which the test suite also uses to keep test runs isolated from your real data). Session ids are `crypto.randomUUID()`. The server responds to `SIGINT`/`SIGTERM` with a graceful shutdown.

## Roadmap

- [ ] Auto-import from Claude Code's local session logs instead of manual entry
- [ ] Multi-provider comparison (same task type, different model — which was better value?)
- [ ] Year-over-year / multi-month trend view (today's chart covers one statement at a time)

## License

MIT
