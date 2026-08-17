<template>
  <div class="mailbox-management-page">
    <el-scrollbar class="page-scroll">
      <main class="page-shell">
        <section class="hero-panel">
          <div class="hero-copy">
            <div class="hero-icon"><Icon icon="fluent:mail-inbox-all-24-regular" width="29" height="29"/></div>
            <div>
              <div class="eyebrow">MAILBOX CONTROL CENTER</div>
              <h1>{{ tr('title') }}</h1>
              <p>{{ tr('subtitle') }}</p>
            </div>
          </div>
          <div class="hero-actions">
            <el-button class="hero-button" :loading="loading" @click="reload">
              <Icon icon="ion:reload" width="16" height="16"/>
              {{ tr('refresh') }}
            </el-button>
          </div>
        </section>

        <section class="summary-grid">
          <article class="summary-card">
            <span class="summary-icon blue"><Icon icon="hugeicons:mailbox-01" width="21" height="21"/></span>
            <div><strong>{{ total }}</strong><span>{{ tr('allMailboxes') }}</span></div>
          </article>
          <article class="summary-card">
            <span class="summary-icon green"><Icon icon="fluent:link-24-regular" width="21" height="21"/></span>
            <div><strong>{{ activeOnPage }}</strong><span>{{ tr('activeOnPage') }}</span></div>
          </article>
          <article class="summary-card">
            <span class="summary-icon amber"><Icon icon="fluent:link-dismiss-24-regular" width="21" height="21"/></span>
            <div><strong>{{ missingOnPage }}</strong><span>{{ tr('missingOnPage') }}</span></div>
          </article>
          <article class="summary-card">
            <span class="summary-icon violet"><Icon icon="fluent:checkbox-checked-24-regular" width="21" height="21"/></span>
            <div><strong>{{ selectedCount }}</strong><span>{{ tr('selectedAcrossPages') }}</span></div>
          </article>
        </section>

        <section class="management-panel">
          <div class="panel-heading">
            <div>
              <h2>{{ tr('inventory') }}</h2>
              <p>{{ tr('inventoryDesc') }}</p>
            </div>
            <div class="panel-actions">
              <el-button
                  :loading="selectingFiltered"
                  :disabled="!total"
                  @click="selectAllFiltered"
              >
                <Icon icon="fluent:checkbox-multiple-20-regular" width="17" height="17"/>
                {{ tr('selectAllFiltered') }}
              </el-button>
              <el-button :loading="bulkWorking" :disabled="!total" @click="copyAllFiltered">
                <Icon icon="fluent-color:clipboard-24" width="17" height="17"/>
                {{ tr('copyAllFiltered') }}
              </el-button>
              <el-button type="primary" plain :loading="bulkWorking" :disabled="!total" @click="exportAllFiltered">
                <Icon icon="system-uicons:push-down" width="17" height="17"/>
                {{ tr('exportAllFiltered') }}
              </el-button>
              <el-button :disabled="!selectedCount" @click="clearSelection">{{ tr('clearSelection') }}</el-button>
            </div>
          </div>

          <form class="filter-bar" @submit.prevent="applyFilters">
            <el-input
                v-model.trim="draftKeyword"
                class="keyword-input"
                clearable
                :placeholder="tr('searchPlaceholder')"
                @clear="applyFilters"
            >
              <template #prefix><Icon icon="iconoir:search" width="17" height="17"/></template>
            </el-input>
            <el-select v-model="draftDomain" class="domain-select" @change="applyFilters">
              <el-option :label="tr('allDomains')" value=""/>
              <el-option v-for="domain in domainOptions" :key="domain" :label="`@${domain}`" :value="domain"/>
            </el-select>
            <el-segmented
                v-model="draftTokenStatus"
                class="status-segmented"
                :options="tokenStatusOptions"
                @change="applyFilters"
            />
            <el-button native-type="submit" type="primary">
              <Icon icon="iconoir:search" width="16" height="16"/>
              {{ tr('search') }}
            </el-button>
          </form>

          <div v-if="selectedCount" class="selection-bar">
            <div class="selection-copy">
              <span class="selection-count">{{ tr('selectedCount', {count: selectedCount}) }}</span>
              <span v-if="selectedMissingCount" class="selection-missing">
                {{ tr('selectedMissing', {count: selectedMissingCount}) }}
              </span>
            </div>
            <div class="selection-actions">
              <el-button
                  v-if="selectedMissingCount"
                  :loading="ensuringTokens"
                  type="warning"
                  plain
                  @click="ensureSelectedApis"
              >
                <Icon icon="fluent:link-add-24-regular" width="17" height="17"/>
                {{ tr('createMissingApis') }}
              </el-button>
              <el-button :disabled="!selectedWithUrlCount" @click="copySelected">
                <Icon icon="fluent-color:clipboard-24" width="17" height="17"/>
                {{ tr('copySelectedApi') }}
              </el-button>
              <el-button type="primary" plain :disabled="!selectedWithUrlCount" @click="exportSelected">
                <Icon icon="system-uicons:push-down" width="17" height="17"/>
                {{ tr('exportSelected') }}
              </el-button>
            </div>
          </div>

          <el-table
              ref="tableRef"
              v-loading="loading"
              :data="rows"
              row-key="accountId"
              stripe
              class="mailbox-table"
              empty-text=" "
              @select="handleRowSelect"
              @select-all="handleSelectAll"
          >
            <el-table-column type="selection" width="48" reserve-selection/>
            <el-table-column :label="tr('mailbox')" min-width="245">
              <template #default="{row}">
                <div class="mailbox-cell">
                  <span class="mail-avatar">{{ String(row.email || '?').charAt(0).toUpperCase() }}</span>
                  <div class="mailbox-identity">
                    <strong>{{ row.email }}</strong>
                    <small>
                      <span v-if="row.name">{{ row.name }}</span>
                      <span>ID {{ row.accountId }}</span>
                    </small>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="tr('messages')" width="105" align="center">
              <template #default="{row}">
                <button class="message-count" type="button" @click="openMailbox(row)">
                  {{ Number(row.messageCount) || 0 }}
                </button>
              </template>
            </el-table-column>
            <el-table-column :label="tr('latestMail')" min-width="170">
              <template #default="{row}">
                <span class="time-cell">{{ formatTime(row.latestEmailTime) }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="tr('retrievalApi')" min-width="325">
              <template #default="{row}">
                <div v-if="row.codeUrl" class="api-cell">
                  <div class="api-status-line">
                    <el-tag size="small" type="success" effect="light">{{ tr('available') }}</el-tag>
                    <small>{{ tr('apiCount', {count: row.tokenCount || row.tokens?.length || 1}) }}</small>
                  </div>
                  <button class="api-url" type="button" :title="row.codeUrl" @click="copyText(row.codeUrl)">
                    <code>{{ row.codeUrl }}</code>
                    <Icon icon="fluent-color:clipboard-24" width="16" height="16"/>
                  </button>
                </div>
                <div v-else class="missing-api">
                  <el-tag size="small" type="warning" effect="light">{{ tr('notCreated') }}</el-tag>
                  <el-button
                      size="small"
                      link
                      type="primary"
                      :loading="rowCreatingIds.has(Number(row.accountId))"
                      @click="ensureRowApi(row)"
                  >{{ tr('createNow') }}</el-button>
                </div>
              </template>
            </el-table-column>
            <el-table-column :label="tr('actions')" width="178" fixed="right">
              <template #default="{row}">
                <div class="row-actions">
                  <el-button size="small" type="primary" plain @click="openMailbox(row)">
                    <Icon icon="fluent:mail-read-24-regular" width="15" height="15"/>
                    {{ tr('viewMail') }}
                  </el-button>
                  <el-dropdown v-if="row.codeUrl" trigger="click">
                    <el-button size="small" link type="primary">
                      <Icon icon="ion:ellipsis-horizontal" width="17" height="17"/>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item @click="copyMailboxApi(row)">{{ tr('copyMailboxApi') }}</el-dropdown-item>
                        <el-dropdown-item @click="openPublicMailbox(row)">{{ tr('openRetrievalPage') }}</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </template>
            </el-table-column>
            <template #empty>
              <div class="empty-state">
                <Icon icon="fluent:mail-inbox-dismiss-24-regular" width="40" height="40"/>
                <strong>{{ tr('noResults') }}</strong>
                <span>{{ tr('noResultsDesc') }}</span>
              </div>
            </template>
          </el-table>

          <div class="pagination-row">
            <span v-if="selectedCount" class="cross-page-note">{{ tr('selectionRetained') }}</span>
            <el-pagination
                :current-page="page"
                :page-size="pageSize"
                :page-sizes="[10, 20, 50, 100]"
                :total="total"
                background
                layout="total, sizes, prev, pager, next, jumper"
                @current-change="handlePageChange"
                @size-change="handlePageSizeChange"
            />
          </div>
        </section>
      </main>
    </el-scrollbar>

    <el-drawer
        v-model="mailDrawer.visible"
        class="mail-drawer"
        :size="drawerSize"
        direction="rtl"
        destroy-on-close
        @closed="resetDrawer"
    >
      <template #header>
        <div class="drawer-heading">
          <div class="drawer-mail-icon"><Icon icon="fluent:mail-read-24-regular" width="22" height="22"/></div>
          <div>
            <h2>{{ mailDrawer.mailbox?.email || tr('mailDetails') }}</h2>
            <span>{{ tr('messageTotal', {count: mailDrawer.mailbox?.messageCount || 0}) }}</span>
          </div>
        </div>
      </template>

      <div class="drawer-body" v-loading="mailDrawer.loading">
        <div class="drawer-toolbar">
          <el-button :loading="mailDrawer.loading" @click="loadMessages('initial')">
            <Icon icon="ion:reload" width="15" height="15"/>
            {{ tr('refresh') }}
          </el-button>
          <el-button
              v-if="mailDrawer.mailbox?.codeUrl"
              type="primary"
              plain
              @click="openPublicMailbox(mailDrawer.mailbox)"
          >{{ tr('openRetrievalPage') }}</el-button>
        </div>

        <div v-if="!mailDrawer.loading && !mailDrawer.messages.length" class="drawer-empty">
          <Icon icon="fluent:mail-inbox-24-regular" width="46" height="46"/>
          <strong>{{ tr('noMessages') }}</strong>
          <span>{{ tr('noMessagesDesc') }}</span>
        </div>

        <div v-else class="message-list">
          <article v-for="message in mailDrawer.messages" :key="message.emailId" class="message-card">
            <header class="message-header">
              <div class="message-title">
                <span class="sender-avatar">{{ senderInitial(message.from) }}</span>
                <div>
                  <strong>{{ message.subject || tr('noSubject') }}</strong>
                  <small>{{ message.from || tr('unknownSender') }}</small>
                </div>
              </div>
              <time>{{ formatTime(message.receivedAt) }}</time>
            </header>
            <div v-if="message.verificationCode" class="verification-code">
              <div>
                <span>{{ tr('verificationCode') }}</span>
                <strong>{{ message.verificationCode }}</strong>
              </div>
              <el-button type="primary" plain @click="copyText(message.verificationCode)">
                <Icon icon="fluent-color:clipboard-24" width="16" height="16"/>
                {{ tr('copyCode') }}
              </el-button>
            </div>
            <details v-if="messageBody(message)" class="message-content">
              <summary>{{ tr('viewContent') }}</summary>
              <pre>{{ messageBody(message) }}</pre>
            </details>
            <footer>
              <span>ID {{ message.emailId }}</span>
              <el-button link type="primary" @click="copyMessage(message)">{{ tr('copyMailInfo') }}</el-button>
            </footer>
          </article>
        </div>

        <div v-if="mailDrawer.messages.length" class="message-pagination">
          <el-button :disabled="!mailDrawer.hasNewer || mailDrawer.loading" @click="loadMessages('newer')">
            <Icon icon="ion:chevron-back" width="15" height="15"/>
            {{ tr('newerMail') }}
          </el-button>
          <span>{{ tr('currentMessages', {count: mailDrawer.messages.length}) }}</span>
          <el-button :disabled="!mailDrawer.hasOlder || mailDrawer.loading" @click="loadMessages('older')">
            {{ tr('olderMail') }}
            <Icon icon="ion:chevron-forward" width="15" height="15"/>
          </el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import {computed, nextTick, onMounted, reactive, ref} from 'vue'
import {Icon} from '@iconify/vue'
import {useI18n} from 'vue-i18n'
import {useSettingStore} from '@/store/setting.js'
import {
  ensureManagedMailboxTokens,
  managedMailboxList,
  managedMailboxMessages
} from '@/request/mailbox-management.js'

const {locale} = useI18n()
const settingStore = useSettingStore()

const translations = {
  zh: {
    title: '邮箱管理', subtitle: '集中查看所有邮箱、取件 API 和历史邮件，批量管理更轻松', refresh: '刷新',
    allMailboxes: '全部邮箱', activeOnPage: '本页已有 API', missingOnPage: '本页缺少 API', selectedAcrossPages: '跨页已选择',
    inventory: '所有邮箱', inventoryDesc: '筛选、选择并导出邮箱和专属取件 URL', selectAllFiltered: '选择全部筛选结果',
    clearSelection: '清空选择', searchPlaceholder: '搜索邮箱、备注或 Account ID', allDomains: '全部域名',
    allStatus: '全部状态', apiReady: '已有 API', apiMissing: '缺少 API', search: '查询',
    selectedCount: '已选择 {count} 个邮箱', selectedMissing: '其中 {count} 个缺少 API', createMissingApis: '补齐选中 API',
    copyAllFiltered: '复制全部筛选', exportAllFiltered: '导出全部筛选',
    copySelectedApi: '复制邮箱 + API', exportSelected: '导出 CSV', mailbox: '邮箱', messages: '邮件', latestMail: '最新邮件',
    retrievalApi: '取件 API', actions: '操作', available: '可用', apiCount: '{count} 个 URL', notCreated: '未创建',
    createNow: '立即创建', viewMail: '查看邮件', copyMailboxApi: '复制邮箱 + API', openRetrievalPage: '打开取件页',
    noResults: '没有匹配的邮箱', noResultsDesc: '请调整搜索、域名或 API 状态筛选', selectionRetained: '切换分页不会丢失当前选择',
    mailDetails: '邮箱邮件', messageTotal: '共收到 {count} 封邮件', noMessages: '暂时没有邮件', noMessagesDesc: '收到新邮件后会显示在这里',
    noSubject: '无主题', unknownSender: '未知发件人', verificationCode: '验证码', copyCode: '复制验证码', viewContent: '查看邮件内容',
    copyMailInfo: '复制邮件信息', newerMail: '较新邮件', olderMail: '更早邮件', currentMessages: '当前 {count} 封',
    copied: '已复制', createdApis: '已补齐 {count} 个取件 API', allFilteredSelected: '已选择全部 {count} 个筛选结果',
    exportDone: '已导出 {count} 个邮箱', apiStillMissing: '有 {count} 个邮箱暂时没有取件 API', loadFailed: '加载失败，请重试'
  },
  en: {
    title: 'Mailbox Management', subtitle: 'Manage every mailbox, retrieval API, and message history in one place', refresh: 'Refresh',
    allMailboxes: 'All mailboxes', activeOnPage: 'APIs on page', missingOnPage: 'Missing on page', selectedAcrossPages: 'Selected across pages',
    inventory: 'All Mailboxes', inventoryDesc: 'Filter, select, and export addresses with their private retrieval URLs', selectAllFiltered: 'Select all filtered',
    clearSelection: 'Clear selection', searchPlaceholder: 'Search email, label, or Account ID', allDomains: 'All domains',
    allStatus: 'All statuses', apiReady: 'API ready', apiMissing: 'API missing', search: 'Search',
    selectedCount: '{count} mailboxes selected', selectedMissing: '{count} are missing an API', createMissingApis: 'Create missing APIs',
    copyAllFiltered: 'Copy all filtered', exportAllFiltered: 'Export all filtered',
    copySelectedApi: 'Copy email + API', exportSelected: 'Export CSV', mailbox: 'Mailbox', messages: 'Messages', latestMail: 'Latest mail',
    retrievalApi: 'Retrieval API', actions: 'Actions', available: 'Available', apiCount: '{count} URLs', notCreated: 'Not created',
    createNow: 'Create now', viewMail: 'View mail', copyMailboxApi: 'Copy email + API', openRetrievalPage: 'Open retrieval page',
    noResults: 'No matching mailboxes', noResultsDesc: 'Change the search, domain, or API status filter', selectionRetained: 'Selection is retained when paging',
    mailDetails: 'Mailbox messages', messageTotal: '{count} messages received', noMessages: 'No messages yet', noMessagesDesc: 'New messages will appear here',
    noSubject: 'No subject', unknownSender: 'Unknown sender', verificationCode: 'Verification code', copyCode: 'Copy code', viewContent: 'View message content',
    copyMailInfo: 'Copy mail info', newerMail: 'Newer', olderMail: 'Older', currentMessages: '{count} shown',
    copied: 'Copied', createdApis: 'Created {count} retrieval APIs', allFilteredSelected: 'Selected all {count} filtered mailboxes',
    exportDone: 'Exported {count} mailboxes', apiStillMissing: '{count} mailboxes still have no retrieval API', loadFailed: 'Failed to load. Try again.'
  }
}

function tr(key, values = {}) {
  const lang = String(locale.value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  let text = translations[lang][key] || translations.zh[key] || key
  Object.entries(values).forEach(([name, value]) => {
    text = text.replaceAll(`{${name}}`, String(value))
  })
  return text
}

const loading = ref(false)
const rows = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const draftKeyword = ref('')
const draftDomain = ref('')
const draftTokenStatus = ref('all')
const filters = reactive({keyword: '', domain: '', tokenStatus: 'all'})
const tableRef = ref(null)
const selectedRows = reactive(new Map())
const selectingFiltered = ref(false)
const bulkWorking = ref(false)
const ensuringTokens = ref(false)
const rowCreatingIds = reactive(new Set())

const mailDrawer = reactive({
  visible: false,
  loading: false,
  mailbox: null,
  messages: [],
  hasOlder: false,
  hasNewer: false,
  nextBeforeEmailId: null,
  nextAfterEmailId: null
})

const drawerSize = computed(() => window.innerWidth < 768 ? '100%' : 'min(760px, 68vw)')
const domainOptions = computed(() => [...new Set((settingStore.domainList || [])
    .map(value => String(value?.domain || value?.value || value || '').trim().replace(/^@+/, '').toLowerCase())
    .filter(Boolean))].sort())
const tokenStatusOptions = computed(() => [
  {label: tr('allStatus'), value: 'all'},
  {label: tr('apiReady'), value: 'active'},
  {label: tr('apiMissing'), value: 'missing'}
])
const activeOnPage = computed(() => rows.value.filter(row => row.codeUrl).length)
const missingOnPage = computed(() => rows.value.filter(row => !row.codeUrl).length)
const selectedList = computed(() => Array.from(selectedRows.values()))
const selectedCount = computed(() => selectedRows.size)
const selectedMissingCount = computed(() => selectedList.value.filter(row => !row.codeUrl).length)
const selectedWithUrlCount = computed(() => selectedList.value.filter(row => row.codeUrl).length)

onMounted(loadRows)

function normalizeMailbox(row = {}) {
  const primary = row.primaryToken || row.tokens?.find(token => token?.active !== false) || {}
  return {
    ...row,
    accountId: Number(row.accountId),
    tokenCount: Number(row.tokenCount ?? row.tokens?.length ?? (row.codeUrl ? 1 : 0)) || 0,
    codeUrl: row.codeUrl || primary.codeUrl || primary.url || primary.retrievalUrl || ''
  }
}

async function loadRows() {
  loading.value = true
  try {
    const data = await managedMailboxList({page: page.value, pageSize: pageSize.value, ...filters})
    rows.value = (data?.list || data?.items || []).map(normalizeMailbox)
    total.value = Number(data?.total) || 0
    rows.value.forEach(row => {
      if (selectedRows.has(row.accountId)) selectedRows.set(row.accountId, row)
    })
    await nextTick()
    syncPageSelection()
  } catch (_) {
    ElMessage.error(tr('loadFailed'))
  } finally {
    loading.value = false
  }
}

function reload() {
  return loadRows()
}

function applyFilters() {
  filters.keyword = draftKeyword.value
  filters.domain = draftDomain.value
  filters.tokenStatus = draftTokenStatus.value
  page.value = 1
  loadRows()
}

function handlePageChange(value) {
  page.value = Number(value) || 1
  loadRows()
}

function handlePageSizeChange(value) {
  pageSize.value = Number(value) || 20
  page.value = 1
  loadRows()
}

function handleRowSelect(selection, row) {
  if (selection.some(item => Number(item.accountId) === Number(row.accountId))) selectedRows.set(Number(row.accountId), row)
  else selectedRows.delete(Number(row.accountId))
}

function handleSelectAll(selection) {
  rows.value.forEach(row => selectedRows.delete(Number(row.accountId)))
  selection.forEach(row => selectedRows.set(Number(row.accountId), row))
}

function syncPageSelection() {
  if (!tableRef.value) return
  rows.value.forEach(row => tableRef.value.toggleRowSelection(row, selectedRows.has(Number(row.accountId)), true))
}

function clearSelection() {
  selectedRows.clear()
  tableRef.value?.clearSelection()
}

async function selectAllFiltered() {
  if (!total.value || selectingFiltered.value) return
  selectingFiltered.value = true
  try {
    const expected = total.value
    const batchSize = 100
    const pageCount = Math.ceil(expected / batchSize)
    for (let current = 1; current <= pageCount; current++) {
      const data = await managedMailboxList({page: current, pageSize: batchSize, ...filters})
      const batch = (data?.list || data?.items || []).map(normalizeMailbox)
      batch.forEach(row => selectedRows.set(Number(row.accountId), row))
      if (batch.length < batchSize) break
    }
    syncPageSelection()
    ElMessage.success(tr('allFilteredSelected', {count: selectedCount.value}))
  } finally {
    selectingFiltered.value = false
  }
}

async function ensureRowApi(row) {
  const accountId = Number(row.accountId)
  if (!accountId || rowCreatingIds.has(accountId)) return
  rowCreatingIds.add(accountId)
  try {
    await ensureManagedMailboxTokens([accountId])
    await loadRows()
    ElMessage.success(tr('createdApis', {count: 1}))
  } finally {
    rowCreatingIds.delete(accountId)
  }
}

async function ensureSelectedApis() {
  const ids = selectedList.value.filter(row => !row.codeUrl).map(row => Number(row.accountId)).filter(Boolean)
  if (!ids.length || ensuringTokens.value) return
  ensuringTokens.value = true
  let created = 0
  try {
    for (let index = 0; index < ids.length; index += 100) {
      const result = await ensureManagedMailboxTokens(ids.slice(index, index + 100))
      created += Number(result?.createdCount) || 0
      const changed = result?.list || result?.items || []
      changed.map(normalizeMailbox).forEach(row => {
        const previous = selectedRows.get(row.accountId) || {}
        selectedRows.set(row.accountId, {...previous, ...row})
      })
    }
    await loadRows()
    ElMessage.success(tr('createdApis', {count: created}))
  } finally {
    ensuringTokens.value = false
  }
}

function mailboxApiText(row) {
  return row?.codeUrl ? `${row.email}\t${row.codeUrl}` : ''
}

function copyMailboxApi(row) {
  return copyText(mailboxApiText(row))
}

function copySelected() {
  const available = selectedList.value.filter(row => row.codeUrl)
  const text = available.map(mailboxApiText).join('\n')
  copyText(text)
  if (available.length !== selectedCount.value) {
    ElMessage.warning(tr('apiStillMissing', {count: selectedCount.value - available.length}))
  }
}

/** Fetch every page matching the active server-side filters for an explicit
 * "all filtered" action. Normal table navigation remains paged, while these
 * actions still work when there are more rows than the current page. */
async function fetchAllFilteredRows() {
  const batchSize = 100
  const first = await managedMailboxList({page: 1, pageSize: batchSize, ...filters})
  const firstRows = (first?.list || first?.items || []).map(normalizeMailbox)
  const expected = Number(first?.total) || firstRows.length
  const pageCount = Math.ceil(expected / batchSize)
  const all = [...firstRows]
  for (let current = 2; current <= pageCount; current++) {
    const data = await managedMailboxList({page: current, pageSize: batchSize, ...filters})
    const batch = (data?.list || data?.items || []).map(normalizeMailbox)
    all.push(...batch)
    if (batch.length < batchSize) break
  }
  const unique = new Map()
  all.forEach(row => unique.set(Number(row.accountId), row))
  return Array.from(unique.values())
}

async function copyAllFiltered() {
  if (bulkWorking.value || !total.value) return
  bulkWorking.value = true
  try {
    const all = await fetchAllFilteredRows()
    const available = all.filter(row => row.codeUrl)
    await copyText(available.map(mailboxApiText).join('\n'))
    ElMessage.success(tr('copied'))
    if (available.length !== all.length) {
      ElMessage.warning(tr('apiStillMissing', {count: all.length - available.length}))
    }
  } finally {
    bulkWorking.value = false
  }
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function downloadRows(rowsToExport, message = true) {
  const available = rowsToExport.filter(row => row.codeUrl)
  const lines = [['email', 'retrievalUrl'], ...available.map(row => [row.email, row.codeUrl])]
      .map(columns => columns.map(csvCell).join(','))
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], {type: 'text/csv;charset=utf-8'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `mailbox-apis-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  if (message) ElMessage.success(tr('exportDone', {count: available.length}))
  if (available.length !== rowsToExport.length) {
    ElMessage.warning(tr('apiStillMissing', {count: rowsToExport.length - available.length}))
  }
}

function exportSelected() {
  return downloadRows(selectedList.value)
}

async function exportAllFiltered() {
  if (bulkWorking.value || !total.value) return
  bulkWorking.value = true
  try {
    const all = await fetchAllFilteredRows()
    downloadRows(all)
  } finally {
    bulkWorking.value = false
  }
}

async function copyText(value) {
  if (!value) return
  try {
    await navigator.clipboard.writeText(String(value))
  } catch (_) {
    const textarea = document.createElement('textarea')
    textarea.value = String(value)
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
  ElMessage.success(tr('copied'))
}

function openPublicMailbox(row) {
  if (row?.codeUrl) window.open(row.codeUrl, '_blank', 'noopener,noreferrer')
}

function openMailbox(row) {
  mailDrawer.mailbox = row
  mailDrawer.visible = true
  nextTick(() => loadMessages('initial'))
}

async function loadMessages(direction = 'initial') {
  const accountId = Number(mailDrawer.mailbox?.accountId)
  if (!accountId || mailDrawer.loading) return
  const params = {limit: 20}
  if (direction === 'older') {
    params.beforeEmailId = Number(mailDrawer.nextBeforeEmailId) || minMessageId()
  } else if (direction === 'newer') {
    params.afterEmailId = Number(mailDrawer.nextAfterEmailId) || maxMessageId()
  }
  mailDrawer.loading = true
  try {
    const data = await managedMailboxMessages(accountId, params)
    const body = data?.data && !data?.messages ? data.data : data
    mailDrawer.messages = (body?.messages || body?.list || []).map(message => ({
      ...message,
      emailId: Number(message.emailId),
      verificationCode: String(message.verificationCode || message.code || '')
    }))
    mailDrawer.hasOlder = Boolean(body?.hasOlder ?? body?.hasMore)
    mailDrawer.hasNewer = Boolean(body?.hasNewer)
    mailDrawer.nextBeforeEmailId = body?.nextBeforeEmailId ?? minMessageId()
    mailDrawer.nextAfterEmailId = body?.nextAfterEmailId ?? maxMessageId()
  } finally {
    mailDrawer.loading = false
  }
}

function minMessageId() {
  const ids = mailDrawer.messages.map(message => Number(message.emailId)).filter(Boolean)
  return ids.length ? Math.min(...ids) : undefined
}

function maxMessageId() {
  const ids = mailDrawer.messages.map(message => Number(message.emailId)).filter(Boolean)
  return ids.length ? Math.max(...ids) : undefined
}

function resetDrawer() {
  mailDrawer.mailbox = null
  mailDrawer.messages = []
  mailDrawer.hasOlder = false
  mailDrawer.hasNewer = false
  mailDrawer.nextBeforeEmailId = null
  mailDrawer.nextAfterEmailId = null
}

function senderInitial(value) {
  const sender = String(value || '?').replace(/^.*</, '').replace(/>.*$/, '').trim()
  return sender.charAt(0).toUpperCase() || '?'
}

function messageBody(message) {
  const value = message?.text || message?.content || message?.html || ''
  return String(value).replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s{3,}/g, ' ')
      .trim()
}

function copyMessage(message) {
  const parts = [
    `${tr('mailbox')}: ${mailDrawer.mailbox?.email || ''}`,
    `${tr('noSubject').replace('无', '') || 'Subject'}: ${message.subject || tr('noSubject')}`,
    `${tr('unknownSender').replace('未知', '') || 'From'}: ${message.from || tr('unknownSender')}`,
    message.receivedAt ? `${tr('latestMail')}: ${formatTime(message.receivedAt)}` : '',
    message.verificationCode ? `${tr('verificationCode')}: ${message.verificationCode}` : '',
    messageBody(message)
  ]
  return copyText(parts.filter(Boolean).join('\n'))
}

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(String(locale.value).startsWith('zh') ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(date)
}
</script>

<style lang="scss" scoped>
.mailbox-management-page {
  height: 100%;
  overflow: hidden;
  background:
      radial-gradient(circle at 96% 0%, rgba(24, 144, 255, 0.08), transparent 28%),
      var(--el-bg-color);
}

.page-scroll { height: 100%; }
.page-shell { width: min(1380px, 100%); margin: 0 auto; padding: 24px 24px 48px; }

.hero-panel {
  min-height: 132px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 25px 30px;
  color: #fff;
  border-radius: 18px;
  background:
      radial-gradient(circle at 82% 18%, rgba(255,255,255,.17), transparent 23%),
      linear-gradient(135deg, #1268d3, #1890ff 58%, #2da9ff);
  box-shadow: 0 16px 38px rgba(24, 144, 255, .18);
}

.hero-copy { display: flex; align-items: center; gap: 18px; }
.hero-icon {
  width: 54px; height: 54px; flex: 0 0 54px; display: grid; place-items: center;
  border: 1px solid rgba(255,255,255,.35); border-radius: 16px; background: rgba(255,255,255,.13);
}
.eyebrow { margin-bottom: 4px; font-size: 11px; font-weight: 750; letter-spacing: .13em; opacity: .76; }
.hero-panel h1 { font-size: clamp(24px, 3vw, 34px); line-height: 1.2; }
.hero-panel p { margin-top: 8px; color: rgba(255,255,255,.85); }
.hero-button { color: #fff; border-color: rgba(255,255,255,.45); background: rgba(255,255,255,.13); }
.hero-button:hover { color: #fff; border-color: #fff; background: rgba(255,255,255,.22); }

.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 18px 0; }
.summary-card {
  display: flex; align-items: center; gap: 14px; min-height: 86px; padding: 16px 18px;
  border: 1px solid var(--el-border-color-lighter); border-radius: 14px; background: var(--el-bg-color-overlay);
}
.summary-icon { width: 42px; height: 42px; display: grid; place-items: center; flex: 0 0 42px; border-radius: 12px; }
.summary-icon.blue { color: #1685e8; background: rgba(24,144,255,.11); }
.summary-icon.green { color: #1f9d69; background: rgba(33,186,120,.12); }
.summary-icon.amber { color: #d18b13; background: rgba(230,162,60,.14); }
.summary-icon.violet { color: #8059d7; background: rgba(128,89,215,.12); }
.summary-card div { display: flex; flex-direction: column; min-width: 0; }
.summary-card strong { font-size: 23px; line-height: 1.15; }
.summary-card span:last-child { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }

.management-panel {
  padding: 22px; border: 1px solid var(--el-border-color-lighter); border-radius: 16px;
  background: var(--el-bg-color-overlay); box-shadow: 0 10px 32px rgba(18,55,94,.06);
}
.panel-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 18px; }
.panel-heading h2 { font-size: 20px; }
.panel-heading p { margin-top: 4px; color: var(--el-text-color-secondary); }
.panel-actions, .selection-actions, .row-actions { display: flex; align-items: center; gap: 8px; }

.filter-bar {
  display: grid; grid-template-columns: minmax(240px, 1fr) 190px auto auto; gap: 10px; align-items: center;
  padding: 13px; margin-bottom: 14px; border-radius: 12px; background: var(--el-fill-color-light);
}
.status-segmented { min-width: 285px; }

.selection-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; padding: 11px 14px;
  border: 1px solid var(--el-color-primary-light-7); border-radius: 11px; background: var(--el-color-primary-light-9);
}
.selection-copy { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.selection-count { color: var(--el-color-primary-dark-2); font-weight: 650; }
.selection-missing { color: var(--el-color-warning-dark-2); font-size: 12px; }

.mailbox-table { width: 100%; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; overflow: hidden; }
.mailbox-cell { display: flex; align-items: center; gap: 11px; min-width: 0; }
.mail-avatar, .sender-avatar {
  display: grid; place-items: center; flex: 0 0 auto; color: #1474cf; background: var(--el-color-primary-light-9); font-weight: 750;
}
.mail-avatar { width: 34px; height: 34px; border-radius: 10px; }
.mailbox-identity { display: flex; flex-direction: column; min-width: 0; }
.mailbox-identity strong { overflow: hidden; color: var(--el-text-color-primary); text-overflow: ellipsis; white-space: nowrap; }
.mailbox-identity small { display: flex; gap: 8px; margin-top: 2px; color: var(--el-text-color-secondary); }
.message-count {
  min-width: 38px; padding: 4px 10px; color: var(--el-color-primary); border-radius: 999px; background: var(--el-color-primary-light-9); cursor: pointer;
}
.time-cell { color: var(--el-text-color-regular); font-size: 13px; }
.api-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.api-status-line { display: flex; align-items: center; gap: 8px; }
.api-status-line small { color: var(--el-text-color-secondary); }
.api-url { display: flex; align-items: center; gap: 7px; max-width: 100%; color: var(--el-text-color-regular); cursor: pointer; }
.api-url code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.api-url:hover code { color: var(--el-color-primary); }
.missing-api { display: flex; align-items: center; gap: 8px; }
.empty-state { min-height: 210px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--el-text-color-secondary); }
.empty-state strong { margin-top: 10px; color: var(--el-text-color-primary); }
.empty-state span { margin-top: 4px; }

.pagination-row { display: flex; justify-content: flex-end; align-items: center; gap: 18px; margin-top: 18px; }
.cross-page-note { margin-right: auto; color: var(--el-text-color-secondary); font-size: 12px; }

.drawer-heading { display: flex; align-items: center; gap: 11px; min-width: 0; }
.drawer-mail-icon { width: 42px; height: 42px; display: grid; place-items: center; color: var(--el-color-primary); border-radius: 12px; background: var(--el-color-primary-light-9); }
.drawer-heading h2 { overflow: hidden; max-width: 520px; font-size: 18px; text-overflow: ellipsis; white-space: nowrap; }
.drawer-heading span { color: var(--el-text-color-secondary); font-size: 12px; }
.drawer-body { min-height: 300px; padding-bottom: 28px; }
.drawer-toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; }
.drawer-empty { min-height: 330px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--el-text-color-secondary); }
.drawer-empty strong { margin-top: 12px; color: var(--el-text-color-primary); }
.drawer-empty span { margin-top: 4px; }
.message-list { display: flex; flex-direction: column; gap: 12px; }
.message-card { padding: 15px; border: 1px solid var(--el-border-color-lighter); border-radius: 13px; background: var(--el-fill-color-blank); }
.message-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.message-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sender-avatar { width: 36px; height: 36px; border-radius: 50%; }
.message-title div { display: flex; flex-direction: column; min-width: 0; }
.message-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-title small, .message-header time { color: var(--el-text-color-secondary); font-size: 12px; }
.message-header time { white-space: nowrap; }
.verification-code {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 13px; padding: 12px 14px;
  border-radius: 10px; background: linear-gradient(135deg, var(--el-color-primary-light-9), rgba(64,158,255,.04));
}
.verification-code div { display: flex; flex-direction: column; }
.verification-code span { color: var(--el-text-color-secondary); font-size: 11px; }
.verification-code strong { color: var(--el-color-primary); font-size: 24px; letter-spacing: .08em; }
.message-content { margin-top: 12px; border-top: 1px dashed var(--el-border-color); padding-top: 10px; }
.message-content summary { color: var(--el-color-primary); cursor: pointer; user-select: none; }
.message-content pre { max-height: 240px; margin-top: 10px; padding: 11px; overflow: auto; white-space: pre-wrap; word-break: break-word; border-radius: 8px; background: var(--el-fill-color-light); font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
.message-card footer { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; color: var(--el-text-color-secondary); font-size: 11px; }
.message-pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 16px; }
.message-pagination span { color: var(--el-text-color-secondary); font-size: 12px; }

:deep(.el-table__inner-wrapper::before) { display: none; }
:deep(.el-drawer__header) { margin-bottom: 0; padding-bottom: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
:deep(.el-drawer__body) { padding-top: 16px; }

@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .filter-bar { grid-template-columns: minmax(220px, 1fr) 180px; }
  .status-segmented { min-width: 0; }
}

@media (max-width: 700px) {
  .page-shell { padding: 14px 12px 32px; }
  .hero-panel { align-items: flex-start; padding: 21px 18px; border-radius: 14px; }
  .hero-icon, .hero-actions { display: none; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
  .summary-card { min-height: 74px; padding: 12px; gap: 9px; }
  .summary-icon { width: 35px; height: 35px; flex-basis: 35px; }
  .summary-card strong { font-size: 19px; }
  .management-panel { padding: 14px 10px; border-radius: 13px; }
  .panel-heading, .selection-bar { align-items: stretch; flex-direction: column; }
  .panel-actions, .selection-actions { flex-wrap: wrap; }
  .filter-bar { grid-template-columns: 1fr; }
  .keyword-input, .domain-select, .status-segmented { width: 100%; }
  .pagination-row { justify-content: center; overflow-x: auto; }
  .cross-page-note { display: none; }
  .message-header { flex-direction: column; }
  .verification-code strong { font-size: 21px; }
}
</style>
