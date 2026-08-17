import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * A revocable, per-mailbox retrieval credential.
 *
 * `public_id` is only an identifier. The externally usable credential also
 * contains an HMAC generated from `jwt_secret`, so a database read alone does
 * not reveal a working retrieval URL.
 */
export const mailboxApiToken = sqliteTable('mailbox_api_token', {
	tokenId: integer('token_id').primaryKey({ autoIncrement: true }),
	publicId: text('public_id').notNull(),
	userId: integer('user_id').notNull(),
	accountId: integer('account_id').notNull(),
	label: text('label').notNull().default(''),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
	lastUsedAt: text('last_used_at'),
	revokedAt: text('revoked_at')
});

export default mailboxApiToken;
