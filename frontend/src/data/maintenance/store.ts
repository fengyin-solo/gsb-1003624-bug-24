import { listRows, resetRows, saveRows, storageKey } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import {
  MAINTENANCE_MODULES,
  MODULE_CONFIG,
  abandonItem as abandonItemInState,
  activeItemFor,
  bootstrapLegacy,
  emptyState,
  isBatchActive,
  normalizeState,
  pendingRefs,
  recoverBatch as recoverBatchInState,
  scheduleMaintenance as scheduleInState,
} from './engine'
import type {
  MaintenanceBatch,
  MaintenanceModuleKey,
  MaintenanceState,
  RecoverInput,
  ScheduleInput,
} from './types'

// 维护—恢复数据独立存放，避免和通用条目数据互相覆盖。
const STORAGE_KEY = 'forest-fire-patrol:maintenance'

function persist(state: MaintenanceState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

function readState(): MaintenanceState {
  let state = emptyState()
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        state = normalizeState(JSON.parse(raw))
      } catch {
        state = emptyState()
      }
    }
  }
  // 基础数据里天生待维护、却没有批次的历史行，补录成 legacy 批次（按原维护日期）。
  const baseRows = {
    firebreak: listRows('firebreak'),
    firebelt: listRows('firebelt'),
  }
  const next = bootstrapLegacy(state, baseRows, new Date().toISOString())
  if (next !== state) {
    persist(next)
  }
  return next
}

let cache: MaintenanceState | null = null

function state(): MaintenanceState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export function maintenanceState(): MaintenanceState {
  return state()
}

export function listBatches(): MaintenanceBatch[] {
  return state().batches
}

/** 待恢复对象（去重后）——列表统计、批量入口、恢复记录三处都从这一个口径取数。 */
export function listPendingRefs() {
  return pendingRefs(state())
}

/**
 * 合并后的模块行：隔离带/林带列表只从这里取数。
 * 最近维护日期、植被恢复程度、维护状态、pending 全部由在途/历史批次派生，
 * 不再直接读基础行上可能残留旧批次的值。
 */
export function mergedRows(module: MaintenanceModuleKey): EntryRow[] {
  const current = state()
  return listRows(module).map((row) => {
    const active = activeItemFor(current, module, Number(row.id))
    const next: EntryRow = { ...row }
    // pending 只认在途批次；legacy 未补录的行不会被算成待恢复，三处口径由此统一。
    next.pending = Boolean(active)
    if (active) {
      next.status = active.item.pendingStatus
      // 安排维护后到恢复前，植被恢复值不残留上一批次。
      next.植被恢复程度 = '待恢复'
      next.最近维护日期 = active.batch.maintenanceDate || String(row.最近维护日期 ?? '')
      next.abnormal = false
    }
    if (module === 'firebreak') {
      next.维护状态 = String(next.status)
    } else {
      next.林带状态 = String(next.status)
    }
    return next
  })
}

/** 带回退的多模块提交：批次状态与涉及到的基础行一起落库，任一步失败整体退回。 */
function commitWithRows(next: MaintenanceState, rowPatch: Partial<Record<MaintenanceModuleKey, EntryRow[]>>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    const maintenanceSnapshot = window.localStorage.getItem(STORAGE_KEY)
    const entriesSnapshot = window.localStorage.getItem(storageKey())
    try {
      persist(next)
      for (const [module, rows] of Object.entries(rowPatch) as [MaintenanceModuleKey, EntryRow[]][]) {
        saveRows(module, rows)
      }
      cache = next
    } catch (error) {
      if (maintenanceSnapshot === null) {
        window.localStorage.removeItem(STORAGE_KEY)
      } else {
        window.localStorage.setItem(STORAGE_KEY, maintenanceSnapshot)
      }
      if (entriesSnapshot === null) {
        window.localStorage.removeItem(storageKey())
      } else {
        window.localStorage.setItem(storageKey(), entriesSnapshot)
      }
      throw error
    }
    return
  }
  for (const [module, rows] of Object.entries(rowPatch) as [MaintenanceModuleKey, EntryRow[]][]) {
    saveRows(module, rows)
  }
  cache = next
}

function getBaseStatus(module: MaintenanceModuleKey, itemId: number): string | undefined {
  // 合并后的状态才是「当前」状态（基础行可能已被在途批次改写）。
  const row = mergedRows(module).find((candidate) => Number(candidate.id) === itemId)
  return row ? String(row.status) : undefined
}

/** 安排维护：纯函数先推演，成功才一次性提交；失败抛错，缓存与 localStorage 都不动。 */
export function scheduleMaintenance(input: ScheduleInput): MaintenanceBatch {
  const current = state()
  const { state: next, batch, reused } = scheduleInState(current, input, getBaseStatus)
  if (reused) {
    // 同批重复提交：直接返回已有批次，不再动任何基础行。
    return batch
  }

  const rowPatch: Partial<Record<MaintenanceModuleKey, EntryRow[]>> = {}
  for (const module of MAINTENANCE_MODULES) {
    const touchedIds = new Set(
      batch.items.filter((item) => item.module === module).map((item) => item.itemId),
    )
    if (touchedIds.size === 0) {
      continue
    }
    const pendingStatus = MODULE_CONFIG[module].pendingStatus
    rowPatch[module] = listRows(module).map((row) => {
      if (!touchedIds.has(Number(row.id))) {
        return row
      }
      const updated: EntryRow = {
        ...row,
        status: pendingStatus,
        pending: true,
        abnormal: false,
      }
      if (module === 'firebreak') {
        // 安排时把批次日期写到最近维护日期；确认恢复时不再改写（原维护日期保持原样）。
        updated.最近维护日期 = batch.maintenanceDate
        // 新批次安排后清空上一批残留的植被恢复值。
        updated.植被恢复程度 = '待恢复'
        updated.维护状态 = pendingStatus
      } else {
        updated.林带状态 = pendingStatus
      }
      return updated
    })
  }

  commitWithRows(next, rowPatch)
  return batch
}

/** 确认恢复：整批落库；批次已确认/不存在时抛错，第二个入口的重复结果不接受。 */
export function confirmRecovery(input: RecoverInput): MaintenanceBatch {
  const current = state()
  const { state: next, batch } = recoverBatchInState(current, input)

  // 恢复结果同步回基础行：状态恢复正常，维护日期保持批次上的原维护日期。
  const rowPatch: Partial<Record<MaintenanceModuleKey, EntryRow[]>> = {}
  for (const module of MAINTENANCE_MODULES) {
    const touched = batch.items.filter((item) => item.module === module)
    if (touched.length === 0) {
      continue
    }
    const rows = listRows(module)
    let changed = false
    rowPatch[module] = rows.map((row) => {
      const item = touched.find((candidate) => candidate.itemId === Number(row.id))
      if (!item) {
        return row
      }
      changed = true
      const updated: EntryRow = {
        ...row,
        status: module === 'firebreak' ? '正常' : '完好',
        pending: false,
        abnormal: false,
      }
      if (module === 'firebreak') {
        // 原维护日期保持原样：批次里记的哪天就是哪天，恢复时不改写。
        updated.最近维护日期 = batch.maintenanceDate || String(row.最近维护日期 ?? '')
        updated.植被恢复程度 = `${item.recovery ?? 0}%`
        updated.维护状态 = '正常'
      } else {
        updated.林带状态 = '完好'
      }
      return updated
    })
    if (!changed) {
      delete rowPatch[module]
    }
  }

  commitWithRows(next, rowPatch)
  return batch
}

/**
 * 标记荒废/退化：基础行落终止态，在途维护提醒一起回退（从批次摘掉）。
 * 批次与基础行在同一个事务里提交，任意一边失败两边都不动。
 */
export function markAbandoned(module: MaintenanceModuleKey, itemId: number): void {
  const current = state()
  const rows = listRows(module)
  const index = rows.findIndex((row) => Number(row.id) === itemId)
  if (index < 0) {
    throw new Error(`没有找到编号为 ${itemId} 的${module === 'firebreak' ? '防火隔离带' : '防火林带'}`)
  }
  const status = MODULE_CONFIG[module].terminalStatus
  const nextRows = rows.slice()
  nextRows[index] = {
    ...nextRows[index],
    status,
    pending: false,
    abnormal: true,
    ...(module === 'firebreak' ? { 维护状态: status } : { 林带状态: status }),
  }
  const nextState = abandonItemInState(current, module, itemId)
  commitWithRows(nextState, { [module]: nextRows })
}

export function resetMaintenance(): void {
  cache = emptyState()
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STORAGE_KEY)
  }
  resetRows('firebreak')
  resetRows('firebelt')
  cache = readState()
}

/** 找到某对象当前在途（待恢复）的批次；行内按钮与恢复面板共用同一入口。 */
export function activeBatchOf(module: MaintenanceModuleKey, itemId: number): MaintenanceBatch | null {
  return activeItemFor(state(), module, itemId)?.batch ?? null
}

export function activeBatchCount(): number {
  return state().batches.filter(isBatchActive).length
}
