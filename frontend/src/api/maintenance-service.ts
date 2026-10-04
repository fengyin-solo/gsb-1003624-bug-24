import {
  activeBatchCount,
  activeBatchOf,
  confirmRecovery,
  listBatches,
  listPendingRefs,
  markAbandoned,
  mergedRows,
  resetMaintenance,
  scheduleMaintenance,
} from '@/data/maintenance/store'
import type {
  ActionResult,
  MaintenanceBatch,
  MaintenanceModuleKey,
  ScheduleSelection,
} from '@/data/maintenance/types'

export function maintenanceRows(module: MaintenanceModuleKey) {
  return mergedRows(module)
}

export function pendingTotal(module?: MaintenanceModuleKey): number {
  return listPendingRefs().filter((ref) => !module || ref.module === module).length
}

export function openBatchCount(): number {
  return activeBatchCount()
}

/** 找到某对象当前在途（待恢复）的批次；行内「确认恢复」和恢复面板共用这一个入口。 */
export function findActiveBatch(
  module: MaintenanceModuleKey,
  itemId: number,
): { batchId: string; pendingCount: number } | null {
  const batch = activeBatchOf(module, itemId)
  if (!batch) {
    return null
  }
  return {
    batchId: batch.id,
    pendingCount: batch.items.filter((item) => item.recoveredAt === null).length,
  }
}

export function batchesFor(module?: MaintenanceModuleKey): MaintenanceBatch[] {
  const all = listBatches()
  if (!module) {
    return all
  }
  return all.filter((batch) => batch.modules.includes(module))
}

export function submitSchedule(
  selections: ScheduleSelection[],
  maintenanceDate: string,
  idempotencyKey?: string,
): ActionResult & { batch?: MaintenanceBatch } {
  try {
    // 每次提交一个新 key；同一次用户操作被重复触发时调用方复用同一 key，只产生一批。
    const key = idempotencyKey ?? `submit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const batch = scheduleMaintenance({ selections, maintenanceDate, idempotencyKey: key })
    const count = selections.reduce((sum, selection) => sum + selection.itemIds.length, 0)
    return {
      ok: true,
      message: `已安排批次 ${batch.id}，共 ${count} 条，维护日期 ${maintenanceDate}`,
      batch,
    }
  } catch (error) {
    // 校验失败：整批退回，前端状态没有任何改动。
    return { ok: false, message: error instanceof Error ? error.message : '安排维护失败，整批已退回' }
  }
}

/** 正在提交恢复的批次：两个入口同时点同一批时，第二次直接挡下。 */
const inFlightRecoveries = new Set<string>()

export function submitRecovery(batchId: string, recovery: number): ActionResult {
  // 两个入口几乎同时点同一批：第二次直接挡下，引擎里的批次状态再做最终兜底。
  if (inFlightRecoveries.has(batchId)) {
    return { ok: false, message: `批次 ${batchId} 的恢复正在提交，请勿重复确认` }
  }
  inFlightRecoveries.add(batchId)
  try {
    const batch = confirmRecovery({ batchId, recovery })
    return { ok: true, message: `批次 ${batch.id} 恢复结果已登记，恢复程度 ${recovery}%` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '恢复确认失败' }
  } finally {
    inFlightRecoveries.delete(batchId)
  }
}

export function abandon(module: MaintenanceModuleKey, itemId: number): ActionResult {
  try {
    markAbandoned(module, itemId)
    return { ok: true, message: '已标记，在途维护提醒一并回退' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '操作失败' }
  }
}

export function resetAll() {
  resetMaintenance()
}
