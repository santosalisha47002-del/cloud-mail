import { afterEach, describe, expect, it, vi } from 'vitest';
import mailboxToolsService, {
	buildRetrievalResult,
	extractVerificationCode,
	MAILBOX_LAST_USED_TOUCH_SQL,
	normalizeEnsureTokenAccountIds,
	normalizeMailboxListOptions,
	normalizeRetrievalOptions
} from '../src/service/mailbox-tools-service';
import { isMailboxCodeCredential, isPublicMailboxCodeRequest } from '../src/security/mailbox-code-route';
import { ensureMailboxToolsSchema, MAILBOX_TOOLS_SCHEMA_STATEMENTS } from '../src/init/mailbox-tools-schema';
import {
	canonicalPublicRequestUrl,
	renderPublicMailboxErrorHtml,
	renderPublicMailboxHtml,
	shouldRenderPublicMailboxHtml,
	toPublicCodeResult
} from '../src/api/mailbox-tools-api';
import accountService from '../src/service/account-service';
import roleService from '../src/service/role-service';
import settingService from '../src/service/setting-service';
import userService from '../src/service/user-service';

const credential = '123e4567-e89b-42d3-a456-426614174000.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

afterEach(() => vi.restoreAllMocks());

describe('batch mailbox retrieval credentials', () => {
	it('atomically creates one independent signed code URL for every new mailbox', async () => {
		vi.spyOn(userService, 'selectById').mockResolvedValue({ email: 'admin@salvadawn.com', type: 1 });
		vi.spyOn(settingService, 'query').mockResolvedValue({ minEmailPrefix: 1, emailPrefixFilter: [] });
		vi.spyOn(roleService, 'selectById').mockResolvedValue({});
		vi.spyOn(accountService, 'countUserAccount')
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(3);

		const batches = [];
		const db = {
			prepare(sql) {
				return {
					sql,
					bindings: [],
					bind(...bindings) {
						this.bindings = bindings;
						return this;
					},
					async first() {
						return { total: 0 };
					}
				};
			},
			async batch(statements) {
				batches.push(statements);
				const accountStatement = statements.find(statement => /WITH candidates\(email, name\)/i.test(statement.sql));
				const tokenStatement = statements.find(statement => /WITH candidates\(public_id, email\)/i.test(statement.sql));
				const accountValues = accountStatement.bindings.slice(0, -1);
				const accounts = [];
				for (let index = 0; index < accountValues.length; index += 2) {
					accounts.push({
						accountId: 900 + accounts.length,
						email: accountValues[index],
						createdAt: '2026-08-17 00:00:00'
					});
				}
				const tokenValues = tokenStatement.bindings.slice(0, accounts.length * 2);
				const tokens = accounts.map((accountRow, index) => ({
					id: 1200 + index,
					publicId: tokenValues[index * 2],
					accountId: accountRow.accountId,
					label: 'batch-created',
					createdAt: '2026-08-17 00:00:00',
					lastUsedAt: null
				}));
				return statements.map(statement => {
					if (statement === accountStatement) return { results: accounts };
					if (statement === tokenStatement) return { results: tokens };
					return { results: [] };
				});
			}
		};
		const context = {
			env: {
				db,
				domain: ['salvadawn.com'],
				admin: 'admin@salvadawn.com',
				jwt_secret: 'unit-test-secret'
			},
			req: { url: 'https://mail.salvadawn.com/api/mailbox-tools/batch-create' }
		};

		const result = await mailboxToolsService.batchCreate(context, {
			count: 2,
			length: 8,
			domain: 'salvadawn.com',
			prefix: 'verify-'
		}, 7);

		expect(result.created).toHaveLength(2);
		expect(new Set(result.created.map(item => item.token)).size).toBe(2);
		for (const item of result.created) {
			expect(isMailboxCodeCredential(item.token)).toBe(true);
			expect(item.codeUrl).toBe(`https://mail.salvadawn.com/api/mailbox-tools/code/${item.token}`);
			expect(item.tokenId).toBeGreaterThan(0);
		}
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(4);
		expect(batches[0][0].sql).toMatch(/COUNT\(\*\).*mailbox_api_token/is);
		expect(batches[0].at(-1).sql).toMatch(/public_id IN/is);
	});
});

describe('mailbox management inventory', () => {
	it('strictly normalizes pagination, filters, and ensure-token ids', () => {
		expect(normalizeMailboxListOptions({
			page: '3',
			pageSize: '100',
			keyword: ' Verify ',
			domain: '@SalvaDawn.com',
			tokenStatus: 'ACTIVE'
		})).toEqual({
			page: 3,
			pageSize: 100,
			keyword: 'verify',
			domain: 'salvadawn.com',
			tokenStatus: 'active'
		});
		expect(normalizeEnsureTokenAccountIds({accountIds: [7, '8', 7]})).toEqual([7, 8]);
		expect(() => normalizeMailboxListOptions({pageSize: 101})).toThrow(/1-100/);
		expect(() => normalizeMailboxListOptions({tokenStatus: 'revoked'})).toThrow(/all、active 或 missing/);
		expect(() => normalizeEnsureTokenAccountIds({accountIds: []})).toThrow(/非空数组/);
	});

	it('returns one mailbox row per account with a canonical owned URL and global stats', async () => {
		const prepared = [];
		const bindChecked = (statement, bindings) => {
			const placeholders = (statement.match(/\?/g) || []).length;
			expect(bindings).toHaveLength(placeholders);
		};
		const db = {
			prepare(sql) {
				const statement = {
					sql,
					bindings: [],
					bind(...bindings) {
						bindChecked(sql, bindings);
						this.bindings = bindings;
						return this;
					},
					async first() {
						if (/AS withApi/i.test(sql)) return {total: 14, withApi: 11, totalMessages: 39};
						return {total: 1};
					},
					async all() {
						if (/FROM account a[\s\S]+ORDER BY a\.account_id DESC/i.test(sql)) {
							return {results: [{
								accountId: 707,
								email: 'verify@salvadawn.com',
								name: 'verify',
								tokenCount: 2,
								messageCount: 5,
								unreadCount: 1,
								latestEmailId: 900,
								latestEmailTime: '2026-08-17 12:00:00'
							}]};
						}
						if (/FROM mailbox_api_token\s+t\b/i.test(sql)) {
							return {results: [{
								id: 44,
								publicId: '123e4567-e89b-42d3-a456-426614174000',
								accountId: 707,
								email: 'verify@salvadawn.com',
								label: 'latest',
								createdAt: '2026-08-17 11:00:00'
							}]};
						}
						return {results: []};
					}
				};
				prepared.push(statement);
				return statement;
			}
		};
		const context = {
			env: {db, domain: ['salvadawn.com'], jwt_secret: 'unit-test-secret'},
			req: {url: 'https://mail.salvadawn.com/api/mailbox-tools/mailboxes'}
		};

		const result = await mailboxToolsService.listMailboxes(context, {
			page: 1,
			pageSize: 20,
			keyword: '707',
			domain: 'salvadawn.com',
			tokenStatus: 'active'
		}, 19);

		expect(result.total).toBe(1);
		expect(result.stats).toEqual({total: 14, withApi: 11, withoutApi: 3, totalMessages: 39});
		expect(result.list).toHaveLength(1);
		expect(result.list[0]).toMatchObject({
			accountId: 707,
			email: 'verify@salvadawn.com',
			tokenCount: 2,
			messageCount: 5,
			unreadCount: 1,
			hasToken: true
		});
		expect(result.list[0].tokens).toHaveLength(1);
		expect(result.list[0].codeUrl).toMatch(/^https:\/\/mail\.salvadawn\.com\/api\/mailbox-tools\/code\//);
		expect(prepared.find(item => /FROM mailbox_api_token\s+t\b/i.test(item.sql)).sql).toMatch(/NOT EXISTS[\s\S]+newer_token/i);
	});

	it('reads only one owned mailbox and returns bounded plain message history', async () => {
		const db = {
			prepare(sql) {
				return {
					sql,
					bindings: [],
					bind(...bindings) {
						expect(bindings).toHaveLength((sql.match(/\?/g) || []).length);
						this.bindings = bindings;
						return this;
					},
					async first() {
						return {accountId: 707, email: 'verify@salvadawn.com', name: 'verify'};
					},
					async all() {
						return {results: [
							{emailId: 99, sendEmail: 'a@example.net', subject: '<b>First</b>', code: '111111', text: 'Code 111111', content: '<script>alert(1)</script>', createTime: '2026-08-17 10:00:00'},
							{emailId: 98, sendEmail: 'b@example.net', subject: 'Second', code: '', text: '', content: '<p>Hello <b>there</b></p>', createTime: '2026-08-17 09:00:00'},
							{emailId: 97, sendEmail: 'c@example.net', subject: 'Third', code: '', text: 'overflow'}
						]};
					}
				};
			}
		};
		const result = await mailboxToolsService.managedMailboxMessages({env: {db}}, 707, {
			beforeEmailId: 100,
			limit: 2
		}, 19);

		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]).toMatchObject({
			email: 'verify@salvadawn.com',
			emailId: 99,
			verificationCode: '111111'
		});
		expect(result.messages[1].preview).toBe('Hello there');
		expect(result.messages[1]).not.toHaveProperty('content');
		expect(result).toMatchObject({hasOlder: true, hasNewer: true, nextBeforeEmailId: 98, nextAfterEmailId: 99});
	});

	it('rejects mailbox message access when the account is not owned', async () => {
		const db = {
			prepare() {
				return {bind() { return this; }, async first() { return null; }};
			}
		};
		await expect(mailboxToolsService.managedMailboxMessages({env: {db}}, 707, {}, 20))
			.rejects.toThrow(/不存在或不属于当前用户/);
	});
});

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

	it('does not mistake digits embedded in a message id for a verification code', () => {
		expect(extractVerificationCode({
			subject: 'SendTestEmail.com - Testing Email ID: aaf1a61f176debd019925001747b0723',
			text: 'If you are reading this your email address is working.'
		})).toEqual({ code: '', source: null });
	});

	it('returns all fetched messages and advances a cursor one code at a time', () => {
		const tokenRow = { email: 'verify@salvadawn.com', accountId: 758 };
		const messages = [
			{ emailId: 707, code: '111111', sendEmail: 'a@example.net', subject: 'First', createTime: '2026-08-17 10:00:00' },
			{ emailId: 708, code: '222222', sendEmail: 'b@example.net', subject: 'Second', createTime: '2026-08-17 10:01:00' },
			{ emailId: 709, code: '', sendEmail: 'c@example.net', subject: 'Notice', text: 'No code', createTime: '2026-08-17 10:02:00' }
		];
		const result = buildRetrievalResult(messages, tokenRow, { afterEmailId: 706, mode: 'after' });
		expect(result.count).toBe(3);
		expect(result.messages.map(item => item.emailId)).toEqual([707, 708, 709]);
		expect(result.messages.map(item => item.verificationCode)).toEqual(['111111', '222222', null]);
		expect(result.code).toBe('111111');
		expect(result.latestEmailId).toBe(707);
		expect(result.nextAfterEmailId).toBe(709);
		expect(result.nextBeforeEmailId).toBe(707);
		expect(result.codeCursor).toBe(707);
		expect(result.hasNewer).toBe(false);
	});
});

describe('retrieval pagination metadata', () => {
	it('distinguishes latest, newer queue, and older history reads', () => {
		expect(normalizeRetrievalOptions({ limit: '50' })).toEqual({
			afterEmailId: 0,
			beforeEmailId: 0,
			limit: 50,
			mode: 'latest'
		});
		expect(normalizeRetrievalOptions({ afterEmailId: '0', limit: '1' }).mode).toBe('after');
		expect(normalizeRetrievalOptions({ beforeEmailId: '708' }).mode).toBe('before');
		expect(() => normalizeRetrievalOptions({ afterEmailId: 10, beforeEmailId: 20 })).toThrow(/不能同时使用/);
		expect(() => normalizeRetrievalOptions({ limit: 51 })).toThrow(/1-50/);
	});

	it('provides a backward cursor when the latest page has older mail', () => {
		const tokenRow = { email: 'verify@salvadawn.com', accountId: 758 };
		const result = buildRetrievalResult([
			{ emailId: 709, code: '', subject: 'Notice', text: 'No code' },
			{ emailId: 708, code: '222222', subject: 'Second' },
			{ emailId: 707, code: '111111', subject: 'First' }
		], tokenRow, { hasMore: true, mode: 'latest' });

		expect(result.code).toBe('222222');
		expect(result.latestEmailId).toBe(709);
		expect(result.nextAfterEmailId).toBe(709);
		expect(result.nextBeforeEmailId).toBe(707);
		expect(result.hasMore).toBe(true);
		expect(result.hasOlder).toBe(true);
		expect(result.hasNewer).toBe(false);
	});

	it('advances a code cursor across code-less queue pages', () => {
		const result = buildRetrievalResult([
			{ emailId: 710, code: '', subject: 'Notice', text: 'No code' }
		], { email: 'verify@salvadawn.com', accountId: 758 }, {
			afterEmailId: 709,
			hasMore: true,
			mode: 'after'
		});

		expect(result.found).toBe(false);
		expect(result.latestEmailId).toBe(710);
		expect(result.codeCursor).toBe(710);
		expect(result.hasNewer).toBe(true);
	});
});

describe('public retrieval authentication boundary', () => {
	it('uses HTML for browser navigation while preserving JSON negotiation', () => {
		expect(shouldRenderPublicMailboxHtml('text/html,application/xhtml+xml', '')).toBe(true);
		expect(shouldRenderPublicMailboxHtml('*/*', '')).toBe(false);
		expect(shouldRenderPublicMailboxHtml('application/json,text/html', 'json')).toBe(false);
		expect(shouldRenderPublicMailboxHtml('application/json', 'html')).toBe(true);
		expect(shouldRenderPublicMailboxHtml('*/*', '', 'navigate', 'document')).toBe(true);
		expect(canonicalPublicRequestUrl('https://mail.salvadawn.com/mailbox-tools/code/id.sig?limit=5'))
			.toBe('https://mail.salvadawn.com/api/mailbox-tools/code/id.sig?limit=5');
	});

	it('renders a readable mailbox page with copy controls and escaped message data', () => {
		const html = renderPublicMailboxHtml({
			email: 'verify@example.com',
			found: true,
			code: '836204',
			verificationCode: '836204',
			count: 1,
			messages: [{
				email: 'verify@example.com',
				emailId: 42,
				verificationCode: '836204',
				subject: '<script>alert(1)</script>',
				from: 'sender@example.com',
				receivedAt: '2026-08-17 12:00:00'
			}]
		}, 'https://mail.salvadawn.com/api/mailbox-tools/code/id.sig?limit=20');

		expect(html).toContain('复制取件 URL');
		expect(html).toContain('复制验证码');
		expect(html).toContain('查看 JSON');
		expect(html).toContain('verify@example.com');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('format=json');
	});

	it('renders an escaped browser-friendly error page', () => {
		const html = renderPublicMailboxErrorHtml('<bad token>', 401, 'https://mail.salvadawn.com/api/mailbox-tools/code/id.sig');
		expect(html).toContain('401');
		expect(html).toContain('&lt;bad token&gt;');
		expect(html).not.toContain('<bad token>');
	});

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

	it('preserves a multi-message history in the public response', () => {
		const result = toPublicCodeResult({
			found: true,
			email: 'verify@salvadawn.com',
			accountId: 758,
			code: '222222',
			latestEmailId: 708,
			nextAfterEmailId: 708,
			nextBeforeEmailId: 707,
			count: 2,
			messages: [
				{emailId: 707, found: true, code: '111111', subject: 'First'},
				{emailId: 708, found: true, code: '222222', subject: 'Second'}
			]
		});
		expect(result.count).toBe(2);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1]).toMatchObject({ email: 'verify@salvadawn.com', verificationCode: '222222' });
		expect(result.nextAfterEmailId).toBe(708);
		expect(result.nextBeforeEmailId).toBe(707);
		expect(result.codeCursor).toBe(708);
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
