<template>
  <div class="mailbox-tools-page">
    <el-scrollbar class="page-scroll">
      <main class="page-shell">
        <section class="hero-panel">
          <div class="hero-copy">
            <div class="hero-icon" aria-hidden="true">
              <Icon icon="fluent:fingerprint-20-filled" width="26" height="26"/>
            </div>
            <div>
              <div class="eyebrow">MAILBOX AUTOMATION</div>
              <h1>{{ $t('mailboxApiTitle') }}</h1>
              <p>{{ $t('mailboxApiSubtitle') }}</p>
            </div>
          </div>
          <div class="hero-status">
            <span class="status-dot"></span>
            <span>{{ $t('receivingReady') }}</span>
          </div>
        </section>

        <section class="workspace-grid">
          <el-card class="tool-card batch-card" shadow="never">
            <template #header>
              <div class="card-heading">
                <div>
                  <h2>{{ $t('batchMailboxTitle') }}</h2>
                  <p>{{ $t('batchMailboxDesc') }}</p>
                </div>
                <span class="step-badge">01</span>
              </div>
            </template>

            <el-form label-position="top" @submit.prevent="createBatch">
              <div class="form-grid">
                <el-form-item :label="$t('createCount')">
                  <el-input-number
                      v-model="batchForm.count"
                      :min="1"
                      :max="50"
                      controls-position="right"
                      class="full-control"
                  />
                </el-form-item>
                <el-form-item :label="$t('mailDomain')">
                  <el-select v-model="batchForm.domain" class="full-control" :placeholder="$t('selectDomain')">
                    <el-option
                        v-for="domain in domainOptions"
                        :key="domain"
                        :label="`@${domain}`"
                        :value="domain"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item :label="$t('optionalPrefix')">
                  <el-input
                      v-model.trim="batchForm.prefix"
                      maxlength="20"
                      clearable
                      :placeholder="$t('randomPrefixPlaceholder')"
                  />
                </el-form-item>
                <el-form-item :label="$t('randomLength')">
                  <el-input-number
                      v-model="batchForm.length"
                      :min="4"
                      :max="32"
                      controls-position="right"
                      class="full-control"
                  />
                </el-form-item>
              </div>

              <div class="sample-line">
                <span>{{ $t('previewExample') }}</span>
                <code>{{ mailboxPreview }}</code>
              </div>

              <el-button
                  native-type="submit"
                  type="primary"
                  size="large"
                  class="primary-action"
                  :loading="batchLoading"
                  :disabled="!batchForm.domain"
              >
                <Icon icon="ion:add-outline" width="18" height="18"/>
                <span>{{ $t('generateMailboxes') }}</span>
              </el-button>
            </el-form>
          </el-card>

          <el-card class="tool-card api-card" shadow="never">
            <template #header>
              <div class="card-heading">
                <div>
                  <h2>{{ $t('codeApiTitle') }}</h2>
                  <p>{{ $t('codeApiDesc') }}</p>
                </div>
                <span class="step-badge">02</span>
              </div>
            </template>

            <div class="token-create-grid">
              <el-form-item :label="$t('selectMailbox')">
                <el-select
                    v-model="tokenForm.accountId"
                    filterable
                    class="full-control"
                    :loading="accountLoading"
                    :placeholder="$t('selectMailbox')"
                >
                  <el-option
                      v-for="account in accountOptions"
                      :key="account.accountId"
                      :label="account.email"
                      :value="account.accountId"
                  />
                </el-select>
              </el-form-item>
              <el-form-item :label="$t('urlLabel')">
                <el-input
                    v-model.trim="tokenForm.label"
                    maxlength="30"
                    clearable
                    :placeholder="$t('urlLabelPlaceholder')"
                />
              </el-form-item>
            </div>

            <el-alert
                class="api-note"
                type="info"
                :closable="false"
                show-icon
                :title="$t('apiUrlHint')"
            />

            <div class="api-actions">
              <el-button
                  type="primary"
                  :loading="tokenCreating"
                  :disabled="!tokenForm.accountId"
                  @click="createToken"
              >
                <Icon icon="fluent:fingerprint-20-filled" width="17" height="17"/>
                <span>{{ $t('createRetrievalUrl') }}</span>
              </el-button>
              <el-button :loading="tokenLoading" @click="refreshTokens">
                <Icon icon="ion:reload" width="15" height="15"/>
                <span>{{ $t('refresh') }}</span>
              </el-button>
            </div>
          </el-card>
        </section>

        <section v-if="batchRows.length" class="result-panel">
          <div class="section-heading">
            <div>
              <div class="section-title-row">
                <h2>{{ $t('createdMailboxes') }}</h2>
                <el-tag type="success" effect="light">{{ batchRows.length }}</el-tag>
              </div>
              <p>{{ $t('sharedLoginHint') }}</p>
            </div>
            <div class="section-actions">
              <el-button @click="copyBatchRows">
                <Icon icon="fluent-color:clipboard-24" width="17" height="17"/>
                {{ $t('copyAll') }}
              </el-button>
              <el-button type="primary" plain @click="downloadCsv">
                <Icon icon="system-uicons:push-down" width="17" height="17"/>
                {{ $t('downloadCsv') }}
              </el-button>
            </div>
          </div>

          <el-table :data="batchRows" stripe class="result-table">
            <el-table-column type="index" width="58" label="#"/>
            <el-table-column prop="email" :label="$t('emailAccount')" min-width="250">
              <template #default="scope">
                <div class="email-cell">
                  <span class="mail-dot"></span>
                  <span>{{ scope.row.email }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="accountId" label="Account ID" width="130">
              <template #default="scope">
                <code class="account-id-cell">{{ scope.row.accountId || '—' }}</code>
              </template>
            </el-table-column>
            <el-table-column prop="url" :label="$t('retrievalUrl')" min-width="390">
              <template #default="scope">
                <button
                    v-if="scope.row.url"
                    class="url-value batch-url-value"
                    type="button"
                    :title="scope.row.url"
                    @click="copyText(scope.row.url)"
                >
                  <code>{{ scope.row.url }}</code>
                  <Icon icon="fluent-color:clipboard-24" width="17" height="17"/>
                </button>
                <span v-else class="url-unavailable">{{ $t('urlUnavailable') }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="$t('operation')" width="225" align="right">
              <template #default="scope">
                <el-button link type="primary" @click="copyText(scope.row.email)">{{ $t('copy') }}</el-button>
                <el-button
                    v-if="scope.row.url"
                    link
                    type="primary"
                    @click="copyText(scope.row.url)"
                >{{ $t('copyUrl') }}</el-button>
                <el-button
                    v-else
                    link
                    type="primary"
                    :disabled="!scope.row.accountId"
                    @click="createTokenForAccount(scope.row)"
                >{{ $t('createRetrievalUrl') }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <section class="tokens-panel">
          <div class="section-heading token-heading">
            <div>
              <div class="section-title-row">
                <h2>{{ $t('activeRetrievalUrls') }}</h2>
                <el-tag effect="plain">{{ tokenRows.length }}</el-tag>
              </div>
              <p>{{ $t('activeRetrievalUrlsDesc') }}</p>
            </div>
          </div>

          <div v-loading="tokenLoading" class="token-list-wrap">
            <el-empty v-if="!tokenLoading && !tokenRows.length" :description="$t('noRetrievalUrls')"/>

            <div v-else class="token-list">
              <article v-for="token in tokenRows" :key="token.rowKey" class="token-item">
                <div class="token-main">
                  <div class="token-mail-icon" aria-hidden="true">
                    <Icon icon="hugeicons:mailbox-01" width="22" height="22"/>
                  </div>
                  <div class="token-identity">
                    <div class="token-title-row">
                      <strong>{{ token.email || $t('unknownMailbox') }}</strong>
                      <el-tag size="small" type="success" effect="light">{{ $t('enabled') }}</el-tag>
                      <span v-if="token.label" class="token-label">{{ token.label }}</span>
                    </div>
                    <div class="token-meta">
                      <span>{{ $t('createdAt') }} {{ formatTime(token.createdAt) }}</span>
                      <span v-if="token.lastUsedAt">{{ $t('lastCalled') }} {{ formatTime(token.lastUsedAt) }}</span>
                    </div>
                  </div>
                </div>

                <div class="credential-grid" :class="{'url-only': !token.token}">
                  <div v-if="token.token" class="credential-block">
                    <span class="credential-label">TOKEN</span>
                    <div class="credential-value">
                      <code>{{ visibleTokens.has(token.rowKey) ? token.token : maskToken(token.token) }}</code>
                      <el-button
                          v-if="token.token"
                          link
                          type="primary"
                          @click="toggleToken(token.rowKey)"
                      >{{ visibleTokens.has(token.rowKey) ? $t('hide') : $t('show') }}</el-button>
                    </div>
                  </div>
                  <div class="credential-block url-block">
                    <span class="credential-label">{{ $t('retrievalUrl') }}</span>
                    <button class="url-value" type="button" :title="token.url" @click="copyText(token.url)">
                      <code>{{ token.url || $t('urlUnavailable') }}</code>
                      <Icon icon="fluent-color:clipboard-24" width="17" height="17"/>
                    </button>
                  </div>
                </div>

                <div class="token-actions">
                  <el-button size="small" :disabled="!token.url" @click="copyText(token.url)">{{ $t('copyUrl') }}</el-button>
                  <el-button size="small" type="primary" plain :disabled="!token.url" @click="testToken(token)">{{ $t('testFetch') }}</el-button>
                  <el-button size="small" type="danger" link @click="revokeToken(token)">{{ $t('revoke') }}</el-button>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section class="api-example">
          <div>
            <span class="eyebrow">API RESPONSE</span>
            <h2>{{ $t('responseExample') }}</h2>
          </div>
          <pre><code>{
  "code": 200,
  "data": {
    "found": true,
    "email": "verify@salvadawn.com",
    "code": "123456",
    "subject": "Your verification code",
    "receivedAt": "2026-08-17T03:12:00.000Z"
  }
}</code></pre>
        </section>
      </main>
    </el-scrollbar>

    <el-dialog v-model="testDialog.visible" :title="$t('testFetchResult')" width="min(520px, calc(100% - 32px))">
      <div v-loading="testDialog.loading" class="test-result">
        <template v-if="!testDialog.loading">
          <div v-if="testDialog.verificationCode" class="code-result">
            <span>{{ $t('latestVerificationCode') }}</span>
            <strong>{{ testDialog.verificationCode }}</strong>
            <el-button link type="primary" @click="copyText(testDialog.verificationCode)">{{ $t('copyCode') }}</el-button>
          </div>
          <el-alert
              v-else
              :type="testDialog.ok ? 'info' : 'error'"
              :title="testDialog.message"
              :closable="false"
              show-icon
          />
          <div v-if="testDialog.subject" class="test-meta">
            <span>{{ $t('subject') }}</span>
            <strong>{{ testDialog.subject }}</strong>
          </div>
          <pre v-if="testDialog.raw" class="raw-result"><code>{{ testDialog.raw }}</code></pre>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import {computed, onMounted, reactive, ref, watch} from 'vue'
import {Icon} from '@iconify/vue'
import {useI18n} from 'vue-i18n'
import {useSettingStore} from '@/store/setting.js'
import {useAccountStore} from '@/store/account.js'
import {useUserStore} from '@/store/user.js'
import {accountList} from '@/request/account.js'
import {
  batchCreateMailboxes,
  mailboxTokenCreate,
  mailboxTokenDelete,
  mailboxTokenList
} from '@/request/mailbox-tools.js'
import {hasPerm} from '@/perm/perm.js'

const {t, locale} = useI18n()
const settingStore = useSettingStore()
const accountStore = useAccountStore()
const userStore = useUserStore()

const batchLoading = ref(false)
const tokenLoading = ref(false)
const tokenCreating = ref(false)
const accountLoading = ref(false)
const batchRows = ref([])
const tokenRows = ref([])
const accountOptions = ref([])
const visibleTokens = reactive(new Set())

const batchForm = reactive({
  count: 10,
  domain: '',
  prefix: '',
  length: 10
})

const tokenForm = reactive({
  accountId: null,
  label: ''
})

const testDialog = reactive({
  visible: false,
  loading: false,
  ok: false,
  verificationCode: '',
  subject: '',
  message: '',
  raw: ''
})

const domainOptions = computed(() => {
  return [...new Set((settingStore.domainList || []).map(normalizeDomain).filter(Boolean))]
})

const mailboxPreview = computed(() => {
  const prefix = safePrefix(batchForm.prefix) || ''
  const random = 'x'.repeat(Math.min(Number(batchForm.length) || 0, 12))
  return `${prefix}${random}@${batchForm.domain || 'example.com'}`
})

watch(domainOptions, (domains) => {
  if (!batchForm.domain && domains.length) {
    batchForm.domain = domains[0]
  }
}, {immediate: true})

onMounted(async () => {
  seedCurrentAccount()
  await Promise.all([loadAccounts(), refreshTokens()])
})

function normalizeDomain(domain) {
  return String(domain || '').trim().replace(/^@+/, '').toLowerCase()
}

function safePrefix(prefix) {
  return String(prefix || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/\.{2,}/g, '.')
}

function seedCurrentAccount() {
  const candidates = [accountStore.currentAccount, userStore.user?.account]
  candidates.forEach(addAccountOption)
  const currentId = Number(accountStore.currentAccountId || userStore.user?.account?.accountId)
  if (!tokenForm.accountId && currentId) {
    tokenForm.accountId = currentId
  }
}

function addAccountOption(account) {
  if (!account?.accountId || !account?.email) return
  const exists = accountOptions.value.some(item => Number(item.accountId) === Number(account.accountId))
  if (!exists) {
    accountOptions.value.push({accountId: Number(account.accountId), email: account.email})
  }
}

async function loadAccounts() {
  if (!hasPerm('account:query')) return
  accountLoading.value = true
  try {
    let cursorId = 0
    let lastSort
    for (let page = 0; page < 20; page++) {
      const list = await accountList(cursorId, 30, lastSort)
      if (!Array.isArray(list) || !list.length) break
      list.forEach(addAccountOption)
      if (list.length < 30) break
      const last = list.at(-1)
      cursorId = Number(last.accountId)
      lastSort = Number(last.sort)
    }
    if (!tokenForm.accountId && accountOptions.value.length) {
      tokenForm.accountId = accountOptions.value[0].accountId
    }
  } finally {
    accountLoading.value = false
  }
}

async function createBatch() {
  if (batchLoading.value) return
  if (!batchForm.domain) {
    ElMessage.warning(t('selectDomain'))
    return
  }

  const prefix = safePrefix(batchForm.prefix)
  if (prefix !== batchForm.prefix) {
    batchForm.prefix = prefix
    ElMessage.warning(t('prefixNormalized'))
  }

  batchLoading.value = true
  try {
    const data = await batchCreateMailboxes({
      count: Number(batchForm.count),
      domain: normalizeDomain(batchForm.domain),
      prefix: prefix || undefined,
      length: Number(batchForm.length)
    })
    batchRows.value = normalizeMailboxRows(data)
    batchRows.value.forEach(row => addAccountOption(row))
    accountStore.refreshAccountList()
    ElMessage({message: t('batchCreateSuccess', {count: batchRows.value.length}), type: 'success', plain: true})
    await loadAccounts()
    await refreshTokens()
  } finally {
    batchLoading.value = false
  }
}

function normalizeMailboxRows(data) {
  const source = Array.isArray(data)
      ? data
      : data?.items || data?.mailboxes || data?.accounts || data?.list || data?.created || []

  return source.map((item, index) => {
    if (typeof item === 'string') {
      return {rowKey: `${item}-${index}`, email: item, accountId: null, token: '', url: ''}
    }
    const token = String(item.token || item.credential || item.accessToken || item.secret || '')
    return {
      ...item,
      rowKey: item.accountId || item.userId || `${item.email}-${index}`,
      accountId: Number(item.accountId) || null,
      email: item.email || item.address || item.mailbox || '',
      token,
      url: item.codeUrl || item.url || item.retrievalUrl || item.fetchUrl || buildFallbackUrl(token)
    }
  }).filter(item => item.email)
}

async function refreshTokens() {
  tokenLoading.value = true
  try {
    const data = await mailboxTokenList()
    const availableAccounts = data?.availableAccounts || data?.accounts || []
    if (Array.isArray(availableAccounts)) {
      availableAccounts.forEach(addAccountOption)
      if (!tokenForm.accountId && accountOptions.value.length) {
        tokenForm.accountId = accountOptions.value[0].accountId
      }
    }
    const source = Array.isArray(data) ? data : data?.items || data?.tokens || data?.list || []
    source.forEach(addAccountOption)
    tokenRows.value = source.map(normalizeTokenRow)
  } finally {
    tokenLoading.value = false
  }
}

async function createToken() {
  if (!tokenForm.accountId || tokenCreating.value) return
  tokenCreating.value = true
  try {
    const data = await mailboxTokenCreate({
      accountId: Number(tokenForm.accountId),
      label: tokenForm.label || undefined
    })
    const source = Array.isArray(data) ? data[0] : data?.tokenInfo || data?.item || data
    if (source) {
      const row = normalizeTokenRow(source, 0)
      tokenRows.value = [row, ...tokenRows.value.filter(item => item.rowKey !== row.rowKey)]
      visibleTokens.add(row.rowKey)
    } else {
      await refreshTokens()
    }
    tokenForm.label = ''
    ElMessage({message: t('retrievalUrlCreated'), type: 'success', plain: true})
  } finally {
    tokenCreating.value = false
  }
}

async function createTokenForAccount(account) {
  tokenForm.accountId = Number(account.accountId)
  tokenForm.label = ''
  await createToken()
}

function normalizeTokenRow(item = {}, index = 0) {
  if (typeof item === 'string') item = {token: item}
  const accountId = Number(item.accountId || item.mailboxId) || null
  const account = accountOptions.value.find(option => Number(option.accountId) === accountId)
  const token = String(item.token || item.accessToken || item.secret || '')
  const id = item.tokenId ?? item.id ?? token
  const url = item.codeUrl || item.url || item.retrievalUrl || item.fetchUrl || buildFallbackUrl(token)

  return {
    ...item,
    id,
    rowKey: String(id || `${accountId || 'token'}-${index}`),
    accountId,
    email: item.email || item.address || account?.email || '',
    token,
    url,
    label: item.label || item.name || '',
    createdAt: item.createdAt || item.createTime || item.created_at || '',
    lastUsedAt: item.lastUsedAt || item.lastCallTime || item.last_used_at || ''
  }
}

function buildFallbackUrl(token) {
  if (!token) return ''
  return `${window.location.origin}/api/mailbox-tools/code/${encodeURIComponent(token)}`
}

async function revokeToken(token) {
  await ElMessageBox.confirm(t('revokeUrlConfirm', {email: token.email || t('unknownMailbox')}), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  })
  await mailboxTokenDelete(token.id)
  tokenRows.value = tokenRows.value.filter(item => item.rowKey !== token.rowKey)
  visibleTokens.delete(token.rowKey)
  ElMessage({message: t('urlRevoked'), type: 'success', plain: true})
}

async function testToken(token) {
  testDialog.visible = true
  testDialog.loading = true
  testDialog.ok = false
  testDialog.verificationCode = ''
  testDialog.subject = ''
  testDialog.message = ''
  testDialog.raw = ''

  try {
    const response = await fetch(token.url, {
      method: 'GET',
      headers: {'Accept': 'application/json'},
      cache: 'no-store',
      credentials: 'omit'
    })
    const text = await response.text()
    let payload = text
    try {
      payload = text ? JSON.parse(text) : null
    } catch (_) {
      // Plain-text APIs are supported as well.
    }

    const result = normalizeCodeResult(payload)
    testDialog.ok = response.ok
    testDialog.verificationCode = result.verificationCode
    testDialog.subject = result.subject
    testDialog.message = response.ok
        ? (result.found ? t('fetchSuccess') : t('noCodeYet'))
        : (result.message || `${response.status} ${response.statusText}`)
    testDialog.raw = prettyResult(payload)
  } catch (error) {
    testDialog.message = error?.message || t('requestFailed')
    testDialog.raw = ''
  } finally {
    testDialog.loading = false
  }
}

function normalizeCodeResult(payload) {
  const body = payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
  if (typeof body === 'string' || typeof body === 'number') {
    return {found: Boolean(body), verificationCode: String(body || ''), subject: '', message: ''}
  }
  const verificationCode = String(body?.verificationCode || body?.code || body?.otp || body?.captcha || '')
  return {
    found: typeof body?.found === 'boolean' ? body.found : Boolean(verificationCode),
    verificationCode,
    subject: body?.subject || body?.emailSubject || '',
    message: body?.message || payload?.message || ''
  }
}

function prettyResult(payload) {
  if (typeof payload === 'string') return payload
  if (payload === null || payload === undefined) return ''
  return JSON.stringify(payload, null, 2)
}

function toggleToken(rowKey) {
  if (visibleTokens.has(rowKey)) {
    visibleTokens.delete(rowKey)
  } else {
    visibleTokens.add(rowKey)
  }
}

function maskToken(token) {
  if (!token) return '—'
  if (token.length <= 10) return '••••••••••'
  return `${token.slice(0, 5)}${'•'.repeat(12)}${token.slice(-5)}`
}

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date)
}

async function copyText(value) {
  if (!value) return
  try {
    await navigator.clipboard.writeText(String(value))
  } catch (_) {
    const textarea = document.createElement('textarea')
    textarea.value = String(value)
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true})
}

function copyBatchRows() {
  return copyText(batchRows.value
      .map(row => row.url ? `${row.email}\t${row.url}` : row.email)
      .join('\n'))
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function downloadCsv() {
  const lines = [
    ['email', 'accountId', 'retrievalUrl'],
    ...batchRows.value.map(row => [row.email, row.accountId || '', row.url || ''])
  ].map(row => row.map(csvCell).join(','))

  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], {type: 'text/csv;charset=utf-8'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `mailboxes-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
</script>

<style lang="scss" scoped>
.mailbox-tools-page {
  height: 100%;
  overflow: hidden;
  background:
      radial-gradient(circle at 96% 0%, rgba(24, 144, 255, 0.08), transparent 28%),
      var(--el-bg-color);
}

.page-scroll {
  height: 100%;
}

.page-shell {
  width: min(1220px, 100%);
  margin: 0 auto;
  padding: 24px 24px 48px;
}

.hero-panel {
  position: relative;
  overflow: hidden;
  min-height: 138px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 26px 30px;
  color: #fff;
  border-radius: 18px;
  background:
      radial-gradient(circle at 82% 20%, rgba(255, 255, 255, .2), transparent 24%),
      linear-gradient(130deg, #0759bd 0%, #168ff1 55%, #50b7ff 100%);
  box-shadow: 0 16px 36px rgba(15, 101, 190, .2);
}

.hero-panel::after {
  content: '';
  position: absolute;
  width: 250px;
  height: 250px;
  right: -65px;
  bottom: -180px;
  border: 34px solid rgba(255, 255, 255, .09);
  border-radius: 50%;
}

.hero-copy {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 18px;
}

.hero-icon {
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, .28);
  border-radius: 14px;
  background: rgba(255, 255, 255, .14);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22);
}

.eyebrow {
  display: block;
  margin-bottom: 5px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .17em;
  opacity: .74;
}

.hero-copy h1 {
  margin: 0;
  font-size: clamp(24px, 3vw, 34px);
  line-height: 1.18;
}

.hero-copy p {
  max-width: 680px;
  margin-top: 8px;
  color: rgba(255, 255, 255, .84);
  font-size: 14px;
}

.hero-status {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 13px;
  border: 1px solid rgba(255, 255, 255, .22);
  border-radius: 999px;
  background: rgba(0, 51, 110, .2);
  font-size: 12px;
  font-weight: 600;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #73f6b2;
  box-shadow: 0 0 0 4px rgba(115, 246, 178, .15);
}

.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  margin-top: 20px;
}

.tool-card,
.result-panel,
.tokens-panel,
.api-example {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 14px;
  background: var(--el-bg-color);
  box-shadow: 0 8px 28px rgba(20, 36, 56, .05);
}

.tool-card {
  :deep(.el-card__header) {
    padding: 20px 22px 15px;
    border-bottom: 0;
  }

  :deep(.el-card__body) {
    padding: 0 22px 22px;
  }

  :deep(.el-form-item) {
    margin-bottom: 14px;
  }

  :deep(.el-form-item__label) {
    padding-bottom: 6px;
    color: var(--el-text-color-regular);
    font-weight: 600;
  }
}

.card-heading,
.section-heading,
.section-title-row,
.token-title-row,
.api-actions,
.section-actions {
  display: flex;
  align-items: center;
}

.card-heading,
.section-heading {
  justify-content: space-between;
  gap: 20px;
}

.card-heading h2,
.section-heading h2,
.api-example h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.3;
}

.card-heading p,
.section-heading p {
  margin-top: 5px;
  color: var(--secondary-text-color);
  font-size: 12px;
}

.step-badge {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  font-size: 12px;
  font-weight: 800;
}

.form-grid,
.token-create-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}

.full-control {
  width: 100%;
}

.sample-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0 0 16px;
  color: var(--secondary-text-color);
  font-size: 12px;
}

.sample-line code {
  overflow: hidden;
  padding: 4px 8px;
  color: var(--el-color-primary);
  border-radius: 6px;
  background: var(--el-color-primary-light-9);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.primary-action {
  width: 100%;
  border-radius: 8px;
  font-weight: 650;
}

.primary-action span,
.api-actions :deep(.el-button > span),
.section-actions :deep(.el-button > span) {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.api-note {
  margin: 0 0 16px;
  align-items: flex-start;
}

.api-note :deep(.el-alert__title) {
  line-height: 1.5;
  font-size: 12px;
}

.api-actions {
  flex-wrap: wrap;
  gap: 9px;
}

.api-actions .el-button + .el-button {
  margin-left: 0;
}

.result-panel,
.tokens-panel {
  margin-top: 18px;
  padding: 21px 22px;
}

.section-title-row,
.token-title-row {
  gap: 9px;
}

.section-actions {
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.section-actions .el-button + .el-button {
  margin-left: 0;
}

.result-table {
  width: 100%;
  margin-top: 16px;
}

.email-cell {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 600;
}

.mail-dot {
  width: 8px;
  height: 8px;
  border-radius: 3px;
  background: linear-gradient(135deg, #168ff1, #6ec7ff);
}

.account-id-cell {
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--light-ill);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.token-heading {
  padding-bottom: 17px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.token-list-wrap {
  min-height: 130px;
}

.token-list {
  display: grid;
  gap: 12px;
  padding-top: 15px;
}

.token-item {
  display: grid;
  grid-template-columns: minmax(190px, .8fr) minmax(340px, 1.7fr) auto;
  align-items: center;
  gap: 18px;
  padding: 15px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 11px;
  background: var(--extra-light-fill);
  transition: border-color .2s, transform .2s;
}

@media (hover: hover) {
  .token-item:hover {
    border-color: var(--el-color-primary-light-7);
    transform: translateY(-1px);
  }
}

.token-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 11px;
}

.token-mail-icon {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  display: grid;
  place-items: center;
  color: var(--el-color-primary);
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
}

.token-identity {
  min-width: 0;
}

.token-title-row {
  flex-wrap: wrap;
}

.token-title-row strong {
  overflow: hidden;
  max-width: 240px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-label {
  color: var(--secondary-text-color);
  font-size: 11px;
}

.token-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 12px;
  margin-top: 5px;
  color: var(--secondary-text-color);
  font-size: 11px;
}

.credential-grid {
  display: grid;
  grid-template-columns: minmax(160px, .7fr) minmax(220px, 1.3fr);
  gap: 10px;
  min-width: 0;
}

.credential-grid.url-only {
  grid-template-columns: minmax(0, 1fr);
}

.credential-block {
  min-width: 0;
}

.credential-label {
  display: block;
  margin-bottom: 4px;
  color: var(--secondary-text-color);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.credential-value,
.url-value {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 9px;
  color: var(--el-text-color-primary);
  border: 1px solid var(--el-border-color);
  border-radius: 7px;
  background: var(--el-bg-color);
}

.credential-value code,
.url-value code {
  overflow: hidden;
  flex: 1;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.credential-value .el-button {
  flex: 0 0 auto;
  margin-left: 6px;
  font-size: 11px;
}

.url-value {
  cursor: pointer;
  text-align: left;
}

.url-value svg {
  flex: 0 0 auto;
  margin-left: 8px;
}

.token-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex-wrap: wrap;
}

.token-actions .el-button + .el-button {
  margin-left: 0;
}

.api-example {
  display: grid;
  grid-template-columns: .65fr 1.35fr;
  align-items: center;
  gap: 30px;
  margin-top: 18px;
  padding: 20px 22px;
}

.api-example .eyebrow {
  color: var(--el-color-primary);
}

.api-example pre,
.raw-result {
  overflow: auto;
  margin: 0;
  padding: 14px 16px;
  color: #d6e8ff;
  border: 1px solid rgba(255, 255, 255, .06);
  border-radius: 9px;
  background: #071a2f;
  font-size: 11px;
  line-height: 1.55;
}

.test-result {
  min-height: 90px;
}

.code-result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px;
  border-radius: 10px;
  background: var(--el-color-success-light-9);
}

.code-result strong {
  color: var(--el-color-success);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 25px;
  letter-spacing: .08em;
}

.test-meta {
  display: grid;
  gap: 3px;
  margin-top: 13px;
  color: var(--secondary-text-color);
  font-size: 12px;
}

.test-meta strong {
  color: var(--el-text-color-primary);
}

.raw-result {
  max-height: 260px;
  margin-top: 13px;
}

@media (max-width: 1100px) {
  .token-item {
    grid-template-columns: minmax(210px, .8fr) minmax(330px, 1.2fr);
  }

  .token-actions {
    grid-column: 1 / -1;
  }
}

@media (max-width: 850px) {
  .page-shell {
    padding: 18px 16px 36px;
  }

  .workspace-grid {
    grid-template-columns: 1fr;
  }

  .token-item {
    grid-template-columns: 1fr;
  }

  .token-actions {
    grid-column: auto;
    justify-content: flex-start;
  }

  .api-example {
    grid-template-columns: 1fr;
    gap: 14px;
  }
}

@media (max-width: 560px) {
  .page-shell {
    padding: 12px 10px 30px;
  }

  .hero-panel {
    min-height: 0;
    align-items: flex-start;
    padding: 20px 18px;
    border-radius: 12px;
  }

  .hero-copy {
    align-items: flex-start;
    gap: 12px;
  }

  .hero-icon {
    width: 42px;
    height: 42px;
    flex-basis: 42px;
  }

  .hero-copy h1 {
    font-size: 22px;
  }

  .hero-status {
    display: none;
  }

  .tool-card :deep(.el-card__header),
  .tool-card :deep(.el-card__body) {
    padding-left: 15px;
    padding-right: 15px;
  }

  .form-grid,
  .token-create-grid,
  .credential-grid {
    grid-template-columns: 1fr;
  }

  .result-panel,
  .tokens-panel,
  .api-example {
    padding: 16px 14px;
    border-radius: 11px;
  }

  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .section-actions {
    justify-content: flex-start;
  }

  .token-item {
    padding: 13px;
  }

  .token-actions .el-button {
    flex: 1;
  }

  .code-result {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
