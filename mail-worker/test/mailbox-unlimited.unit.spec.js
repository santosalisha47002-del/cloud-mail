import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import service from '../src/service/mailbox-tools-service';
import { MAILBOX_TOOLS_SCHEMA_STATEMENTS } from '../src/init/mailbox-tools-schema';
import accountService from '../src/service/account-service';
import roleService from '../src/service/role-service';
import settingService from '../src/service/setting-service';
import userService from '../src/service/user-service';

const databases = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

// Execute the actual service SQL with SQLite transactions, not canned D1 results.
function fixture(existing) {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(`CREATE TABLE account (
    account_id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL,
    is_del INTEGER NOT NULL DEFAULT 0,
    create_time TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
  for (const sql of MAILBOX_TOOLS_SCHEMA_STATEMENTS.slice(0, 4)) sqlite.exec(sql);
  sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${existing})
    INSERT INTO account(email,user_id) SELECT 'existing-'||i||'@example.com',7 FROM n;
    INSERT INTO mailbox_api_token(public_id,user_id,account_id)
    SELECT 'existing-'||account_id,7,account_id FROM account;`);
  const db = {
    prepare(sql) {
      return {
        sql, bindings: [],
        bind(...values) { this.bindings = values; return this; },
        async all() { return {results: sqlite.prepare(sql).all(...this.bindings)}; },
        async first() { return sqlite.prepare(sql).get(...this.bindings); }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(s => ({results: sqlite.prepare(s.sql).all(...s.bindings)}));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  vi.spyOn(userService, 'selectById').mockResolvedValue({email: 'admin@example.com', type: 1});
  vi.spyOn(roleService, 'selectById').mockResolvedValue({});
  vi.spyOn(settingService, 'query').mockResolvedValue({minEmailPrefix: 1, emailPrefixFilter: []});
  vi.spyOn(accountService, 'countUserAccount').mockImplementation(async () =>
    sqlite.prepare('SELECT COUNT(*) AS n FROM account WHERE user_id=7 AND is_del=0').get().n);
  const context = {
    env: {db, domain: ['example.com'], admin: 'admin@example.com', jwt_secret: 'test-only-secret'},
    req: {url: 'https://mail.example.com/api/mailbox-tools/batch-create'}
  };
  return {sqlite, context};
}

describe('unlimited cumulative mailbox capacity', () => {
  it.each([500, 5000])('creates 50 complete mailboxes when %i already exist', async existing => {
    const {sqlite, context} = fixture(existing);
    const result = await service.batchCreate(context, {count: 50, length: 10, domain: 'example.com'}, 7);
    expect(result.createdCount).toBe(50);
    expect(result.quota).toEqual({limit: null, unlimited: true, used: existing + 50, remaining: null});
    expect(new Set(result.created.map(r => r.codeUrl)).size).toBe(50);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM account').get().n).toBe(existing + 50);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM mailbox_api_token').get().n).toBe(existing + 50);
  });

  it('still bounds each request and rejects unconfigured domains', async () => {
    const {context} = fixture(500);
    await expect(service.batchCreate(context, {count: 51, length: 10, domain: 'example.com'}, 7))
      .rejects.toThrow(/1-50/);
    await expect(service.batchCreate(context, {count: 1, length: 10, domain: 'other.example'}, 7))
      .rejects.toThrow(/可用域名/);
  });

  it('ensures missing URLs beyond 5000 and remains idempotent and owner-scoped', async () => {
    const {sqlite, context} = fixture(5001);
    sqlite.exec("INSERT INTO account(email,user_id) VALUES ('missing@example.com',7),('other@example.com',8)");
    const first = await service.ensureMailboxTokens(context, {accountIds: [5002]}, 7);
    const again = await service.ensureMailboxTokens(context, {accountIds: [5002]}, 7);
    expect(first.createdCount).toBe(1);
    expect(again.createdCount).toBe(0);
    expect(again.list[0].codeUrl).toBe(first.list[0].codeUrl);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM mailbox_api_token').get().n).toBe(5002);
    await expect(service.ensureMailboxTokens(context, {accountIds: [5003]}, 7)).rejects.toThrow(/不属于/);
  });

  it('rolls back newly-created mailboxes if credential cardinality fails', async () => {
    const {sqlite, context} = fixture(500);
    sqlite.exec(`CREATE TRIGGER suppress_new_token BEFORE INSERT ON mailbox_api_token
      WHEN NEW.public_id IS NOT NULL BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(service.batchCreate(context, {count: 1, length: 10, domain: 'example.com'}, 7)).rejects.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM account').get().n).toBe(500);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM mailbox_api_token').get().n).toBe(500);
  });
});
