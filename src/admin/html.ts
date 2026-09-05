/**
 * HTML rendering for the admin console.
 *
 * Server-rendered, with a small Alpine + htmx layer for interactivity:
 *   - htmx drives partial page updates (e.g. inline actions, view toggles)
 *     so navigating between sections does not re-render the shell;
 *   - Alpine handles local state — modals, tabs, the toast queue, dropdowns;
 *   - Sonner renders the toasts themselves.
 *
 * The whole point of this rewrite was to delete the previous hand-rolled SPA
 * routing (which had dead handlers for `data-nav`/`data-confirm`/`data-modal-open`)
 * and let well-tested libraries do those jobs. The custom code is now down to
 * a small set of htmx-triggered helpers in `client.js` and Alpine stores in
 * `alpine-stores.js`.
 *
 * The Sonner import must come from the ESM bundle because sonner-js shadows
 * its config in shadow DOM. The icon module replaces the 356 KB Lucide UMD
 * bundle with 5 KB of inline SVG paths rendered server-side.
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

const safeHtmlStrings = new Set<string>();

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += renderValue(values[i]) + (strings[i + 1] ?? '');
  }
  safeHtmlStrings.add(out);
  if (safeHtmlStrings.size > 1000) {
    const first = safeHtmlStrings.values().next().value;
    if (first !== undefined) safeHtmlStrings.delete(first);
  }
  return out;
}

/**
 * Pre-rendered HTML. Defined in its own module so `icons.ts` can produce
 * safe markup without a circular import back here.
 */
import { Html, isRaw, raw } from './raw.ts';
export { raw };
export type { Html };

function renderValue(value: unknown): string {
  if (isRaw(value)) return value.value;
  if (typeof value === 'string' && safeHtmlStrings.has(value)) return value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

/**
 * Shared byte formatting.
 *
 * One implementation for both the server-rendered pages and the client's
 * toasts. The client used to carry its own copy and the two drifted — the
 * server said "4.00 GiB" while a toast said "4.3 GB" for the same file. The
 * function is serialized into the page (see `scriptTags`) so the browser runs
 * the exact same code the server does, and a test asserts the serialized form
 * matches the module export.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

/**
 * Server-rendered SVG icons.
 *
 * Imported as a value (not just re-exported) because `layout()` below calls
 * `icon()` directly to render the sidebar glyphs.
 */
import { icon } from './icons.ts';
export { icon };


/**
 * The admin's stylesheet.
 *
 * Exported as a string so the assets module can serve it as a single
 * cacheable file (content-hashed URL) instead of inlining 28 KB into every
 * HTML response. Kept inline so the runtime ships zero node_modules and no
 * build step is needed.
 */
export const STYLES_BODY = `

/* =====================================================================
   SeedrPool — Command Deck
   ---------------------------------------------------------------------
   Every visible color, spacing, and curve flows from :root tokens so
   changing one place updates everywhere (item 7: "everything dynamic").
   Motion values follow Emil Kowalski's guidance: ≤300ms, custom curves,
   transform + opacity only, no scale-from-zero, scale(0.97) on press.
   ===================================================================== */

:root {
  --bg:           #0a0d12;
  --surface-0:    #0f1218;
  --surface-1:    #151a23;
  --surface-2:    #1c2230;
  --surface-3:    #242c3d;
  --surface-4:    #2e384d;
  --border:       rgba(160, 175, 200, 0.09);
  --border-2:     rgba(160, 175, 200, 0.18);
  --border-focus: rgba(110, 168, 254, 0.55);

  --text:         #e6ebf2;
  --text-muted:   #8a96a8;
  --text-dim:     #5a6273;
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
  --cyan:        #67e8f9;

  --font-body: ui-sans-serif, system-ui, -apple-system, "Inter", "Segoe UI", "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;

  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --r-xl: 16px;

  /* Curves: all custom, per Emil's "never use built-in easings" rule. */
  --ease-out:     cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out:  cubic-bezier(0.77, 0, 0.175, 1);
  --ease-soft:    cubic-bezier(0.4, 0, 0.2, 1);
  --ease-press:   cubic-bezier(0.4, 0, 0.2, 1);

  --t-fast:   140ms;
  --t-med:    200ms;
  --t-slow:   280ms;
  --t-modal:  220ms;

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

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* =====================================================================
   App shell: sidebar + main.
   ===================================================================== */

.app {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
}

.sidebar {
  background: var(--surface-0);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 0.85rem 0.6rem;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem 0.95rem;
  text-decoration: none;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.65rem;
  transition: color var(--t-fast) var(--ease-out);
}
.brand:hover { color: var(--accent); }
.brand-mark {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, var(--accent), var(--purple));
  color: var(--bg);
  border-radius: 8px;
  font-weight: 800;
  font-size: 0.9rem;
  letter-spacing: -0.02em;
  box-shadow: 0 6px 18px -8px var(--accent-glow);
}
.brand-mark svg { color: var(--bg); width: 16px; height: 16px; }
.brand-text { display: flex; flex-direction: column; line-height: 1.18; }
.brand-name { font-weight: 600; font-size: 0.95rem; letter-spacing: -0.01em; }
.brand-tag { font-family: var(--font-mono); font-size: 0.62rem; color: var(--text-muted); letter-spacing: 0.08em; }

.nav-section {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--text-faint);
  padding: 0.7rem 0.7rem 0.4rem;
}

.nav { display: flex; flex-direction: column; gap: 0.1rem; }
.nav a {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  border-radius: var(--r-md);
  color: var(--text-muted);
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  position: relative;
  transition:
    color var(--t-fast) var(--ease-out),
    background var(--t-fast) var(--ease-out),
    transform var(--t-fast) var(--ease-out);
}
.nav a:hover { color: var(--text); background: var(--surface-1); }
.nav a:active { transform: scale(0.97); }
.nav a[aria-current="page"] {
  color: var(--text);
  background: var(--surface-2);
  font-weight: 600;
}
.nav a[aria-current="page"]::before {
  content: "";
  position: absolute;
  left: -0.6rem;
  top: 0.6rem;
  bottom: 0.6rem;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}
.nav a .icon { width: 16px; height: 16px; display: inline-flex; }
.nav a[aria-current="page"] .icon { color: var(--accent); }
.nav a .nav-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.62rem;
  background: var(--surface-3);
  color: var(--text-muted);
  padding: 0.08rem 0.45rem;
  border-radius: 999px;
  min-width: 1.4rem;
  text-align: center;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
}
.nav a[aria-current="page"] .nav-count { background: var(--accent-soft); color: var(--accent); }

.sidebar-foot {
  margin-top: auto;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.sidebar-foot a {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.7rem;
  border-radius: var(--r-sm);
  color: var(--text-muted);
  text-decoration: none;
  transition: color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out);
}
.sidebar-foot a:hover { color: var(--text); background: var(--surface-1); }
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

.main {
  padding: 1.5rem 2rem 5rem;
  min-width: 0;
  max-width: 100%;
  background:
    radial-gradient(ellipse 80% 50% at 20% -10%, rgba(110,168,254,0.06), transparent 50%),
    radial-gradient(ellipse 60% 40% at 90% 0%, rgba(192,132,252,0.05), transparent 60%);
}

/* =====================================================================
   Page header.
   ===================================================================== */

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 1.55rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
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
.lede {
  font-size: 0.85rem;
  color: var(--text-muted);
  max-width: 64ch;
  margin-top: 0.45rem;
  line-height: 1.55;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.5rem;
}
.eyebrow.muted { color: var(--text-muted); }

.actions { display: flex; gap: 0.5rem; align-items: center; flex-shrink: 0; flex-wrap: wrap; }

/* The left-hand column of a page header: eyebrow + h1 + lede. Declared so
   the header's flex layout has an explicit min-width:0 child and long
   titles wrap instead of pushing the actions off-screen. */
.lead { min-width: 0; flex: 1 1 auto; }

/* =====================================================================
   Sections, cards, KPIs.
   ===================================================================== */

.section { margin-bottom: 1.5rem; }
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 0.7rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.section-head h2 {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--text-muted);
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.section-head h2 .count {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--text-dim);
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: none;
}

.card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 1.15rem 1.25rem;
  box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.02) inset;
  transition: border-color var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out);
}
.card:hover { border-color: var(--border-2); }
.card.clickable { cursor: pointer; }
.card.clickable:active { transform: scale(0.99); }
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  margin-bottom: 0.85rem;
}
.card-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.card-title svg { color: var(--accent); }
.card-sub { font-size: 0.78rem; color: var(--text-muted); }

.kpi {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 0.95rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  transition: border-color var(--t-fast) var(--ease-out), transform var(--t-fast) var(--ease-out);
}
.kpi:hover { border-color: var(--border-2); }
.kpi .label {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.kpi .label svg { width: 11px; height: 11px; }
.kpi .value {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  margin-top: 0.1rem;
}
.kpi .sub { font-family: var(--font-mono); font-size: 0.66rem; color: var(--text-dim); margin-top: 0.2rem; }
.kpi .sub strong { color: var(--text); font-weight: 600; }

/* =====================================================================
   Bento grid (overview).
   Two-row layout: row 1 auto-sized for content, row 2 the fleet cards.
   ===================================================================== */

.bento-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 0.85rem;
  margin-bottom: 1.5rem;
}
.col-3 { grid-column: span 3; }
.col-4 { grid-column: span 4; }
.col-5 { grid-column: span 5; }
.col-6 { grid-column: span 6; }
.col-7 { grid-column: span 7; }
.col-8 { grid-column: span 8; }
.col-12 { grid-column: span 12; }
@media (max-width: 1100px) {
  .col-3 { grid-column: span 6; }
  .col-4, .col-5 { grid-column: span 6; }
  .col-6, .col-7, .col-8 { grid-column: span 12; }
}
@media (max-width: 640px) {
  .col-3, .col-4, .col-5, .col-6, .col-7, .col-8 { grid-column: span 12; }
}

.overview-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
.overview-row > * { width: 100%; }
.kpi-col { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.kpi-col .kpi { width: 100%; }

.fleet-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.75rem;
}

/* Account card: clickable, content-width, modern. */
.account-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 1rem 1.1rem;
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition:
    border-color var(--t-fast) var(--ease-out),
    transform var(--t-fast) var(--ease-out),
    box-shadow var(--t-med) var(--ease-out);
}
.account-card::before {
  content: "";
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 3px;
  background: var(--off);
  transition: background var(--t-fast) var(--ease-out);
}
.account-card:hover {
  border-color: var(--border-2);
  transform: translateY(-2px);
  box-shadow: 0 12px 24px -16px rgba(0, 0, 0, 0.6);
}
.account-card:active { transform: translateY(0) scale(0.99); }
.account-card.ok::before     { background: var(--ok); }
.account-card.warn::before   { background: var(--warn); }
.account-card.bad::before    { background: var(--bad); }
.account-card.off::before    { background: var(--off); }

.account-card .head {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  padding-left: 0.25rem;
}
.account-card .id {
  font-family: var(--font-mono);
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.01em;
}
.account-card .email {
  font-size: 0.72rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-left: 0.25rem;
}
.account-card .state {
  font-family: var(--font-mono);
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  white-space: nowrap;
}
.account-card .state .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.account-card.ok .state   { color: var(--ok);   background: var(--ok-bg); }
.account-card.warn .state { color: var(--warn); background: var(--warn-bg); }
.account-card.bad .state  { color: var(--bad);  background: var(--bad-bg); }
.account-card.off .state  { color: var(--off);  background: var(--off-bg); }
.account-card.ok .state .dot { animation: pulse 1.8s var(--ease-in-out) infinite; }

.account-card .meter {
  height: 4px;
  background: var(--surface-3);
  border-radius: 2px;
  overflow: hidden;
  position: relative;
  margin-top: 0.2rem;
}
.account-card .meter .fill {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transform-origin: left;
  transform: scaleX(var(--fill, 0));
  transition: transform var(--t-slow) var(--ease-out);
}
.account-card.warn .meter .fill { background: var(--warn); }
.account-card.bad .meter .fill  { background: var(--bad); }
.account-card.off .meter .fill  { background: var(--off); }

.account-card .stats {
  display: flex; justify-content: space-between; gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-muted);
  padding-left: 0.25rem;
}
.account-card .stats strong { color: var(--text); font-weight: 600; }
.account-card .stats .sep { color: var(--text-faint); }

/* =====================================================================
   Headroom card — top of overview.
   ===================================================================== */

.headroom-card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}
.headroom-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; flex-wrap: wrap;
  margin-bottom: 0.7rem;
}
.headroom-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  display: inline-flex; align-items: center; gap: 0.45rem;
}
.headroom-title svg { color: var(--accent); }
.headroom-stats {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--text-muted);
}
.headroom-stats strong { color: var(--text); font-weight: 600; }
.headroom-meter {
  height: 8px;
  background: var(--surface-3);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.headroom-fill {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent-hover));
  transform-origin: left;
  transform: scaleX(var(--fill, 0));
  transition: transform var(--t-slow) var(--ease-out);
}
.headroom-fill.warn { background: var(--warn); }
.headroom-fill.bad  { background: var(--bad); }
.headroom-meta {
  display: flex; gap: 1.1rem; flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--text-dim);
  margin-top: 0.5rem;
}

/* =====================================================================
   Pills, buttons, forms.
   ===================================================================== */

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0.18rem 0.55rem;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid transparent;
}
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.pill.ok    { color: var(--ok);   background: var(--ok-bg);   border-color: var(--ok-border); }
.pill.warn  { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-border); }
.pill.bad   { color: var(--bad);  background: var(--bad-bg);  border-color: var(--bad-border); }
.pill.off   { color: var(--off);  background: var(--off-bg);  border-color: var(--border-2); }
.pill.muted { color: var(--text-muted); background: var(--surface-2); border-color: var(--border-2); }
.pill.purple { color: var(--purple); background: var(--purple-bg); border-color: rgba(192, 132, 252, 0.30); }
.pill.cyan   { color: var(--cyan); background: rgba(103, 232, 249, 0.10); border-color: rgba(103, 232, 249, 0.30); }
.pill.ok.live .dot { animation: pulse 1.6s var(--ease-in-out) infinite; }

button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.42rem;
  padding: 0.5rem 0.85rem;
  border-radius: var(--r-md);
  border: 1px solid var(--border-2);
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  white-space: nowrap;
  user-select: none;
  transition:
    transform var(--t-fast) var(--ease-out),
    background-color var(--t-fast) var(--ease-out),
    border-color var(--t-fast) var(--ease-out),
    color var(--t-fast) var(--ease-out);
}
button:hover, .btn:hover { background: var(--surface-3); border-color: var(--border-2); color: var(--text); }
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

.btn-sm { padding: 0.34rem 0.62rem; font-size: 0.74rem; border-radius: 5px; }
.btn-icon { padding: 0.32rem; width: 30px; height: 30px; }
.btn-link { background: transparent; border-color: transparent; color: var(--accent); padding: 0.25rem 0.4rem; }
.btn-link:hover { background: var(--accent-soft); }

form.inline { display: inline; }

.input-group { display: flex; gap: 0.4rem; align-items: stretch; }
.input-group input { flex: 1; min-width: 0; }

input[type=text], input[type=url], input[type=number], input[type=password], input[type=email], input[type=search], textarea, select, .field-input {
  width: 100%;
  padding: 0.55rem 0.75rem;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 0.84rem;
  transition: border-color var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out);
  resize: vertical;
}
textarea { min-height: 4rem; line-height: 1.45; font-family: var(--font-mono); }
input::placeholder, textarea::placeholder { color: var(--text-dim); }
input:focus, textarea:focus, select:focus, .field-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

label.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-muted);
}
label.field .hint { font-family: var(--font-body); font-size: 0.78rem; text-transform: none; letter-spacing: 0; color: var(--text-dim); }

/* =====================================================================
   Tables.
   ===================================================================== */

.table-wrap {
  width: 100%;
  overflow-x: auto;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
th, td {
  text-align: left;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
th {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  background: var(--surface-0);
  position: sticky;
  top: 0;
  z-index: 1;
}
tbody tr { transition: background var(--t-fast) var(--ease-out); }
tbody tr:hover { background: var(--surface-2); }
tr:last-child td { border-bottom: none; }
tr.torn  { background: rgba(248, 113, 113, 0.07); }
tr.mixed { background: rgba(245, 185, 66, 0.06); }

td.mono, .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--text-muted); }
.dim { color: var(--text-dim); }
.row-actions { display: flex; gap: 0.32rem; align-items: center; justify-content: flex-end; flex-wrap: wrap; }

.bar-inline {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 8rem;
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
  position: absolute; inset: 0;
  background: var(--accent);
  transform-origin: left;
  transform: scaleX(var(--fill, 0));
  transition: transform var(--t-med) var(--ease-out);
}
.bar-inline .bar.warn .fill { background: var(--warn); }
.bar-inline .bar.bad  .fill { background: var(--bad); }
.bar-inline .pct { font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted); min-width: 2.4rem; text-align: right; }

/* =====================================================================
   Empty states & notices.
   ===================================================================== */

.empty {
  padding: 2.5rem 1.5rem;
  text-align: center;
  border: 1px dashed var(--border-2);
  border-radius: var(--r-md);
  background: var(--surface-1);
  color: var(--text-muted);
}
.empty h3 { font-size: 1rem; font-weight: 600; color: var(--text); margin-bottom: 0.4rem; letter-spacing: -0.01em; }
.empty p { font-size: 0.85rem; max-width: 44ch; margin: 0 auto 1.1rem; line-height: 1.5; }
.empty .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }

.notice {
  border-left: 3px solid var(--accent);
  padding: 0.7rem 0.95rem;
  background: var(--surface-1);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
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
.notice.warn { border-left-color: var(--warn); }

/* =====================================================================
   Library poster grid.
   ===================================================================== */

.poster-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1.15rem;
  margin-bottom: 1.5rem;
}
.poster-card {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
  transition:
    transform var(--t-med) var(--ease-out),
    border-color var(--t-med) var(--ease-out),
    box-shadow var(--t-med) var(--ease-out);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.poster-card:hover {
  transform: translateY(-3px);
  border-color: var(--accent);
  box-shadow: 0 12px 24px -8px rgba(0, 0, 0, 0.6), 0 0 0 1px var(--accent-soft);
}
.poster-card.torn { border-color: rgba(248, 113, 113, 0.4); }
.poster-cover {
  width: 100%;
  aspect-ratio: 2 / 3;
  background: var(--surface-3);
  position: relative;
  overflow: hidden;
}
.poster-cover img, .poster-fallback {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.poster-cover img {
  object-fit: cover;
  z-index: 1;
  transition: transform 0.4s var(--ease-out);
}
.poster-card:hover .poster-cover img { transform: scale(1.04); }
.poster-fallback {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0.4rem;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 700;
  background: linear-gradient(135deg, #161c28 0%, #0d1117 100%);
  z-index: 0;
}
.poster-fallback svg { width: 32px; height: 32px; color: var(--text-faint); }

.poster-badges {
  position: absolute; top: 0.55rem; left: 0.55rem; right: 0.55rem;
  display: flex; justify-content: space-between; align-items: center;
  pointer-events: none;
  z-index: 2;
}

.poster-overlay-actions {
  position: absolute; inset: 0;
  background: rgba(10, 13, 18, 0.85);
  backdrop-filter: blur(4px);
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--t-fast) var(--ease-out);
  z-index: 3;
}
.poster-card:hover .poster-overlay-actions { opacity: 1; pointer-events: auto; }
.poster-overlay-actions .row { display: flex; gap: 0.32rem; flex-wrap: wrap; justify-content: center; }

.poster-info {
  padding: 0.75rem 0.85rem;
  display: flex; flex-direction: column; gap: 0.3rem;
  flex: 1;
  background: var(--surface-1);
}
.poster-title {
  font-size: 0.88rem; font-weight: 600; color: var(--text);
  line-height: 1.25;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.poster-meta {
  display: flex; align-items: center; justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 0.7rem; color: var(--text-muted);
  margin-top: auto;
  padding-top: 0.3rem;
  border-top: 1px solid var(--border);
}
.poster-node-tag {
  font-family: var(--font-mono);
  font-size: 0.65rem; color: var(--accent);
  max-width: 7rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* =====================================================================
   Toolbar, tabs, view toggle.
   ===================================================================== */

.view-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  gap: 0.75rem; margin-bottom: 1rem;
  flex-wrap: wrap;
}
.filter-tabs { display: flex; align-items: center; gap: 0.35rem; overflow-x: auto; padding-bottom: 2px; }
.filter-tab {
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out);
}
.filter-tab:hover { color: var(--text); border-color: var(--border-2); }
.filter-tab.active { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }

.view-toggle {
  display: inline-flex;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: 2px;
  gap: 2px;
}
.view-toggle-btn {
  padding: 0.32rem 0.55rem;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  display: flex; align-items: center; gap: 0.32rem;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
}
.view-toggle-btn:hover { color: var(--text); }
.view-toggle-btn.active { background: var(--surface-3); color: var(--accent); font-weight: 600; }

/* =====================================================================
   Chips (activity filters).
   ===================================================================== */

.chip-group { display: flex; gap: 0.3rem; flex-wrap: wrap; }
.chip {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out);
}
.chip:hover { color: var(--text); border-color: var(--border-2); }
.chip.active { background: var(--accent-soft); color: var(--accent); border-color: rgba(110, 168, 254, 0.4); }
.chip .x { color: var(--text-dim); font-weight: 700; padding-left: 0.15rem; }

/* =====================================================================
   Timeline.
   ===================================================================== */

.timeline { list-style: none; display: flex; flex-direction: column; gap: 0; position: relative; padding-left: 1.1rem; margin: 0; }
.timeline::before {
  content: "";
  position: absolute; left: 0.4rem; top: 0.6rem; bottom: 0.6rem;
  width: 1px;
  background: var(--border-2);
}
.timeline li {
  position: relative;
  padding: 0.45rem 0 0.45rem 0.5rem;
  display: flex; align-items: baseline; gap: 0.6rem;
  line-height: 1.5; font-size: 0.83rem;
}
.timeline li::before {
  content: "";
  position: absolute; left: -1.1rem; top: 0.9rem;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  border: 1px solid var(--bg);
}
.timeline li.info::before    { background: var(--accent); }
.timeline li.success::before { background: var(--ok); }
.timeline li.warn::before    { background: var(--warn); }
.timeline li.bad::before     { background: var(--bad); }
.timeline .ts { font-family: var(--font-mono); font-size: 0.66rem; color: var(--text-dim); letter-spacing: 0.04em; min-width: 4.5rem; flex-shrink: 0; }
.timeline .detail { color: var(--text-muted); font-size: 0.78rem; }

/* =====================================================================
   Library table.
   ===================================================================== */

.movie-cell { display: flex; align-items: center; gap: 0.75rem; min-width: 0; white-space: normal; padding: 0.5rem 0.85rem; }
.movie-cell .poster-thumb {
  width: 36px; height: 52px;
  border-radius: 4px;
  background: var(--surface-3);
  display: grid; place-items: center;
  font-family: var(--font-mono);
  font-size: 0.8rem; font-weight: 700;
  color: var(--accent);
  overflow: hidden;
  border: 1px solid var(--border-2);
  flex-shrink: 0;
  position: relative;
}
.movie-cell .poster-thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 1;
}
.poster-thumb-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  z-index: 0;
}
.movie-cell .meta { min-width: 0; flex: 1; }
.movie-cell .title { font-weight: 600; color: var(--text); font-size: 0.86rem; line-height: 1.2; }
.movie-cell .sub { font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-muted); margin-top: 0.2rem; display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
.movie-cell .sub a { color: var(--accent); text-decoration: none; }
.movie-cell .sub a:hover { text-decoration: underline; }

/* =====================================================================
   Modal (Alpine-controlled).
   ===================================================================== */

.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(5, 7, 10, 0.7);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 50;
  padding: 1rem;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--t-modal) var(--ease-out);
}
.modal-backdrop.open { opacity: 1; pointer-events: auto; }
.modal {
  background: var(--surface-1);
  border: 1px solid var(--border-2);
  border-radius: var(--r-lg);
  padding: 0;
  max-width: 480px;
  width: 100%;
  box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.6);
  transform: scale(0.95);
  opacity: 0;
  transition: transform var(--t-modal) var(--ease-out), opacity var(--t-modal) var(--ease-out);
}
.modal-backdrop.open .modal { transform: scale(1); opacity: 1; }
.modal-head { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.modal-title { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; }
.modal-close { background: transparent; border: none; color: var(--text-muted); padding: 0.32rem; border-radius: var(--r-sm); cursor: pointer; }
.modal-close:hover { color: var(--text); background: var(--surface-2); }
.modal-body { padding: 1.1rem 1.25rem; display: flex; flex-direction: column; gap: 0.85rem; }
.modal-foot { padding: 0.95rem 1.25rem; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 0.45rem; }

/* =====================================================================
   Account detail page.
   ===================================================================== */

.detail-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 1.25rem;
}
@media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }

.kv-list { display: flex; flex-direction: column; gap: 0.55rem; }
.kv-list .kv { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; padding-bottom: 0.4rem; border-bottom: 1px dashed var(--border); }
.kv-list .kv:last-child { border-bottom: none; }
.kv-list .k { font-family: var(--font-mono); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-muted); }
.kv-list .v { font-family: var(--font-mono); font-size: 0.82rem; color: var(--text); text-align: right; word-break: break-all; }

.action-cluster { display: flex; flex-direction: column; gap: 0.5rem; }
.action-cluster .row { display: flex; gap: 0.45rem; flex-wrap: wrap; }

/* =====================================================================
   Confirm dialog (Alpine-controlled, used in place of native confirm()).
   ===================================================================== */

.confirm-dialog { max-width: 420px; }
.confirm-dialog .modal-body { font-size: 0.9rem; line-height: 1.5; color: var(--text); }
.confirm-dialog .modal-body strong { color: var(--bad); }
.confirm-dialog .modal-foot { gap: 0.5rem; }

/* =====================================================================
   Search bar.
   ===================================================================== */

.search-bar { display: flex; align-items: center; gap: 0.5rem; position: relative; min-width: 240px; }
.search-bar .search-icon { position: absolute; left: 0.7rem; color: var(--text-dim); pointer-events: none; width: 14px; height: 14px; }
.search-bar input, .search-input { padding-left: 2rem; min-width: 240px; }

/* =====================================================================
   Animations.
   ===================================================================== */

@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(1.3); } }
@keyframes spin  { to { transform: rotate(360deg); } }
.spinner { width: 12px; height: 12px; border: 2px solid var(--border-2); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }
.copy-flash { background: var(--ok-bg) !important; color: var(--ok) !important; border-color: var(--ok-border) !important; }

/* =====================================================================
   Responsive.
   ===================================================================== */

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  .pill.ok.live .dot, .account-card.ok .state .dot { animation: none; }
}

@media (max-width: 720px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  .main { padding: 1rem; }
  .page-head { flex-direction: column; align-items: flex-start; }
  .page-head .actions { width: 100%; }
  .poster-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem; }
}

/* =====================================================================
   Storage donut (server-rendered, zero JS).
   ===================================================================== */

.donut {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 1.25rem;
  align-items: center;
  min-height: 180px;
}
@media (max-width: 540px) { .donut { grid-template-columns: 1fr; } }

.donut-ring {
  position: relative;
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: var(--surface-3);
  display: grid;
  place-items: center;
}
.donut-ring::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--donut-gradient, var(--surface-3));
  mask: radial-gradient(circle, transparent 55%, black 55.5%);
  -webkit-mask: radial-gradient(circle, transparent 55%, black 55.5%);
}
.donut-center {
  position: relative;
  z-index: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
}
.donut-value {
  font-size: 1.35rem; font-weight: 600; letter-spacing: -0.01em; color: var(--text);
  font-variant-numeric: tabular-nums;
}
.donut-value .muted { color: var(--text-dim); font-size: 0.8rem; font-weight: 400; margin-left: 0.1rem; }
.donut-label { font-family: var(--font-mono); font-size: 0.66rem; color: var(--text-dim); margin-top: 0.15rem; }

.donut-legend { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
.donut-row {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--text);
}
.donut-row .dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.donut-row .muted { margin-left: auto; }

/* =====================================================================
   Quality bars (server-rendered).
   ===================================================================== */

.bars { display: flex; flex-direction: column; gap: 0.7rem; min-height: 180px; justify-content: center; }
.bar-row { display: grid; grid-template-columns: 80px 1fr 30px; gap: 0.6rem; align-items: center; }
.bar-label { font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted); }
.bar-track { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; transition: width var(--t-slow) var(--ease-out); }
.bar-num { font-family: var(--font-mono); font-size: 0.78rem; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
`;

/**
 * Script tags for the admin console.
 *
 * Two bugs lived here and both silently disabled most of the UI:
 *
 * 1. sonner-js was imported as `{ toast }`. The bundle only has a DEFAULT
 *    export, so the named import threw a SyntaxError, `window.toast` was
 *    never assigned, and every toast in the app degraded to a
 *    `console.log`. Every success and every error message was invisible.
 *
 * 2. Alpine and client.js were both plain `defer` scripts, with Alpine
 *    first. Alpine's CDN build ends with `queueMicrotask(() =>
 *    Alpine.start())`, and a microtask checkpoint runs between two deferred
 *    scripts — so Alpine had already started and fired `alpine:init` before
 *    client.js got a chance to add its listener. `Alpine.store('modals')`
 *    and `Alpine.data('seedrpool')` never registered, which made
 *    `$store.modals` undefined and broke every modal and every
 *    confirm-gated destructive action.
 *
 * The fix for (2) is ordering: client.js is loaded BEFORE Alpine so its
 * `alpine:init` listener is installed first. client.js also handles the
 * already-started case defensively, so the order here is belt and braces.
 *
 * All three libraries are served from our own origin (see core/assets.ts)
 * rather than jsdelivr, so a blocked CDN can no longer leave the console
 * with no interactivity.
 */
export function scriptTags(options: {
  htmxPath: string;
  alpinePath: string;
  sonnerPath: string;
  jsPath: string;
}): string {
  return `
<script>
  // The server's own byte formatter, serialized in place so the client can
  // never drift from it. client.js reads window.formatBytes for toasts.
  window.formatBytes = ${formatBytes.toString()};
</script>
<script type="module">
  // Default export, not named. See the note above.
  import toast from '${esc(options.sonnerPath)}';
  window.toast = toast;
  window.dispatchEvent(new CustomEvent('seedrpool:toast-ready'));
</script>
<script src="${esc(options.htmxPath)}" defer></script>
<script src="${esc(options.jsPath)}" defer></script>
<script src="${esc(options.alpinePath)}" defer></script>
`.trim();
}

interface NavItem { href: string; label: string; short: string; iconName: string; }

const NAV_ITEMS: NavItem[] = [
  { href: '/admin',            label: 'Overview',   short: 'H', iconName: 'layout-grid' },
  { href: '/admin/library',    label: 'Library',    short: 'G', iconName: 'film' },
  { href: '/admin/transfers',  label: 'Transfers',  short: 'T', iconName: 'arrow-down-up' },
  { href: '/admin/accounts',   label: 'Fleet',      short: 'A', iconName: 'server' },
  { href: '/admin/activity',   label: 'Activity',   short: 'Y', iconName: 'activity' },
];

export interface LayoutOptions {
  title: string;
  activeNav?: string;
  body: string;
  activeTransfers?: number;
  cssPath: string;
  jsPath: string;
  htmxPath: string;
  alpinePath: string;
  sonnerPath: string;
  /** x-init body to run after Alpine is ready, used by pages for local state. */
  pageInit?: string;
}

export function layout(options: LayoutOptions): string {
  const navHtml = NAV_ITEMS.map((n) => {
    const isActive = options.activeNav === n.href;
    return (
      `<a href="${esc(n.href)}"${isActive ? ' aria-current="page"' : ''}>` +
      icon(n.iconName, { size: 16 }) +
      `<span>${esc(n.label)}</span>` +
      `</a>`
    );
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(options.title)} · SeedrPool</title>
<link rel="stylesheet" href="${esc(options.cssPath)}">
</head>
<body x-data="seedrpool" x-init="${esc(options.pageInit ?? '')}">
<div class="app">
  <aside class="sidebar">
    <a href="/admin" class="brand">
      <span class="brand-mark">${icon('layers', { size: 16 })}</span>
      <span class="brand-text">
        <span class="brand-name">SeedrPool</span>
        <span class="brand-tag">Command Deck</span>
      </span>
    </a>
    <div class="nav-section">Navigation</div>
    <nav class="nav">${navHtml}</nav>
    <div class="sidebar-foot">
      <a href="/healthz" target="_blank" rel="noreferrer">${icon('heart-pulse', { size: 13 })} Health</a>
      <a href="https://github.com/JayeshVegda/SeedrPool" target="_blank" rel="noreferrer">${icon('external-link', { size: 13 })} Repo</a>
    </div>
  </aside>
  <main class="main" hx-history-elt>
    ${options.body}
  </main>
</div>

<!-- =====================================================================
     Confirm dialog. Rendered once per page; every destructive button in
     the app dispatches a seedrpool:confirm event with a payload and this
     dialog reads it. The previous build referenced a data-confirm
     attribute with no handler behind it, so Purge and Remove fired
     instantly with no confirmation at all.
     ===================================================================== -->
<div class="modal-backdrop" x-data
     x-bind:class="$store.modals.confirm ? 'open' : ''"
     x-on:click.self="$store.modals.confirm = null"
     x-on:keydown.escape.window="$store.modals.confirm = null">
  <div class="modal confirm-dialog" x-on:click.stop x-show="$store.modals.confirm">
    <div class="modal-head">
      <div class="modal-title" x-text="($store.modals.confirm?.verb || 'Confirm') + '?'"></div>
      <button class="modal-close" x-on:click="$store.modals.confirm = null">${icon('x', { size: 14 })}</button>
    </div>
    <div class="modal-body">
      <p x-text="$store.modals.confirm?.body || ''"></p>
      <p class="muted" style="font-size: 0.78rem;" x-show="$store.modals.confirm?.accountId">
        Target: <strong class="mono" x-text="$store.modals.confirm?.accountId"></strong>
      </p>
    </div>
    <div class="modal-foot">
      <button type="button" class="btn" x-on:click="$store.modals.confirm = null">Cancel</button>
      <button type="button" class="btn danger"
              x-on:click="runConfirmedAction($store.modals.confirm); $store.modals.confirm = null"
              x-text="$store.modals.confirm?.verb || 'Confirm'"></button>
    </div>
  </div>
</div>

<!-- Keyboard shortcut reference. The sidebar advertises "?" — this makes
     that promise real. -->
<div class="modal-backdrop" x-data
     x-bind:class="$store.modals.shortcuts ? 'open' : ''"
     x-on:click.self="$store.modals.shortcuts = false"
     x-on:keydown.escape.window="$store.modals.shortcuts = false">
  <div class="modal" x-on:click.stop x-show="$store.modals.shortcuts">
    <div class="modal-head">
      <div class="modal-title">Keyboard shortcuts</div>
      <button class="modal-close" x-on:click="$store.modals.shortcuts = false">${icon('x', { size: 14 })}</button>
    </div>
    <div class="modal-body">
      <div class="kv-list">
        <div class="kv"><span class="k">Focus search</span><span class="v"><kbd>/</kbd></span></div>
        <div class="kv"><span class="k">This dialog</span><span class="v"><kbd>?</kbd></span></div>
        <div class="kv"><span class="k">Close dialogs</span><span class="v"><kbd>Esc</kbd></span></div>
      </div>
    </div>
  </div>
</div>

${scriptTags({
  htmxPath: options.htmxPath,
  alpinePath: options.alpinePath,
  sonnerPath: options.sonnerPath,
  jsPath: options.jsPath,
})}
</body>
</html>`;
}

