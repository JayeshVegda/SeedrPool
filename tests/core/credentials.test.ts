import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCredentials,
  writeCredentials,
  slotOf,
  type AccountCredential,
} from '../../src/core/credentials.ts';

describe('parseCredentials', () => {
  it('assigns positional ids starting at acc1', () => {
    const { accounts, problems } = parseCredentials(
      'first@example.com:pw1\nsecond@example.com:pw2\nthird@example.com:pw3\n',
    );

    expect(problems).toEqual([]);
    expect(accounts.map((a) => a.id)).toEqual(['acc1', 'acc2', 'acc3']);
    expect(accounts.map((a) => a.email)).toEqual([
      'first@example.com',
      'second@example.com',
      'third@example.com',
    ]);
    expect(accounts[0]?.password).toBe('pw1');
  });

  it('keeps colons inside passwords', () => {
    // Only the first colon separates the fields, since an email cannot contain one.
    const { accounts } = parseCredentials('a@b.com:pass:with:colons');
    expect(accounts[0]?.password).toBe('pass:with:colons');
  });

  it('tolerates CRLF line endings and surrounding whitespace', () => {
    const { accounts, problems } = parseCredentials('  a@b.com:secret  \r\nc@d.com:other\r\n');
    expect(problems).toEqual([]);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.email).toBe('a@b.com');
    // Trailing whitespace belongs to the line, not the password.
    expect(accounts[0]?.password).toBe('secret');
  });

  it('ignores blank lines and comments without consuming an account number', () => {
    const { accounts } = parseCredentials('# header\n\na@b.com:pw\n\n# note\nc@d.com:pw2\n');
    expect(accounts.map((a) => a.id)).toEqual(['acc1', 'acc2']);
  });

  it('reports a line with no separator rather than dropping it silently', () => {
    const { accounts, problems } = parseCredentials('a@b.com:pw\ngarbage\n');
    expect(accounts).toHaveLength(1);
    expect(problems).toEqual([{ line: 2, reason: 'missing ":" separator' }]);
  });

  it('reports empty emails and passwords', () => {
    const { accounts, problems } = parseCredentials(':pw\na@b.com:\n');
    expect(accounts).toHaveLength(0);
    expect(problems).toEqual([
      { line: 1, reason: 'empty email' },
      { line: 2, reason: 'empty password for a@b.com' },
    ]);
  });

  it('rejects a duplicate account, which would double-count one quota', () => {
    const { accounts, problems } = parseCredentials('a@b.com:pw1\nA@B.com:pw2\n');
    expect(accounts).toHaveLength(1);
    expect(problems).toEqual([{ line: 2, reason: 'duplicate account A@B.com' }]);
  });

  it('yields nothing for an empty file', () => {
    expect(parseCredentials('')).toEqual({ accounts: [], problems: [], highestSlot: 0 });
  });

  it('still renumbers when a line is deleted by hand, which is why tombstones exist', () => {
    // Hand-editing the file out from under us is the one case we cannot
    // defend against: nothing records that a slot was retired, so acc2's
    // identity changes and its library rows follow the wrong account.
    // `writeCredentials` never produces this shape — see the tombstone tests.
    const before = parseCredentials('a@b.com:p\nb@b.com:p\nc@b.com:p');
    const after = parseCredentials('a@b.com:p\nc@b.com:p');

    expect(before.accounts[1]?.email).toBe('b@b.com');
    expect(after.accounts[1]?.email).toBe('c@b.com');
    expect(after.accounts[1]?.id).toBe('acc2');
  });

  it('treats a #deleted tombstone as a consumed slot so later ids are stable', () => {
    // This is the shape writeCredentials produces after a delete. acc3 keeps
    // its id even though only two accounts remain, so the library rows
    // recorded against acc3 still point at the same account.
    const { accounts, highestSlot } = parseCredentials(
      'a@b.com:p\n#deleted acc2\nc@b.com:p\n',
    );
    expect(accounts.map((a) => a.id)).toEqual(['acc1', 'acc3']);
    expect(accounts.map((a) => a.email)).toEqual(['a@b.com', 'c@b.com']);
    expect(highestSlot).toBe(3);
  });

  it('accepts a tombstone with no trailing note and is case-insensitive', () => {
    const { accounts } = parseCredentials('#DELETED\na@b.com:p\n');
    expect(accounts.map((a) => a.id)).toEqual(['acc2']);
  });

  it('does not let an ordinary comment consume a slot', () => {
    // Only `#deleted` is a tombstone. A normal comment must stay inert or
    // documenting the file would silently renumber it.
    const { accounts } = parseCredentials('# my accounts\na@b.com:p\n# note\nc@d.com:p\n');
    expect(accounts.map((a) => a.id)).toEqual(['acc1', 'acc2']);
  });

  it('reports highestSlot so a new account can take the next free number', () => {
    const { accounts, highestSlot } = parseCredentials('a@b.com:p\n#deleted acc2\n');
    expect(accounts).toHaveLength(1);
    // Not accounts.length + 1 — that would reuse retired slot 2.
    expect(highestSlot).toBe(2);
  });
});

describe('writeCredentials', () => {
  /** Round-trips through a temp file so the on-disk format is what is tested. */
  async function roundTrip(accounts: AccountCredential[]): Promise<{
    text: string;
    parsed: ReturnType<typeof parseCredentials>;
  }> {
    const path = join(await mkdtemp(join(tmpdir(), 'seedrpool-creds-')), 'credentials.txt');
    await writeCredentials(path, accounts);
    const text = await readFile(path, 'utf8');
    return { text, parsed: parseCredentials(text) };
  }

  it('preserves every id across a delete, which is the whole point', async () => {
    // Deleting acc2 from a three-account file used to renumber acc3 to acc2,
    // silently reattributing acc3's library rows to a different Seedr
    // account. The write must leave a tombstone in slot 2.
    const { text, parsed } = await roundTrip([
      { id: 'acc1', email: 'a@b.com', password: 'p1' },
      { id: 'acc3', email: 'c@b.com', password: 'p3' },
    ]);

    expect(text).toBe('a@b.com:p1\n#deleted acc2\nc@b.com:p3\n');
    expect(parsed.accounts.map((a) => a.id)).toEqual(['acc1', 'acc3']);
    expect(parsed.accounts[1]?.email).toBe('c@b.com');
  });

  it('round-trips a full file unchanged', async () => {
    const { parsed } = await roundTrip([
      { id: 'acc1', email: 'a@b.com', password: 'p1' },
      { id: 'acc2', email: 'b@b.com', password: 'p2' },
    ]);
    expect(parsed.accounts.map((a) => [a.id, a.email, a.password])).toEqual([
      ['acc1', 'a@b.com', 'p1'],
      ['acc2', 'b@b.com', 'p2'],
    ]);
  });

  it('keeps a trailing tombstone so the retired slot is not reused', async () => {
    // acc2 deleted from a two-account file. Without the trailing tombstone
    // the next added account would be handed slot 2 and inherit acc2's rows.
    const { text, parsed } = await roundTrip([
      { id: 'acc1', email: 'a@b.com', password: 'p1' },
      { id: 'acc3', email: 'c@b.com', password: 'p3' },
    ]);
    expect(text).toContain('#deleted acc2');
    expect(parsed.highestSlot).toBe(3);
  });

  it('preserves passwords containing colons', async () => {
    const { parsed } = await roundTrip([
      { id: 'acc1', email: 'a@b.com', password: 'pass:with:colons' },
    ]);
    expect(parsed.accounts[0]?.password).toBe('pass:with:colons');
  });

  it('writes an empty file for no accounts rather than a stray newline', async () => {
    const { text, parsed } = await roundTrip([]);
    expect(text).toBe('');
    expect(parsed.accounts).toEqual([]);
  });

  it('appends an account whose id is not in accN form', async () => {
    // Defensive: an id we cannot place in a slot must not be dropped.
    const { parsed } = await roundTrip([
      { id: 'acc1', email: 'a@b.com', password: 'p1' },
      { id: 'weird', email: 'w@b.com', password: 'pw' },
    ]);
    expect(parsed.accounts.map((a) => a.email)).toEqual(['a@b.com', 'w@b.com']);
  });
});

describe('slotOf', () => {
  it('extracts the slot number from an accN id', () => {
    expect(slotOf('acc1')).toBe(1);
    expect(slotOf('acc42')).toBe(42);
  });

  it('returns null for anything that is not an accN id', () => {
    expect(slotOf('acc0')).toBeNull();
    expect(slotOf('acc')).toBeNull();
    expect(slotOf('__probe__')).toBeNull();
    expect(slotOf('acc1x')).toBeNull();
  });
});
