import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import mailboxToolsService from '../service/mailbox-tools-service';
import { ensureMailboxToolsSchema } from '../init/mailbox-tools-schema';

app.use('/mailbox-tools/*', async (c, next) => {
	await ensureMailboxToolsSchema(c);
	return next();
});

app.post('/mailbox-tools/batch-create', async c => {
	const data = await mailboxToolsService.batchCreate(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/mailbox-tools/tokens', async c => {
	const data = await mailboxToolsService.listTokens(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/mailbox-tools/tokens', async c => {
	const data = await mailboxToolsService.createToken(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.delete('/mailbox-tools/tokens/:tokenId', async c => {
	await mailboxToolsService.revokeToken(c, c.req.param('tokenId'), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/mailbox-tools/tokens/:tokenId/test', async c => {
	const data = await mailboxToolsService.testToken(c, c.req.param('tokenId'), userContext.getUserId(c), c.req.query());
	return c.json(result.ok(toPublicCodeResult(data)));
});

app.get('/mailbox-tools/code/:credential', async c => {
	c.header('Cache-Control', 'no-store, max-age=0');
	c.header('Pragma', 'no-cache');
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('Referrer-Policy', 'no-referrer');

	try {
		const data = await mailboxToolsService.retrievePublic(c, c.req.param('credential'), c.req.query());
		const publicData = toPublicCodeResult(data);
		if (shouldRenderPublicMailboxHtml(
			c.req.header('Accept'),
			c.req.query('format'),
			c.req.header('Sec-Fetch-Mode'),
			c.req.header('Sec-Fetch-Dest')
		)) {
			return htmlResponse(renderPublicMailboxHtml(publicData, canonicalPublicRequestUrl(c.req.url)));
		}
		return c.json(result.ok(publicData));
	} catch (error) {
		if (error?.name !== 'BizError') throw error;
		const status = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599 ? error.code : 500;
		if (shouldRenderPublicMailboxHtml(
			c.req.header('Accept'),
			c.req.query('format'),
			c.req.header('Sec-Fetch-Mode'),
			c.req.header('Sec-Fetch-Dest')
		)) {
			return htmlResponse(renderPublicMailboxErrorHtml(error.message, status, canonicalPublicRequestUrl(c.req.url)), status);
		}
		return c.json(result.fail(error.message, status), status);
	}
});

const HTML_ESCAPE_MAP = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPE_MAP[character]);
}

function htmlResponse(body, status = 200) {
	return new Response(body, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=UTF-8',
			'Cache-Control': 'no-store, max-age=0',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer'
		}
	});
}

export function canonicalPublicRequestUrl(requestUrl) {
	try {
		const url = new URL(requestUrl);
		// index.js strips `/api` before dispatching to Hono. Put it back in
		// links rendered for humans so copy/JSON buttons remain callable.
		if (!url.pathname.startsWith('/api/')) url.pathname = `/api${url.pathname}`;
		return url.toString();
	} catch (_) {
		return requestUrl;
	}
}

/**
 * Browser navigation sends `text/html`, while API clients normally send
 * `application/json` or a wildcard Accept value. Keep JSON as the default for clients and make
 * the human-readable page opt-in either through Accept or `?format=html`.
 */
export function shouldRenderPublicMailboxHtml(accept = '', format = '', fetchMode = '', fetchDest = '') {
	const requested = String(format || '').trim().toLowerCase();
	if (requested === 'json') return false;
	if (requested === 'html') return true;
	return /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/iu.test(String(accept || ''))
		|| String(fetchMode || '').toLowerCase() === 'navigate'
		|| String(fetchDest || '').toLowerCase() === 'document';
}

function formatHtmlMessageTime(value) {
	return value ? String(value) : '—';
}

function copyButton(value, label) {
	if (!value) return '';
	return `<button class="copy-button" type="button" data-copy="${escapeHtml(value)}" onclick="copyValue(this)">${escapeHtml(label)}</button>`;
}

function publicJsonUrl(requestUrl) {
	try {
		const url = new URL(requestUrl);
		url.searchParams.set('format', 'json');
		return url.toString();
	} catch (_) {
		return `${requestUrl}${String(requestUrl).includes('?') ? '&' : '?'}format=json`;
	}
}

export function renderPublicMailboxHtml(data = {}, requestUrl = '') {
	const messages = Array.isArray(data.messages) ? data.messages : [];
	const email = data.email || messages.find(message => message.email)?.email || '';
	const retrievalUrl = requestUrl || '';
	const jsonUrl = publicJsonUrl(retrievalUrl);
	const code = data.verificationCode || data.code || '';
	const messageCards = messages.map((message, index) => {
		const messageCode = message.verificationCode || message.code || '';
		const subject = message.subject || '无主题';
		const sender = message.from || '未知发件人';
		return `<article class="message-card">
  <div class="message-topline"><span class="message-number">#${index + 1}</span><span class="message-id">邮件 ID ${escapeHtml(message.emailId || '—')}</span></div>
  <div class="message-subject">${escapeHtml(subject)}</div>
  <div class="message-meta"><span>发件人：${escapeHtml(sender)}</span><span>时间：${escapeHtml(formatHtmlMessageTime(message.receivedAt))}</span></div>
  <div class="message-code-row">${messageCode
			? `<strong class="message-code">${escapeHtml(messageCode)}</strong>${copyButton(messageCode, '复制验证码')}`
			: '<span class="no-code">未识别到验证码</span>'}</div>
</article>`;
	}).join('\n');

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>邮件取件 · ${escapeHtml(email || 'Cloud Mail')}</title>
<style>
:root{color-scheme:light;--blue:#1769d3;--ink:#17253a;--muted:#6b7a90;--line:#dfe7f1;--panel:#fff;--soft:#f4f8fc;--green:#138a56}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#edf5ff,#f8fbff 52%,#eef8f3);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.shell{width:min(860px,calc(100% - 28px));margin:30px auto 48px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:0 16px 44px rgba(35,73,120,.1);overflow:hidden}.header{padding:24px 26px;background:linear-gradient(125deg,#0b5ec4,#36a2f3);color:#fff}.eyebrow{font-size:11px;letter-spacing:.15em;font-weight:700;opacity:.78}.header h1{margin:5px 0 4px;font-size:25px}.mailbox{font-size:14px;opacity:.9}.toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:16px 26px;border-bottom:1px solid var(--line);background:#fbfdff}.button,.copy-button{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:6px 12px;border:1px solid #c8d7e8;border-radius:8px;background:#fff;color:var(--blue);cursor:pointer;font:inherit;text-decoration:none}.button.primary,.copy-button{border-color:var(--blue);background:var(--blue);color:#fff}.button:hover,.copy-button:hover{filter:brightness(.96)}.summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 26px 8px}.summary-label{color:var(--muted);font-size:13px}.summary-code{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.summary-code strong{font:700 28px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;color:var(--green)}.empty{margin:12px 26px 24px;padding:18px;border:1px dashed #cbd8e6;border-radius:10px;color:var(--muted);background:var(--soft)}.messages{display:grid;gap:10px;padding:12px 26px 26px}.message-card{padding:15px 16px;border:1px solid var(--line);border-radius:12px;background:#fff}.message-topline,.message-meta,.message-code-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.message-topline{color:var(--muted);font-size:12px}.message-number{color:var(--blue);font-weight:700}.message-id{margin-left:auto}.message-subject{margin-top:8px;font-size:15px;font-weight:650;word-break:break-word}.message-meta{margin-top:6px;color:var(--muted);font-size:12px}.message-code-row{margin-top:12px}.message-code{color:var(--green);font:700 20px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em}.no-code{color:var(--muted);font-size:13px}.footer{padding:14px 26px 20px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}.error{padding:26px;color:#b42318}.toast{position:fixed;right:18px;bottom:18px;padding:10px 14px;border-radius:8px;background:#17253a;color:#fff;opacity:0;transform:translateY(8px);transition:.2s}.toast.show{opacity:1;transform:translateY(0)}@media(max-width:560px){.shell{width:calc(100% - 16px);margin:8px auto 24px}.header,.toolbar,.summary,.messages,.footer{padding-left:16px;padding-right:16px}.summary{align-items:flex-start;flex-direction:column}.message-id{margin-left:0}}
</style>
</head>
<body><main class="shell"><section class="panel">
<header class="header"><div class="eyebrow">CLOUD MAIL · MAILBOX RETRIEVAL</div><h1>邮件取件</h1><div class="mailbox">${escapeHtml(email || '未知邮箱')}</div></header>
<nav class="toolbar" aria-label="操作">${copyButton(retrievalUrl, '复制取件 URL')}<a class="button" href="${escapeHtml(jsonUrl)}">查看 JSON</a><button class="button" type="button" onclick="location.reload()">刷新邮件</button></nav>
<section class="summary"><div><div class="summary-label">本次读取 ${escapeHtml(data.count ?? messages.length)} 封邮件</div><div class="summary-label">${data.hasMore ? '还有更多邮件可继续翻页' : '当前批次已读取完毕'}</div></div>${code ? `<div class="summary-code"><strong>${escapeHtml(code)}</strong>${copyButton(code, '复制验证码')}</div>` : '<span class="no-code">当前批次未识别到验证码</span>'}</section>
${messageCards ? `<section class="messages">${messageCards}</section>` : '<div class="empty">暂无邮件。收到新邮件后刷新此页面即可查看。</div>'}
<footer class="footer">需要程序调用时，请使用“查看 JSON”地址；浏览器页面提供可读邮件信息和复制按钮。</footer>
</section></main><div id="toast" class="toast" role="status">已复制</div>
<script>function copyValue(button){var value=button.getAttribute('data-copy')||'';if(!value)return;var done=function(){var t=document.getElementById('toast');t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1400)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(value).then(done).catch(function(){fallback(value,done)})}else{fallback(value,done)}}function fallback(value,done){var area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();try{document.execCommand('copy');done()}finally{area.remove()}}<\/script>
</body></html>`;
}

export function renderPublicMailboxErrorHtml(message, status = 500, requestUrl = '') {
	const jsonUrl = publicJsonUrl(requestUrl);
	return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>取件 URL 错误</title><style>body{margin:0;padding:28px;background:#f4f8fc;color:#17253a;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}.box{max-width:640px;margin:8vh auto;padding:26px;background:#fff;border:1px solid #dfe7f1;border-radius:14px;box-shadow:0 12px 30px #23497818}h1{margin-top:0;color:#b42318;font-size:22px}a{color:#1769d3}</style></head><body><main class="box"><h1>取件 URL 暂时不可用（${escapeHtml(status)}）</h1><p>${escapeHtml(message || '请求失败')}</p><a href="${escapeHtml(jsonUrl)}">查看 JSON 错误</a></main></body></html>`;
}

export function toPublicCodeResult(data) {
	const verificationCode = data?.code || null;
	const messages = Array.isArray(data?.messages)
		? data.messages.map(message => {
			const messageCode = message?.code || message?.verificationCode || null;
			return {
				found: Boolean(message?.found || messageCode),
				email: message?.email || data?.email || null,
				accountId: message?.accountId || data?.accountId || null,
				code: messageCode,
				verificationCode: messageCode,
				emailId: message?.emailId || null,
				from: message?.from || null,
				subject: message?.subject || null,
				receivedAt: message?.receivedAt || null,
				source: message?.source || null
			};
		})
		: [];
	return {
		found: Boolean(data?.found),
		email: data?.email || null,
		accountId: data?.accountId || null,
		code: verificationCode,
		verificationCode,
		emailId: data?.emailId || null,
		latestEmailId: data?.latestEmailId || 0,
		from: data?.from || null,
		subject: data?.subject || null,
		receivedAt: data?.receivedAt || null,
		source: data?.source || null,
		count: Number.isSafeInteger(Number(data?.count)) ? Number(data.count) : messages.length,
		hasMore: Boolean(data?.hasMore),
		hasOlder: Boolean(data?.hasOlder),
		hasNewer: Boolean(data?.hasNewer),
		nextAfterEmailId: data?.nextAfterEmailId || data?.latestEmailId || 0,
		nextBeforeEmailId: data?.nextBeforeEmailId || 0,
		codeCursor: data?.codeCursor || data?.latestEmailId || 0,
		messages
	};
}
