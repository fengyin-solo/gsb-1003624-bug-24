/**
 * store 全链路冒烟：用最小 localStorage 桩，跑通「安排→列表→恢复→再安排→荒废回退」，
 * 以及跨模块整批失败回退、重复恢复只接受一次、同批只产生一批。
 */
const assert = require('node:assert')

// ---- 最小浏览器环境桩（必须在加载 store 之前装好）----
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => void storage.set(k, String(v)),
    removeItem: (k) => void storage.delete(k),
  },
}

require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..', 'node_modules/.tmp/verify')
const {
  listBatches,
  listPendingRefs,
  mergedRows,
  scheduleMaintenance,
  confirmRecovery,
  markAbandoned,
  activeBatchCount,
} = require(path.join(root, 'src/data/maintenance/store.js'))
require('assert')

function status(module, id) {
  return mergedRows(module).find((r) => Number(r.id) === id)
}

// 首次加载：隔离带2(需割草)、隔离带3(需补植) 与林带2(有缺株)、林带3(需补植) 被补录为 legacy。
assert.strictEqual(listPendingRefs().length, 4, '初始待恢复 4 条（legacy 补录）')

// 跨模块整批安排：只产生一条批次。
const batch = scheduleMaintenance({
  maintenanceDate: '2026-10-04',
  idempotencyKey: 'ui-1',
  selections: [
    { module: 'firebreak', itemIds: [1] },
    { module: 'firebelt', itemIds: [1] },
  ],
})
assert.strictEqual(activeBatchCount() - 0 >= 1, true)
assert.deepStrictEqual([...batch.modules].sort(), ['firebelt', 'firebreak'])
assert.strictEqual(batch.items.length, 2)

// 同 key 重复提交 → 同一批。
const again = scheduleMaintenance({
  maintenanceDate: '2026-10-04',
  idempotencyKey: 'ui-1',
  selections: [
    { module: 'firebreak', itemIds: [1] },
    { module: 'firebelt', itemIds: [1] },
  ],
})
assert.strictEqual(again.id, batch.id)
assert.strictEqual(listBatches().filter((b) => b.items.some((i) => i.itemId === 1)).length, 1, '含 1 号对象的只有新批次这一条')
assert.strictEqual(listBatches().length, 4, 'legacy 按日期三组 + 新批次一批，共 4 批')

// 列表状态立即刷新（问题1：安排维护后状态不刷新）。
assert.strictEqual(status('firebreak', 1).status, '需割草')
assert.strictEqual(status('firebelt', 1).status, '需补植')
// 植被恢复值不残留旧批次（问题2）。
assert.strictEqual(status('firebreak', 1).植被恢复程度, '待恢复')
assert.strictEqual(status('firebreak', 1).最近维护日期, '2026-10-04')

// 待恢复条数（去重，问题3）：legacy 4 + 新 2 = 6。
assert.strictEqual(listPendingRefs().length, 6)

// 恢复确认：整批成功，原维护日期不变。
confirmRecovery({ batchId: batch.id, recovery: 75 })
assert.strictEqual(status('firebreak', 1).status, '正常')
assert.strictEqual(status('firebreak', 1).植被恢复程度, '75%')
assert.strictEqual(status('firebreak', 1).最近维护日期, '2026-10-04', '恢复不改维护日期')
assert.strictEqual(status('firebelt', 1).status, '完好')
assert.strictEqual(listPendingRefs().length, 4)

// 两处同时恢复：第二次结果不接受。
assert.throws(() => confirmRecovery({ batchId: batch.id, recovery: 40 }), /已登记/)

// 荒废：在途维护提醒一起回退。
const before = listPendingRefs().filter((r) => r.module === 'firebelt' && r.itemId === 2).length
assert.strictEqual(before, 1)
markAbandoned('firebelt', 2)
assert.strictEqual(status('firebelt', 2).status, '已退化')
assert.strictEqual(
  listPendingRefs().filter((r) => r.module === 'firebelt' && r.itemId === 2).length,
  0,
  '荒废后待恢复口径同步移除',
)

// 跨模块整批失败：混了荒废对象 → 抛错且不落任何批次/不改行状态。
const batchCountBefore = listBatches().length
assert.throws(() =>
  scheduleMaintenance({
    maintenanceDate: '2026-10-05',
    selections: [
      { module: 'firebreak', itemIds: [1] },
      { module: 'firebelt', itemIds: [2] }, // 已退化
    ],
  }),
)
assert.strictEqual(listBatches().length, batchCountBefore, '失败后批次数不变')
assert.strictEqual(status('firebreak', 1).status, '正常', '失败后隔离带1未被改动')

console.log('maintenance store smoke: all assertions passed')
