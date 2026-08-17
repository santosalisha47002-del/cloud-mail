const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SIGNATURE_PATTERN = '[A-Za-z0-9_-]{43}';

export const MAILBOX_CODE_CREDENTIAL_PATTERN = new RegExp(`^${UUID_PATTERN}\\.${SIGNATURE_PATTERN}$`, 'i');
const MAILBOX_CODE_PATH_PATTERN = new RegExp(`^/mailbox-tools/code/${UUID_PATTERN}\\.${SIGNATURE_PATTERN}$`, 'i');

export function isMailboxCodeCredential(value) {
	return typeof value === 'string' && MAILBOX_CODE_CREDENTIAL_PATTERN.test(value);
}

/**
 * The only unauthenticated mailbox-tools surface is one well-formed GET URL.
 * Prefix matches, extra path segments, alternate methods and malformed tokens
 * deliberately remain behind the normal JWT middleware.
 */
export function isPublicMailboxCodeRequest(path, method) {
	return String(method || '').toUpperCase() === 'GET' && MAILBOX_CODE_PATH_PATTERN.test(String(path || ''));
}
