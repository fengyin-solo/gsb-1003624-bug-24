<template>
  <section class="recovery-panel">
    <header class="panel-head">
      <h3>恢复记录</h3>
      <span class="panel-tip">待恢复 {{ pendingCount }} 条 · 在途批次 {{ activeBatchTotal }} 批</span>
    </header>

    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>来源</th>
          <th>编号</th>
          <th>原维护日期</th>
          <th>植被恢复程度</th>
          <th>状态</th>
          <th>恢复确认时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="batch in batches" :key="batch.id">
          <tr
            v-for="(item, index) in batch.items"
            :key="`${batch.id}-${item.module}-${item.itemId}`"
            :class="{ 'row-pending': item.recoveredAt === null }"
          >
            <td>{{ index === 0 ? batch.id : '〃' }}</td>
            <td>{{ item.module === 'firebreak' ? '防火隔离带' : '防火林带' }}</td>
            <td>{{ codeOf(item.module, item.itemId) }}</td>
            <td>{{ batch.maintenanceDate || '—' }}</td>
            <td>{{ item.recoveredAt === null ? '待恢复' : `${item.recovery}%` }}</td>
            <td>{{ item.recoveredAt === null ? '待恢复' : '已恢复' }}</td>
            <td>{{ item.recoveredAt ? formatTime(item.recoveredAt) : '—' }}</td>
            <td class="row-actions">
              <button
                v-if="item.recoveredAt === null && batch.confirmedAt === null"
                class="link"
                type="button"
                :disabled="confirmingKey === `${batch.id}`"
                @click="askRecover(batch.id)"
              >
                {{ confirmingKey === batch.id ? '提交中…' : '确认恢复' }}
              </button>
              <span v-else-if="batch.confirmedAt !== null && item.recoveredAt !== null" class="muted-text">结果已登记</span>
              <span v-else class="muted-text">—</span>
            </td>
          </tr>
        </template>
        <tr v-if="!batches.length">
          <td colspan="8" class="empty-state">暂无维护/恢复批次记录</td>
        </tr>
      </tbody>
    </table>

    <div v-if="recoverTarget" class="modal-mask" @click.self="cancelRecover">
      <form class="modal-card small" @submit.prevent="submitRecover">
        <header class="modal-head">
          <h3>确认批次恢复</h3>
          <button class="link" type="button" @click="cancelRecover">关闭</button>
        </header>
        <div class="modal-body">
          <p class="modal-tip">
            批次 {{ recoverTarget }} 一次性整批确认，恢复结果只接受一次；原维护日期不会改动。
          </p>
          <label class="modal-field">
            <span>植被恢复程度（0-100）</span>
            <input v-model.number="recoveryValue" type="number" min="0" max="100" step="1" required />
          </label>
          <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
        </div>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="cancelRecover">取消</button>
          <button class="btn primary" type="submit">确认恢复</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { activeBatchCount, confirmRecovery, listBatches, mergedRows } from '@/data/maintenance/store'
import type { MaintenanceModuleKey } from '@/data/maintenance/types'

const props = defineProps<{
  /** 不传显示两个模块；从隔离带/林带页面打开时只看本模块的批次。 */
  module?: MaintenanceModuleKey
  /** 数据版本号：每次写操作后由父组件 +1，驱动重新取数。 */
  revision: number
}>()

const emit = defineEmits<{
  (event: 'recovered'): void
  (event: 'failed', message: string): void
}>()

const confirmingKey = ref<string | null>(null)
const recoverTarget = ref<string | null>(null)
const recoveryValue = ref<number>(90)
const errorMessage = ref('')

const batches = computed(() => {
  void props.revision
  const all = listBatches()
  const filtered = props.module
    ? all.filter((batch) => batch.modules.includes(props.module as MaintenanceModuleKey))
      // 只展示与本模块有关的明细。
      .map((batch) => ({
        ...batch,
        items: batch.items.filter((item) => item.module === props.module),
      }))
      .filter((batch) => batch.items.length > 0)
    : all
  return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})

const pendingCount = computed(() =>
  batches.value.reduce(
    (sum, batch) => sum + batch.items.filter((item) => item.recoveredAt === null).length,
    0,
  ),
)

const activeBatchTotal = computed(() => {
  void props.revision
  return activeBatchCount()
})

const codeCache = computed(() => {
  void props.revision
  const map = new Map<string, string>()
  for (const module of ['firebreak', 'firebelt'] as MaintenanceModuleKey[]) {
    for (const row of mergedRows(module)) {
      const field = module === 'firebreak' ? '隔离带编号' : '林带编号'
      map.set(`${module}:${row.id}`, String(row[field] ?? row.id))
    }
  }
  return map
})

function codeOf(module: MaintenanceModuleKey, itemId: number): string {
  return codeCache.value.get(`${module}:${itemId}`) ?? String(itemId)
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

function askRecover(batchId: string) {
  recoverTarget.value = batchId
  recoveryValue.value = 90
  errorMessage.value = ''
}

function cancelRecover() {
  recoverTarget.value = null
  errorMessage.value = ''
}

async function submitRecover() {
  if (!recoverTarget.value || confirmingKey.value) {
    return
  }
  const batchId = recoverTarget.value
  confirmingKey.value = batchId
  errorMessage.value = ''
  // 先让两个入口同时触发的第二次点击拿到禁用态；真正的互斥由引擎的批次状态兜底。
  await Promise.resolve()
  try {
    confirmRecovery({ batchId, recovery: Math.round(Number(recoveryValue.value)) })
    recoverTarget.value = null
    emit('recovered')
  } catch (error) {
    // 批次已确认/并发的第二个结果：不接受，提示并保持数据原样。
    errorMessage.value = error instanceof Error ? error.message : '恢复确认失败'
    emit('failed', errorMessage.value)
  } finally {
    confirmingKey.value = null
  }
}
</script>
