/**
 * 防火隔离带 / 防火林带「维护—恢复」领域模型。
 *
 * 设计要点（对应排查结论）：
 * - 列表、批量维护入口、恢复记录三处共用同一份 MaintenanceState，待恢复口径只有一个；
 * - 一次安排（可跨隔离带与林带）只产生一条 MaintenanceBatch，整批成功或整批退回；
 * - 同一批次的恢复确认只接受一次结果，重复/并发确认整体拒绝；
 * - 维护日期在批次创建时固化，确认恢复不改动它，历史批次按原维护日期读取。
 */

export type MaintenanceModuleKey = 'firebreak' | 'firebelt'
export type MaintenanceWorkType = '割草' | '补植'

/** 批次内的一条明细：一个隔离带/林带对象在某一批次里的维护结果。 */
export type MaintenanceItem = {
  module: MaintenanceModuleKey
  itemId: number
  /** 安排维护时对外呈现的业务态（隔离带=需割草，林带=需补植；历史批次沿用原态）。 */
  pendingStatus: string
  /** 植被恢复程度（0-100 的百分数）；安排维护后到确认恢复前为空，不沿用上一批次的值。 */
  recovery: number | null
  /** 恢复确认时间；未确认前为空。 */
  recoveredAt: string | null
}

export type MaintenanceBatch = {
  id: string
  /** 幂等键：同一次提交（含跨模块）无论触发几次，只对应这一条批次。 */
  idempotencyKey: string | null
  /** 维护作业日期：确认恢复后也保持原样。 */
  maintenanceDate: string
  createdAt: string
  /** 本批包含的模块；跨模块批量安排时两个都在。 */
  modules: MaintenanceModuleKey[]
  items: MaintenanceItem[]
  confirmedAt: string | null
}

export type MaintenanceState = {
  batches: MaintenanceBatch[]
  /** 历史种子数据是否已补录为 legacy 批次（只做一次）。 */
  legacyBootstrapped: boolean
}

/** 待恢复明细的唯一键：模块 + 对象编号。同一对象待恢复期间全局只出现一次。 */
export type PendingRef = {
  module: MaintenanceModuleKey
  itemId: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type ScheduleSelection = {
  module: MaintenanceModuleKey
  itemIds: number[]
}

export type ScheduleInput = {
  selections: ScheduleSelection[]
  /** 维护作业日期；不传时由调用方给出当天日期。 */
  maintenanceDate: string
  idempotencyKey?: string
  now?: string
}

export type RecoverInput = {
  batchId: string
  /** 植被恢复程度（0-100）。 */
  recovery: number
  now?: string
}
