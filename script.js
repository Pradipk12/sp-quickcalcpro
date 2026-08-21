"use strict";

/* ==========================================================
   Global state
   ========================================================== */
const state = {
  angleMode: "DEG",      // DEG | RAD
  shiftActive: false,
  memory: 0,
  lastAnswer: 0,
  history: [],           // {expr, result, ts}
  activeTab: "standard",
};

const $ = (id) => document.getElementById(id);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ==========================================================
   Numeric text-input sanitizer
   (keeps mobile's numeric keyboard via inputmode, but avoids
   native type="number" quirks: spinner arrows, locale decimal
   separators, and stray validation-bubble popups)
   ========================================================== */
function attachNumericInput(el, opts) {
  opts = opts || {};
  const allowDecimal = opts.decimal !== false;
  const allowNegative = !!opts.negative;
  el.addEventListener("input", () => {
    const cursorFromEnd = el.value.length - el.selectionStart;
    let v = el.value;
    let allowedChars = "0-9";
    if (allowDecimal) allowedChars += ".";
    if (allowNegative) allowedChars += "-";
    v = v.replace(new RegExp("[^" + allowedChars + "]", "g"), "");
    if (allowNegative) {
      const neg = v.startsWith("-");
      v = v.replace(/-/g, "");
      if (neg) v = "-" + v;
    }
    if (allowDecimal) {
      const firstDot = v.indexOf(".");
      if (firstDot !== -1) {
        v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
      }
    }
    el.value = v;
    const pos = Math.max(0, v.length - cursorFromEnd);
    el.setSelectionRange(pos, pos);
  });
}

/* ==========================================================
   Toast
   ========================================================== */
let toastTimer = null;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

/* ==========================================================
   Theme
   ========================================================== */
function initTheme() {
  const saved = localStorage.getItem("spqc-theme");
  const theme = saved || "dark";
  document.documentElement.setAttribute("data-theme", theme);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("spqc-theme", next); } catch (e) {}
}

/* ==========================================================
   Tabs
   ========================================================== */
function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".calc-section").forEach((s) => s.classList.remove("active"));
      btn.classList.add("active");
      const id = btn.dataset.tab;
      $(id).classList.add("active");
      state.activeTab = id;
    });
  });
}

/* ==========================================================
   Expression engine (shared by Standard + Scientific)
   ========================================================== */
function makeEngine(displayId, subId) {
  return {
    displayId,
    subId,
    expr: "",
    justEvaluated: false,

    display() { return $(this.displayId); },
    sub() { return $(this.subId); },

    render() {
      this.display().textContent = this.expr === "" ? "0" : this.expr;
    },

    renderPreview() {
      const subEl = this.sub();
      if (this.expr === "" || this.justEvaluated) { subEl.textContent = "\u00A0"; return; }
      try {
        const val = evaluateExpr(this.expr, { silent: true });
        if (val === null) { subEl.textContent = "\u00A0"; return; }
        subEl.textContent = "= " + formatNumber(val);
      } catch (e) {
        subEl.textContent = "\u00A0";
      }
    },

    clear() {
      this.expr = "";
      this.justEvaluated = false;
      this.render();
      this.sub().textContent = "\u00A0";
    },

    del() {
      if (this.justEvaluated) { this.clear(); return; }
      this.expr = this.expr.slice(0, -1);
      this.render();
      this.renderPreview();
    },

    append(val) {
      const operators = ["+", "-", "*", "/", "^", "%"];
      if (this.justEvaluated) {
        if (operators.includes(val)) {
          this.expr = formatNumber(state.lastAnswer) + val;
        } else if (val === ")" ) {
          this.expr = formatNumber(state.lastAnswer) + val;
        } else {
          this.expr = val === "." ? "0." : val;
        }
        this.justEvaluated = false;
      } else {
        this.expr += val;
      }
      this.render();
      this.renderPreview();
    },

    equals() {
      if (this.expr.trim() === "") return;
      const result = evaluateExpr(this.expr);
      if (result === null) {
        this.display().textContent = "Error";
        this.sub().textContent = this.expr;
        this.expr = "";
        this.justEvaluated = true;
        return;
      }
      const formatted = formatNumber(result);
      this.sub().textContent = this.expr + " =";
      this.expr = formatted;
      this.render();
      this.display().textContent = formatted;
      state.lastAnswer = result;
      this.justEvaluated = true;
      pushHistory(this.sub().textContent.replace(/\s=$/, ""), formatted);
    },
  };
}

function formatNumber(val) {
  if (typeof val !== "number" || !isFinite(val)) return String(val);
  if (Math.abs(val) > 0 && (Math.abs(val) < 1e-9 || Math.abs(val) >= 1e15)) {
    return math.format(val, { notation: "exponential", precision: 8 });
  }
  let out = math.format(val, { precision: 12 });
  // trim trailing float noise
  if (out.includes(".") && !out.includes("e")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  return out;
}

function evaluateExpr(rawExpr, opts) {
  opts = opts || {};
  try {
    let expr = rawExpr;
    // simple percentage handling: 50% -> (50/100)
    expr = expr.replace(/(\d+(\.\d+)?)%/g, "($1/100)");

    const scope = { Ans: state.lastAnswer, ans: state.lastAnswer, M: state.memory };
    if (state.angleMode === "DEG") {
      scope.sin = (x) => Math.sin((x * Math.PI) / 180);
      scope.cos = (x) => Math.cos((x * Math.PI) / 180);
      scope.tan = (x) => Math.tan((x * Math.PI) / 180);
      scope.asin = (x) => (Math.asin(x) * 180) / Math.PI;
      scope.acos = (x) => (Math.acos(x) * 180) / Math.PI;
      scope.atan = (x) => (Math.atan(x) * 180) / Math.PI;
    }
    let result = math.evaluate(expr, scope);
    if (result && result.type === "Unit") result = result.toNumber();
    if (typeof result === "object" && result !== null && "re" in result) {
      // complex number fallback -> magnitude not desired, treat as error for now
      return null;
    }
    if (typeof result !== "number" || !isFinite(result)) return null;
    return result;
  } catch (e) {
    if (!opts.silent) { /* swallow */ }
    return null;
  }
}

/* ==========================================================
   History (shared tape)
   ========================================================== */
function pushHistory(expr, result) {
  state.history.push({ expr, result, ts: Date.now() });
  if (state.history.length > 50) state.history.shift();
  renderHistory();
}

function renderHistory() {
  const list = $("history-list");
  if (state.history.length === 0) {
    list.innerHTML = '<div class="history-empty">No calculations yet — your tape will show up here.</div>';
    return;
  }
  list.innerHTML = state.history
    .map((h, i) => `<div class="history-item" data-idx="${i}">
        <div class="h-expr">${escapeHtml(h.expr)}</div>
        <div class="h-res">${escapeHtml(h.result)}</div>
      </div>`)
    .join("");
  list.querySelectorAll(".history-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.idx);
      const item = state.history[idx];
      const engine = state.activeTab === "sci-eng" ? sciEngine : stdEngine;
      engine.expr = item.result;
      engine.justEvaluated = true;
      engine.render();
      closeHistory();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openHistory() {
  $("history-drawer").classList.add("open");
  $("history-backdrop").classList.add("show");
}
function closeHistory() {
  $("history-drawer").classList.remove("open");
  $("history-backdrop").classList.remove("show");
}

/* ==========================================================
   Standard calculator wiring
   ========================================================== */
const stdEngine = makeEngine("std-display", "std-expr");

function initStandard() {
  document.querySelectorAll('#standard [data-act]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "append") stdEngine.append(btn.dataset.val);
      else if (act === "clear") stdEngine.clear();
      else if (act === "del") stdEngine.del();
    });
  });
  $("std-equals").addEventListener("click", () => stdEngine.equals());
  $("std-history-btn").addEventListener("click", openHistory);
  $("std-copy-btn").addEventListener("click", () => copyToClipboard(stdEngine.display().textContent));
  stdEngine.render();
}

/* ==========================================================
   Scientific calculator wiring
   ========================================================== */
const sciEngine = makeEngine("sci-eng-display", "sci-expr");

function updateAngleUI() {
  $("btn-angle").textContent = state.angleMode;
}

function updateShiftUI() {
  $("status-shift").classList.toggle("on", state.shiftActive);
  $("btn-shift").classList.toggle("active", state.shiftActive);
  document.querySelectorAll(".multi-key").forEach((btn) => {
    btn.classList.toggle("shift-mode", state.shiftActive);
  });
}

function updateMemUI() {
  $("status-mem").classList.toggle("on", state.memory !== 0);
}

function initScientific() {
  $("btn-angle").addEventListener("click", () => {
    state.angleMode = state.angleMode === "DEG" ? "RAD" : "DEG";
    updateAngleUI();
    sciEngine.renderPreview();
  });

  $("btn-shift").addEventListener("click", () => {
    state.shiftActive = !state.shiftActive;
    updateShiftUI();
  });

  document.querySelectorAll(".sci-func-keypad .multi-key").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = state.shiftActive && btn.dataset.shift ? btn.dataset.shift : btn.dataset.base;
      sciEngine.append(val);
      if (state.shiftActive) { state.shiftActive = false; updateShiftUI(); }
    });
  });

  document.querySelectorAll('#sci-eng [data-act="append"], #sci-eng [data-act="clear"], #sci-eng [data-act="del"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "append") sciEngine.append(btn.dataset.val);
      else if (act === "clear") sciEngine.clear();
      else if (act === "del") sciEngine.del();
    });
  });

  $("sci-equals").addEventListener("click", () => sciEngine.equals());

  document.querySelector('[data-act="mclear"]').addEventListener("click", () => {
    state.memory = 0; updateMemUI(); showToast("Memory cleared");
  });
  document.querySelector('[data-act="mrecall"]').addEventListener("click", () => {
    sciEngine.append(formatNumber(state.memory));
  });
  document.querySelector('[data-act="mplus"]').addEventListener("click", () => {
    const val = sciEngine.justEvaluated ? state.lastAnswer : evaluateExpr(sciEngine.expr);
    if (val !== null) { state.memory += val; updateMemUI(); showToast("Added to memory"); }
  });
  document.querySelector('[data-act="mminus"]').addEventListener("click", () => {
    const val = sciEngine.justEvaluated ? state.lastAnswer : evaluateExpr(sciEngine.expr);
    if (val !== null) { state.memory -= val; updateMemUI(); showToast("Subtracted from memory"); }
  });
  document.querySelector('[data-act="ans"]').addEventListener("click", () => {
    sciEngine.append("Ans");
  });

  $("sci-history-btn").addEventListener("click", openHistory);
  $("sci-copy-btn").addEventListener("click", () => copyToClipboard(sciEngine.display().textContent));

  updateAngleUI();
  updateShiftUI();
  updateMemUI();
  sciEngine.render();
}

/* ==========================================================
   Clipboard helper
   ========================================================== */
function copyToClipboard(text) {
  if (!text || text === "0") { showToast("Nothing to copy"); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast("Copied " + text)).catch(() => showToast("Copy failed"));
  } else {
    showToast("Copy not supported");
  }
}

/* ==========================================================
   Keyboard support (Standard + Scientific)
   ========================================================== */
function initKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (state.activeTab !== "standard" && state.activeTab !== "sci-eng") return;
    const engine = state.activeTab === "sci-eng" ? sciEngine : stdEngine;
    const key = e.key;

    if (/^[0-9.]$/.test(key)) { engine.append(key); return; }
    if (["+", "-", "*", "/", "%", "^", "(", ")"].includes(key)) { engine.append(key); return; }
    if (key === "Enter" || key === "=") { e.preventDefault(); engine.equals(); return; }
    if (key === "Backspace") { engine.del(); return; }
    if (key === "Escape") { engine.clear(); return; }
  });
}

/* ==========================================================
   Financial / EMI calculator
   ========================================================== */
function initFinancial() {
  $("emi-calc-btn").addEventListener("click", calculateEMI);
  $("toggle-schedule").addEventListener("click", () => {
    const wrap = $("schedule-wrap");
    const btn = $("toggle-schedule");
    const isHidden = wrap.hidden;
    wrap.hidden = !isHidden;
    btn.textContent = isHidden ? "Hide yearly breakdown" : "Show yearly breakdown";
  });
}

function calculateEMI() {
  const symbol = $("currency-symbol").value;
  const P = parseFloat($("loan-amount").value);
  const annualRate = parseFloat($("interest-rate").value);
  const tenureRaw = parseFloat($("loan-tenure").value);
  const tenureUnit = $("tenure-unit").value;

  if (!P || P <= 0 || !annualRate || annualRate <= 0 || !tenureRaw || tenureRaw <= 0) {
    showToast("Enter valid loan details");
    return;
  }

  const n = tenureUnit === "years" ? Math.round(tenureRaw * 12) : Math.round(tenureRaw);
  const r = annualRate / (12 * 100);
  const emi = (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  const totalPayment = emi * n;
  const totalInterest = totalPayment - P;

  const fmt = (v) => symbol + v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

  $("emi-val").textContent = fmt(emi);
  $("interest-val").textContent = fmt(totalInterest);
  $("total-val").textContent = fmt(totalPayment);
  $("legend-principal").textContent = fmt(P);
  $("legend-interest").textContent = fmt(totalInterest);

  const principalPct = clamp((P / totalPayment) * 100, 0, 100);
  $("ratio-principal").style.width = principalPct + "%";
  $("ratio-interest").style.width = (100 - principalPct) + "%";

  $("emi-results").hidden = false;
  buildAmortizationSchedule(P, r, n, emi, fmt);
}

function buildAmortizationSchedule(P, r, n, emi, fmt) {
  const body = $("schedule-body");
  body.innerHTML = "";
  let balance = P;
  const years = Math.ceil(n / 12);
  let rows = [];
  let month = 0;
  for (let y = 1; y <= years; y++) {
    let yearPrincipal = 0, yearInterest = 0;
    for (let m = 0; m < 12 && month < n; m++, month++) {
      const interestPortion = balance * r;
      const principalPortion = emi - interestPortion;
      balance -= principalPortion;
      yearPrincipal += principalPortion;
      yearInterest += interestPortion;
    }
    rows.push({ year: y, principal: yearPrincipal, interest: yearInterest, balance: Math.max(balance, 0) });
  }
  body.innerHTML = rows
    .map((row) => `<tr><td>Yr ${row.year}</td><td>${fmt(row.principal)}</td><td>${fmt(row.interest)}</td><td>${fmt(row.balance)}</td></tr>`)
    .join("");
}

/* ==========================================================
   Age / Date calculator
   ========================================================== */
function initAgeDate() {
  $("end-date").valueAsDate = new Date();

  document.querySelectorAll("#date-mode-toggle .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#date-mode-toggle .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode;
      $("date-diff-panel").hidden = mode !== "diff";
      $("date-addsub-panel").hidden = mode !== "addsub";
    });
  });

  document.querySelectorAll("#offset-direction .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#offset-direction .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  $("age-calc-btn").addEventListener("click", calculateAge);
  $("addsub-calc-btn").addEventListener("click", calculateAddSub);
}

function addMonthsJS(base, deltaMonths) {
  const y = base.getFullYear();
  const m0 = base.getMonth();
  const d = base.getDate();
  const total = y * 12 + m0 + deltaMonths;
  const newY = Math.floor(total / 12);
  const newM0 = ((total % 12) + 12) % 12;
  const firstOfMonth = new Date(newY, newM0, 1);
  firstOfMonth.setDate(firstOfMonth.getDate() + (d - 1));
  return firstOfMonth;
}

function preciseYMD(start, end) {
  let totalMonths = (end.getFullYear() * 12 + end.getMonth()) - (start.getFullYear() * 12 + start.getMonth());
  let candidate = addMonthsJS(start, totalMonths);
  while (candidate > end) {
    totalMonths -= 1;
    candidate = addMonthsJS(start, totalMonths);
  }
  const dayRemainder = Math.round((end - candidate) / (1000 * 3600 * 24));
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  return { y, m, d: dayRemainder };
}

function calculateAge() {
  const start = new Date($("start-date").value);
  const end = new Date($("end-date").value);
  if (isNaN(start) || isNaN(end)) { showToast("Pick both dates"); return; }
  if (start > end) { showToast("Start date must be before end date"); return; }

  const totalMs = end - start;
  const totalDays = Math.floor(totalMs / (1000 * 3600 * 24));

  const { y, m, d } = preciseYMD(start, end);

  $("age-diff-main").textContent = `${y}y ${m}m ${d}d`;
  $("age-days").textContent = totalDays.toLocaleString();
  $("age-weeks").textContent = Math.floor(totalDays / 7).toLocaleString();
  $("age-months").textContent = (y * 12 + m).toLocaleString();
  $("age-hours").textContent = Math.floor(totalMs / (1000 * 3600)).toLocaleString();
  $("age-results").hidden = false;
}

function calculateAddSub() {
  const base = new Date($("base-date").value);
  const days = parseInt($("offset-days").value, 10);
  if (isNaN(base) || $("base-date").value === "") { showToast("Pick a base date"); return; }
  if (isNaN(days)) { showToast("Enter a number of days"); return; }
  const dir = document.querySelector("#offset-direction .seg-btn.active").dataset.dir === "sub" ? -1 : 1;
  const result = new Date(base);
  result.setDate(result.getDate() + dir * days);

  $("addsub-date-main").textContent = result.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  $("addsub-weekday").textContent = result.toLocaleDateString(undefined, { weekday: "long" });
  $("addsub-results").hidden = false;
}

/* ==========================================================
   Unit converter
   ========================================================== */
const UNIT_DATA = {
  length: {
    base: "m",
    units: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
    labels: { m: "Meters", km: "Kilometers", cm: "Centimeters", mm: "Millimeters", mi: "Miles", yd: "Yards", ft: "Feet", in: "Inches", nmi: "Nautical mi" },
    defaultFrom: "km", defaultTo: "mi",
  },
  weight: {
    base: "kg",
    units: { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523, t: 1000, st: 6.35029 },
    labels: { kg: "Kilograms", g: "Grams", mg: "Milligrams", lb: "Pounds", oz: "Ounces", t: "Tonnes", st: "Stone" },
    defaultFrom: "kg", defaultTo: "lb",
  },
  temperature: {
    special: true,
    units: { c: "Celsius", f: "Fahrenheit", k: "Kelvin" },
    labels: { c: "Celsius (°C)", f: "Fahrenheit (°F)", k: "Kelvin (K)" },
    defaultFrom: "c", defaultTo: "f",
  },
  area: {
    base: "m2",
    units: { m2: 1, km2: 1000000, cm2: 0.0001, ha: 10000, acre: 4046.8564224, mi2: 2589988.110336, ft2: 0.09290304 },
    labels: { m2: "Sq. meters", km2: "Sq. kilometers", cm2: "Sq. centimeters", ha: "Hectares", acre: "Acres", mi2: "Sq. miles", ft2: "Sq. feet" },
    defaultFrom: "m2", defaultTo: "ft2",
  },
  volume: {
    base: "l",
    units: { l: 1, ml: 0.001, m3: 1000, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735296 },
    labels: { l: "Liters", ml: "Milliliters", m3: "Cubic meters", gal: "Gallons (US)", qt: "Quarts", pt: "Pints", cup: "Cups", floz: "Fluid oz" },
    defaultFrom: "l", defaultTo: "gal",
  },
  speed: {
    base: "mps",
    units: { mps: 1, kmh: 0.277778, mph: 0.44704, knot: 0.514444, fts: 0.3048 },
    labels: { mps: "m/s", kmh: "km/h", mph: "mph", knot: "Knots", fts: "ft/s" },
    defaultFrom: "kmh", defaultTo: "mph",
  },
  time: {
    base: "s",
    units: { s: 1, ms: 0.001, min: 60, hr: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 },
    labels: { s: "Seconds", ms: "Milliseconds", min: "Minutes", hr: "Hours", day: "Days", week: "Weeks", month: "Months", year: "Years" },
    defaultFrom: "hr", defaultTo: "min",
  },
  data: {
    base: "b",
    units: { b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776, bit: 0.125 },
    labels: { b: "Bytes", kb: "Kilobytes", mb: "Megabytes", gb: "Gigabytes", tb: "Terabytes", bit: "Bits" },
    defaultFrom: "gb", defaultTo: "mb",
  },
};

let convertState = { category: "length" };

function initConverter() {
  document.querySelectorAll("#convert-categories .chip-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#convert-categories .chip-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      convertState.category = btn.dataset.cat;
      populateConverterUnits();
      runConversion();
    });
  });

  $("convert-from-val").addEventListener("input", runConversion);
  $("convert-from-unit").addEventListener("change", runConversion);
  $("convert-to-unit").addEventListener("change", runConversion);
  $("convert-swap").addEventListener("click", () => {
    const fromSel = $("convert-from-unit"), toSel = $("convert-to-unit");
    const tmp = fromSel.value; fromSel.value = toSel.value; toSel.value = tmp;
    runConversion();
  });

  populateConverterUnits();
  $("convert-from-val").value = 1;
  runConversion();
}

function populateConverterUnits() {
  const cat = UNIT_DATA[convertState.category];
  const fromSel = $("convert-from-unit"), toSel = $("convert-to-unit");
  fromSel.innerHTML = ""; toSel.innerHTML = "";
  Object.keys(cat.labels).forEach((key) => {
    const opt1 = document.createElement("option"); opt1.value = key; opt1.textContent = cat.labels[key];
    const opt2 = document.createElement("option"); opt2.value = key; opt2.textContent = cat.labels[key];
    fromSel.appendChild(opt1); toSel.appendChild(opt2);
  });
  fromSel.value = cat.defaultFrom;
  toSel.value = cat.defaultTo;
}

function convertTemperature(value, from, to) {
  let celsius;
  if (from === "c") celsius = value;
  else if (from === "f") celsius = (value - 32) * (5 / 9);
  else celsius = value - 273.15;

  if (to === "c") return celsius;
  if (to === "f") return celsius * (9 / 5) + 32;
  return celsius + 273.15;
}

function runConversion() {
  const cat = UNIT_DATA[convertState.category];
  const from = $("convert-from-unit").value;
  const to = $("convert-to-unit").value;
  const rawVal = parseFloat($("convert-from-val").value);
  if (isNaN(rawVal)) { $("convert-to-val").value = ""; renderQuickConversions(NaN); return; }

  let result;
  if (cat.special) {
    result = convertTemperature(rawVal, from, to);
  } else {
    const baseVal = rawVal * cat.units[from];
    result = baseVal / cat.units[to];
  }
  $("convert-to-val").value = formatConvertResult(result);
  renderQuickConversions(rawVal, from);
}

function formatConvertResult(v) {
  if (!isFinite(v)) return "";
  if (Math.abs(v) >= 1e9 || (Math.abs(v) < 1e-6 && v !== 0)) return v.toExponential(4);
  return parseFloat(v.toFixed(6)).toString();
}

function renderQuickConversions(rawVal, from) {
  const container = $("convert-quick");
  const cat = UNIT_DATA[convertState.category];
  if (isNaN(rawVal)) { container.innerHTML = ""; return; }
  const keys = Object.keys(cat.labels).filter((k) => k !== from).slice(0, 4);
  container.innerHTML = keys
    .map((k) => {
      let val;
      if (cat.special) val = convertTemperature(rawVal, from, k);
      else val = (rawVal * cat.units[from]) / cat.units[k];
      return `<div class="quick-item">${cat.labels[k]}<strong>${formatConvertResult(val)}</strong></div>`;
    })
    .join("");
}

/* ==========================================================
   History drawer wiring
   ========================================================== */
function initHistoryDrawer() {
  $("history-close").addEventListener("click", closeHistory);
  $("history-backdrop").addEventListener("click", closeHistory);
  $("history-clear").addEventListener("click", () => {
    state.history = [];
    renderHistory();
  });
  renderHistory();
}

/* ==========================================================
   Boot
   ========================================================== */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  $("theme-toggle").addEventListener("click", toggleTheme);
  initTabs();
  initStandard();
  initScientific();
  initKeyboard();
  initFinancial();
  initAgeDate();
  initConverter();
  initHistoryDrawer();

  attachNumericInput($("loan-amount"), { decimal: true, negative: false });
  attachNumericInput($("interest-rate"), { decimal: true, negative: false });
  attachNumericInput($("loan-tenure"), { decimal: true, negative: false });
  attachNumericInput($("offset-days"), { decimal: false, negative: false });
  attachNumericInput($("convert-from-val"), { decimal: true, negative: true });
});
