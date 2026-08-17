import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import BizError from '../error/biz-error';
import { emailConst, isDel } from '../const/entity-const';
import account from '../entity/account';
import email from '../entity/email';
import mailboxApiToken from '../entity/mailbox-api-token';
import orm from '../entity/orm';
import accountService from './account-service';
import roleService from './role-service';
import settingService from './setting-service';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import { isMailboxCodeCredential } from '../security/mailbox-code-route';

const encoder = new TextEncoder();
const MAX_BATCH_SIZE = 50;
const MAX_MAILBOXES_PER_USER = 500;
const MAX_RANDOM_LENGTH = 32;
const MAX_ACTIVE_TOKENS_PER_ACCOUNT = 10;
// Every mailbox created by the automation pool owns one retrieval URL. Keep
// enough user-level capacity for all 500 mailboxes while retaining the
// existing per-mailbox limit for manually-created replacement URLs.
const MAX_ACTIVE_TOKENS_PER_USER = MAX_MAILBOXES_PER_USER * MAX_ACTIVE_TOKENS_PER_ACCOUNT;
const BATCH_SQL_CHUNK_SIZE = 25;
const AUTO_TOKEN_LABEL = 'batch-created';
const TOKEN_PURPOSE = 'cloud-mail:mailbox-api:v1:';
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const MAILBOX_LAST_USED_TOUCH_SQL = `
	UPDATE mailbox_api_token
	SET last_used_at = CURRENT_TIMESTAMP
	WHERE token_id = ?
		AND revoked_at IS NULL
		AND (last_used_at IS NULL OR last_used_at <= datetime('now', '-1 minute'))
`;

function asDomainList(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== 'string') return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [value];
	} catch (_) {
		return [value];
	}
}

function normalizeDomain(value) {
	return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function base64Url(bytes) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function base64UrlDecode(value) {
	let input = value.replace(/-/g, '+').replace(/_/g, '/');
	while (input.length % 4) input += '=';
	return Uint8Array.from(atob(input), item => item.charCodeAt(0));
}

async function tokenKey(c, usage) {
	if (!c.env.jwt_secret) {
		throw new BizError('jwt_secret 未配置', 502);
	}
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(c.env.jwt_secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		[usage]
	);
}

async function signPublicId(c, publicId) {
	const key = await tokenKey(c, 'sign');
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(TOKEN_PURPOSE + publicId)
	);
	return base64Url(new Uint8Array(signature));
}

async function verifyPublicCredential(c, credential) {
	if (typeof credential !== 'string' || credential.length > 160) return null;
	if (!isMailboxCodeCredential(credential)) return null;
	const separator = credential.lastIndexOf('.');
	if (separator < 1) return null;
	const publicId = credential.slice(0, separator);
	const signature = credential.slice(separator + 1);

	try {
		const key = await tokenKey(c, 'verify');
		const valid = await crypto.subtle.verify(
			'HMAC',
			key,
			base64UrlDecode(signature),
			encoder.encode(TOKEN_PURPOSE + publicId)
		);
		return valid ? publicId : null;
	} catch (_) {
		return null;
	}
}

function randomString(length) {
	let output = '';
	// Rejection sampling avoids modulo bias while keeping the local part compact.
	const threshold = Math.floor(256 / RANDOM_ALPHABET.length) * RANDOM_ALPHABET.length;
	while (output.length < length) {
		const bytes = new Uint8Array(Math.max(16, (length - output.length) * 2));
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte >= threshold) continue;
			output += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
			if (output.length === length) break;
		}
	}
	return output;
}

function isUniqueConstraint(error) {
	return /unique constraint|constraint failed|sqlite_constraint/i.test(error?.message || '');
}

function isQuotaGuardConstraint(error) {
	return /not null constraint failed:\s*account\.email|sqlite_constraint_notnull/i.test(error?.message || '');
}

function chunks(items, size = BATCH_SQL_CHUNK_SIZE) {
	const output = [];
	for (let index = 0; index < items.length; index += size) {
		output.push(items.slice(index, index + size));
	}
	return output;
}

function valuesPlaceholders(rowCount, columnCount) {
	const row = `(${Array(columnCount).fill('?').join(', ')})`;
	return Array(rowCount).fill(row).join(', ');
}

async function countActiveUserTokens(c, userId) {
	const row = await c.env.db
		.prepare(`
			SELECT COUNT(*) AS total
			FROM mailbox_api_token
			WHERE user_id = ? AND revoked_at IS NULL
		`)
		.bind(userId)
		.first();
	return Number(row?.total || 0);
}

async function removeIncompleteBatch(c, userId, accountIds) {
	if (!accountIds.length) return;
	for (const idChunk of chunks(accountIds, 50)) {
		const placeholders = idChunk.map(() => '?').join(', ');
		await c.env.db.batch([
			c.env.db.prepare(`
				DELETE FROM mailbox_api_token
				WHERE user_id = ? AND account_id IN (${placeholders})
			`).bind(userId, ...idChunk),
			c.env.db.prepare(`
				DELETE FROM account
				WHERE user_id = ? AND account_id IN (${placeholders})
			`).bind(userId, ...idChunk)
		]);
	}
}

function retrievalOrigin(c) {
	const configured = String(c.env.mailbox_api_origin || '').trim().replace(/\/$/, '');
	return configured || new URL(c.req.url).origin;
}

function normalizeAfterEmailId(value) {
	if (value === undefined || value === null || value === '') return 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new BizError('afterEmailId 必须是非负整数', 400);
	}
	return parsed;
}

function storedCode(value) {
	const code = String(value || '').trim();
	if (!code || code.length > 64 || /[\r\n]/.test(code)) return '';
	return code;
}

/**
 * Deterministic fallback for deployments where Workers AI is unavailable or
 * an individual message was not classified. Marker-based matches are tried
 * first, followed by a conservative numeric OTP match.
 */
export function extractVerificationCode(row) {
	const existing = storedCode(row?.code);
	if (existing) return { code: existing, source: 'stored' };

	const subject = String(row?.subject || '');
	const text = String(row?.text || '');
	const htmlText = row?.content ? emailUtils.htmlToText(row.content) : '';
	const searchable = `${subject}\n${text}\n${htmlText}`.slice(0, 16000);
	if (!searchable.trim()) return { code: '', source: null };

	const markerPatterns = [
		/(?:verification\s*code|security\s*code|one[-\s]*time(?:\s*password|\s*code)?|otp|passcode|验证码|校验码|动态码|确认码)(?:\s*(?:is|为|是|[:：-]))?\s*([A-Z0-9][A-Z0-9-]{2,11})/giu,
		/([A-Z0-9][A-Z0-9-]{2,11})\s*(?:is\s+your\s+)?(?:verification\s*code|security\s*code|one[-\s]*time(?:\s*password|\s*code)?|otp|passcode|验证码|校验码|动态码|确认码)/giu
	];

	for (const pattern of markerPatterns) {
		for (const match of searchable.matchAll(pattern)) {
			const candidate = match[1].replace(/^-|-$/g, '');
			if (candidate.length >= 4 && candidate.length <= 12 && /\d/.test(candidate)) {
				return { code: candidate, source: 'parsed' };
			}
		}
	}

	const numeric = searchable.match(/(?:^|\D)(\d{4,8})(?!\d)/u);
	return numeric ? { code: numeric[1], source: 'parsed' } : { code: '', source: null };
}

const mailboxToolsService = {
	async batchCreate(c, params, userId) {
		const countRequested = Number(params?.count);
		const randomLength = Number(params?.length);
		const domain = normalizeDomain(params?.domain);
		const prefix = String(params?.prefix || '').trim().toLowerCase();

		if (!Number.isSafeInteger(countRequested) || countRequested < 1 || countRequested > MAX_BATCH_SIZE) {
			throw new BizError(`count 必须是 1-${MAX_BATCH_SIZE} 的整数`, 400);
		}
		if (!Number.isSafeInteger(randomLength) || randomLength < 4 || randomLength > MAX_RANDOM_LENGTH) {
			throw new BizError(`length 必须是 4-${MAX_RANDOM_LENGTH} 的整数`, 400);
		}
		if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
			throw new BizError('域名格式无效', 400);
		}
		if (prefix && (!/^[a-z0-9][a-z0-9._-]*$/i.test(prefix) || prefix.includes('..'))) {
			throw new BizError('prefix 只能包含字母、数字、点、下划线和短横线，且不能以符号开头', 400);
		}
		if (prefix.length + randomLength > 64) {
			throw new BizError('邮箱前缀总长度不能超过 64', 400);
		}

		const allowedDomains = asDomainList(c.env.domain).map(normalizeDomain);
		if (!allowedDomains.includes(domain)) {
			throw new BizError('当前域名不在可用域名列表中', 403);
		}

		const [userRow, settings] = await Promise.all([
			userService.selectById(c, userId),
			settingService.query(c)
		]);
		if (!userRow) throw new BizError('用户不存在', 404);

		const isAdmin = String(userRow.email || '').toLowerCase() === String(c.env.admin || '').toLowerCase();
		const roleRow = await roleService.selectById(c, userRow.type);
		if (!isAdmin) {
			if (!roleRow) throw new BizError('用户身份不存在', 403);
			if (!roleService.hasAvailDomainPerm(roleRow.availDomain, `probe@${domain}`)) {
				throw new BizError('当前身份无权使用该域名', 403);
			}
		}

		const minPrefixLength = Number(settings.minEmailPrefix || 1);
		if (prefix.length + randomLength < minPrefixLength) {
			throw new BizError(`邮箱前缀长度不能小于 ${minPrefixLength}`, 400);
		}
		const filters = Array.isArray(settings.emailPrefixFilter) ? settings.emailPrefixFilter : [];
		if (filters.some(item => item && prefix.includes(String(item).toLowerCase()))) {
			throw new BizError('固定前缀包含已禁用内容', 403);
		}

		// This automation pool intentionally has its own quota. The ordinary
		// role.accountCount value is designed for interactive account creation
		// and would make a default batch of ten fail for a user with one mailbox.
		const [currentCount, activeTokenCount] = await Promise.all([
			accountService.countUserAccount(c, userId),
			countActiveUserTokens(c, userId)
		]);
		const remainingBeforeCreate = Math.max(0, MAX_MAILBOXES_PER_USER - currentCount);
		if (countRequested > remainingBeforeCreate) {
			throw new BizError(`批量邮箱上限为 ${MAX_MAILBOXES_PER_USER} 个，当前仅可创建 ${remainingBeforeCreate} 个`, 403);
		}
		const remainingTokenCapacity = Math.max(0, MAX_ACTIVE_TOKENS_PER_USER - activeTokenCount);
		if (countRequested > remainingTokenCapacity) {
			throw new BizError(`取件 URL 上限为 ${MAX_ACTIVE_TOKENS_PER_USER} 个，当前仅可创建 ${remainingTokenCapacity} 个`, 403);
		}

		// D1 executes every statement in a batch as one transaction. Accounts,
		// their public IDs and the final cardinality assertion therefore commit
		// together. A quota race, address collision or token collision aborts the
		// whole batch rather than leaving mailboxes without retrieval URLs.
		for (let batchAttempt = 0; batchAttempt < 6; batchAttempt++) {
			const candidates = [];
			const candidateSet = new Set();
			let generationAttempts = 0;
			while (candidates.length < countRequested && generationAttempts < countRequested * 30) {
				generationAttempts++;
				const local = prefix + randomString(randomLength);
				if (filters.some(item => item && local.includes(String(item).toLowerCase()))) continue;
				const address = `${local}@${domain}`;
				if (candidateSet.has(address)) continue;
				candidateSet.add(address);
				candidates.push({ address, local });
			}
			if (candidates.length !== countRequested) {
				throw new BizError('无法生成符合前缀过滤规则的随机邮箱', 409);
			}

			const origin = retrievalOrigin(c);
			const tokenCandidates = await Promise.all(candidates.map(async item => {
				const publicId = crypto.randomUUID();
				const signature = await signPublicId(c, publicId);
				const token = `${publicId}.${signature}`;
				return {
					...item,
					publicId,
					token,
					codeUrl: `${origin}/api/mailbox-tools/code/${token}`
				};
			}));

			const accountChunks = chunks(tokenCandidates);
			const tokenChunks = chunks(tokenCandidates);
			const statements = [];

			// This zero-row guard becomes a deliberate NOT NULL violation only if
			// another request used account/token capacity after our preflight read.
			statements.push(c.env.db.prepare(`
				INSERT INTO account (email, name, user_id)
				SELECT NULL, '', ?
				WHERE (
					SELECT COUNT(*) FROM account WHERE user_id = ? AND is_del = 0
				) + ? > ?
				OR (
					SELECT COUNT(*) FROM mailbox_api_token WHERE user_id = ? AND revoked_at IS NULL
				) + ? > ?
			`).bind(
				userId,
				userId,
				countRequested,
				MAX_MAILBOXES_PER_USER,
				userId,
				countRequested,
				MAX_ACTIVE_TOKENS_PER_USER
			));

			for (const itemChunk of accountChunks) {
				const bindings = itemChunk.flatMap(item => [item.address, item.local]);
				statements.push(c.env.db.prepare(`
					WITH candidates(email, name) AS (
						VALUES ${valuesPlaceholders(itemChunk.length, 2)}
					)
					INSERT INTO account (email, name, user_id)
					SELECT email, name, ? FROM candidates
					RETURNING account_id AS accountId, email, create_time AS createdAt
				`).bind(...bindings, userId));
			}

			for (const itemChunk of tokenChunks) {
				const bindings = itemChunk.flatMap(item => [item.publicId, item.address]);
				statements.push(c.env.db.prepare(`
					WITH candidates(public_id, email) AS (
						VALUES ${valuesPlaceholders(itemChunk.length, 2)}
					)
					INSERT INTO mailbox_api_token (public_id, user_id, account_id, label)
					SELECT candidates.public_id, ?, account.account_id, ?
					FROM candidates
					INNER JOIN account
						ON account.email = candidates.email COLLATE NOCASE
						AND account.user_id = ?
						AND account.is_del = ?
					WHERE (
						SELECT COUNT(*)
						FROM mailbox_api_token existing
						WHERE existing.user_id = ?
							AND existing.account_id = account.account_id
							AND existing.revoked_at IS NULL
					) < ?
					RETURNING
						token_id AS id,
						public_id AS publicId,
						account_id AS accountId,
						label,
						created_at AS createdAt,
						last_used_at AS lastUsedAt
				`).bind(
					...bindings,
					userId,
					AUTO_TOKEN_LABEL,
					userId,
					isDel.NORMAL,
					userId,
					MAX_ACTIVE_TOKENS_PER_ACCOUNT
				));
			}

			// This assertion covers any unexpected account/token join mismatch.
			// It intentionally violates public_id NOT NULL when fewer than N
			// credentials were inserted, causing D1 to roll the transaction back.
			const publicIds = tokenCandidates.map(item => item.publicId);
			statements.push(c.env.db.prepare(`
				INSERT INTO mailbox_api_token (public_id, user_id, account_id, label)
				SELECT NULL, ?, 0, ''
				WHERE (
					SELECT COUNT(*)
					FROM mailbox_api_token
					WHERE user_id = ?
						AND revoked_at IS NULL
						AND public_id IN (${publicIds.map(() => '?').join(', ')})
				) <> ?
			`).bind(userId, userId, ...publicIds, countRequested));

			try {
				const batchResult = await c.env.db.batch(statements);
				const accountStart = 1;
				const tokenStart = accountStart + accountChunks.length;
				const createdAccounts = batchResult
					.slice(accountStart, tokenStart)
					.flatMap(item => item.results || []);
				const insertedTokens = batchResult
					.slice(tokenStart, tokenStart + tokenChunks.length)
					.flatMap(item => item.results || []);

				const candidateByEmail = new Map(tokenCandidates.map(item => [item.address.toLowerCase(), item]));
				const tokenByAccountId = new Map(insertedTokens.map(item => [Number(item.accountId), item]));
				const created = createdAccounts.map(accountRow => {
					const candidate = candidateByEmail.get(String(accountRow.email || '').toLowerCase());
					const tokenRow = tokenByAccountId.get(Number(accountRow.accountId));
					if (!candidate || !tokenRow || tokenRow.publicId !== candidate.publicId) return null;
					return {
						...accountRow,
						tokenId: tokenRow.id,
						token: candidate.token,
						codeUrl: candidate.codeUrl
					};
				});

				if (
					createdAccounts.length !== countRequested ||
					insertedTokens.length !== countRequested ||
					created.some(item => !item)
				) {
					await removeIncompleteBatch(c, userId, createdAccounts.map(item => Number(item.accountId)).filter(Boolean));
					throw new BizError('批量创建未能完整生成取件 URL，请重试', 409);
				}
				const used = await accountService.countUserAccount(c, userId);
				return {
					created,
					requested: countRequested,
					createdCount: created.length,
					quota: {
						limit: MAX_MAILBOXES_PER_USER,
						used,
						remaining: Math.max(0, MAX_MAILBOXES_PER_USER - used)
					}
				};
			} catch (error) {
				if (error?.name === 'BizError') throw error;
				if (isQuotaGuardConstraint(error)) {
					throw new BizError('批量邮箱或取件 URL 配额已被并发请求占用，请重试', 409);
				}
				if (!isUniqueConstraint(error) || batchAttempt === 5) throw error;
			}
		}

		throw new BizError('随机邮箱创建冲突，请重试', 409);
	},

	async listTokens(c, userId) {
		const rows = await orm(c)
			.select({
				id: mailboxApiToken.tokenId,
				publicId: mailboxApiToken.publicId,
				accountId: mailboxApiToken.accountId,
				email: account.email,
				label: mailboxApiToken.label,
				createdAt: mailboxApiToken.createdAt,
				lastUsedAt: mailboxApiToken.lastUsedAt
			})
			.from(mailboxApiToken)
			.innerJoin(account, and(
				eq(account.accountId, mailboxApiToken.accountId),
				eq(account.userId, mailboxApiToken.userId),
				eq(account.isDel, isDel.NORMAL)
			))
			.where(and(
				eq(mailboxApiToken.userId, userId),
				isNull(mailboxApiToken.revokedAt)
			))
			.orderBy(desc(mailboxApiToken.tokenId))
			.all();

		return Promise.all(rows.map(row => this.toTokenRecord(c, row)));
	},

	async createToken(c, params, userId) {
		const accountId = Number(params?.accountId);
		const label = String(params?.label || '').trim();
		if (!Number.isSafeInteger(accountId) || accountId < 1) {
			throw new BizError('accountId 无效', 400);
		}
		if (label.length > 80 || /[\r\n]/.test(label)) {
			throw new BizError('label 最多 80 个字符且不能包含换行', 400);
		}

		const accountRow = await orm(c).select().from(account).where(and(
			eq(account.accountId, accountId),
			eq(account.userId, userId),
			eq(account.isDel, isDel.NORMAL)
		)).get();
		if (!accountRow) throw new BizError('邮箱不存在或不属于当前用户', 404);

		const [userTokenCount, accountTokenCount] = await Promise.all([
			orm(c).select({ total: count() }).from(mailboxApiToken).where(and(
				eq(mailboxApiToken.userId, userId),
				isNull(mailboxApiToken.revokedAt)
			)).get(),
			orm(c).select({ total: count() }).from(mailboxApiToken).where(and(
				eq(mailboxApiToken.userId, userId),
				eq(mailboxApiToken.accountId, accountId),
				isNull(mailboxApiToken.revokedAt)
			)).get()
		]);
		if (Number(userTokenCount.total) >= MAX_ACTIVE_TOKENS_PER_USER) {
			throw new BizError(`每个用户最多保留 ${MAX_ACTIVE_TOKENS_PER_USER} 个有效取件 URL`, 403);
		}
		if (Number(accountTokenCount.total) >= MAX_ACTIVE_TOKENS_PER_ACCOUNT) {
			throw new BizError(`每个邮箱最多保留 ${MAX_ACTIVE_TOKENS_PER_ACCOUNT} 个有效取件 URL`, 403);
		}

		let inserted;
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				inserted = await orm(c).insert(mailboxApiToken).values({
					publicId: crypto.randomUUID(),
					userId,
					accountId,
					label
				}).returning().get();
				break;
			} catch (error) {
				if (!isUniqueConstraint(error) || attempt === 3) throw error;
			}
		}

		return this.toTokenRecord(c, {
			id: inserted.tokenId,
			publicId: inserted.publicId,
			accountId: inserted.accountId,
			email: accountRow.email,
			label: inserted.label,
			createdAt: inserted.createdAt,
			lastUsedAt: inserted.lastUsedAt
		});
	},

	async revokeToken(c, tokenIdValue, userId) {
		const tokenId = Number(tokenIdValue);
		if (!Number.isSafeInteger(tokenId) || tokenId < 1) throw new BizError('tokenId 无效', 400);
		const revoked = await orm(c).update(mailboxApiToken)
			.set({ revokedAt: sql`CURRENT_TIMESTAMP` })
			.where(and(
				eq(mailboxApiToken.tokenId, tokenId),
				eq(mailboxApiToken.userId, userId),
				isNull(mailboxApiToken.revokedAt)
			))
			.returning({ id: mailboxApiToken.tokenId })
			.get();
		if (!revoked) throw new BizError('取件 URL 不存在或已撤销', 404);
	},

	async testToken(c, tokenIdValue, userId, params = {}) {
		const tokenId = Number(tokenIdValue);
		if (!Number.isSafeInteger(tokenId) || tokenId < 1) throw new BizError('tokenId 无效', 400);
		const tokenRow = await this.selectOwnedActiveToken(c, tokenId, userId);
		if (!tokenRow) throw new BizError('取件 URL 不存在或已撤销', 404);
		return this.retrieveForToken(c, tokenRow, normalizeAfterEmailId(params.afterEmailId));
	},

	async retrievePublic(c, credential, params = {}) {
		const publicId = await verifyPublicCredential(c, credential);
		if (!publicId) throw new BizError('取件 URL 无效或已撤销', 401);

		const tokenRow = await orm(c)
			.select({
				id: mailboxApiToken.tokenId,
				userId: mailboxApiToken.userId,
				accountId: mailboxApiToken.accountId,
				email: account.email
			})
			.from(mailboxApiToken)
			.innerJoin(account, and(
				eq(account.accountId, mailboxApiToken.accountId),
				eq(account.userId, mailboxApiToken.userId),
				eq(account.isDel, isDel.NORMAL)
			))
			.where(and(
				eq(mailboxApiToken.publicId, publicId),
				isNull(mailboxApiToken.revokedAt)
			))
			.get();
		if (!tokenRow) throw new BizError('取件 URL 无效或已撤销', 401);

		return this.retrieveForToken(c, tokenRow, normalizeAfterEmailId(params.afterEmailId));
	},

	async selectOwnedActiveToken(c, tokenId, userId) {
		return orm(c)
			.select({
				id: mailboxApiToken.tokenId,
				userId: mailboxApiToken.userId,
				accountId: mailboxApiToken.accountId,
				email: account.email
			})
			.from(mailboxApiToken)
			.innerJoin(account, and(
				eq(account.accountId, mailboxApiToken.accountId),
				eq(account.userId, mailboxApiToken.userId),
				eq(account.isDel, isDel.NORMAL)
			))
			.where(and(
				eq(mailboxApiToken.tokenId, tokenId),
				eq(mailboxApiToken.userId, userId),
				isNull(mailboxApiToken.revokedAt)
			))
			.get();
	},

	async retrieveForToken(c, tokenRow, afterEmailId) {
		const messages = await orm(c)
			.select({
				emailId: email.emailId,
				code: email.code,
				sendEmail: email.sendEmail,
				subject: email.subject,
				text: email.text,
				content: email.content,
				createTime: email.createTime
			})
			.from(email)
			.where(and(
				eq(email.accountId, tokenRow.accountId),
				eq(email.userId, tokenRow.userId),
				eq(email.type, emailConst.type.RECEIVE),
				eq(email.isDel, isDel.NORMAL),
				gt(email.emailId, afterEmailId)
			))
			.orderBy(desc(email.emailId))
			.limit(25)
			.all();

		// Retrieval URLs are commonly polled every few seconds. Keep useful
		// activity metadata without turning every read into a D1 write.
		await c.env.db
			.prepare(MAILBOX_LAST_USED_TOUCH_SQL)
			.bind(tokenRow.id)
			.run();

		let selected = null;
		let extracted = { code: '', source: null };
		for (const message of messages) {
			const candidate = extractVerificationCode(message);
			if (!candidate.code) continue;
			selected = message;
			extracted = candidate;
			break;
		}

		const newest = messages[0] || null;
		return {
			found: Boolean(extracted.code),
			email: tokenRow.email,
			accountId: tokenRow.accountId,
			code: extracted.code || null,
			emailId: selected?.emailId || null,
			latestEmailId: newest?.emailId || afterEmailId,
			from: selected?.sendEmail || null,
			subject: selected?.subject || null,
			receivedAt: selected?.createTime || null,
			source: extracted.source
		};
	},

	async toTokenRecord(c, row) {
		const signature = await signPublicId(c, row.publicId);
		const token = `${row.publicId}.${signature}`;
		return {
			id: row.id,
			token,
			accountId: row.accountId,
			email: row.email,
			label: row.label || '',
			codeUrl: `${retrievalOrigin(c)}/api/mailbox-tools/code/${token}`,
			createdAt: row.createdAt,
			lastUsedAt: row.lastUsedAt || null
		};
	}
};

export default mailboxToolsService;
