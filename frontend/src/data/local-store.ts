import { SEED_MAINTENANCE, SEED_ROWS } from './seed'
import type { EntryRow, MaintenanceBatch, MaintenanceState, RestorationRecord } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const MAINTENANCE_KEY = 'forest-fire-patrol:maintenance'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

/** 兼容历史批次：老数据缺字段时在读取侧补齐，不改业务含义。 */
function normalizeBatch(
  raw: Partial<MaintenanceBatch> & { id: number; module: string },
  restorations: RestorationRecord[],
): MaintenanceBatch {
  const entryIds = Array.isArray(raw.entryIds) ? raw.entryIds.map(Number) : []
  // 历史批次没有 restoredEntryIds，从恢复记录里推导；部分成功批次因此能接着恢复
  const restoredEntryIds = Array.isArray(raw.restoredEntryIds)
    ? raw.restoredEntryIds.map(Number)
    : restorations.filter((item) => item.batchId === raw.id).map((item) => Number(item.entryId))
  const status =
    raw.status ??
    (entryIds.length > 0 && restoredEntryIds.length >= entryIds.length ? '已恢复' : '待恢复')
  const idempotencyKey =
    raw.idempotencyKey ?? `${raw.module}:${[...entryIds].sort((a, b) => a - b).join(',')}`
  // 原维护日期保持原样；实在没有才用创建时间兜底
  const maintenanceDate = raw.maintenanceDate ?? String(raw.createdAt ?? '').slice(0, 10)
  const createdAt = raw.createdAt ?? ''
  const batchNo =
    raw.batchNo ?? `MB-${maintenanceDate.replace(/-/g, '')}-${String(raw.id).padStart(4, '0')}`
  return { ...raw, batchNo, createdAt, entryIds, restoredEntryIds, status, idempotencyKey, maintenanceDate }
}

function normalizeMaintenance(raw: unknown): MaintenanceState {
  const source = (raw ?? {}) as Partial<MaintenanceState>
  const restorations = Array.isArray(source.restorations) ? source.restorations : []
  const reminders = Array.isArray(source.reminders) ? source.reminders : []
  const batches = (Array.isArray(source.batches) ? source.batches : []).map((batch) =>
    normalizeBatch(batch, restorations),
  )
  return { batches, restorations, reminders }
}

function readMaintenance(): MaintenanceState {
  const fallback = normalizeMaintenance(clone(SEED_MAINTENANCE))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(MAINTENANCE_KEY)
  if (!raw) {
    window.localStorage.setItem(MAINTENANCE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return normalizeMaintenance(JSON.parse(raw))
  } catch {
    window.localStorage.setItem(MAINTENANCE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
let maintenanceCache: MaintenanceState | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function loadMaintenance(): MaintenanceState {
  if (maintenanceCache === null) {
    maintenanceCache = readMaintenance()
  }
  return maintenanceCache
}

export function saveMaintenance(state: MaintenanceState): void {
  maintenanceCache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MAINTENANCE_KEY, JSON.stringify(state))
  }
}

export type StateSnapshot = {
  entries: Record<string, EntryRow[]>
  maintenance: MaintenanceState
}

/** 事务快照：批量维护要整批落库或整体退回，失败时按快照回滚。 */
export function snapshotState(): StateSnapshot {
  return { entries: clone(allRows()), maintenance: clone(loadMaintenance()) }
}

export function restoreState(snapshot: StateSnapshot): void {
  cache = clone(snapshot.entries)
  maintenanceCache = clone(snapshot.maintenance)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
    window.localStorage.setItem(MAINTENANCE_KEY, JSON.stringify(maintenanceCache))
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
