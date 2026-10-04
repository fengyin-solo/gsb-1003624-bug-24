import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  loadMaintenance,
  resetRows,
  restoreState,
  saveMaintenance,
  saveRows,
  snapshotState,
} from '@/data/local-store'
import type {
  ActionResult,
  BatchActionResult,
  EntryRow,
  MaintenanceBatch,
  MaintenanceReminder,
  MaintenanceState,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RestorationRecord,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 参与批量维护的模块：安排维护后的状态、恢复后的状态、植被恢复字段都在这里登记。
const MAINTENANCE_MODULES: Record<
  string,
  {
    entity: string
    scheduleTarget: string
    restoreTarget: string
    vegetationField: string | null
    labelField: string
  }
> = {
  firebreak: {
    entity: '防火隔离带',
    scheduleTarget: '需割草',
    restoreTarget: '正常',
    vegetationField: '植被恢复程度',
    labelField: '隔离带编号',
  },
  firebelt: {
    entity: '防火林带',
    scheduleTarget: '需补植',
    restoreTarget: '完好',
    vegetationField: null,
    labelField: '林带编号',
  },
}

// 维护提醒对这两个模块一起生成，任一失败连同批次整体回退。
const REMINDER_MODULES = ['firebreak', 'firebelt']

const DEFAULT_VEGETATION = '恢复良好'
const PENDING_VEGETATION = '待恢复'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function today(): string {
  const nowDate = new Date()
  return `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}`
}

function now(): string {
  const nowDate = new Date()
  return `${today()} ${pad2(nowDate.getHours())}:${pad2(nowDate.getMinutes())}:${pad2(nowDate.getSeconds())}`
}

function nextId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 事务：整批落库或整体退回，任何一步失败都按快照回滚，不留半截数据。 */
function transact<T>(run: () => T): T {
  const snapshot = snapshotState()
  try {
    return run()
  } catch (error) {
    restoreState(snapshot)
    throw error
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 单条恢复：命中进行中的批次就走批次流程，返回 null 表示不在批次里、走普通流转。 */
function restoreEntryNow(key: string, id: number, vegetation: string): ActionResult | null {
  const cfg = MAINTENANCE_MODULES[key]
  if (!cfg) {
    return null
  }
  const state = loadMaintenance()
  const batch = state.batches.find(
    (item) => item.module === key && item.status === '待恢复' && item.entryIds.includes(id),
  )
  if (!batch) {
    return null
  }
  // 两处同时恢复只接受一个结果：批次里已恢复过的条目直接拒绝
  if (batch.restoredEntryIds.includes(id)) {
    return { ok: false, message: `编号 ${id} 在批次 ${batch.batchNo} 中已恢复，重复恢复被拒绝` }
  }
  try {
    return transact(() => {
      const rows = listRows(key)
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${id} 的${cfg.entity}`)
      }
      const updated: EntryRow = { ...rows[index], status: cfg.restoreTarget, pending: false }
      if (cfg.vegetationField) {
        updated[cfg.vegetationField] = vegetation
      }
      const next = [...rows]
      next[index] = updated
      const restoredEntryIds = [...batch.restoredEntryIds, id]
      const done = restoredEntryIds.length >= batch.entryIds.length
      const batches = state.batches.map((item) =>
        item.id === batch.id
          ? {
              ...item,
              restoredEntryIds,
              status: done ? ('已恢复' as const) : ('待恢复' as const),
              closedAt: done ? now() : item.closedAt,
            }
          : item,
      )
      // 恢复记录按 批次+条目 去重，重复恢复不会产生第二条记录
      const restorations = state.restorations.some(
        (item) => item.batchId === batch.id && item.entryId === id,
      )
        ? state.restorations
        : [
            ...state.restorations,
            {
              id: nextId(state.restorations),
              batchId: batch.id,
              batchNo: batch.batchNo,
              module: key,
              entryId: id,
              entryLabel: String(updated[cfg.labelField] ?? id),
              vegetation,
              restoredAt: now(),
            },
          ]
      const reminders = done
        ? state.reminders.filter((item) => item.batchId !== batch.id)
        : state.reminders
      saveRows(key, next)
      saveMaintenance({ batches, restorations, reminders })
      return { ok: true, message: `${cfg.entity} ${id} 已恢复并记入批次 ${batch.batchNo}` }
    })
  } catch (error) {
    return { ok: false, message: `恢复失败，已整体回退：${messageOf(error)}` }
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 恢复类动作先走维护批次流程：写恢复记录、同步批次状态
  const maintenance = MAINTENANCE_MODULES[key]
  if (maintenance && target === maintenance.restoreTarget) {
    const result = restoreEntryNow(key, id, DEFAULT_VEGETATION)
    if (result) {
      return result
    }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function listBatches(key: string): MaintenanceBatch[] {
  return loadMaintenance()
    .batches.filter((item) => item.module === key)
    .sort((a, b) => b.id - a.id)
}

export function listRestorations(key: string): RestorationRecord[] {
  return loadMaintenance()
    .restorations.filter((item) => item.module === key)
    .sort((a, b) => b.id - a.id)
}

export function listReminders(key: string): MaintenanceReminder[] {
  return loadMaintenance().reminders.filter((item) => item.module === key)
}

/** 待恢复条数：按条目去重，同一记录进了多个批次也只算一次。 */
export function pendingRestorationCount(key: string): number {
  const pending = new Set<number>()
  for (const batch of loadMaintenance().batches) {
    if (batch.module !== key || batch.status !== '待恢复') {
      continue
    }
    for (const id of batch.entryIds) {
      if (!batch.restoredEntryIds.includes(id)) {
        pending.add(id)
      }
    }
  }
  return pending.size
}

function makeBatchNo(batches: MaintenanceBatch[]): string {
  const seq = String(nextId(batches)).padStart(4, '0')
  return `MB-${today().replace(/-/g, '')}-${seq}`
}

/** 隔离带与林带的维护提醒一起生成；任一失败抛错，由事务整体回退。 */
function buildReminders(batch: MaintenanceBatch, state: MaintenanceState): MaintenanceReminder[] {
  let reminderId = nextId(state.reminders)
  return REMINDER_MODULES.map((moduleKey) => {
    const cfg = MAINTENANCE_MODULES[moduleKey]
    if (!cfg) {
      throw new Error(`模块 ${moduleKey} 没有登记维护提醒`)
    }
    if (state.reminders.some((item) => item.batchId === batch.id && item.module === moduleKey)) {
      throw new Error(`批次 ${batch.batchNo} 的${cfg.entity}提醒已存在`)
    }
    const message =
      moduleKey === batch.module
        ? `批次 ${batch.batchNo} 已安排维护：${cfg.entity} ${batch.entryIds.length} 条待恢复`
        : `批次 ${batch.batchNo} 已安排维护，请同步巡查${cfg.entity}`
    return {
      id: reminderId++,
      module: moduleKey,
      batchId: batch.id,
      batchNo: batch.batchNo,
      message,
      createdAt: now(),
    }
  })
}

/**
 * 批量安排维护：整批落库或整体退回。
 * 同批提交只产生一批；行状态与植被恢复程度同步刷新，最近维护日期保持原样。
 */
export function scheduleMaintenanceBatch(
  key: string,
  entryIds: number[],
  maintenanceDate?: string,
): BatchActionResult {
  const cfg = MAINTENANCE_MODULES[key]
  if (!cfg) {
    return { ok: false, message: '该模块没有登记批量维护' }
  }
  const ids = [...new Set(entryIds.map(Number))].sort((a, b) => a - b)
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选要维护的记录' }
  }
  const date = maintenanceDate?.trim() || today()
  const idempotencyKey = `${key}:${ids.join(',')}`
  const state = loadMaintenance()
  const existing = state.batches.find(
    (item) => item.module === key && item.status === '待恢复' && item.idempotencyKey === idempotencyKey,
  )
  if (existing) {
    return { ok: true, created: false, batch: existing, message: `批次 ${existing.batchNo} 已存在，同批提交不重复生成` }
  }
  const rows = listRows(key)
  const rowById = new Map(rows.map((row) => [Number(row.id), row]))
  const missing = ids.filter((id) => !rowById.has(id))
  if (missing.length > 0) {
    return { ok: false, message: `编号 ${missing.join('、')} 的记录不存在` }
  }
  const busy = ids.filter((id) =>
    state.batches.some(
      (item) => item.module === key && item.status === '待恢复' && item.entryIds.includes(id),
    ),
  )
  if (busy.length > 0) {
    return { ok: false, message: `编号 ${busy.join('、')} 已在进行中的批次里，请先恢复或退回该批次` }
  }
  try {
    return transact(() => {
      const previous: Record<number, { status: string; pending: boolean; vegetation: string }> = {}
      const next = rows.map((row) => {
        const id = Number(row.id)
        if (!ids.includes(id)) {
          return row
        }
        previous[id] = {
          status: String(row.status),
          pending: Boolean(row.pending),
          vegetation: cfg.vegetationField ? String(row[cfg.vegetationField] ?? '') : '',
        }
        const updated: EntryRow = { ...row, status: cfg.scheduleTarget, pending: true }
        // 植被恢复程度重置为「待恢复」，清掉旧批次残留的值
        if (cfg.vegetationField) {
          updated[cfg.vegetationField] = PENDING_VEGETATION
        }
        return updated
      })
      const batch: MaintenanceBatch = {
        id: nextId(state.batches),
        batchNo: makeBatchNo(state.batches),
        module: key,
        entryIds: ids,
        restoredEntryIds: [],
        maintenanceDate: date,
        status: '待恢复',
        idempotencyKey,
        createdAt: now(),
        previous,
      }
      const reminders = buildReminders(batch, state)
      saveRows(key, next)
      saveMaintenance({
        batches: [...state.batches, batch],
        restorations: state.restorations,
        reminders: [...state.reminders, ...reminders],
      })
      return { ok: true, created: true, batch, message: `已生成维护批次 ${batch.batchNo}，共 ${ids.length} 条` }
    })
  } catch (error) {
    return { ok: false, message: `批量维护失败，已整体回退：${messageOf(error)}` }
  }
}

/** 整批恢复：批次内剩余条目一次落库，任何一步失败整体回退；原维护日期不改写。 */
export function restoreBatch(key: string, batchId: number, vegetation?: string): ActionResult {
  const cfg = MAINTENANCE_MODULES[key]
  if (!cfg) {
    return { ok: false, message: '该模块没有登记维护批次' }
  }
  const state = loadMaintenance()
  const batch = state.batches.find((item) => item.id === batchId && item.module === key)
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${batchId} 的维护批次` }
  }
  if (batch.status !== '待恢复') {
    return { ok: false, message: `批次 ${batch.batchNo} 已${batch.status}，重复恢复被拒绝` }
  }
  const veg = vegetation?.trim() || DEFAULT_VEGETATION
  try {
    return transact(() => {
      const rows = listRows(key)
      const rowById = new Map(rows.map((row) => [Number(row.id), row]))
      const pendingIds = batch.entryIds.filter((id) => !batch.restoredEntryIds.includes(id))
      const missing = pendingIds.filter((id) => !rowById.has(id))
      if (missing.length > 0) {
        throw new Error(`批次内编号 ${missing.join('、')} 的记录不存在`)
      }
      const next = rows.map((row) => {
        if (!pendingIds.includes(Number(row.id))) {
          return row
        }
        const updated: EntryRow = { ...row, status: cfg.restoreTarget, pending: false }
        if (cfg.vegetationField) {
          updated[cfg.vegetationField] = veg
        }
        return updated
      })
      // 部分成功批次接着恢复：已有记录的条目跳过，只补剩余条目
      const restorations = [...state.restorations]
      for (const id of pendingIds) {
        if (restorations.some((item) => item.batchId === batch.id && item.entryId === id)) {
          continue
        }
        restorations.push({
          id: nextId(restorations),
          batchId: batch.id,
          batchNo: batch.batchNo,
          module: key,
          entryId: id,
          entryLabel: String(rowById.get(id)?.[cfg.labelField] ?? id),
          vegetation: veg,
          restoredAt: now(),
        })
      }
      const batches = state.batches.map((item) =>
        item.id === batch.id
          ? { ...item, restoredEntryIds: [...item.entryIds], status: '已恢复' as const, closedAt: now() }
          : item,
      )
      const reminders = state.reminders.filter((item) => item.batchId !== batch.id)
      saveRows(key, next)
      saveMaintenance({ batches, restorations, reminders })
      return {
        ok: true,
        message: `批次 ${batch.batchNo} 已整批恢复 ${pendingIds.length} 条，原维护日期 ${batch.maintenanceDate} 保持不变`,
      }
    })
  } catch (error) {
    return { ok: false, message: `批次恢复失败，已整体回退：${messageOf(error)}` }
  }
}

/** 整体退回：有快照的条目还原到安排维护前，历史批次没有快照就保持行现状。 */
export function rollbackBatch(key: string, batchId: number): ActionResult {
  const cfg = MAINTENANCE_MODULES[key]
  if (!cfg) {
    return { ok: false, message: '该模块没有登记维护批次' }
  }
  const state = loadMaintenance()
  const batch = state.batches.find((item) => item.id === batchId && item.module === key)
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${batchId} 的维护批次` }
  }
  if (batch.status !== '待恢复') {
    return { ok: false, message: `批次 ${batch.batchNo} 已${batch.status}，不能再退回` }
  }
  try {
    return transact(() => {
      const rows = listRows(key)
      const pendingIds = batch.entryIds.filter((id) => !batch.restoredEntryIds.includes(id))
      const next = rows.map((row) => {
        const id = Number(row.id)
        if (!pendingIds.includes(id)) {
          return row
        }
        const prev = batch.previous?.[id]
        if (!prev) {
          return row
        }
        const updated: EntryRow = { ...row, status: prev.status, pending: prev.pending }
        if (cfg.vegetationField) {
          updated[cfg.vegetationField] = prev.vegetation
        }
        return updated
      })
      const batches = state.batches.map((item) =>
        item.id === batch.id ? { ...item, status: '已退回' as const, closedAt: now() } : item,
      )
      const reminders = state.reminders.filter((item) => item.batchId !== batch.id)
      saveRows(key, next)
      saveMaintenance({ batches, restorations: state.restorations, reminders })
      return { ok: true, message: `批次 ${batch.batchNo} 已整体退回，未恢复条目回到维护前状态` }
    })
  } catch (error) {
    return { ok: false, message: `批次退回失败，已整体回退：${messageOf(error)}` }
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
