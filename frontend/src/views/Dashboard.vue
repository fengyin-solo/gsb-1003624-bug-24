<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="scheduleOpen = true">跨模块批量维护</button>
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">隔离带待恢复</span>
        <strong class="stat-value">{{ firebreakPending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">林带待恢复</span>
        <strong class="stat-value">{{ firebeltPending }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在途维护批次</span>
        <strong class="stat-value">{{ openBatches }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <RecoveryPanel
      class="panel-gap"
      :revision="revision"
      @recovered="refresh"
      @failed="(message: string) => (errorMessage = message)"
    />

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <ScheduleModal
      :open="scheduleOpen"
      :modules="['firebreak', 'firebelt']"
      @close="scheduleOpen = false"
      @submit="handleSchedule"
    />

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { openBatchCount, pendingTotal, submitSchedule } from '@/api/maintenance-service'
import ScheduleModal from '@/components/ScheduleModal.vue'
import RecoveryPanel from '@/components/RecoveryPanel.vue'
import type { OverviewResult } from '@/data/types'
import type { ScheduleSelection } from '@/data/maintenance/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const revision = ref(0)
const scheduleOpen = ref(false)
const errorMessage = ref('')
const firebreakPending = ref(0)
const firebeltPending = ref(0)
const openBatches = ref(0)

function refresh() {
  revision.value += 1
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  // 待恢复只有一个口径：与隔离带列表、林带列表、恢复记录完全一致。
  firebreakPending.value = pendingTotal('firebreak')
  firebeltPending.value = pendingTotal('firebelt')
  openBatches.value = openBatchCount()
}

function handleSchedule(payload: {
  selections: ScheduleSelection[]
  maintenanceDate: string
}) {
  // 跨模块的选择在同一次提交里：只产生一条批次；任一对象失败整批退回。
  const result = submitSchedule(payload.selections, payload.maintenanceDate)
  scheduleOpen.value = false
  errorMessage.value = result.ok ? result.message : result.message
  refresh()
}

onMounted(refresh)
</script>
