<template>
  <section class="page" data-module="firebreak">
    <header class="page-head">
      <div>
        <h2>防火隔离带管理</h2>
        <p class="page-desc">维护防火隔离带，围绕隔离带编号、所属林区、起止坐标、带宽米数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火隔离带</button>
        <button class="btn" type="button" @click="exportRows">导出防火隔离带清单</button>
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

    <section v-if="reminders.length" class="panel">
      <header class="panel-head">
        <h3>维护提醒</h3>
      </header>
      <ul class="reminder-list">
        <li v-for="reminder in reminders" :key="reminder.id">
          {{ reminder.createdAt }} · {{ reminder.message }}
        </li>
      </ul>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <span>已勾选 {{ selectedIds.length }} 条</span>
      <label class="filter-item">
        <span>维护日期</span>
        <input v-model="maintenanceDate" type="date" />
      </label>
      <button class="btn primary" type="button" :disabled="!selectedIds.length" @click="scheduleBatch">
        批量安排维护
      </button>
      <button class="btn ghost" type="button" :disabled="!selectedIds.length" @click="clearSelection">
        清空选择
      </button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              :checked="allSelected"
              :disabled="!rows.length"
              @change="toggleSelectAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selectedIds.includes(Number(row.id))"
              @change="toggleSelect(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无防火隔离带数据，可先登记防火隔离带</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <header class="panel-head">
        <h3>维护批次</h3>
        <div class="panel-actions">
          <label class="filter-item">
            <span>植被恢复程度</span>
            <input v-model="vegetation" placeholder="恢复良好" />
          </label>
        </div>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>维护日期</th>
            <th>条数</th>
            <th>已恢复</th>
            <th>待恢复</th>
            <th>批次状态</th>
            <th>创建时间</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="batch in batches" :key="batch.id">
            <td>{{ batch.batchNo }}</td>
            <td>{{ batch.maintenanceDate }}</td>
            <td>{{ batch.entryIds.length }}</td>
            <td>{{ batch.restoredEntryIds.length }}</td>
            <td>{{ batch.entryIds.length - batch.restoredEntryIds.length }}</td>
            <td>{{ batch.status }}</td>
            <td>{{ batch.createdAt }}</td>
            <td class="row-actions">
              <template v-if="batch.status === '待恢复'">
                <button class="link" type="button" @click="confirmRestoreBatch(batch.id)">确认恢复</button>
                <button class="link" type="button" @click="confirmRollbackBatch(batch.id)">退回批次</button>
              </template>
              <span v-else>—</span>
            </td>
          </tr>
          <tr v-if="!batches.length">
            <td colspan="8" class="empty-state">暂无维护批次，勾选记录后点击「批量安排维护」</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="panel">
      <header class="panel-head">
        <h3>恢复记录</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>隔离带编号</th>
            <th>植被恢复程度</th>
            <th>恢复时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in restorations" :key="record.id">
            <td>{{ record.batchNo }}</td>
            <td>{{ record.entryLabel }}</td>
            <td>{{ record.vegetation }}</td>
            <td>{{ record.restoredAt }}</td>
          </tr>
          <tr v-if="!restorations.length">
            <td colspan="4" class="empty-state">暂无恢复记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火隔离带记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listBatches,
  listEntries,
  listReminders,
  listRestorations,
  moduleMeta,
  pendingRestorationCount,
  restoreBatch,
  rollbackBatch,
  runAction as applyAction,
  scheduleMaintenanceBatch,
} from '@/api/local-service'
import type { EntryRow, MaintenanceBatch, MaintenanceReminder, RestorationRecord } from '@/data/types'

const meta = moduleMeta('firebreak')
const columns = ["隔离带编号", "所属林区", "起止坐标", "带宽米数", "建成日期", "最近维护日期", "植被恢复程度", "维护状态"]
const actions = ["安排维护", "确认恢复", "标记荒废"]
const statuses = ["正常", "需割草", "需补植", "已荒废"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const maintenanceDate = ref(new Date().toISOString().slice(0, 10))
const vegetation = ref('恢复良好')
const batches = ref<MaintenanceBatch[]>([])
const restorations = ref<RestorationRecord[]>([])
const reminders = ref<MaintenanceReminder[]>([])
const pendingCount = ref(0)

const stats = computed(() => [
  { label: '隔离带条数', value: total.value },
  { label: '需维护条数', value: rows.value.filter((row) => ['需割草', '需补植'].includes(String(row.status))).length },
  { label: '待恢复条数', value: pendingCount.value },
  { label: '荒废条数', value: rows.value.filter((row) => String(row.status) === '已荒废').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)

function toggleSelect(id: number) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value ? [] : rows.value.map((row) => Number(row.id))
}

function clearSelection() {
  selectedIds.value = []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火隔离带登记入口尚未接入审批流'
}

function scheduleBatch() {
  errorMessage.value = ''
  const result = scheduleMaintenanceBatch(meta.key, selectedIds.value, maintenanceDate.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  if (result.created) {
    clearSelection()
  }
  reload()
}

function confirmRestoreBatch(batchId: number) {
  errorMessage.value = ''
  const result = restoreBatch(meta.key, batchId, vegetation.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function confirmRollbackBatch(batchId: number) {
  errorMessage.value = ''
  const result = rollbackBatch(meta.key, batchId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    batches.value = listBatches(meta.key)
    restorations.value = listRestorations(meta.key)
    reminders.value = listReminders(meta.key)
    pendingCount.value = pendingRestorationCount(meta.key)
    selectedIds.value = selectedIds.value.filter((id) =>
      payload.items.some((row) => Number(row.id) === id),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火隔离带列表读取失败'
  }
}

onMounted(reload)
</script>
