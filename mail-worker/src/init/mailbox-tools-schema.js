/**
 * Mailbox automation schema kept separate from the historical migrations so
 * an already-running deployment can create it lazily on the first request.
 * Every statement is idempotent, which also makes concurrent cold starts safe.
 */
export const MAILBOX_TOOLS_SCHEMA_STATEMENTS = Object.freeze([
	`CREATE TABLE IF NOT EXISTS mailbox_api_token (
		token_id INTEGER PRIMARY KEY AUTOINCREMENT,
		public_id TEXT NOT NULL,
		user_id INTEGER NOT NULL,
		account_id INTEGER NOT NULL,
		label TEXT NOT NULL DEFAULT '',
		created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		last_used_at DATETIME,
		revoked_at DATETIME
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_api_token_public_id
		ON mailbox_api_token (public_id)`,
	`CREATE INDEX IF NOT EXISTS idx_mailbox_api_token_user_active
		ON mailbox_api_token (user_id, revoked_at, token_id DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_mailbox_api_token_account_active
		ON mailbox_api_token (user_id, account_id, revoked_at)`,
	`CREATE INDEX IF NOT EXISTS idx_email_mailbox_code_lookup
		ON email (user_id, account_id, type, is_del, email_id DESC)`
]);

const schemaPromises = new WeakMap();

/**
 * Ensure the table and indexes once per D1 binding in the current isolate.
 *
 * D1 batches are transactional and the SQL itself uses IF NOT EXISTS. The
 * WeakMap only removes duplicate work inside one isolate; idempotent DDL is the
 * cross-isolate concurrency guarantee. A failed attempt is evicted so the next
 * request can retry instead of leaving the deployment permanently poisoned.
 */
export function ensureMailboxToolsSchema(c) {
	const db = c?.env?.db;
	if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
		throw new Error('D1数据库未绑定 D1 database not bound');
	}

	const inFlight = schemaPromises.get(db);
	if (inFlight) return inFlight;

	const pending = (async () => {
		try {
			const statements = MAILBOX_TOOLS_SCHEMA_STATEMENTS.map(statement => db.prepare(statement));
			await db.batch(statements);
		} catch (error) {
			schemaPromises.delete(db);
			throw error;
		}
	})();

	schemaPromises.set(db, pending);
	return pending;
}
