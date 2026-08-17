import { describe, expect, it } from 'vitest';
import { extractVerificationCode, MAILBOX_LAST_USED_TOUCH_SQL } from '../src/service/mailbox-tools-service';
import { isMailboxCodeCredential, isPublicMailboxCodeRequest } from '../src/security/mailbox-code-route';
import { ensureMailboxToolsSchema, MAILBOX_TOOLS_SCHEMA_STATEMENTS } from '../src/init/mailbox-tools-schema';
import { toPublicCodeResult } from '../src/api/mailbox-tools-api';

const credential = '123e4567-e89b-42d3-a456-426614174000.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

describe('verification-code extraction', () => {
	it('prefers the code stored by the mail ingestion pipeline', () => {
		expect(extractVerificationCode({ code: 'A9-42K', subject: '验证码 111111' })).toEqual({
			code: 'A9-42K',
			source: 'stored'
		});
	});

	it('extracts marked Chinese and English verification codes', () => {
		expect(extractVerificationCode({ subject: '登录验证码：836204', text: '' })).toEqual({ code: '836204', source: 'parsed' });
		expect(extractVerificationCode({ subject: 'Sign in', text: 'Your one-time password is Q7M4P2.' })).toEqual({
			code: 'Q7M4P2',
			source: 'parsed'
		});
	});

	it('falls back to HTML text and returns an empty result when no code exists', () => {
		expect(extractVerificationCode({ subject: 'Security notice', content: '<p>OTP: <b>450912</b></p>' })).toEqual({
			code: '450912',
			source: 'parsed'
		});
		expect(extractVerificationCode({ subject: 'Welcome', text: 'Thanks for signing up.' })).toEqual({ code: '', source: null });
	});
});

describe('public retrieval authentication boundary', () => {
	it('only exempts an exact, well-formed GET code URL', () => {
		expect(isMailboxCodeCredential(credential)).toBe(true);
		expect(isPublicMailboxCodeRequest(`/mailbox-tools/code/${credential}`, 'GET')).toBe(true);
		expect(isPublicMailboxCodeRequest(`/mailbox-tools/code/${credential}`, 'POST')).toBe(false);
		expect(isPublicMailboxCodeRequest(`/mailbox-tools/code/${credential}/extra`, 'GET')).toBe(false);
		expect(isPublicMailboxCodeRequest('/mailbox-tools/code/not-a-token', 'GET')).toBe(false);
		expect(isPublicMailboxCodeRequest('/mailbox-tools/tokens', 'GET')).toBe(false);
	});

	it('returns both common code field names and cursor metadata', () => {
		expect(
			toPublicCodeResult({
				found: true,
				code: '836204',
				latestEmailId: 703,
				subject: '登录验证码'
			})
		).toMatchObject({
			found: true,
			code: '836204',
			verificationCode: '836204',
			latestEmailId: 703,
			subject: '登录验证码'
		});
	});
});

describe('lazy D1 schema initialization', () => {
	it('uses idempotent table/index SQL and shares concurrent work per binding', async () => {
		const prepared = [];
		let batchCalls = 0;
		const db = {
			prepare(statement) {
				prepared.push(statement);
				return { statement };
			},
			async batch(statements) {
				batchCalls++;
				expect(statements).toHaveLength(MAILBOX_TOOLS_SCHEMA_STATEMENTS.length);
			}
		};
		const context = { env: { db } };

		await Promise.all([ensureMailboxToolsSchema(context), ensureMailboxToolsSchema(context), ensureMailboxToolsSchema(context)]);

		expect(batchCalls).toBe(1);
		expect(prepared).toEqual(MAILBOX_TOOLS_SCHEMA_STATEMENTS);
		expect(MAILBOX_TOOLS_SCHEMA_STATEMENTS.every(statement => /IF NOT EXISTS/i.test(statement))).toBe(true);
		expect(MAILBOX_TOOLS_SCHEMA_STATEMENTS.join('\n')).toMatch(/UNIQUE INDEX[\s\S]+public_id/i);
		expect(MAILBOX_TOOLS_SCHEMA_STATEMENTS.join('\n')).toMatch(/email \(user_id, account_id, type, is_del, email_id DESC\)/i);
		expect(MAILBOX_LAST_USED_TOUCH_SQL).toMatch(/last_used_at <= datetime\('now', '-1 minute'\)/i);
	});

	it('evicts a failed initialization so a later request can retry', async () => {
		let batchCalls = 0;
		const db = {
			prepare(statement) {
				return { statement };
			},
			async batch() {
				batchCalls++;
				if (batchCalls === 1) throw new Error('temporary D1 error');
			}
		};
		const context = { env: { db } };

		await expect(ensureMailboxToolsSchema(context)).rejects.toThrow('temporary D1 error');
		await expect(ensureMailboxToolsSchema(context)).resolves.toBeUndefined();
		expect(batchCalls).toBe(2);
	});
});
