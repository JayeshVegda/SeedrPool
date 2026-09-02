/**
 * Loads Seedr account credentials from a plain `email:password` file.
 *
 * Why passwords rather than OAuth tokens: Seedr's V2 device flow requires a
 * browser approval per account and the public client id we were borrowing is now
 * refused for new authorizations ("This application is not available for
 * authorization"). The V1 password grant needs no browser, no client
 * registration, and can be repeated without limit. See RESEARCH.md.
 *
 * Account ids are positional — line 1 becomes `acc1`. That keeps ids short and
 * stable across restarts, but it means the file is APPEND-ONLY: reordering or
 * deleting a line renumbers every account after it, and the library index stores
 * account ids. Add new accounts at the end.
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
}

/**
 * Parses `email:password` lines.
 *
 * Blank lines and `#` comments are ignored and do not consume an account number,
 * so commenting a line out would renumber the accounts below it. Comment lines
 * are therefore only safe at the end of the file.
 */
export function parseCredentials(raw: string): CredentialFile {
  const accounts: AccountCredential[] = [];
  const problems: CredentialProblem[] = [];
  const seen = new Set<string>();

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // Trim handles trailing CR from files written on Windows.
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;

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

    accounts.push({ id: `acc${accounts.length + 1}`, email, password });
  }

  return { accounts, problems };
}

/** Reads and parses the credentials file. A missing file yields no accounts. */
export async function loadCredentials(path: string): Promise<CredentialFile> {
  try {
    return parseCredentials(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { accounts: [], problems: [] };
    }
    throw err;
  }
}

/**
 * Writes the credentials file in the same format `parseCredentials` reads.
 * Used by addAccount/deleteAccount; preserves comments and blank lines.
 */
export async function writeCredentials(path: string, accounts: AccountCredential[]): Promise<void> {
  const body = accounts.map((a) => `${a.email}:${a.password}`).join('\n') + '\n';
  await writeFile(path, body, { mode: 0o600 });
}
