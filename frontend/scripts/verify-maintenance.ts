/**
 * 维护—恢复引擎行为验证：node --import tsx 不引入新依赖，用 vite/esbuild 直接跑本脚本。
 * 运行：node --experimental-strip-types scripts/verify-maintenance.ts（Node 20 需用 esbuild 打包）
 */
import assert from 'node:assert'

import {
  abandonItem,
  bootstrapLegacy,
  emptyState,
  normalizeState,
  pendingCount,
  pendingRefs,
  recoverBatch,
  scheduleMaintenance,
} from '../src/data/maintenance/engine'
import type { MaintenanceState } from '../src/data/maintenance/types'

const now = '2026-10-04T08:00:00.000Z'
const base = {
  firebreak: [
    { id: 1, status: '正常', 最近维护日期: '2026-09-01' },
    { id: 2, status: '需割草', 最近维护日期: '2026-09-02' },
    { id: 3, status: '已荒废', 最近维护日期: '2026-08-01' },
  ],
  firebelt: [
    { id: 1, status: '完好' },
    { id: 2, status: '有缺株' },
    { id: 3, status: '需补植' },
  ],
}
const getBase = (module: 'firebreak' | 'firebelt', id: number) =>
  (base as any)[module].find((row: any) => row.id === id)?.status as string | undefined

let state = bootstrapLegacy(emptyState(), base as any, now)
// 历史待维护行（隔离带2/3? 3荒废不算；林带2/3）按原维护日期补录。
assert.strictEqual(pendingCount(state), 3, 'legacy: 隔离带2 + 林带2/3 = 3 条待恢复')
assert.ok(
  state.batches.every((b) => b.confirmedAt === null),
  'legacy 批次都是待恢复',
)
assert.strictEqual(
  state.batches.find((b) => b.items.some((i) => i.module === 'firebreak'))?.maintenanceDate,
  '2026-09-02',
  'legacy 批次沿用原维护日期',
)

// 1) 安排维护：跨模块同批提交只产生一批。
const before = state.batches.length
const r1 = scheduleMaintenance(
  state,
  {
    maintenanceDate: '2026-10-04',
    idempotencyKey: 'k1',
    selections: [
      { module: 'firebreak', itemIds: [1] },
      { module: 'firebelt', itemIds: [1] },
    ],
  },
  getBase,
)
state = r1.state
assert.strictEqual(r1.reused, false)
assert.strictEqual(state.batches.length, before + 1, '只新增一条批次')
assert.deepStrictEqual(r1.batch.modules.sort(), ['firebelt', 'firebreak'], '跨模块明细在同一批')

// 2) 同批重复提交（同 key）：不产生新批次。
const r2 = scheduleMaintenance(
  state,
  {
    maintenanceDate: '2026-10-04',
    idempotencyKey: 'k1',
    selections: [
      { module: 'firebreak', itemIds: [1] },
      { module: 'firebelt', itemIds: [1] },
    ],
  },
  getBase,
)
assert.strictEqual(r2.reused, true, '同 key 复用')
assert.strictEqual(r2.batch.id, r1.batch.id)
assert.strictEqual(r2.state, state, '同 key 状态对象都不变')

// 3) 重复安排同一对象：整批退回（抛错，状态不变）。
const snapshot = state
assert.throws(
  () =>
    scheduleMaintenance(
      state,
      { maintenanceDate: '2026-10-05', selections: [{ module: 'firebreak', itemIds: [1, 2] }] },
      getBase,
    ),
  /已有一批维护待恢复/,
)
assert.strictEqual(state, snapshot, '校验失败整体退回')

// 荒废对象不能安排。
assert.throws(
  () =>
    scheduleMaintenance(
      state,
      { maintenanceDate: '2026-10-05', selections: [{ module: 'firebreak', itemIds: [3] }] },
      getBase,
    ),
  /已荒废/,
)

// 4) 待恢复去重：隔离带1、林带1 加上 legacy 三条，共 5 个唯一对象。
assert.strictEqual(pendingCount(state), 5)
assert.strictEqual(pendingRefs(state).length, new Set(pendingRefs(state).map((r) => `${r.module}:${r.itemId}`)).size)

// 5) 确认恢复：整批落库，原维护日期不变；重复确认被拒。
const originalDate = r1.batch.maintenanceDate
const rec1 = recoverBatch(state, { batchId: r1.batch.id, recovery: 80, now })
state = rec1.state
assert.strictEqual(rec1.batch.maintenanceDate, originalDate, '恢复不改维护日期')
assert.ok(rec1.batch.items.every((i) => i.recovery === 80 && i.recoveredAt === now))
assert.strictEqual(pendingCount(state), 3, '恢复后剩 legacy 3 条')

assert.throws(
  () => recoverBatch(state, { batchId: r1.batch.id, recovery: 60 }),
  /已登记/,
  '两处同时恢复只接受第一个结果',
)

// 6) 标记荒废：在途提醒一起回退。
const beforePending = pendingCount(state, 'firebelt')
state = abandonItem(state, 'firebelt', 2)
assert.strictEqual(pendingCount(state, 'firebelt'), beforePending - 1, '林带2摘掉后待恢复少一条')
assert.ok(
  !pendingRefs(state).some((r) => r.module === 'firebelt' && r.itemId === 2),
  '恢复口径里不再有林带2',
)

// 7) 历史「部分成功批次」按原维护日期兼容：不强制补全、不回退。
const legacyPartial = normalizeState({
  legacyBootstrapped: true,
  batches: [
    {
      id: 'old-1',
      maintenanceDate: '2026-07-15',
      createdAt: '2026-07-15T00:00:00.000Z',
      modules: ['firebreak'],
      confirmedAt: null,
      items: [
        { module: 'firebreak', itemId: 1, pendingStatus: '需割草', recovery: 55, recoveredAt: '2026-08-01T00:00:00.000Z' },
        { module: 'firebreak', itemId: 2, pendingStatus: '需补植', recovery: null, recoveredAt: null },
        // 重复的待恢复明细应被去重。
        { module: 'firebreak', itemId: 2, pendingStatus: '需补植', recovery: null, recoveredAt: null },
      ],
    },
  ],
})
assert.strictEqual(legacyPartial.batches[0].maintenanceDate, '2026-07-15', '原维护日期保留')
assert.strictEqual(legacyPartial.batches[0].items.length, 2, '重复待恢复明细去重')
assert.strictEqual(legacyPartial.batches[0].items[0].recovery, 55, '部分恢复的 55% 维持原状')
assert.strictEqual(pendingCount(legacyPartial), 1, '部分成功批次只把未恢复的算待恢复')

// 8) 跨模块「维护提醒失败一起回退」：选择里混了荒废对象 → 整批不落库。
const clean: MaintenanceState = emptyState(true)
assert.throws(() =>
  scheduleMaintenance(
    clean,
    {
      maintenanceDate: '2026-10-04',
      selections: [
        { module: 'firebreak', itemIds: [1, 3] },
        { module: 'firebelt', itemIds: [1] },
      ],
    },
    getBase,
  ),
)
assert.strictEqual(clean.batches.length, 0, '跨模块任一失败整体退回，不产生任何批次')

console.log('maintenance engine: all assertions passed')
