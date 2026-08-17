import http from '@/axios/index.js'

/**
 * Create a group of receiving aliases (account rows) for the current user.
 *
 * @param {{count: number, domain: string, prefix?: string, length: number}} form
 */
export function batchCreateMailboxes(form) {
    return http.post('/mailbox-tools/batch-create', form)
}

/**
 * List retrieval tokens owned by the current user.
 */
export function mailboxTokenList() {
    return http.get('/mailbox-tools/tokens')
}

/**
 * Create a retrieval URL for one of the current user's mailboxes.
 *
 * @param {{accountId: number, label?: string}} form
 */
export function mailboxTokenCreate(form) {
    return http.post('/mailbox-tools/tokens', form)
}

/**
 * Revoke a retrieval token immediately.
 */
export function mailboxTokenDelete(tokenId) {
    return http.delete(`/mailbox-tools/tokens/${encodeURIComponent(tokenId)}`)
}
