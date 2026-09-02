import { describe, it, expect } from 'vitest';
import { parseCredentials } from '../../src/core/credentials.ts';

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
    expect(parseCredentials('')).toEqual({ accounts: [], problems: [] });
  });

  it('renumbers later accounts when an earlier line is removed', () => {
    // Documents why the file is append-only: acc2's identity changes.
    const before = parseCredentials('a@b.com:p\nb@b.com:p\nc@b.com:p');
    const after = parseCredentials('a@b.com:p\nc@b.com:p');

    expect(before.accounts[1]?.email).toBe('b@b.com');
    expect(after.accounts[1]?.email).toBe('c@b.com');
    expect(after.accounts[1]?.id).toBe('acc2');
  });
});
