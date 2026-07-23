/* CostWorth frontend — vanilla JS, zero dependencies. */

const $ = (id) => document.getElementById(id);
let mode = "tokens";
let modelPricing = {};
let heroDisplayed = null;
let editingId = null;
let viewedMonth = null;
let lastSessions = [];
const filters = { outcome: "", category: "" };
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

const fmt = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Render a list into HTML, or a fallback note if there's nothing. */
const renderList = (items, itemHtml, emptyHtml) =>
  items.length ? items.map(itemHtml).join("") : emptyHtml;

const emptyIconSvg = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>`;

// ---------- month helpers ----------

function currentMonthStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(monthStr, delta) {
  const [y, m] = monthStr.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .toUpperCase();
}

// ---------- cost-entry mode ----------

function setMode(newMode) {
  mode = newMode;
  document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === newMode));
  $("tokens-inputs").hidden = newMode !== "tokens";
  $("direct-inputs").hidden = newMode !== "direct";
}

document.querySelectorAll(".toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

// ---------- edit mode ----------

function enterEditMode(session) {
  editingId = session.id;
  $("s-desc").value = session.description;
  $("s-category").value = session.category;
  $("s-outcome").value = session.outcome;

  if (session.model) {
    setMode("tokens");
    $("s-model").value = session.model;
    $("s-input-tok").value = session.inputTokens;
    $("s-output-tok").value = session.outputTokens;
  } else {
    setMode("direct");
    $("s-cost").value = session.cost;
  }

  $("log-session").textContent = "Save changes";
  $("cancel-edit").hidden = false;
  $("edit-indicator").hidden = false;
  $("s-desc").focus();
}

function exitEditMode() {
  editingId = null;
  $("log-session").textContent = "Log session";
  $("cancel-edit").hidden = true;
  $("edit-indicator").hidden = true;
  ["s-desc", "s-input-tok", "s-output-tok", "s-cost"].forEach((id) => ($(id).value = ""));
}

$("cancel-edit").addEventListener("click", exitEditMode);

// ---------- init ----------

async function init() {
  viewedMonth = currentMonthStr();
  $("ledger").classList.add("is-loading");

  modelPricing = await api("GET", "/api/models");
  $("s-model").innerHTML = Object.entries(modelPricing)
    .map(([id, m]) => `<option value="${id}">${esc(m.label || id)}</option>`)
    .join("");

  attachEnterToSubmit();
  await refreshAll();
  $("ledger").classList.remove("is-loading");
}

function attachEnterToSubmit() {
  ["s-desc", "s-category", "s-input-tok", "s-output-tok", "s-cost"].forEach((id) => {
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        $("log-session").click();
      }
    });
  });
}

// ---------- logging / editing ----------

$("log-session").addEventListener("click", async () => {
  const description = $("s-desc").value.trim();
  const category = $("s-category").value.trim().toLowerCase();
  const outcome = $("s-outcome").value;
  if (!description) return toast("Describe what you were doing");
  if (!category) return toast("Give it a category");

  const body = { description, category, outcome };
  if (mode === "tokens") {
    const inputTokens = Number($("s-input-tok").value);
    const outputTokens = Number($("s-output-tok").value);
    if (!(inputTokens >= 0) || !(outputTokens >= 0)) return toast("Enter valid token counts");
    body.model = $("s-model").value;
    body.inputTokens = inputTokens;
    body.outputTokens = outputTokens;
  } else {
    const cost = Number($("s-cost").value);
    if (!(cost >= 0)) return toast("Enter a valid cost");
    body.cost = cost;
  }

  try {
    if (editingId) {
      await api("PATCH", `/api/sessions/${editingId}`, body);
      toast("Session updated");
      exitEditMode();
    } else {
      await api("POST", "/api/sessions", body);
      ["s-desc", "s-input-tok", "s-output-tok", "s-cost"].forEach((id) => ($(id).value = ""));
      toast("Session logged");
    }
    refreshAll();
  } catch (e) { toast(e.message); }
});

// ---------- session list filters ----------

function sessionsQuery() {
  const params = new URLSearchParams();
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.category) params.set("category", filters.category);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

$("filter-outcome").addEventListener("change", () => {
  filters.outcome = $("filter-outcome").value;
  refreshAll();
});
$("filter-category").addEventListener("change", () => {
  filters.category = $("filter-category").value;
  refreshAll();
});

// ---------- month navigation ----------

$("month-prev").addEventListener("click", () => {
  viewedMonth = shiftMonth(viewedMonth, -1);
  refreshAll();
});
$("month-next").addEventListener("click", () => {
  if (viewedMonth === currentMonthStr()) return;
  viewedMonth = shiftMonth(viewedMonth, 1);
  refreshAll();
});

function updateMonthNavUI() {
  $("ledger-date").textContent = formatMonthLabel(viewedMonth);
  $("month-next").disabled = viewedMonth === currentMonthStr();
}

// ---------- rendering ----------

async function refreshAll() {
  updateMonthNavUI();
  $("export-link").href = `/api/sessions/export.csv${sessionsQuery()}`;

  const needsFilteredFetch = Boolean(filters.outcome || filters.category);
  const [allSessions, filteredSessions, analytics] = await Promise.all([
    api("GET", "/api/sessions"),
    needsFilteredFetch ? api("GET", `/api/sessions${sessionsQuery()}`) : Promise.resolve(null),
    api("GET", `/api/analytics?month=${viewedMonth}`),
  ]);

  const visibleSessions = filteredSessions || allSessions;
  lastSessions = visibleSessions;
  renderSessions(visibleSessions);
  renderCategoryOptions(allSessions);
  renderLedger(analytics);
}

function renderCategoryOptions(sessions) {
  const cats = [...new Set(sessions.map((s) => s.category))].sort();
  $("cat-list").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");

  const select = $("filter-category");
  const current = select.value;
  select.innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  select.value = cats.includes(current) ? current : "";
}

function renderSessions(sessions) {
  $("session-count").textContent = sessions.length ? `· ${sessions.length}` : "";
  $("session-list").innerHTML = renderList(sessions.slice(0, 12), (s) => `
      <li>
        <div class="s-main">
          <div class="s-desc">${esc(s.description)}</div>
          <div class="s-meta"><span class="s-tag ${s.outcome}">${s.outcome}</span>${esc(s.category)}</div>
        </div>
        <span class="s-cost">${fmt(s.cost)}</span>
        <div class="s-actions">
          <button class="s-edit" data-id="${s.id}" aria-label="Edit session">✎</button>
          <button class="s-del" data-id="${s.id}" aria-label="Delete session">✕</button>
        </div>
      </li>`, `<li><div class="empty-note">${emptyIconSvg}<span>No sessions logged yet — your first entry starts the ledger.</span></div></li>`);
}

function animateHero(target) {
  const el = $("hero-value");
  if (target === null) {
    heroDisplayed = null;
    el.textContent = "—";
    return;
  }
  const from = heroDisplayed ?? target;
  if (prefersReducedMotion || from === target) {
    el.textContent = fmt(target);
    heroDisplayed = target;
    return;
  }
  const duration = 500;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else heroDisplayed = target;
  }
  requestAnimationFrame(step);
}

function buildSparkline(daily) {
  const w = 260, h = 54, pad = 4;
  const maxY = Math.max(...daily.map((d) => d.cumulative), 1);
  const stepX = daily.length > 1 ? (w - pad * 2) / (daily.length - 1) : 0;
  const pts = daily.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (d.cumulative / maxY) * (h - pad * 2);
    return [x, y];
  });
  const linePoints = pts.map((p) => p.join(",")).join(" ");
  const areaPoints = `${pad},${h - pad} ${linePoints} ${w - pad},${h - pad}`;
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Daily cumulative spend this statement">
    <defs><linearGradient id="sparklineFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:var(--brass-bright);stop-opacity:0.35" />
      <stop offset="100%" style="stop-color:var(--brass-bright);stop-opacity:0" />
    </linearGradient></defs>
    <polygon class="sparkline-area" points="${areaPoints}"></polygon>
    <polyline class="sparkline-line" points="${linePoints}"></polyline>
    <circle class="sparkline-dot" cx="${lx}" cy="${ly}" r="2.6"></circle>
  </svg>`;
}

function renderForecastSection(a) {
  const spark = a.dailySeries.length >= 2 ? buildSparkline(a.dailySeries) : "";

  if (a.isCurrentMonth) {
    return a.forecast
      ? `<p class="forecast-line">At the current daily rate (${fmt(a.forecast.dailyRate)}/day), projected month-end spend:
         <span class="forecast-value">${fmt(a.forecast.projectedTotal)}</span></p>${spark}`
      : `<p class="forecast-line">Log sessions across 2+ days this month to see a spend forecast.</p>`;
  }

  if (a.dailySeries.length === 0) {
    return `<p class="forecast-line">No sessions logged this month.</p>`;
  }
  const days = a.dailySeries.length;
  return `<p class="forecast-line">Statement closed — ${days} day${days === 1 ? "" : "s"} logged.
     <span class="forecast-value">${fmt(a.byOutcome.total)}</span></p>${spark}`;
}

function renderLedger(a) {
  animateHero(a.perCompleted);
  $("ledger-closed-badge").hidden = a.isCurrentMonth;

  const wastedStamp = a.byOutcome.wastedPct > 0 ? `<span class="stamp-void">void</span>` : "";
  $("outcome-breakdown").innerHTML = `
    <div class="led-row"><span class="label">Completed</span><span class="value completed">${fmt(a.byOutcome.completed)}</span></div>
    <div class="led-row"><span class="label">Partial progress</span><span class="value">${fmt(a.byOutcome.partial)}</span></div>
    <div class="led-row"><span class="label">Wasted${wastedStamp}</span><span class="value wasted">${fmt(a.byOutcome.wasted)} · ${(a.byOutcome.wastedPct * 100).toFixed(0)}%</span></div>
    <div class="led-row"><span class="label">Total spend</span><span class="value">${fmt(a.byOutcome.total)}</span></div>
  `;

  const cats = Object.entries(a.byCategory).sort((x, y) => y[1].total - x[1].total);
  const maxTotal = cats.length ? Math.max(...cats.map(([, v]) => v.total)) : 1;
  $("category-breakdown").innerHTML = renderList(cats, ([name, v]) => `
      <div class="cat-row">
        <div class="cat-top"><span class="cat-name">${esc(name)}</span><span class="cat-cost">${fmt(v.total)}${v.costPerCompleted !== null ? ` · ${fmt(v.costPerCompleted)}/done` : ""}</span></div>
        <div class="cat-bar-track"><div class="cat-bar-fill" data-width="${(v.total / maxTotal) * 100}%"></div></div>
      </div>`, `<p class="ledger-empty">Log a session to see where the spend concentrates.</p>`);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll(".cat-bar-fill").forEach((el) => { el.style.width = el.dataset.width; });
  }));

  $("forecast-section").innerHTML = renderForecastSection(a);
}

// ---------- edit / delete ----------

$("session-list").addEventListener("click", async (ev) => {
  const editBtn = ev.target.closest(".s-edit");
  if (editBtn) {
    const session = lastSessions.find((s) => s.id === editBtn.dataset.id);
    if (session) enterEditMode(session);
    return;
  }

  const delBtn = ev.target.closest(".s-del");
  if (delBtn) {
    try {
      await api("DELETE", `/api/sessions/${delBtn.dataset.id}`);
      if (editingId === delBtn.dataset.id) exitEditMode();
      refreshAll();
    } catch (e) { toast(e.message); }
  }
});

// ---------- utils ----------

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.hidden = false;
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

init();
