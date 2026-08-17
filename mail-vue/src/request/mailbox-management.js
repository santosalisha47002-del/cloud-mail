import http from '@/axios/index.js'

/**
 * Server-side mailbox inventory for the signed-in user.
 *
 * @param {{page?: number, pageSize?: number, keyword?: string, domain?: string, tokenStatus?: 'all'|'active'|'missing'}} params
 */
export function managedMailboxList(params = {}) {
    return http.get('/mailbox-tools/mailboxes', {params})
}

/**
 * Idempotently create a retrieval token for every mailbox that does not have
 * an active one yet. The worker accepts at most 100 ids per request.
 *
 * @param {number[]} accountIds
 */
export function ensureManagedMailboxTokens(accountIds) {
    return http.post('/mailbox-tools/mailboxes/ensure-tokens', {accountIds})
}

/**
 * Read a mailbox's recent messages while retaining the mailbox ownership
 * checks performed by the worker.
 *
 * @param {number} accountId
 * @param {{limit?: number, beforeEmailId?: number, afterEmailId?: number}} params
 */
export function managedMailboxMessages(accountId, params = {}) {
    return http.get(`/mailbox-tools/mailboxes/${encodeURIComponent(accountId)}/messages`, {params})
}

