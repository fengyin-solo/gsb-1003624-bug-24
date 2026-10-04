<template>
  <section class="page" data-module="firebelt">
    <header class="page-head">
      <div>
        <h2>防火林带管理</h2>
        <p class="page-desc">维护防火林带，围绕林带编号、林带名称、所属林区、树种组成做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openBatchSchedule">批量安排补植</button>
        <button class="btn" type="button" @click="exportRows">导出防火林带清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="row.pending" @click="scheduleOne(row)">安排补植</button>
            <button class="link" type="button" :disabled="!row.pending" @click="recoverOne(row)">
              确认补植
            </button>
            <button class="link" type="button" :disabled="row.status === '已退化'" @click="abandonOne(row)">标记退化</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火林带数据，可先登记防火林带</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火林带记录 · 待恢复 {{ pending }} 条（与批量入口、恢复记录同源）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <ScheduleModal
      :open="scheduleOpen"
      :modules="['firebelt']"
      :preset="preset"
      @close="scheduleOpen = false"
      @submit="handleScheduleSubmit"
    />

    <RecoveryPanel
      class="panel-gap"
      module="firebelt"
      :revision="revision"
      @recovered="reload"
      @failed="(message: string) => (errorMessage = message)"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  abandon,
  findActiveBatch,
  maintenanceRows,
  pendingTotal,
  submitRecovery,
  submitSchedule,
} from '@/api/maintenance-service'
import ScheduleModal from '@/components/ScheduleModal.vue'
import RecoveryPanel from '@/components/RecoveryPanel.vue'
import type { EntryRow } from '@/data/types'
import type { MaintenanceModuleKey, ScheduleSelection } from '@/data/maintenance/types'

const MODULE: MaintenanceModuleKey = 'firebelt'
const meta = moduleMeta(MODULE)
const columns = ["林带编号", "林带名称", "所属林区", "树种组成", "林带长度", "林带宽度", "种植年份", "林带状态"]
const statuses = ["完好", "有缺株", "需补植", "已退化"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const pending = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const revision = ref(0)
const scheduleOpen = ref(false)
const preset = ref<{ module: MaintenanceModuleKey; itemId: number } | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '林带总数', value: total.value },
  { label: '完好条数', value: rows.value.filter((row) => row.status === '完好').length },
  { label: '缺株条数', value: rows.value.filter((row) => row.status === '有缺株').length },
  { label: '待恢复条数', value: pending.value },
])

function applyFilters(items: EntryRow[]): EntryRow[] {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return items
  }
  return items.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  revision.value += 1
  rows.value = applyFilters(maintenanceRows(MODULE))
  total.value = maintenanceRows(MODULE).length
  pending.value = pendingTotal(MODULE)
}

function openBatchSchedule() {
  preset.value = null
  scheduleOpen.value = true
}

function scheduleOne(row: EntryRow) {
  preset.value = { module: MODULE, itemId: Number(row.id) }
  scheduleOpen.value = true
}

function handleScheduleSubmit(payload: {
  selections: ScheduleSelection[]
  maintenanceDate: string
}) {
  const result = submitSchedule(payload.selections, payload.maintenanceDate)
  scheduleOpen.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function recoverOne(row: EntryRow) {
  const found = findActiveBatch(MODULE, Number(row.id))
  if (!found) {
    errorMessage.value = '该林带没有待恢复的补植批次'
    return
  }
  const recoveryInput = window.prompt(`批次 ${found.batchId}：请输入植被恢复程度（0-100）`, '90')
  if (recoveryInput === null) {
    return
  }
  const recovery = Number(recoveryInput)
  if (!Number.isInteger(recovery) || recovery < 0 || recovery > 100) {
    errorMessage.value = '植被恢复程度需为 0-100 的整数'
    return
  }
  const result = submitRecovery(found.batchId, recovery)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function abandonOne(row: EntryRow) {
  const result = abandon(MODULE, Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

onMounted(reload)
</script>
