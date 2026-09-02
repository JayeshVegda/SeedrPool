import { describe, it, expect } from 'vitest';
import { icon, iconMarkup, hasIcon, ICON_NAMES } from '../../src/admin/icons.ts';
import { html, esc } from '../../src/admin/html.ts';
import { isRaw } from '../../src/admin/raw.ts';

describe('inline icons', () => {
  it('renders a complete inline SVG', () => {
    const svg = iconMarkup('play');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke="currentColor"');
    // The glyph body must actually be present, not an empty shell.
    expect(svg).toContain('polygon');
  });

  it('inherits the surrounding text colour', () => {
    // The whole reason to inline rather than use <img>: the glyph picks up
    // whatever colour the parent sets, so a danger button gets a red icon
    // with no extra work.
    expect(iconMarkup('trash-2')).toContain('stroke="currentColor"');
  });

  it('is hidden from assistive tech, since icons here are always decorative', () => {
    const svg = iconMarkup('server');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('focusable="false"');
  });

  it('honours a custom size on both dimensions', () => {
    const svg = iconMarkup('film', { size: 32 });
    expect(svg).toContain('width="32"');
    expect(svg).toContain('height="32"');
  });

  it('defaults to 15px, which sits inline with the body font', () => {
    const svg = iconMarkup('film');
    expect(svg).toContain('width="15"');
    expect(svg).toContain('height="15"');
  });

  it('appends a custom class alongside the generated ones', () => {
    const svg = iconMarkup('search', { className: 'search-icon' });
    expect(svg).toContain('class="icon icon-search search-icon"');
  });

  it('renders nothing for an unknown name rather than throwing', () => {
    // A typo in a template should degrade to a missing glyph, not a 500.
    expect(iconMarkup('definitely-not-an-icon')).toBe('');
    expect(String(icon('definitely-not-an-icon'))).toBe('');
  });

  describe('escaping', () => {
    it('icon() returns pre-rendered HTML, not a plain string', () => {
      // This is the bug guard. `html` escapes interpolated values by
      // default, so an icon returning a bare string rendered as visible
      // "&lt;svg&gt;" text on every page.
      expect(isRaw(icon('play'))).toBe(true);
    });

    it('interpolates into the html template verbatim', () => {
      const out = html`<button>${icon('play')} Play</button>`;
      expect(out).toContain('<svg');
      expect(out).not.toContain('&lt;svg');
    });

    it('interpolates into a plain template literal via toString', () => {
      // Half the render code assembles strings by hand rather than through
      // the `html` tag, so the marker object has to survive that too.
      const out = `<button>${icon('play')} Play</button>`;
      expect(out).toContain('<svg');
      expect(out).not.toContain('[object Object]');
    });

    it('still escapes ordinary text alongside an icon', () => {
      const name = '<img onerror=alert(1)>';
      const out = html`<span>${icon('film')}${name}</span>`;
      expect(out).toContain('<svg');
      expect(out).toContain('&lt;img onerror=alert(1)&gt;');
      expect(out).not.toContain('<img onerror');
    });

    it('esc() on the markup would have produced the broken output', () => {
      // Documents what went wrong, so a future change that reintroduces
      // string returns fails here with an obvious message.
      expect(esc(iconMarkup('play'))).toContain('&lt;svg');
    });
  });

  it('exposes the full name list', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(30);
    expect(ICON_NAMES).toContain('play');
    expect(ICON_NAMES).toContain('server');
  });

  it('hasIcon agrees with the render path', () => {
    for (const name of ICON_NAMES) {
      expect(hasIcon(name)).toBe(true);
      expect(iconMarkup(name)).not.toBe('');
    }
    expect(hasIcon('nope')).toBe(false);
  });

  it('every icon has a non-trivial body', () => {
    // Guards against a regeneration that silently produced empty entries
    // (which is what happened for the renamed Lucide aliases: pie-chart,
    // alert-triangle, bar-chart-3, arrow-down-circle, plus-circle all
    // 404'd against lucide-static and would have shipped as blanks).
    for (const name of ICON_NAMES) {
      const svg = iconMarkup(name);
      const bodyStart = svg.indexOf('>', svg.indexOf('focusable')) + 1;
      const body = svg.slice(bodyStart, svg.lastIndexOf('</svg>'));
      expect(body.length, `icon ${name} has an empty body`).toBeGreaterThan(20);
      expect(body, `icon ${name} is not valid svg`).toMatch(
        /<(path|circle|rect|line|polygon|polyline|ellipse)/,
      );
    }
  });

  it('does not contain the license comment or newlines', () => {
    // Both would bloat every page. The generator strips them.
    for (const name of ICON_NAMES) {
      const svg = iconMarkup(name);
      expect(svg).not.toContain('@license');
      expect(svg).not.toContain('\n');
    }
  });

  it('total payload stays small', () => {
    // The point of replacing Lucide's 356 KB UMD bundle. All 36 icons
    // rendered at once is ~12 KB of markup, and a page uses a fraction of
    // that. If this grows past ~16 KB the tradeoff needs revisiting.
    const total = ICON_NAMES.reduce((sum, n) => sum + iconMarkup(n).length, 0);
    expect(total).toBeLessThan(16_000);
    // An order of magnitude smaller than the bundle it replaced.
    expect(total).toBeLessThan(356_000 / 10);
  });
});
