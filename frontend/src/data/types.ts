/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 维护批次：一次批量维护覆盖若干条记录，整批落库或整体退回。 */
export type MaintenanceBatch = {
  id: number
  batchNo: string
  module: string
  entryIds: number[]
  /** 已恢复的条目；部分成功批次就是这里没装满，兼容历史数据时从恢复记录推导 */
  restoredEntryIds: number[]
  /** 原维护日期：创建批次时记下，之后任何流转都不改写 */
  maintenanceDate: string
  status: '待恢复' | '已恢复' | '已退回'
  /** 幂等键：模块 + 排序后的条目集合，同批提交只产生一批 */
  idempotencyKey: string
  createdAt: string
  closedAt?: string
  /** 安排维护前的行快照，退回时还原；历史批次可能没有，退回时保持行现状 */
  previous?: Record<number, { status: string; pending: boolean; vegetation: string }>
}

/** 恢复记录：一条记录一次恢复，按 批次+条目 去重，两处同时恢复只接受一个结果。 */
export type RestorationRecord = {
  id: number
  batchId: number
  batchNo: string
  module: string
  entryId: number
  entryLabel: string
  vegetation: string
  restoredAt: string
}

/** 维护提醒：隔离带与林带一起生成，任一失败连同批次整体回退。 */
export type MaintenanceReminder = {
  id: number
  module: string
  batchId: number
  batchNo: string
  message: string
  createdAt: string
}

export type MaintenanceState = {
  batches: MaintenanceBatch[]
  restorations: RestorationRecord[]
  reminders: MaintenanceReminder[]
}

export type BatchActionResult = ActionResult & {
  batch?: MaintenanceBatch
  created?: boolean
}
