/**
 * Pre-rendered HTML marker.
 *
 * Lives in its own module so both `html.ts` (the template engine) and
 * `icons.ts` (which emits real SVG markup) can share one identity without a
 * circular import. That identity matters: the `html` tagged template escapes
 * every interpolated value by default, so a value carrying real markup has to
 * be distinguishable from a string of user text. When the two modules each
 * declared their own marker, the check silently failed and every
 * server-rendered icon appeared on the page as literal `&lt;svg&gt;` text.
 *
 * A class rather than a symbol brand: `instanceof` is unambiguous, needs no
 * index-signature gymnastics, and there is exactly one class object because
 * there is exactly one module.
 */

export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  /** So a `Raw` also interpolates correctly into a plain template literal. */
  toString(): string {
    return this.value;
  }
}

/** Marks pre-rendered HTML as safe to insert without escaping. */
export function raw(value: string): Html {
  return new Html(value);
}

/** True when `value` is pre-rendered HTML rather than text to escape. */
export function isRaw(value: unknown): value is Html {
  return value instanceof Html;
}
