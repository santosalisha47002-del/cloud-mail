import { and, asc, count, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
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
const DEFAULT_RETRIEVAL_LIMIT = 20;
const MAX_RETRIEVAL_LIMIT = 50;
const DEFAULT_MAILBOX_PAGE_SIZE = 20;
const MAX_MAILBOX_PAGE_SIZE = 100;
const MAX_MAILBOX_PAGE = 1000000;
const MAX_MAILBOX_SEARCH_LENGTH = 128;
const MAX_ENSURE_TOKEN_ACCOUNTS = 100;
const AUTO_TOKEN_LABEL = 'batch-created';
const MANAGED_TOKEN_LABEL = 'mailbox-management';
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
			FROM mailbox_api_token token
			INNER JOIN account owned
				ON owned.account_id = token.account_id
				AND owned.user_id = token.user_id
				AND owned.is_del = ?
			WHERE token.user_id = ? AND token.revoked_at IS NULL
		`)
		.bind(isDel.NORMAL, userId)
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

function rowsFromD1(result) {
	if (Array.isArray(result)) return result;
	return Array.isArray(result?.results) ? result.results : [];
}

function normalizePositiveInteger(value, fallback, maximum, label) {
	if (value === undefined || value === null || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new BizError(`${label} 必须是 1-${maximum} 的整数`, 400);
	}
	return parsed;
}

/**
 * Normalize the authenticated mailbox-management list query. Keeping this
 * strict prevents very large offsets and accidental wildcard-style searches
 * from turning a management page into an unbounded D1 scan.
 */
export function normalizeMailboxListOptions(params = {}) {
	const keyword = String(params.keyword || '').trim().toLowerCase();
	if (keyword.length > MAX_MAILBOX_SEARCH_LENGTH) {
		throw new BizError(`keyword 最多 ${MAX_MAILBOX_SEARCH_LENGTH} 个字符`, 400);
	}

	const domain = normalizeDomain(params.domain);
	if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
		throw new BizError('domain 格式无效', 400);
	}

	const tokenStatus = String(params.tokenStatus || 'all').trim().toLowerCase();
	if (!['all', 'active', 'missing'].includes(tokenStatus)) {
		throw new BizError('tokenStatus 必须是 all、active 或 missing', 400);
	}

	return {
		page: normalizePositiveInteger(params.page, 1, MAX_MAILBOX_PAGE, 'page'),
		pageSize: normalizePositiveInteger(params.pageSize, DEFAULT_MAILBOX_PAGE_SIZE, MAX_MAILBOX_PAGE_SIZE, 'pageSize'),
		keyword,
		domain,
		tokenStatus
	};
}

export function normalizeEnsureTokenAccountIds(params = {}) {
	if (!Array.isArray(params.accountIds) || params.accountIds.length === 0) {
		throw new BizError('accountIds 必须是非空数组', 400);
	}
	if (params.accountIds.length > MAX_ENSURE_TOKEN_ACCOUNTS) {
		throw new BizError(`单次最多处理 ${MAX_ENSURE_TOKEN_ACCOUNTS} 个邮箱`, 400);
	}

	const accountIds = [];
	const seen = new Set();
	for (const value of params.accountIds) {
		const accountId = Number(value);
		if (!Number.isSafeInteger(accountId) || accountId < 1) {
			throw new BizError('accountIds 只能包含正整数', 400);
		}
		if (seen.has(accountId)) continue;
		seen.add(accountId);
		accountIds.push(accountId);
	}
	return accountIds;
}

function mailboxFilterSql(options, userId) {
	const conditions = ['a.user_id = ?', 'a.is_del = ?'];
	const bindings = [userId, isDel.NORMAL];
	if (options.keyword) {
		conditions.push('(instr(lower(a.email), ?) > 0 OR instr(lower(a.name), ?) > 0 OR instr(CAST(a.account_id AS TEXT), ?) > 0)');
		bindings.push(options.keyword, options.keyword, options.keyword);
	}
	if (options.domain) {
		conditions.push("lower(substr(a.email, instr(a.email, '@') + 1)) = ?");
		bindings.push(options.domain);
	}
	if (options.tokenStatus === 'active') {
		conditions.push(`EXISTS (
			SELECT 1 FROM mailbox_api_token active_token
			WHERE active_token.user_id = a.user_id
				AND active_token.account_id = a.account_id
				AND active_token.revoked_at IS NULL
		)`);
	} else if (options.tokenStatus === 'missing') {
		conditions.push(`NOT EXISTS (
			SELECT 1 FROM mailbox_api_token active_token
			WHERE active_token.user_id = a.user_id
				AND active_token.account_id = a.account_id
				AND active_token.revoked_at IS NULL
		)`);
	}
	return { sql: conditions.join('\n AND '), bindings };
}

function normalizeAfterEmailId(value) {
	if (value === undefined || value === null || value === '') return 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new BizError('afterEmailId 必须是非负整数', 400);
	}
	return parsed;
}

function normalizeBeforeEmailId(value) {
	if (value === undefined || value === null || value === '') return 0;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new BizError('beforeEmailId 必须是正整数', 400);
	}
	return parsed;
}

function normalizeRetrievalLimit(value) {
	if (value === undefined || value === null || value === '') return DEFAULT_RETRIEVAL_LIMIT;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RETRIEVAL_LIMIT) {
		throw new BizError(`limit 必须是 1-${MAX_RETRIEVAL_LIMIT} 的整数`, 400);
	}
	return parsed;
}

export function normalizeRetrievalOptions(params = {}) {
	const afterProvided = params.afterEmailId !== undefined && params.afterEmailId !== null && params.afterEmailId !== '';
	const beforeProvided = params.beforeEmailId !== undefined && params.beforeEmailId !== null && params.beforeEmailId !== '';
	if (afterProvided && beforeProvided) {
		throw new BizError('afterEmailId 与 beforeEmailId 不能同时使用', 400);
	}
	return {
		afterEmailId: normalizeAfterEmailId(params.afterEmailId),
		beforeEmailId: normalizeBeforeEmailId(params.beforeEmailId),
		limit: normalizeRetrievalLimit(params.limit),
		// `afterEmailId` is a queue read (oldest unseen first); `beforeEmailId`
		// and cursor-less calls are latest/history reads (newest first).
		mode: afterProvided ? 'after' : (beforeProvided ? 'before' : 'latest')
	};
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

	// Do not treat a numeric run embedded in a UUID, message ID or another
	// alphanumeric identifier as an OTP. This used to turn values such as
	// `aaf1a61f176debd019925001747b0723` into a false verification code.
	const numeric = searchable.match(/(?:^|[^A-Z0-9])(\d{4,8})(?![A-Z0-9])/iu);
	return numeric ? { code: numeric[1], source: 'parsed' } : { code: '', source: null };
}

function toRetrievedMessage(message, tokenRow) {
	const extracted = extractVerificationCode(message);
	const verificationCode = extracted.code || null;
	return {
		found: Boolean(verificationCode),
		email: tokenRow.email,
		accountId: tokenRow.accountId,
		code: verificationCode,
		verificationCode,
		emailId: message.emailId,
		from: message.sendEmail || null,
		subject: message.subject || null,
		receivedAt: message.createTime || null,
		source: extracted.source
	};
}

function safePlainText(value) {
	if (!value) return '';
	try {
		return String(emailUtils.htmlToText(String(value)) || '')
			.replace(/\s+/g, ' ')
			.trim();
	} catch (_) {
		return String(value || '').replace(/\s+/g, ' ').trim();
	}
}

/**
 * Authenticated management response. Do not expose raw HTML: a mailbox can
 * contain arbitrary sender-controlled markup and the management UI should
 * render this as text. `text` is bounded while `preview` is deliberately
 * short, enough for a list/drawer without making a single response enormous.
 */
function toManagedMailboxMessage(message, mailbox) {
	const extracted = extractVerificationCode(message);
	const plainText = String(message.text || '').slice(0, 20000);
	const preview = safePlainText(message.text || message.content).slice(0, 500);
	const verificationCode = extracted.code || null;
	return {
		emailId: Number(message.emailId),
		accountId: mailbox.accountId,
		email: mailbox.email,
		from: message.sendEmail || null,
		sendEmail: message.sendEmail || null,
		fromName: message.name || null,
		subject: message.subject || null,
		text: plainText || null,
		preview: preview || null,
		verificationCode,
		code: verificationCode,
		source: extracted.source,
		receivedAt: message.createTime || null,
		createTime: message.createTime || null,
		unread: Number(message.unread || 0),
		status: Number(message.status || 0),
		toEmail: message.toEmail || null,
		toName: message.toName || null,
		messageId: message.messageId || null
	};
}

/**
 * Keep the original single-message fields for existing clients while also
 * returning every fetched message. `messages` is the queue clients should
 * process before advancing to `nextAfterEmailId`.
 */
export function buildRetrievalResult(messages, tokenRow, options = {}) {
	const {
		afterEmailId = 0,
		beforeEmailId = 0,
		hasMore = false,
		mode = 'latest'
	} = options;
	const queueMode = mode === 'after';
	const items = messages.map(message => toRetrievedMessage(message, tokenRow));
	const newest = items.reduce((current, item) => (
		!current || Number(item.emailId) > Number(current.emailId) ? item : current
	), null);
	const oldest = items.reduce((current, item) => (
		!current || Number(item.emailId) < Number(current.emailId) ? item : current
	), null);
	const matched = items.filter(item => item.found);
	const selected = queueMode
		? (matched[0] || null)
		: matched.reduce((current, item) => (
			!current || Number(item.emailId) > Number(current.emailId) ? item : current
		), null);
	// `nextAfterEmailId` is the batch cursor for array-aware consumers. Keep
	// `latestEmailId` on the selected code in queue mode so older single-code
	// clients can continue one message at a time without skipping later codes.
	const nextAfterEmailId = newest?.emailId || afterEmailId;
	const nextBeforeEmailId = oldest?.emailId || beforeEmailId;
	const legacyCursor = (queueMode ? selected?.emailId : nextAfterEmailId)
		|| nextAfterEmailId;

	return {
		found: Boolean(selected),
		email: tokenRow.email,
		accountId: tokenRow.accountId,
		code: selected?.code || null,
		emailId: selected?.emailId || null,
		latestEmailId: legacyCursor,
		nextAfterEmailId,
		nextBeforeEmailId,
		codeCursor: legacyCursor,
		from: selected?.from || null,
		subject: selected?.subject || null,
		receivedAt: selected?.receivedAt || null,
		source: selected?.source || null,
		count: items.length,
		hasMore: Boolean(hasMore),
		hasOlder: mode !== 'after' && Boolean(hasMore),
		hasNewer: mode === 'after' && Boolean(hasMore),
		messages: items
	};
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

	/**
	 * One owner-scoped, paginated source of truth for the mailbox-management
	 * screen. Active credentials are joined in a second bounded query so the
	 * response never exposes another user's token and does not multiply account
	 * rows when an account has replacement credentials.
	 */
	async listMailboxes(c, params, userId) {
		const options = normalizeMailboxListOptions(params);
		const filter = mailboxFilterSql(options, userId);
		const offset = (options.page - 1) * options.pageSize;
		const countStatement = c.env.db.prepare(`
			SELECT COUNT(*) AS total
			FROM account a
			WHERE ${filter.sql}
		`).bind(...filter.bindings);
		const listStatement = c.env.db.prepare(`
			SELECT
				a.account_id AS accountId,
				a.email,
				a.name,
				a.status,
				a.create_time AS createdAt,
				a.all_receive AS allReceive,
				a.sort,
				(
					SELECT COUNT(*) FROM mailbox_api_token token_count
					WHERE token_count.user_id = a.user_id
						AND token_count.account_id = a.account_id
						AND token_count.revoked_at IS NULL
				) AS tokenCount,
				(
					SELECT COUNT(*) FROM email message_count
					WHERE message_count.user_id = a.user_id
						AND message_count.account_id = a.account_id
						AND message_count.type = ?
						AND message_count.is_del = ?
				) AS messageCount,
				(
					SELECT COUNT(*) FROM email unread_count
					WHERE unread_count.user_id = a.user_id
						AND unread_count.account_id = a.account_id
						AND unread_count.type = ?
						AND unread_count.is_del = ?
						AND unread_count.unread = ?
				) AS unreadCount,
				(
					SELECT MAX(latest_message.email_id) FROM email latest_message
					WHERE latest_message.user_id = a.user_id
						AND latest_message.account_id = a.account_id
						AND latest_message.type = ?
						AND latest_message.is_del = ?
				) AS latestEmailId,
				(
					SELECT latest_time.create_time FROM email latest_time
					WHERE latest_time.user_id = a.user_id
						AND latest_time.account_id = a.account_id
						AND latest_time.type = ?
						AND latest_time.is_del = ?
					ORDER BY latest_time.email_id DESC
					LIMIT 1
				) AS latestEmailTime
			FROM account a
			WHERE ${filter.sql}
			ORDER BY a.account_id DESC
			LIMIT ? OFFSET ?
		`).bind(
			emailConst.type.RECEIVE,
			isDel.NORMAL,
			emailConst.type.RECEIVE,
			isDel.NORMAL,
			emailConst.unread.UNREAD,
			emailConst.type.RECEIVE,
			isDel.NORMAL,
			emailConst.type.RECEIVE,
			isDel.NORMAL,
			...filter.bindings,
			options.pageSize,
			offset
		);
		const statsStatement = c.env.db.prepare(`
			SELECT
				COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN EXISTS (
					SELECT 1 FROM mailbox_api_token stats_token
					WHERE stats_token.user_id = a.user_id
						AND stats_token.account_id = a.account_id
						AND stats_token.revoked_at IS NULL
				) THEN 1 ELSE 0 END), 0) AS withApi,
				(
					SELECT COUNT(*) FROM email stats_message
					WHERE stats_message.user_id = ?
						AND stats_message.type = ?
						AND stats_message.is_del = ?
						AND EXISTS (
							SELECT 1 FROM account stats_account
							WHERE stats_account.account_id = stats_message.account_id
								AND stats_account.user_id = ?
								AND stats_account.is_del = ?
						)
				) AS totalMessages
			FROM account a
			WHERE a.user_id = ? AND a.is_del = ?
		`).bind(
			userId,
			emailConst.type.RECEIVE,
			isDel.NORMAL,
			userId,
			isDel.NORMAL,
			userId,
			isDel.NORMAL
		);

		const [countResult, listResult, statsResult] = await Promise.all([
			countStatement.first(),
			listStatement.all(),
			statsStatement.first()
		]);
		const total = Number(countResult?.total || 0);
		const accountRows = rowsFromD1(listResult).map(row => ({
			...row,
			accountId: Number(row.accountId),
			status: Number(row.status || 0),
			allReceive: Number(row.allReceive || 0),
			sort: Number(row.sort || 0),
			tokenCount: Number(row.tokenCount || 0),
			messageCount: Number(row.messageCount || 0),
			unreadCount: Number(row.unreadCount || 0),
			latestEmailId: row.latestEmailId == null ? null : Number(row.latestEmailId)
		}));

		const tokensByAccountId = new Map();
		if (accountRows.length) {
			const placeholders = accountRows.map(() => '?').join(', ');
			const tokenResult = await c.env.db.prepare(`
				SELECT
					t.token_id AS id,
					t.public_id AS publicId,
					t.account_id AS accountId,
					a.email,
					t.label,
					t.created_at AS createdAt,
					t.last_used_at AS lastUsedAt
				FROM mailbox_api_token t
				INNER JOIN account a
					ON a.account_id = t.account_id
					AND a.user_id = t.user_id
					AND a.is_del = ?
				WHERE t.user_id = ?
					AND t.revoked_at IS NULL
					AND t.account_id IN (${placeholders})
					AND NOT EXISTS (
						SELECT 1 FROM mailbox_api_token newer_token
						WHERE newer_token.user_id = t.user_id
							AND newer_token.account_id = t.account_id
							AND newer_token.revoked_at IS NULL
							AND newer_token.token_id > t.token_id
					)
				ORDER BY t.token_id DESC
			`).bind(isDel.NORMAL, userId, ...accountRows.map(row => row.accountId)).all();
			const tokenRecords = await Promise.all(rowsFromD1(tokenResult).map(row => this.toTokenRecord(c, row)));
			for (const tokenRecord of tokenRecords) {
				const accountTokens = tokensByAccountId.get(tokenRecord.accountId) || [];
				accountTokens.push(tokenRecord);
				tokensByAccountId.set(tokenRecord.accountId, accountTokens);
			}
		}

		const list = accountRows.map(row => {
			const tokens = tokensByAccountId.get(row.accountId) || [];
			const primaryToken = tokens[0] || null;
			return {
				...row,
				hasToken: row.tokenCount > 0,
				tokens,
				primaryToken,
				codeUrl: primaryToken?.codeUrl || null
			};
		});
		const statsTotal = Number(statsResult?.total || 0);
		const withApi = Number(statsResult?.withApi || 0);

		return {
			list,
			total,
			page: options.page,
			pageSize: options.pageSize,
			pageCount: total ? Math.ceil(total / options.pageSize) : 0,
			stats: {
				total: statsTotal,
				withApi,
				withoutApi: Math.max(0, statsTotal - withApi),
				totalMessages: Number(statsResult?.totalMessages || 0)
			},
			domains: asDomainList(c.env.domain).map(normalizeDomain).filter(Boolean)
		};
	},

	/**
	 * Idempotently create one default retrieval credential for every requested
	 * owned mailbox that currently has none. The D1 batch contains a live quota
	 * guard and the INSERT re-checks ownership/token existence in the same
	 * transaction, so retries and concurrent clicks cannot create duplicates.
	 */
	async ensureMailboxTokens(c, params, userId) {
		const accountIds = normalizeEnsureTokenAccountIds(params);
		const placeholders = accountIds.map(() => '?').join(', ');
		const ownedResult = await c.env.db.prepare(`
			SELECT account_id AS accountId, email
			FROM account
			WHERE user_id = ? AND is_del = ? AND account_id IN (${placeholders})
		`).bind(userId, isDel.NORMAL, ...accountIds).all();
		const ownedRows = rowsFromD1(ownedResult).map(row => ({
			accountId: Number(row.accountId),
			email: row.email
		}));
		if (ownedRows.length !== accountIds.length) {
			throw new BizError('一个或多个邮箱不存在或不属于当前用户', 404);
		}

		let activeRows = await this.selectActiveTokensForAccounts(c, userId, accountIds);
		const existingAccountIds = new Set(activeRows.map(row => Number(row.accountId)));
		const missingRows = ownedRows.filter(row => !existingAccountIds.has(row.accountId));
		if (missingRows.length) {
			const activeCount = await countActiveUserTokens(c, userId);
			if (activeCount + missingRows.length > MAX_ACTIVE_TOKENS_PER_USER) {
				throw new BizError(`每个用户最多保留 ${MAX_ACTIVE_TOKENS_PER_USER} 个有效取件 URL`, 403);
			}

			const candidates = missingRows.map(row => ({
				...row,
				publicId: crypto.randomUUID()
			}));
			const guardValues = candidates.map(() => '(?)').join(', ');
			const insertValues = candidates.map(() => '(?, ?)').join(', ');
			const guard = c.env.db.prepare(`
				WITH candidates(account_id) AS (VALUES ${guardValues})
				INSERT INTO mailbox_api_token (public_id, user_id, account_id, label)
				SELECT NULL, ?, 0, ?
				WHERE (
					SELECT COUNT(*)
					FROM mailbox_api_token quota_token
					INNER JOIN account quota_account
						ON quota_account.account_id = quota_token.account_id
						AND quota_account.user_id = quota_token.user_id
						AND quota_account.is_del = ?
					WHERE quota_token.user_id = ? AND quota_token.revoked_at IS NULL
				) + (
					SELECT COUNT(*)
					FROM candidates candidate
					INNER JOIN account owned
						ON owned.account_id = candidate.account_id
						AND owned.user_id = ?
						AND owned.is_del = ?
					WHERE NOT EXISTS (
						SELECT 1 FROM mailbox_api_token active
						WHERE active.user_id = ?
							AND active.account_id = candidate.account_id
							AND active.revoked_at IS NULL
					)
				) > ?
			`).bind(
				...candidates.map(row => row.accountId),
				userId,
				MANAGED_TOKEN_LABEL,
				isDel.NORMAL,
				userId,
				userId,
				isDel.NORMAL,
				userId,
				MAX_ACTIVE_TOKENS_PER_USER
			);
			const insert = c.env.db.prepare(`
				WITH candidates(account_id, public_id) AS (VALUES ${insertValues})
				INSERT INTO mailbox_api_token (public_id, user_id, account_id, label)
				SELECT candidate.public_id, ?, candidate.account_id, ?
				FROM candidates candidate
				INNER JOIN account owned
					ON owned.account_id = candidate.account_id
					AND owned.user_id = ?
					AND owned.is_del = ?
				WHERE NOT EXISTS (
					SELECT 1 FROM mailbox_api_token active
					WHERE active.user_id = ?
						AND active.account_id = candidate.account_id
						AND active.revoked_at IS NULL
				)
				RETURNING
					token_id AS id,
					public_id AS publicId,
					account_id AS accountId,
					label,
					created_at AS createdAt,
					last_used_at AS lastUsedAt
			`).bind(
				...candidates.flatMap(row => [row.accountId, row.publicId]),
				userId,
				MANAGED_TOKEN_LABEL,
				userId,
				isDel.NORMAL,
				userId
			);

			try {
				await c.env.db.batch([guard, insert]);
			} catch (error) {
				if (/not null constraint failed:\s*mailbox_api_token\.public_id|sqlite_constraint_notnull/i.test(error?.message || '')) {
					throw new BizError('取件 URL 配额已被并发请求占用，请重试', 409);
				}
				throw error;
			}
			activeRows = await this.selectActiveTokensForAccounts(c, userId, accountIds);
		}

		const ownedById = new Map(ownedRows.map(row => [row.accountId, row]));
		const primaryByAccountId = new Map();
		for (const row of activeRows) {
			const accountId = Number(row.accountId);
			if (!primaryByAccountId.has(accountId)) primaryByAccountId.set(accountId, row);
		}
		const initialExistingIds = existingAccountIds;
		const list = await Promise.all(accountIds.map(async accountId => {
			const row = primaryByAccountId.get(accountId);
			if (!row) throw new BizError('取件 URL 创建未完成，请重试', 409);
			const token = await this.toTokenRecord(c, {
				...row,
				email: ownedById.get(accountId).email
			});
			return {
				...token,
				created: !initialExistingIds.has(accountId)
			};
		}));
		const createdCount = list.filter(item => item.created).length;
		return {
			requestedCount: accountIds.length,
			createdCount,
			existingCount: accountIds.length - createdCount,
			list
		};
	},

	async selectActiveTokensForAccounts(c, userId, accountIds) {
		if (!accountIds.length) return [];
		const placeholders = accountIds.map(() => '?').join(', ');
		const result = await c.env.db.prepare(`
			SELECT
				token_id AS id,
				public_id AS publicId,
				account_id AS accountId,
				label,
				created_at AS createdAt,
				last_used_at AS lastUsedAt
			FROM mailbox_api_token
			WHERE user_id = ? AND revoked_at IS NULL
				AND account_id IN (${placeholders})
			ORDER BY token_id DESC
		`).bind(userId, ...accountIds).all();
		return rowsFromD1(result).map(row => ({
			...row,
			id: Number(row.id),
			accountId: Number(row.accountId)
		}));
	},

	/**
	 * Return one owned mailbox's received mail as plain, bounded management
	 * records. This endpoint intentionally does not depend on a retrieval token,
	 * so mailboxes whose API has not been created can still be inspected.
	 */
	async managedMailboxMessages(c, accountIdValue, params, userId) {
		const accountId = Number(accountIdValue);
		if (!Number.isSafeInteger(accountId) || accountId < 1) {
			throw new BizError('accountId 无效', 400);
		}
		const options = normalizeRetrievalOptions(params);
		const mailbox = await c.env.db.prepare(`
			SELECT account_id AS accountId, email, name
			FROM account
			WHERE account_id = ? AND user_id = ? AND is_del = ?
		`).bind(accountId, userId, isDel.NORMAL).first();
		if (!mailbox) throw new BizError('邮箱不存在或不属于当前用户', 404);

		const cursorSql = options.mode === 'before'
			? 'AND email_id < ?'
			: options.mode === 'after'
				? 'AND email_id > ?'
				: '';
		const cursorBindings = options.mode === 'before'
			? [options.beforeEmailId]
			: options.mode === 'after'
				? [options.afterEmailId]
				: [];
		const order = options.mode === 'after' ? 'ASC' : 'DESC';
		const result = await c.env.db.prepare(`
			SELECT
				email_id AS emailId,
				send_email AS sendEmail,
				name,
				subject,
				code,
				text,
				content,
				unread,
				status,
				to_email AS toEmail,
				to_name AS toName,
				message_id AS messageId,
				create_time AS createTime
			FROM email
			WHERE user_id = ?
				AND account_id = ?
				AND type = ?
				AND is_del = ?
				${cursorSql}
			ORDER BY email_id ${order}
			LIMIT ?
		`).bind(
			userId,
			accountId,
			emailConst.type.RECEIVE,
			isDel.NORMAL,
			...cursorBindings,
			options.limit + 1
		).all();
		const fetched = rowsFromD1(result);
		const hasMore = fetched.length > options.limit;
		const pageRows = hasMore ? fetched.slice(0, options.limit) : fetched;
		const mailboxRecord = {
			accountId: Number(mailbox.accountId),
			email: mailbox.email,
			name: mailbox.name || ''
		};
		const messages = pageRows.map(message => toManagedMailboxMessage(message, mailboxRecord));
		const ids = messages.map(message => Number(message.emailId)).filter(Number.isSafeInteger);
		const newestId = ids.length ? Math.max(...ids) : (options.afterEmailId || 0);
		const oldestId = ids.length ? Math.min(...ids) : (options.beforeEmailId || 0);

		return {
			mailbox: mailboxRecord,
			messages,
			list: messages,
			count: messages.length,
			hasMore,
			hasOlder: options.mode === 'after' ? Boolean(options.afterEmailId) : hasMore,
			hasNewer: options.mode === 'before' ? Boolean(options.beforeEmailId) : (options.mode === 'after' && hasMore),
			nextBeforeEmailId: oldestId,
			nextAfterEmailId: newestId
		};
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
			countActiveUserTokens(c, userId),
			orm(c).select({ total: count() }).from(mailboxApiToken).where(and(
				eq(mailboxApiToken.userId, userId),
				eq(mailboxApiToken.accountId, accountId),
				isNull(mailboxApiToken.revokedAt)
			)).get()
		]);
		if (Number(userTokenCount) >= MAX_ACTIVE_TOKENS_PER_USER) {
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
		return this.retrieveForToken(c, tokenRow, normalizeRetrievalOptions(params));
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

		return this.retrieveForToken(c, tokenRow, normalizeRetrievalOptions(params));
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

	async retrieveForToken(c, tokenRow, options = {}) {
		const {
			afterEmailId = 0,
			beforeEmailId = 0,
			limit = DEFAULT_RETRIEVAL_LIMIT,
			mode = 'latest'
		} = options;
		const ascending = mode === 'after';
		const cursorCondition = mode === 'before'
			? lt(email.emailId, beforeEmailId)
			: gt(email.emailId, afterEmailId);
		const fetchedMessages = await orm(c)
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
				cursorCondition
			))
			.orderBy(ascending ? asc(email.emailId) : desc(email.emailId))
			.limit(limit + 1)
			.all();
		const hasMore = fetchedMessages.length > limit;
		const messages = hasMore ? fetchedMessages.slice(0, limit) : fetchedMessages;

		// Retrieval URLs are commonly polled every few seconds. Keep useful
		// activity metadata without turning every read into a D1 write.
		await c.env.db
			.prepare(MAILBOX_LAST_USED_TOUCH_SQL)
			.bind(tokenRow.id)
			.run();

		return buildRetrievalResult(messages, tokenRow, {
			afterEmailId,
			beforeEmailId,
			hasMore,
			mode
		});
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
