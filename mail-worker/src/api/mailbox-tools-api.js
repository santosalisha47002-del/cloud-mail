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

	try {
		const data = await mailboxToolsService.retrievePublic(c, c.req.param('credential'), c.req.query());
		return c.json(result.ok(toPublicCodeResult(data)));
	} catch (error) {
		if (error?.name !== 'BizError') throw error;
		const status = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599 ? error.code : 500;
		return c.json(result.fail(error.message, status), status);
	}
});

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
