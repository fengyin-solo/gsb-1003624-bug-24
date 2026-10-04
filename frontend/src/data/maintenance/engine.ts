/**
 * 维护—恢复纯函数引擎：只做校验与状态推演，不碰 localStorage。
 * 所有写操作要么返回完整的新状态（整批落库），要么抛错（整体退回，原状态不动）。
 */
import type {
  MaintenanceBatch,
  MaintenanceItem,
  MaintenanceModuleKey,
  MaintenanceState,
  PendingRef,
  RecoverInput,
  ScheduleInput,
} from './types'

export const MAINTENANCE_MODULES: MaintenanceModuleKey[] = ['firebreak', 'firebelt']

export type ModuleConfig = {
  key: MaintenanceModuleKey
  /** 安排维护后对象进入的状态。 */
  pendingStatus: string
  /** 终止/荒废状态：处于该状态不能再安排维护。 */
  terminalStatus: string
  /** 基础数据里「天生就在等维护/恢复」的历史状态（种子数据兼容用）。 */
  legacyStatuses: string[]
}

export const MODULE_CONFIG: Record<MaintenanceModuleKey, ModuleConfig> = {
  firebreak: {
    key: 'firebreak',
    pendingStatus: '需割草',
    terminalStatus: '已荒废',
    legacyStatuses: ['需割草', '需补植'],
  },
  firebelt: {
    key: 'firebelt',
    pendingStatus: '需补植',
    terminalStatus: '已退化',
    legacyStatuses: ['有缺株', '需补植'],
  },
}

export function isMaintenanceModule(value: string): value is MaintenanceModuleKey {
  return value === 'firebreak' || value === 'firebelt'
}

export function emptyState(legacyBootstrapped = false): MaintenanceState {
  return { batches: [], legacyBootstrapped }
}

export function isBatchActive(batch: MaintenanceBatch): boolean {
  return batch.confirmedAt === null && batch.items.some((item) => item.recoveredAt === null)
}

/** 待恢复明细，按「模块+对象编号」去重；同一对象待恢复期间只算一条。 */
export function pendingRefs(state: MaintenanceState): PendingRef[] {
  const seen = new Set<string>()
  const refs: PendingRef[] = []
  for (const batch of state.batches) {
    if (batch.confirmedAt !== null) {
      continue
    }
    for (const item of batch.items) {
      if (item.recoveredAt !== null) {
        continue
      }
      const key = `${item.module}:${item.itemId}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      refs.push({ module: item.module, itemId: item.itemId })
    }
  }
  return refs
}

export function pendingCount(state: MaintenanceState, module?: MaintenanceModuleKey): number {
  const refs = pendingRefs(state)
  return module ? refs.filter((ref) => ref.module === module).length : refs.length
}

export function activeItemFor(
  state: MaintenanceState,
  module: MaintenanceModuleKey,
  itemId: number,
): { batch: MaintenanceBatch; item: MaintenanceItem } | null {
  for (const batch of state.batches) {
    if (batch.confirmedAt !== null) {
      continue
    }
    const item = batch.items.find(
      (candidate) =>
        candidate.module === module && candidate.itemId === itemId && candidate.recoveredAt === null,
    )
    if (item) {
      return { batch, item }
    }
  }
  return null
}

function itemKey(module: MaintenanceModuleKey, itemId: number): string {
  return `${module}:${itemId}`
}

function generateBatchId(existing: MaintenanceBatch[], now: string): string {
  const stamp = now.replace(/[-:T.Z]/g, '').slice(0, 14)
  const serial = existing.length + 1
  let id = `WH-${stamp}-${String(serial).padStart(3, '0')}`
  // 同毫秒多次提交时再追加序号，保证批次号唯一。
  let extra = 1
  while (existing.some((batch) => batch.id === id)) {
    extra += 1
    id = `WH-${stamp}-${String(serial).padStart(3, '0')}-${extra}`
  }
  return id
}

/**
 * 安排维护（支持一条调用里跨隔离带与林带）。
 * - 同 idempotencyKey 的重复提交：原样返回已有批次，不新增任何明细；
 * - 任一对象校验不过：抛错，调用方整体退回，状态保持提交前；
 * - 成功：只产生一条批次，跨模块的明细都挂在这同一条下。
 */
export function scheduleMaintenance(
  state: MaintenanceState,
  input: ScheduleInput,
  getBaseStatus: (module: MaintenanceModuleKey, itemId: number) => string | undefined,
): { state: MaintenanceState; batch: MaintenanceBatch; reused: boolean } {
  const now = input.now ?? new Date().toISOString()
  const date = (input.maintenanceDate ?? '').trim()
  if (!date) {
    throw new Error('请填写维护日期')
  }

  if (input.idempotencyKey) {
    const existing = state.batches.find((batch) => batch.idempotencyKey === input.idempotencyKey)
    if (existing) {
      return { state, batch: existing, reused: true }
    }
  }

  const selections = input.selections
    .map((selection) => ({
      module: selection.module,
      itemIds: [...new Set(selection.itemIds)].sort((a, b) => a - b),
    }))
    .filter((selection) => selection.itemIds.length > 0)

  if (selections.length === 0 || selections.every((selection) => selection.itemIds.length === 0)) {
    throw new Error('请先勾选需要安排维护的隔离带或林带')
  }

  const claimed = new Set<string>()
  const modules: MaintenanceModuleKey[] = []
  const items: MaintenanceItem[] = []

  // 先整批校验，任何一条不过都不产生批次（整体退回）。
  for (const selection of selections) {
    const config = MODULE_CONFIG[selection.module]
    if (!config) {
      throw new Error('维护对象只支持防火隔离带与防火林带')
    }
    modules.push(selection.module)
    for (const itemId of selection.itemIds) {
      const key = itemKey(selection.module, itemId)
      if (claimed.has(key)) {
        throw new Error(`同一条记录在本次提交里被重复勾选`)
      }
      claimed.add(key)

      const baseStatus = getBaseStatus(selection.module, itemId)
      if (baseStatus === undefined) {
        throw new Error(`没有找到编号为 ${itemId} 的${config.key === 'firebreak' ? '防火隔离带' : '防火林带'}`)
      }
      if (baseStatus === config.terminalStatus) {
        throw new Error(`编号 ${itemId} 已${config.terminalStatus}，不能再安排维护`)
      }
      if (activeItemFor(state, selection.module, itemId)) {
        throw new Error(`编号 ${itemId} 已有一批维护待恢复，不能重复安排`)
      }
      items.push({
        module: selection.module,
        itemId,
        pendingStatus: config.pendingStatus,
        recovery: null,
        recoveredAt: null,
      })
    }
  }

  const batch: MaintenanceBatch = {
    id: generateBatchId(state.batches, now),
    idempotencyKey: input.idempotencyKey ?? null,
    maintenanceDate: date,
    createdAt: now,
    modules: [...new Set(modules)],
    items,
    confirmedAt: null,
  }

  return { state: { ...state, batches: [...state.batches, batch] }, batch, reused: false }
}

/**
 * 确认恢复：整批生效或整体退回。
 * - 只能确认尚未确认的批次；重复/并发（两个入口同时点）确认只接受第一个结果；
 * - 植被恢复程度为 0-100 的整数；
 * - 不修改 maintenanceDate（原维护日期保持原样）。
 */
export function recoverBatch(
  state: MaintenanceState,
  input: RecoverInput,
): { state: MaintenanceState; batch: MaintenanceBatch } {
  const batchIndex = state.batches.findIndex((batch) => batch.id === input.batchId)
  if (batchIndex < 0) {
    throw new Error(`没有找到批次 ${input.batchId}`)
  }
  const batch = state.batches[batchIndex]
  if (batch.confirmedAt !== null) {
    throw new Error(`批次 ${batch.id} 的恢复结果已登记，不能重复确认`)
  }
  const stillPending = batch.items.filter((item) => item.recoveredAt === null)
  if (stillPending.length === 0) {
    throw new Error(`批次 ${batch.id} 没有待恢复的明细`)
  }
  if (!Number.isInteger(input.recovery) || input.recovery < 0 || input.recovery > 100) {
    throw new Error('植被恢复程度需为 0-100 的整数')
  }

  const now = input.now ?? new Date().toISOString()
  const nextItems = batch.items.map((item) =>
    item.recoveredAt === null
      ? { ...item, recovery: input.recovery, recoveredAt: now }
      : item,
  )
  const nextBatch: MaintenanceBatch = {
    ...batch,
    items: nextItems,
    confirmedAt: now,
  }
  const batches = state.batches.slice()
  batches[batchIndex] = nextBatch
  return { state: { ...state, batches }, batch: nextBatch }
}

/**
 * 标记荒废/退化：若该对象有在途批次，把它从批次里摘掉（维护提醒一起回退），
 * 这样列表、待恢复条数、恢复记录三处会同步少掉这一条。
 */
export function abandonItem(
  state: MaintenanceState,
  module: MaintenanceModuleKey,
  itemId: number,
): MaintenanceState {
  const active = activeItemFor(state, module, itemId)
  if (!active) {
    return state
  }
  const batches = state.batches
    .map((batch) => {
      if (batch.id !== active.batch.id) {
        return batch
      }
      const items = batch.items.filter(
        (item) => !(item.module === module && item.itemId === itemId && item.recoveredAt === null),
      )
      const modules = [...new Set(items.map((item) => item.module))]
      // 摘掉的若是批次里最后一条待恢复明细，则该批次视作已关闭，避免挂空批次重复计数。
      const confirmedAt = batch.confirmedAt ?? (items.some((item) => item.recoveredAt === null) ? null : new Date().toISOString())
      return { ...batch, items, modules, confirmedAt }
    })
    .filter((batch) => batch.items.length > 0)
  return { ...state, batches }
}

type BaseRowLike = { id: number; status?: unknown; 最近维护日期?: unknown }

/**
 * 兼容历史持久化数据：把可能缺字段/形态各异的旧批次规整成当前模型。
 * - maintenanceDate 一律保留旧值（部分成功批次按原维护日期兼容，不重排、不补做）；
 * - 已部分恢复的明细维持原状，不强制补全也不回退；
 * - 同一对象重复出现的待恢复明细只保留第一条。
 */
export function normalizeState(raw: unknown): MaintenanceState {
  if (!raw || typeof raw !== 'object') {
    return emptyState()
  }
  const candidate = raw as Partial<MaintenanceState>
  const rawBatches = Array.isArray(candidate.batches) ? candidate.batches : []
  const seenPending = new Set<string>()
  const batches: MaintenanceBatch[] = []

  for (const rawBatch of rawBatches) {
    if (!rawBatch || typeof rawBatch !== 'object') {
      continue
    }
    const b = rawBatch as Partial<MaintenanceBatch>
    const id = typeof b.id === 'string' && b.id ? b.id : `legacy-${batches.length + 1}`
    const maintenanceDate = typeof b.maintenanceDate === 'string' && b.maintenanceDate
      ? b.maintenanceDate
      : ''
    const createdAt = typeof b.createdAt === 'string' && b.createdAt ? b.createdAt : maintenanceDate
    const confirmedAt = typeof b.confirmedAt === 'string' ? b.confirmedAt : null
    const rawItems = Array.isArray(b.items) ? b.items : []
    const items: MaintenanceItem[] = []
    const modules: MaintenanceModuleKey[] = []

    for (const rawItem of rawItems) {
      if (!rawItem || typeof rawItem !== 'object') {
        continue
      }
      const it = rawItem as Partial<MaintenanceItem>
      const moduleKey = String(it.module)
      if (!isMaintenanceModule(moduleKey)) {
        continue
      }
      const itemId = Number(it.itemId)
      if (!Number.isInteger(itemId) || itemId <= 0) {
        continue
      }
      const recoveredAt = typeof it.recoveredAt === 'string' ? it.recoveredAt : null
      const key = itemKey(moduleKey, itemId)
      // 同一对象在同一历史快照里出现多次待恢复：只留第一条，杜绝待恢复重复。
      if (recoveredAt === null && seenPending.has(key)) {
        continue
      }
      if (recoveredAt === null) {
        seenPending.add(key)
      }
      const config = MODULE_CONFIG[moduleKey]
      const recovery =
        it.recovery === null || it.recovery === undefined
          ? null
          : Math.max(0, Math.min(100, Number(it.recovery) || 0))
      items.push({
        module: moduleKey,
        itemId,
        pendingStatus:
          typeof it.pendingStatus === 'string' && it.pendingStatus
            ? it.pendingStatus
            : config.pendingStatus,
        recovery: recoveredAt === null ? null : recovery,
        recoveredAt,
      })
      modules.push(moduleKey)
    }

    if (items.length === 0) {
      continue
    }
    batches.push({
      id,
      idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : null,
      maintenanceDate,
      createdAt,
      modules: [...new Set(modules)],
      items,
      confirmedAt,
    })
  }

  return { batches, legacyBootstrapped: Boolean(candidate.legacyBootstrapped) }
}

/**
 * 种子数据兼容：把基础数据里「天生处于待维护/待恢复状态、却没有任何批次」的历史记录
 * 补成一批 legacy 批次（维护日期沿用行上的原维护日期；没有日期字段的林带留空字符串）。
 * 只在还没有任何批次数据时执行一次，之后以批次为准。
 */
export function bootstrapLegacy(
  state: MaintenanceState,
  baseRowsByModule: Record<MaintenanceModuleKey, BaseRowLike[]>,
  now: string,
): MaintenanceState {
  if (state.legacyBootstrapped || state.batches.length > 0) {
    return state.legacyBootstrapped ? state : { ...state, legacyBootstrapped: true }
  }
  const covered = new Set(pendingRefs(state).map((ref) => itemKey(ref.module, ref.itemId)))
  const items: MaintenanceItem[] = []
  const dateByRef = new Map<string, string>()

  for (const module of MAINTENANCE_MODULES) {
    const config = MODULE_CONFIG[module]
    for (const row of baseRowsByModule[module] ?? []) {
      const status = String(row.status ?? '')
      if (!config.legacyStatuses.includes(status)) {
        continue
      }
      const key = itemKey(module, Number(row.id))
      if (covered.has(key)) {
        continue
      }
      const date = typeof row.最近维护日期 === 'string' ? row.最近维护日期 : ''
      dateByRef.set(key, date)
      items.push({
        module,
        itemId: Number(row.id),
        pendingStatus: status,
        recovery: null,
        recoveredAt: null,
      })
    }
  }

  if (items.length === 0) {
    return { ...state, legacyBootstrapped: true }
  }

  // 按原维护日期分成若干历史批次；日期相同的落在同一批。
  const groups = new Map<string, MaintenanceItem[]>()
  for (const item of items) {
    const date = dateByRef.get(itemKey(item.module, item.itemId)) ?? ''
    const group = groups.get(date) ?? []
    group.push(item)
    groups.set(date, group)
  }
  const batches = [...state.batches]
  let serial = 0
  for (const [date, groupItems] of groups) {
    serial += 1
    batches.push({
      id: `legacy-${date || 'nodate'}-${serial}`,
      idempotencyKey: null,
      maintenanceDate: date,
      createdAt: now,
      modules: [...new Set(groupItems.map((item) => item.module))],
      items: groupItems,
      confirmedAt: null,
    })
  }
  return { batches, legacyBootstrapped: true }
}
