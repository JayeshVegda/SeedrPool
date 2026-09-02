/**
 * Minimal HTML rendering.
 *
 * Server-rendered on purpose: no SPA build step, no client framework, and a much
 * smaller memory footprint on a 1.9 GiB VPS.
 */

/** Escapes text for interpolation into HTML. */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Tagged template that escapes interpolated values by default.
 *
 * Values wrapped in `raw()` are inserted verbatim, for composing fragments.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += renderValue(values[i]) + (strings[i + 1] ?? '');
  }
  return out;
}

const RAW = Symbol('raw');

interface Raw {
  [RAW]: string;
}

/** Marks pre-rendered HTML as safe to insert without escaping. */
export function raw(value: string): Raw {
  return { [RAW]: value };
}

function isRaw(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && RAW in value;
}

function renderValue(value: unknown): string {
  if (isRaw(value)) return value[RAW];
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

const STYLES = `
/* ===========================================================
   SeedrPool — Signal Console
   Design constraints (per emil review-animations):
     - All UI animations are sub-300ms
     - Custom easing curves; no built-in easings
     - Only transform and opacity are animated (GPU-only)
     - Never scale(0); start from scale(0.9-0.97) + opacity
     - Buttons get scale(0.97) on :active for press feedback
     - prefers-reduced-motion and (hover:hover) gating ship
     - No transition: all
   =========================================================== */

:root {
  --bg:           #0c0f14;
  --surface-1:    #161b25;
  --surface-2:    #1c2230;
  --surface-3:    #232a3a;
  --surface-4:    #2c3445;
  --border:       rgba(160, 175, 200, 0.10);
  --border-2:     rgba(160, 175, 200, 0.18);
  --border-focus: rgba(110, 168, 254, 0.55);

  --text:         #e6ebf2;
  --text-muted:   #8a96a8;
  --text-dim:     #586273;
  --text-faint:   #3a4252;

  --ok:    #4ade80;
  --ok-bg:    rgba(74, 222, 128, 0.10);
  --ok-border:  rgba(74, 222, 128, 0.30);
  --warn:  #f5b942;
  --warn-bg:  rgba(245, 185, 66, 0.10);
  --warn-border: rgba(245, 185, 66, 0.30);
  --bad:   #f87171;
  --bad-bg:  rgba(248, 113, 113, 0.10);
  --bad-border: rgba(248, 113, 113, 0.30);
  --off:   #6b7280;
  --off-bg:  rgba(107, 114, 128, 0.10);

  --accent:      #6ea8fe;
  --accent-hover:#93c0ff;
  --accent-soft: rgba(110, 168, 254, 0.12);
  --accent-glow: rgba(110, 168, 254, 0.22);
  --purple:      #c084fc;
  --purple-bg:   rgba(192, 132, 252, 0.12);

  --font-body: ui-sans-serif, system-ui, -apple-system, "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;

  --ease:      cubic-bezier(0.22, 1, 0.36, 1);
  --ease-2:    cubic-bezier(0.77, 0, 0.175, 1);
  --ease-soft: cubic-bezier(0.4, 0, 0.2, 1);
  --t-fast:    120ms;
  --t-med:     200ms;
  --t-slow:    320ms;

  color-scheme: dark;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 13.5px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100vh;
  font-feature-settings: "ss01", "cv11", "tnum";
}
::selection { background: var(--accent); color: var(--bg); }

/* ----- Focus ring (everywhere) ----- */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* ===========================================================
   Layout shell
   =========================================================== */

.app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

.sidebar {
  background: var(--bg-elev, var(--surface-1));
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 0.75rem 0.6rem;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.4rem 0.5rem 0.85rem;
  text-decoration: none;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.6rem;
}
.brand-mark {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 7px;
  font-weight: 800;
  font-size: 0.85rem;
  letter-spacing: -0.02em;
}
.brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.brand-name { font-weight: 600; font-size: 0.9rem; letter-spacing: -0.01em; }
.brand-tag { font-family: var(--font-mono); font-size: 0.62rem; color: var(--text-muted); letter-spacing: 0.06em; }

.nav-section {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--text-faint);
  padding: 0.65rem 0.65rem 0.35rem;
}

.nav { display: flex; flex-direction: column; gap: 0.12rem; }
.nav a {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.65rem;
  border-radius: 6px;
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.84rem;
  font-weight: 500;
  position: relative;
  transition: color var(--t-fast) var(--ease-soft), background var(--t-fast) var(--ease-soft);
}
.nav a:hover { color: var(--text); background: var(--surface-2); }
.nav a[aria-current="page"] {
  color: var(--bg);
  background: var(--accent);
  font-weight: 600;
}
.nav a[aria-current="page"]:hover { color: var(--bg); }
.nav a .icon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: currentColor;
  opacity: 0.85;
}
.nav a[aria-current="page"] .icon { opacity: 1; }
.nav a .nav-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  background: var(--surface-3);
  color: var(--text-muted);
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  min-width: 1.25rem;
  text-align: center;
}
.nav a[aria-current="page"] .nav-count { background: rgba(16, 13, 10, 0.18); color: var(--bg); }

.sidebar-foot {
  margin-top: auto;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.sidebar-foot a, .sidebar-foot button {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.65rem;
  border-radius: 5px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  text-decoration: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.sidebar-foot a:hover, .sidebar-foot button:hover {
  color: var(--text);
  background: var(--surface-2);
  border-color: var(--border-2);
}
.sidebar-foot kbd {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  background: var(--bg);
  border: 1px solid var(--border-2);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0.05rem 0.4rem;
  color: var(--text);
}

/* ----- Main column ----- */
.main { padding: 1.5rem 2rem 5rem; min-width: 0; max-width: 100%; }

/* Page header */
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.05;
  color: var(--text);
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  flex-wrap: wrap;
}
.page-head h1 .num {
  font-family: var(--font-mono);
  font-size: 0.95rem;
  color: var(--text-muted);
  font-weight: 400;
  letter-spacing: 0;
}
.page-head h1 .accent { color: var(--accent); }
.page-head .lede {
  font-size: 0.85rem;
  color: var(--text-muted);
  max-width: 70ch;
  margin-top: 0.4rem;
  line-height: 1.5;
}
.page-head .actions { display: flex; gap: 0.45rem; align-items: center; flex-shrink: 0; flex-wrap: wrap; }

/* Section */
.section { margin-bottom: 1.5rem; }
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 0.65rem;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.section-head h2 {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.13em;
  color: var(--text-muted);
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.section-head h2 .count {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-dim);
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: none;
}
.section-head .actions { display: flex; gap: 0.4rem; align-items: center; }

/* ===========================================================
   Cards & KPIs
   =========================================================== */

.card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.15rem 1.25rem;
  box-shadow: 0 1px 0 0 rgba(245, 215, 175, 0.03) inset, 0 20px 40px -20px rgba(0, 0, 0, 0.5);
}
.card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.65rem; margin-bottom: 1.5rem; }
.card-row.cols-3 { grid-template-columns: repeat(3, 1fr); }
.card-row.cols-2 { grid-template-columns: repeat(2, 1fr); }
@media (max-width: 720px) { .card-row.cols-3, .card-row.cols-2 { grid-template-columns: 1fr; } }

.kpi {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.95rem 1.05rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  transition: border-color var(--t-med) var(--ease-soft);
}
.kpi:hover { border-color: var(--border-2); }
.kpi .label {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-muted);
}
.kpi .value {
  font-size: 1.45rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
  font-variant-numeric: tabular-nums oldstyle-nums;
  line-height: 1.1;
}
.kpi .sub { font-family: var(--font-mono); font-size: 0.66rem; color: var(--text-dim); margin-top: 0.15rem; }
.kpi .sub strong { color: var(--text); font-weight: 600; }

/* ===========================================================
   Signal bar (top of overview): one cell per account
   =========================================================== */

.signal-bar {
  display: grid;
  /* Driven by --signal-cols which the server sets based on account count. */
  grid-template-columns: repeat(var(--signal-cols, 8), minmax(0, 1fr));
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}
.signal-cell {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.6rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  position: relative;
  min-width: 0;
  transition: border-color var(--t-fast) var(--ease-soft);
}
.signal-cell:hover { border-color: var(--border-2); }
.signal-cell.ok    { border-left: 3px solid var(--ok); }
.signal-cell.warn  { border-left: 3px solid var(--warn); background: var(--warn-bg); }
.signal-cell.bad   { border-left: 3px solid var(--bad); }
.signal-cell.off   { border-left: 3px solid var(--off); }
.signal-cell .id {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.signal-cell .state {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.signal-cell .state .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.signal-cell.ok .state    { color: var(--ok); }
.signal-cell.warn .state  { color: var(--warn); }
.signal-cell.bad .state   { color: var(--bad); }
.signal-cell.off .state   { color: var(--off); }
.signal-cell .meter {
  height: 3px;
  background: var(--bg);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
}
.signal-cell .meter .fill {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transform-origin: left;
  transform: scaleX(var(--fill, 0));
  transition: transform var(--t-slow) var(--ease-2);
}
.signal-cell.warn .meter .fill { background: var(--warn); }
.signal-cell.bad  .meter .fill { background: var(--bad); }
.signal-cell.off  .meter .fill { background: var(--off); }
.signal-cell .bytes {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

/* ===========================================================
   Pills, buttons, forms
   =========================================================== */

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0.18rem 0.5rem;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.pill .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.pill.ok    { color: var(--ok);   background: var(--ok-bg);   border-color: var(--ok-border); }
.pill.warn  { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-border); }
.pill.bad   { color: var(--bad);  background: var(--bad-bg);  border-color: var(--bad-border); }
.pill.off   { color: var(--off);  background: var(--off-bg);  border-color: var(--border-2); }
.pill.muted { color: var(--text-muted); background: var(--surface-2); border-color: var(--border-2); }
.pill.purple { color: var(--purple); background: var(--purple-bg); border-color: rgba(192, 132, 252, 0.30); }
.pill.ok.live .dot { animation: pulse 1.6s var(--ease) infinite; }

button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.5rem 0.85rem;
  border-radius: 7px;
  border: 1px solid var(--border-2);
  background: var(--surface-3);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  transition:
    transform var(--t-fast) var(--ease),
    background-color var(--t-fast) var(--ease-soft),
    border-color var(--t-fast) var(--ease-soft),
    color var(--t-fast) var(--ease-soft);
}
button:hover, .btn:hover { background: var(--surface-4); border-color: var(--border-2); color: var(--text); }
button:active, .btn:active { transform: scale(0.97); }
button:disabled, .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
button.primary, .btn.primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
button.primary:hover, .btn.primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
  color: var(--bg);
}
button.danger, .btn.danger {
  background: transparent;
  color: var(--bad);
  border-color: var(--bad-border);
}
button.danger:hover, .btn.danger:hover { background: var(--bad-bg); }
button.ghost, .btn.ghost { background: transparent; border-color: var(--border); color: var(--text-muted); }
button.ghost:hover, .btn.ghost:hover { color: var(--text); background: var(--surface-2); }

.btn-sm { padding: 0.32rem 0.6rem; font-size: 0.72rem; border-radius: 5px; }
.btn-icon { padding: 0.32rem; width: 28px; height: 28px; }

form.inline { display: inline; }
form .field-row { display: flex; flex-direction: column; gap: 0.4rem; }
form label.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-muted);
}

input[type=text], input[type=url], input[type=number], input[type=password], input[type=email], textarea {
  width: 100%;
  padding: 0.55rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 0.84rem;
  transition: border-color var(--t-fast) var(--ease-soft), box-shadow var(--t-fast) var(--ease-soft);
  resize: vertical;
}
textarea { min-height: 4rem; line-height: 1.4; font-family: var(--font-mono); }
input::placeholder, textarea::placeholder { color: var(--text-dim); }
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.input-group { display: flex; gap: 0.4rem; align-items: stretch; }
.input-group input { flex: 1; min-width: 0; }

/* ===========================================================
   Tables (the operator's primary surface)
   =========================================================== */

.table-wrap {
  width: 100%;
  overflow-x: auto;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 10px;
}
table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
th, td {
  text-align: left;
  padding: 0.55rem 0.85rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  background: rgba(245, 215, 175, 0.015);
  position: sticky;
  top: 0;
  z-index: 1;
}
tbody tr { transition: background var(--t-fast) var(--ease-soft); }
tbody tr:hover { background: var(--surface-2); }
tr:last-child td { border-bottom: none; }
tr.torn { background: rgba(248, 113, 113, 0.06); }
tr.mixed { background: rgba(245, 185, 66, 0.05); }

td.mono, .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--text-muted); }
.dim { color: var(--text-dim); }
.row-actions { display: flex; gap: 0.3rem; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
.row-actions form { display: inline; }

mark.hit {
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 2px;
  padding: 0 0.15rem;
  font-weight: 600;
}

.bar-inline {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 9rem;
}
.bar-inline .bar {
  width: 6rem;
  height: 4px;
  background: var(--bg);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
  flex-shrink: 0;
}
.bar-inline .bar .fill {
  position: absolute;
  inset: 0;
  background: var(--accent);
  transform-origin: left;
  transform: scaleX(var(--fill, 0));
  transition: transform var(--t-med) var(--ease-2);
}
.bar-inline .bar.warn .fill { background: var(--warn); }
.bar-inline .bar.bad  .fill { background: var(--bad); }
.bar-inline .pct {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-muted);
  min-width: 2.5rem;
  text-align: right;
}

/* ===========================================================
   Empty states
   =========================================================== */

.empty {
  padding: 2.5rem 1.5rem;
  text-align: center;
  border: 1px dashed var(--border-2);
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--text-muted);
}
.empty h3 {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.4rem;
  letter-spacing: -0.01em;
}
.empty p { font-size: 0.85rem; max-width: 44ch; margin: 0 auto 1.1rem; line-height: 1.5; }
.empty .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }

/* Inline notice (page-level banner) */
.notice {
  border-left: 3px solid var(--accent);
  padding: 0.7rem 0.95rem;
  background: var(--surface-1);
  border-radius: 0 6px 6px 0;
  border-top: 1px solid var(--border);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.notice.bad { border-left-color: var(--bad); }
.notice.ok  { border-left-color: var(--ok); }

/* ===========================================================
   Activity timeline
   =========================================================== */

.timeline {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0;
  position: relative;
  padding-left: 1.1rem;
  margin: 0;
}
.timeline::before {
  content: "";
  position: absolute;
  left: 0.4rem;
  top: 0.6rem;
  bottom: 0.6rem;
  width: 1px;
  background: var(--border-2);
}
.timeline li {
  position: relative;
  padding: 0.4rem 0 0.4rem 0.5rem;
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  line-height: 1.5;
  font-size: 0.83rem;
}
.timeline li::before {
  content: "";
  position: absolute;
  left: -1.1rem;
  top: 0.9rem;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  border: 1px solid var(--bg);
}
.timeline li.info::before    { background: var(--accent); }
.timeline li.success::before { background: var(--ok); }
.timeline li.warn::before    { background: var(--warn); }
.timeline li.bad::before     { background: var(--bad); }
.timeline .ts {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-dim);
  letter-spacing: 0.04em;
  min-width: 4.5rem;
  flex-shrink: 0;
}
.timeline .detail { color: var(--text-muted); font-size: 0.78rem; }

/* ===========================================================
   Library table — movie poster + meta + actions
   =========================================================== */

.movie-cell {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  white-space: normal;
  padding: 0.5rem 0.85rem;
}
.movie-cell .poster {
  width: 44px;
  height: 64px;
  border-radius: 4px;
  background: var(--bg);
  object-fit: cover;
  flex-shrink: 0;
  background: var(--surface-3);
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-dim);
  overflow: hidden;
  border: 1px solid var(--border-2);
}
.movie-cell .poster img { width: 100%; height: 100%; object-fit: cover; }
.movie-cell .meta { min-width: 0; flex: 1; }
.movie-cell .title { font-weight: 600; color: var(--text); font-size: 0.86rem; line-height: 1.2; }
.movie-cell .sub {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  color: var(--text-muted);
  margin-top: 0.2rem;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}
.movie-cell .sub .id { color: var(--text-dim); }
.movie-cell .actions {
  display: flex;
  gap: 0.25rem;
  margin-top: 0.3rem;
  flex-wrap: wrap;
}

/* ===========================================================
   Filter bar, search, account chips
   =========================================================== */

.search-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.65rem;
  flex-wrap: wrap;
}
.search-bar input { flex: 1; min-width: 200px; max-width: 28rem; }
.search-bar .count { font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted); }

.chip-group { display: inline-flex; gap: 0.3rem; flex-wrap: wrap; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.55rem;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  transition: border-color var(--t-fast) var(--ease-soft), color var(--t-fast) var(--ease-soft);
}
.chip:hover { color: var(--text); border-color: var(--border-2); }
.chip.active { background: var(--accent-soft); color: var(--accent); border-color: var(--border-2); }
.chip .x { color: var(--text-dim); font-size: 0.7rem; }

/* ===========================================================
   Modal
   =========================================================== */

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 300;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  animation: fade-in var(--t-med) var(--ease) both;
}
.modal-backdrop.open { display: flex; }
.modal {
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  border-radius: 10px;
  padding: 1.25rem;
  width: 100%;
  max-width: 32rem;
  box-shadow: 0 20px 60px -20px rgba(0, 0, 0, 0.7);
  animation: modal-in var(--t-med) var(--ease) both;
}
.modal-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.85rem; }
.modal-title { font-size: 1.05rem; font-weight: 600; letter-spacing: -0.015em; }
.modal-close { background: transparent; border: none; color: var(--text-muted); font-size: 1.2rem; padding: 0.1rem 0.5rem; cursor: pointer; }
.modal-body { display: flex; flex-direction: column; gap: 0.85rem; }
.modal-foot { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes modal-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

/* ===========================================================
   Utility
   =========================================================== */

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(1.5); }
}
.divider { height: 1px; background: var(--border); margin: 0.85rem 0; }
.spinner {
  width: 12px; height: 12px;
  border: 2px solid var(--border-2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }
.copy-flash { background: var(--ok-bg) !important; color: var(--ok) !important; border-color: var(--ok-border) !important; }

/* ===========================================================
   Reduced motion & responsive
   =========================================================== */

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .pill.ok.live .dot { animation: none; }
  .signal-cell .meter .fill, .bar-inline .bar .fill { transition: none; }
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  .signal-bar { grid-template-columns: repeat(2, 1fr); }
  .main { padding: 1rem; }
  .page-head { flex-direction: column; align-items: flex-start; }
  .page-head .actions { width: 100%; }
}
`;

const CLIENT_SCRIPT = `
(function () {
  'use strict';

  // ----- Toasts (Sonner, CDN) -----
  // window.toast is set by the sonner-js module script in the page.
  // If the CDN is blocked or Sonner is still loading, showToast is a no-op
  // and the rest of the page still works.
  function showToast(kind, title, detail) {
    if (!window.toast) return;
    var opts = detail ? { description: detail } : undefined;
    if (kind === 'ok')      window.toast.success(title, opts);
    else if (kind === 'bad') window.toast.error(title, opts);
    else if (kind === 'warn') window.toast.warning(title, opts);
    else                    window.toast(title, opts);
  }
  window.showToast = showToast;

  // ----- Copy to clipboard -----
  window.copyText = function (btn, text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      var orig = btn.dataset.orig || btn.innerHTML;
      btn.dataset.orig = orig;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied';
      btn.classList.add('copy-flash');
      setTimeout(function () { btn.innerHTML = orig; btn.classList.remove('copy-flash'); }, 1400);
    }).catch(function (err) {
      showToast('bad', 'Copy failed', err && err.message);
    });
  };

  // ----- Debounce (utility) -----
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  // ----- Inline form action via fetch -----
  // Posts the form, replaces the <main> with the new page, fires a toast.
  // Falls back to a real form submit on network error so nothing is lost.
  window.inlineAction = function (form) {
    var btn = form.querySelector('button[type=submit]');
    var orig = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    var timeout = setTimeout(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
      showToast('bad', 'Action timed out', 'No response within 15s');
    }, 15000);
    return fetch(form.action, {
      method: form.method || 'POST',
      body: new FormData(form),
      headers: { 'X-Requested-With': 'fetch' },
    }).then(function (r) {
      clearTimeout(timeout);
      if (r.redirected) { window.location = r.url; return; }
      return r.text().then(function (html) {
        if (r.ok) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var initial = doc.querySelector('.initial-toast');
          if (initial) {
            var kind = initial.dataset.kind || 'info';
            var tEl = initial.querySelector('.toast-title');
            var dEl = initial.querySelector('.toast-detail');
            showToast(kind, tEl ? tEl.textContent : 'Done', dEl ? dEl.textContent : '');
          } else {
            var notice = doc.querySelector('.notice');
            if (notice) {
              showToast(
                notice.classList.contains('ok') ? 'ok' : 'bad',
                notice.querySelector('strong') ? notice.querySelector('strong').textContent : 'Notice',
                notice.textContent.replace(/^\\s*\\S+\\s+/, '').slice(0, 120)
              );
            }
          }
          var main = doc.querySelector('main');
          if (main) {
            document.querySelector('main').replaceChildren.apply(
              document.querySelector('main'), main.childNodes
            );
            rebind();
            hydrateIcons();
          }
        } else {
          showToast('bad', 'Action failed', 'HTTP ' + r.status);
        }
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
      });
    }).catch(function (err) {
      clearTimeout(timeout);
      showToast('bad', 'Action failed', err && err.message || 'Network error');
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    });
  };

  // ----- Inline delete with confirmation -----
  // The form's "data-confirm" attribute carries a confirmation message;
  // we show a small confirm step in the button before submitting.
  window.confirmAction = function (form) {
    var msg = form.dataset.confirm || 'Are you sure?';
    if (!window.toast) return form.submit();
    // Use Sonner's action-button feature for inline confirm
    var id = window.toast(msg, {
      duration: 6000,
      action: {
        label: 'Confirm',
        onClick: function () {
          window.toast.dismiss(id);
          // Mark the form so inlineAction doesn't ask again
          form.dataset.confirmed = '1';
          window.inlineAction(form);
        }
      },
      cancel: { label: 'Cancel', onClick: function () { window.toast.dismiss(id); } }
    });
    return false;
  };

  // ----- Page navigation (instant, no full reload) -----
  // Intercept nav-link clicks to do an inline swap; this is the "instant
  // page switching" requirement. Falls back to a full navigation if the
  // fetch fails (offline, edge case, etc.).
  function navigate(href, push) {
    var target = new URL(href, window.location.origin);
    // Preload the new HTML in parallel; swap when it lands.
    var p = fetch(target.pathname + target.search, { headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var main = doc.querySelector('main');
        if (!main) throw new Error('no main');
        // Update <title>
        if (doc.title) document.title = doc.title;
        // Update active nav state immediately
        document.querySelectorAll('.nav a').forEach(function (a) {
          var aUrl = new URL(a.href, window.location.origin);
          a.toggleAttribute('aria-current', aUrl.pathname === target.pathname);
        });
        document.querySelector('main').replaceChildren.apply(
          document.querySelector('main'), main.childNodes
        );
        rebind();
        hydrateIcons();
        // Fire any initial-toast on the destination page
        var initial = doc.querySelector('.initial-toast');
        if (initial) {
          var kind = initial.dataset.kind || 'info';
          var tEl = initial.querySelector('.toast-title');
          var dEl = initial.querySelector('.toast-detail');
          showToast(kind, tEl ? tEl.textContent : 'Done', dEl ? dEl.textContent : '');
        }
      });
    if (push) {
      history.pushState({ href: target.href }, '', target.href);
    }
    return p.catch(function () { window.location.href = target.href; });
  }
  window.navigate = navigate;

  // ----- Search-as-you-type with inline highlighting -----
  function filterTable(input) {
    var tableId = input.dataset.table;
    var table = document.getElementById(tableId);
    if (!table) return;
    var q = input.value.trim().toLowerCase();
    var rows = table.querySelectorAll('tbody tr');
    rows.forEach(function (row) {
      if (!q) {
        row.querySelectorAll('mark.hit').forEach(function (m) {
          m.replaceWith(document.createTextNode(m.textContent));
        });
        row.style.display = '';
        return;
      }
      var match = row.textContent.toLowerCase().indexOf(q) !== -1;
      row.style.display = match ? '' : 'none';
      if (match) {
        var cells = row.querySelectorAll('td');
        for (var i = 0; i < Math.min(cells.length, 5); i++) {
          highlight(cells[i], q);
        }
      }
    });
  }
  function highlight(cell, q) {
    cell.querySelectorAll('mark.hit').forEach(function (m) {
      m.replaceWith(document.createTextNode(m.textContent));
    });
    var walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (tn) {
      var idx = tn.textContent.toLowerCase().indexOf(q);
      if (idx === -1) return;
      var pre = document.createTextNode(tn.textContent.slice(0, idx));
      var mark = document.createElement('mark');
      mark.className = 'hit';
      mark.textContent = tn.textContent.slice(idx, idx + q.length);
      var post = document.createTextNode(tn.textContent.slice(idx + q.length));
      tn.replaceWith(pre, mark, post);
    });
  }
  window.filterTable = filterTable;

  // ----- Live transfer count (poll every 30s) -----
  function pollTransferCount() {
    fetch('/admin/transfers/count')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var node = document.querySelector('[data-transfer-pulse]');
        if (!node) return;
        if (d.count > 0) {
          node.innerHTML = '<span class="nav-count" style="background: var(--accent); color: var(--bg);">' + d.count + '</span>';
          node.setAttribute('title', d.count + ' active transfer' + (d.count === 1 ? '' : 's'));
        } else {
          node.innerHTML = '';
          node.removeAttribute('title');
        }
      })
      .catch(function () {});
  }
  pollTransferCount();
  setInterval(pollTransferCount, 30_000);

  // ----- Modal helpers -----
  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('open');
  }
  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }
  window.openModal = openModal;
  window.closeModal = closeModal;

  // ----- Wire up everything -----
  function rebind() {
    document.querySelectorAll('form[data-inline]').forEach(function (form) {
      if (form._bound) return;
      form._bound = true;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (form.dataset.confirm && !form.dataset.confirmed) {
          return confirmAction(form);
        }
        inlineAction(form);
      });
    });
    document.querySelectorAll('a[data-nav]').forEach(function (a) {
      if (a._bound) return;
      a._bound = true;
      a.addEventListener('click', function (e) {
        e.preventDefault();
        navigate(a.href, true);
      });
    });
    document.querySelectorAll('.search-input').forEach(function (input) {
      if (input._h) {
        input.removeEventListener('input', input._h);
        input.removeEventListener('keydown', input._kh);
      }
      var h = debounce(function () { filterTable(input); }, 90);
      var kh = function (e) {
        if (e.key === 'Escape') { input.value = ''; filterTable(input); input.blur(); }
      };
      input.addEventListener('input', h);
      input.addEventListener('keydown', kh);
      input._h = h; input._kh = kh;
    });
    document.querySelectorAll('[data-modal-open]').forEach(function (el) {
      if (el._bound) return;
      el._bound = true;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        openModal(el.dataset.modalOpen);
      });
    });
    document.querySelectorAll('[data-modal-close]').forEach(function (el) {
      if (el._bound) return;
      el._bound = true;
      el.addEventListener('click', function (e) {
        e.preventDefault();
        closeModal(el.dataset.modalClose);
      });
    });
    // Close any open modal on Escape
    document.addEventListener('keydown', escCloseModal);
  }
  function escCloseModal(e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal-backdrop.open').forEach(function (m) {
      m.classList.remove('open');
    });
  }

  // Lucide replaces <i data-lucide="name"> with the actual SVG.
  function hydrateIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (e) {}
    }
  }
  window.hydrateIcons = hydrateIcons;

  // Initial toast fired on page load
  function fireInitialToast() {
    var initial = document.querySelector('.initial-toast');
    if (!initial) return;
    var kind = initial.dataset.kind || 'info';
    var tEl = initial.querySelector('.toast-title');
    var dEl = initial.querySelector('.toast-detail');
    showToast(kind, tEl ? tEl.textContent : 'Done', dEl ? dEl.textContent : '');
    initial.remove();
  }

  // Run as soon as Sonner signals it's ready, OR after a 4s hard timeout.
  var sonnerReady = new Promise(function (resolve) {
    var done = false;
    function go() { if (!done) { done = true; resolve(); } }
    window.addEventListener('seedrpool:sonner-ready', go, { once: true });
    setTimeout(go, 4000);
  });
  sonnerReady.then(function () {
    hydrateIcons();
    rebind();
    fireInitialToast();
  });

  // ----- Global keyboard shortcuts (only when not in an input) -----
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === 'r') { var f = document.querySelector('form[action="/admin/reindex"]'); if (f) { e.preventDefault(); f.querySelector('button[type=submit]').click(); } }
    else if (k === 'g') { e.preventDefault(); navigate('/admin/library', true); }
    else if (k === 't') { e.preventDefault(); navigate('/admin/transfers', true); }
    else if (k === 'a') { e.preventDefault(); navigate('/admin/accounts', true); }
    else if (k === 'h') { e.preventDefault(); navigate('/admin', true); }
    else if (k === '?') {
      e.preventDefault();
      showToast('info', 'Shortcuts',
        'R = reindex · G = library · T = transfers · A = fleet · H = home · ? = this');
    }
  });

  // Back/forward buttons
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.href) navigate(e.state.href, false);
  });
})();
`;

interface NavItem {
  href: string;
  label: string;
  short: string; // single-letter shortcut
  iconName: string; // lucide icon name
}

const NAV_ITEMS: NavItem[] = [
  { href: '/admin', label: 'Overview', short: 'H', iconName: 'layout-dashboard' },
  { href: '/admin/library', label: 'Library', short: 'G', iconName: 'library' },
  { href: '/admin/transfers', label: 'Transfers', short: 'T', iconName: 'arrow-down-up' },
  { href: '/admin/accounts', label: 'Fleet', short: 'A', iconName: 'server' },
  { href: '/admin/activity', label: 'Activity', short: 'Y', iconName: 'activity' },
];

/** Wraps content in the shared page shell. */
export function layout(options: {
  title: string;
  activeNav?: string;
  body: string;
  activeTransfers?: number;
  signalCols?: number;
  initialToast?: { kind: 'ok' | 'bad' | 'info' | 'warn'; title: string; detail?: string };
}): string {
  const navHtml = NAV_ITEMS.map((n) => {
    const isActive = options.activeNav === n.href;
    const isTransfers = n.href === '/admin/transfers';
    const pulseAttr = isTransfers ? ' data-transfer-pulse="1"' : '';
    return (
      `<a href="${esc(n.href)}"${pulseAttr} data-nav${isActive ? ' aria-current="page"' : ''}>` +
      `<span class="icon"><i data-lucide="${n.iconName}"></i></span>` +
      `<span>${esc(n.label)}</span>` +
      `</a>`
    );
  }).join('');

  const initialToastHtml = options.initialToast
    ? `<div class="initial-toast" data-kind="${esc(options.initialToast.kind)}" hidden>
         <span class="toast-title">${esc(options.initialToast.title)}</span>
         ${options.initialToast.detail ? `<span class="toast-detail">${esc(options.initialToast.detail)}</span>` : ''}
       </div>`
    : '';

  const signalCols = options.signalCols ?? 8;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)} · SeedrPool</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <a href="/admin" class="brand" data-nav>
      <span class="brand-mark">S</span>
      <span class="brand-text">
        <span class="brand-name">SeedrPool</span>
        <span class="brand-tag">Operator</span>
      </span>
    </a>
    <div class="nav-section">Workspace</div>
    <nav class="nav">${navHtml}</nav>
    <div class="sidebar-foot">
      <button data-inline data-confirm="Reload credentials and rebuild the pool?" type="submit" formaction="/admin/accounts/reload" formmethod="post">
        <i data-lucide="rotate-ccw"></i> Reload credentials
      </button>
      <a href="https://github.com/cliffordmanasseh/mediafusion" target="_blank" rel="noreferrer">
        <i data-lucide="github"></i> Documentation
      </a>
      <a href="/healthz" target="_blank" rel="noreferrer">
        <i data-lucide="heart-pulse"></i> Health
      </a>
      <div style="padding: 0.35rem 0.65rem; font-size: 0.65rem; color: var(--text-dim); display:flex; align-items:center; gap: 0.4rem;">
        <kbd>?</kbd> for shortcuts
      </div>
    </div>
  </aside>
  <main class="main" style="--signal-cols: ${signalCols};">${options.body}</main>
</div>
${initialToastHtml}

<!-- Sonner toaster (CDN-loaded; the toaster container is created
     automatically on first import). Style overrides live further down
     so the toast matches the signal-console palette. -->
<script type="module">
  import toast from 'https://cdn.jsdelivr.net/npm/sonner-js@1.1.3/+esm';
  window.toast = toast;
  toast.config({
    position: 'bottom-right',
    duration: 3500,
    closeButton: false,
    theme: 'dark',
    visibleToasts: 4,
  });
  if (window.lucide) window.lucide.createIcons();
  window.dispatchEvent(new Event('seedrpool:sonner-ready'));
</script>

<!-- Lucide icons. Pinned to 0.460.0 for stability; update deliberately. -->
<script src="https://cdn.jsdelivr.net/npm/lucide@0.460.0/dist/umd/lucide.min.js"></script>
<script>if (window.lucide) window.lucide.createIcons();</script>

<style>
  /* Sonner (sonner-js) theme overrides — the package scopes its vars to
     [data-sonner-toaster]. We set them at that scope so they take
     precedence over the package defaults. */
  [data-sonner-toaster][data-sonner-theme="dark"] {
    --normal-bg:           #1c2230 !important;
    --normal-bg-hover:     #232a3a !important;
    --normal-border:       rgba(160, 175, 200, 0.18) !important;
    --normal-border-hover: rgba(160, 175, 200, 0.28) !important;
    --normal-text:         #e6ebf2 !important;
    --success-bg:          rgba(74, 222, 128, 0.12) !important;
    --success-border:      rgba(74, 222, 128, 0.30) !important;
    --success-text:        #4ade80 !important;
    --error-bg:            rgba(248, 113, 113, 0.12) !important;
    --error-border:        rgba(248, 113, 113, 0.30) !important;
    --error-text:          #f87171 !important;
    --info-bg:             rgba(110, 168, 254, 0.12) !important;
    --info-border:         rgba(110, 168, 254, 0.30) !important;
    --info-text:           #6ea8fe !important;
    --warning-bg:          rgba(217, 148, 65, 0.12) !important;
    --warning-border:      rgba(217, 148, 65, 0.30) !important;
    --warning-text:        #d99441 !important;
    --border-radius:       8px !important;
    --offset:              16px !important;
    --mobile-offset:       12px !important;
    font-family: var(--font-body) !important;
  }
  [data-sonner-toaster][data-sonner-toast] {
    border-radius: 8px !important;
    box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.6) !important;
    font-size: 0.84rem !important;
    padding: 0.7rem 0.9rem !important;
  }
  [data-sonner-toaster][data-sonner-toast][data-type="success"] { border-left: 3px solid var(--ok) !important; }
  [data-sonner-toaster][data-sonner-toast][data-type="error"]   { border-left: 3px solid var(--bad) !important; }
  [data-sonner-toaster][data-sonner-toast][data-type="warning"] { border-left: 3px solid var(--warn) !important; }
  [data-sonner-toaster][data-sonner-toast][data-type="info"]    { border-left: 3px solid var(--accent) !important; }

  /* Lucide icon defaults inside the signal-console */
  [data-lucide] { width: 14px; height: 14px; vertical-align: -2px; }
  .brand-mark [data-lucide] { width: 16px; height: 16px; color: var(--accent); }
  button [data-lucide], .btn [data-lucide] { width: 13px; height: 13px; }
  .pill [data-lucide] { width: 11px; height: 11px; }
  .signal-cell .state [data-lucide] { width: 8px; height: 8px; margin-right: 0.3rem; }
  .nav a .icon [data-lucide] { width: 15px; height: 15px; }
  .sidebar-foot [data-lucide] { width: 13px; height: 13px; }
  .movie-cell .poster [data-lucide] { width: 18px; height: 18px; }
</style>

<script>
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
}
