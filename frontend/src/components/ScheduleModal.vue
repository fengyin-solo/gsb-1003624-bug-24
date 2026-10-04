<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <form class="modal-card" @submit.prevent="submit">
      <header class="modal-head">
        <h3>批量安排维护</h3>
        <button class="link" type="button" @click="close">关闭</button>
      </header>

      <div class="modal-body">
        <p class="modal-tip">隔离带与林带在同一次提交里只会生成一个批次；任一对象校验不过，整批退回不落库。</p>

        <table class="data-table select-table">
          <thead>
            <tr>
              <th class="col-check"><input type="checkbox" :checked="allChecked" :disabled="!!props.preset" @change="toggleAll" /></th>
              <th>来源</th>
              <th>编号</th>
              <th>所属林区</th>
              <th>当前状态</th>
              <th>在途批次</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in candidates" :key="`${row.module}-${row.id}`" :class="{ 'row-disabled': row.busy }">
              <td class="col-check">
                <input
                  type="checkbox"
                  :checked="isChecked(row)"
                  :disabled="row.busy || !!props.preset"
                  @change="toggle(row)"
                />
              </td>
              <td>{{ row.module === 'firebreak' ? '防火隔离带' : '防火林带' }}</td>
              <td>{{ row.code }}</td>
              <td>{{ row.area }}</td>
              <td>{{ row.status }}</td>
              <td>{{ row.busy ? '待恢复' : '—' }}</td>
            </tr>
            <tr v-if="!candidates.length">
              <td colspan="6" class="empty-state">暂无可安排维护的对象</td>
            </tr>
          </tbody>
        </table>

        <label class="modal-field">
          <span>维护日期</span>
          <input v-model="maintenanceDate" type="date" required />
        </label>
        <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
      </div>

      <footer class="modal-foot">
        <button class="btn" type="button" @click="close">取消</button>
        <button class="btn primary" type="submit" :disabled="submitting || checkedCount === 0">
          {{ submitting ? '提交中…' : `提交（已选 ${checkedCount} 条）` }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { mergedRows } from '@/data/maintenance/store'
import type { MaintenanceModuleKey } from '@/data/maintenance/types'

type Candidate = {
  module: MaintenanceModuleKey
  id: number
  code: string
  area: string
  status: string
  busy: boolean
}

const props = defineProps<{
  open: boolean
  /** 为单一模块时只列该模块；从「批量维护」入口打开时两个模块都列。 */
  modules: MaintenanceModuleKey[]
  /** 单条「安排维护」入口时预选并锁定该对象。 */
  preset?: { module: MaintenanceModuleKey; itemId: number } | null
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (
    event: 'submit',
    payload: {
      selections: { module: MaintenanceModuleKey; itemIds: number[] }[]
      maintenanceDate: string
    },
  ): void
}>()

const today = () => new Date().toISOString().slice(0, 10)
const maintenanceDate = ref(today())
const errorMessage = ref('')
const submitting = ref(false)

const candidates = computed<Candidate[]>(() => {
  return props.modules.flatMap((module) =>
    mergedRows(module).map((row) => ({
      module,
      id: Number(row.id),
      code: String(row[module === 'firebreak' ? '隔离带编号' : '林带编号'] ?? ''),
      area: String(row.所属林区 ?? ''),
      status: String(row.status),
      // pending 由在途批次派生：已在某批待恢复的对象不能重复安排。
      busy: Boolean(row.pending),
    })),
  )
})

const checked = ref<Set<string>>(new Set())
const isChecked = (row: Candidate) => checked.value.has(`${row.module}-${row.id}`)
const checkedCount = computed(() => checked.value.size)

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return
    }
    errorMessage.value = ''
    maintenanceDate.value = today()
    // 单条「安排维护」入口：预选并只保留这一条；批量入口：清空勾选等用户选择。
    checked.value = props.preset ? new Set([`${props.preset.module}-${props.preset.itemId}`]) : new Set()
  },
)
const allChecked = computed(
  () => candidates.value.filter((row) => !row.busy).length > 0 &&
    candidates.value.filter((row) => !row.busy).every((row) => isChecked(row)),
)

function toggle(row: Candidate) {
  const key = `${row.module}-${row.id}`
  const next = new Set(checked.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  checked.value = next
}

function toggleAll(event: Event) {
  const selected = (event.target as HTMLInputElement).checked
  checked.value = new Set(
    selected ? candidates.value.filter((row) => !row.busy).map((row) => `${row.module}-${row.id}`) : [],
  )
}

function selections() {
  const grouped = new Map<MaintenanceModuleKey, number[]>()
  for (const key of checked.value) {
    const splitAt = key.lastIndexOf('-')
    const mod = key.slice(0, splitAt) as MaintenanceModuleKey
    const itemId = Number(key.slice(splitAt + 1))
    const list = grouped.get(mod) ?? []
    list.push(itemId)
    grouped.set(mod, list)
  }
  return [...grouped.entries()].map(([module, itemIds]) => ({ module, itemIds }))
}

function submit() {
  errorMessage.value = ''
  const payload = selections()
  if (payload.length === 0) {
    errorMessage.value = '请至少勾选一条记录'
    return
  }
  submitting.value = true
  try {
    emit('submit', { selections: payload, maintenanceDate: maintenanceDate.value })
    close()
  } finally {
    submitting.value = false
  }
}

function close() {
  errorMessage.value = ''
  emit('close')
}

defineExpose({
  reset() {
    checked.value = new Set()
    maintenanceDate.value = today()
    errorMessage.value = ''
  },
})
</script>
