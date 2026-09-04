/**
 * Loads Seedr account credentials from a plain `email:password` file.
 *
 * Why passwords rather than OAuth tokens: Seedr's V2 device flow requires a
 * browser approval per account and the public client id we were borrowing is now
 * refused for new authorizations ("This application is not available for
 * authorization"). The V1 password grant needs no browser, no client
 * registration, and can be repeated without limit. See RESEARCH.md.
 *
 * Account ids are positional — slot 1 becomes `acc1`. That keeps ids short and
 * stable across restarts, but it used to make deletion unsafe: removing line 3
 * renumbered acc4 to acc3, and the library index stores account ids, so every
 * file row below the deleted line was silently reattributed to the wrong
 * account.
 *
 * The fix is a TOMBSTONE. A removed account leaves a `#deleted` marker on its
 * line, and the parser counts that marker as a consumed slot. Slot numbers are
 * therefore append-only for the lifetime of the file, no matter how many
 * accounts come and go, and no library row is ever reattributed.
 */

import { readFile, writeFile } from 'node:fs/promises';

/** One account's login. The password is never logged or rendered. */
export interface AccountCredential {
  /** Positional local id, e.g. `acc1`. */
  id: string;
  email: string;
  password: string;
}

/** A line that could not be parsed, reported rather than silently dropped. */
export interface CredentialProblem {
  /** 1-based line number in the source file. */
  line: number;
  reason: string;
}

export interface CredentialFile {
  accounts: AccountCredential[];
  problems: CredentialProblem[];
  /**
   * Highest slot number consumed by the file, including tombstones.
   *
   * A new account must take `highestSlot + 1`, not `accounts.length + 1`:
   * with a tombstone present those differ, and reusing a retired slot would
   * hand the new account the deleted one's library rows.
   */
  highestSlot: number;
}

/**
 * Marker written in place of a deleted account so the slot it occupied is
 * never reused. Matched case-insensitively and allows a trailing note, so
 * `#deleted acc3 was removed 2026-09-04` is still a valid tombstone.
 */
const TOMBSTONE = /^#\s*deleted\b/i;

/**
 * Parses `email:password` lines.
 *
 * Blank lines and ordinary `#` comments are ignored and do not consume a slot.
 * A `#deleted` tombstone DOES consume one — that is the whole point of it.
 */
export function parseCredentials(raw: string): CredentialFile {
  const accounts: AccountCredential[] = [];
  const problems: CredentialProblem[] = [];
  const seen = new Set<string>();
  /** Slots consumed so far, by accounts and tombstones alike. */
  let slot = 0;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // Trim handles trailing CR from files written on Windows.
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;

    if (TOMBSTONE.test(line)) {
      // A retired slot. Consumes a number so everything below keeps its id.
      slot += 1;
      continue;
    }
    if (line.startsWith('#')) continue;

    const lineNumber = i + 1;
    // An email address cannot contain a colon, so the first one separates the
    // fields and everything after it is the password, colons included.
    const separator = line.indexOf(':');
    if (separator === -1) {
      problems.push({ line: lineNumber, reason: 'missing ":" separator' });
      continue;
    }

    const email = line.slice(0, separator).trim();
    const password = line.slice(separator + 1);

    if (email === '') {
      problems.push({ line: lineNumber, reason: 'empty email' });
      continue;
    }
    if (password === '') {
      problems.push({ line: lineNumber, reason: `empty password for ${email}` });
      continue;
    }

    // Two lines for one account would produce two pool members sharing a quota,
    // which breaks capacity accounting.
    const key = email.toLowerCase();
    if (seen.has(key)) {
      problems.push({ line: lineNumber, reason: `duplicate account ${email}` });
      continue;
    }
    seen.add(key);

    slot += 1;
    accounts.push({ id: `acc${slot}`, email, password });
  }

  return { accounts, problems, highestSlot: slot };
}

/** Reads and parses the credentials file. A missing file yields no accounts. */
export async function loadCredentials(path: string): Promise<CredentialFile> {
  try {
    return parseCredentials(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { accounts: [], problems: [], highestSlot: 0 };
    }
    throw err;
  }
}

/** Extracts the slot number from an `accN` id, or null if it is not one. */
export function slotOf(id: string): number | null {
  const m = /^acc(\d+)$/.exec(id);
  if (m?.[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Writes the credentials file so that re-reading it yields exactly the ids
 * passed in.
 *
 * Each account is placed on the line matching its slot number and every gap
 * is filled with a tombstone. This is what makes deletion safe: writing
 * `[acc1, acc2, acc4]` produces four lines, the third a tombstone, and acc4
 * stays acc4. The previous implementation joined the array directly, so the
 * same input came back as acc1, acc2, acc3 and acc4's library rows were
 * reattributed to a different account.
 */
export async function writeCredentials(path: string, accounts: AccountCredential[]): Promise<void> {
  const bySlot = new Map<number, AccountCredential>();
  /** Accounts whose id is not in `accN` form get appended after the slots. */
  const unslotted: AccountCredential[] = [];
  let highest = 0;

  for (const account of accounts) {
    const slot = slotOf(account.id);
    if (slot === null || bySlot.has(slot)) {
      unslotted.push(account);
      continue;
    }
    bySlot.set(slot, account);
    if (slot > highest) highest = slot;
  }

  const lines: string[] = [];
  for (let slot = 1; slot <= highest; slot += 1) {
    const account = bySlot.get(slot);
    lines.push(
      account === undefined
        ? `#deleted acc${slot}`
        : `${account.email}:${account.password}`,
    );
  }
  for (const account of unslotted) {
    lines.push(`${account.email}:${account.password}`);
  }

  const body = lines.length === 0 ? '' : lines.join('\n') + '\n';
  await writeFile(path, body, { mode: 0o600 });
}
