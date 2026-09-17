<script setup lang="ts">
// 总览：补贴进度 + 关键数字 + 打印点快照 + 快捷入口。
import { computed, onMounted } from "vue";
import { NButton, NIcon, NProgress, NSkeleton, NTag } from "naive-ui";
import {
  CloudUploadOutline,
  DocumentTextOutline,
  PrintOutline,
  RefreshOutline,
  TimeOutline,
} from "@vicons/ionicons5";

import {
  isPrinterIdle,
  loadPrinters,
  loadSummary,
  printerStatusKind,
  state,
  type ViewKey,
} from "../store";
import { fmtDate, money } from "../format";
import { PRINTER_NAME } from "../const";

onMounted(() => {
  if (!state.summary) loadSummary();
  if (!state.printers.length) loadPrinters();
});

const sub = computed(() => state.summary?.subsidy ?? null);
const user = computed(() => state.summary?.user ?? null);

/**
 * 环表示**剩余**补贴占额度的比例：满环 = 一分没用，用掉多少环就少多少。
 * 比"用掉多少"更直观 —— 一眼看到的是"我还剩多少"。
 */
const remainingPct = computed(() => {
  const s = sub.value;
  if (!s || !s.perYear) return 0;
  const p = (s.remainingComputed / s.perYear) * 100;
  return Math.max(0, Math.min(100, p));
});

/** 本地累计值和系统返回值是否一致——不一致就有可能漏算了记录。 */
const reconciled = computed(() => {
  const s = sub.value;
  if (!s) return null;
  return Math.abs(s.remainingComputed - s.serverReported) < 0.011;
});

/**
 * 颜色语义跟着反过来：剩得多是安全的绿，快见底才变黄、变红。
 * （之前是按"已用"着色，已用越多越红，和现在这个"余额"环正好相反。）
 */
const ringColor = computed(() => {
  const left = remainingPct.value;
  if (left <= 10) return "#d63b4a"; // 快用完了
  if (left <= 30) return "#d99414"; // 不多了
  return "#12a06a"; // 充足
});

const idleCount = computed(() => state.printers.filter((p) => isPrinterIdle(p.status)).length);
const busyCount = computed(() => state.printers.length - idleCount.value);

const docCount = computed(
  () =>
    state.summary?.counts.pendingJobs ??
    (state.jobs?.length ?? 0) + (state.scans?.length ?? 0),
);

const printersPreview = computed(() => state.printers.slice(0, 6));

async function refresh() {
  await Promise.allSettled([loadSummary(true), loadPrinters()]);
}

function go(v: ViewKey) {
  state.view = v;
}
</script>

<template>
  <div v-if="!sub" class="grid cols-2">
    <div class="panel" style="padding: 20px">
      <n-skeleton height="150px" :sharp="false" />
    </div>
    <div class="panel" style="padding: 20px">
      <n-skeleton height="150px" :sharp="false" />
    </div>
  </div>

  <template v-else>
    <!-- 补贴 + 账号 -->
    <div class="grid cols-2" style="margin-bottom: 14px">
      <div class="panel">
        <div class="panel-body ring-wrap">
          <n-progress
            type="circle"
            :percentage="remainingPct"
            :stroke-width="10"
            :color="ringColor"
            :rail-color="'rgba(127,140,165,.16)'"
            :show-indicator="false"
            style="width: 138px; flex: 0 0 138px"
          >
            <div class="ring-center">
              <span class="big" :style="{ color: ringColor }">
                ¥{{ money(sub.remainingComputed) }}
              </span>
              <span class="cap">剩余补贴 · {{ remainingPct.toFixed(0) }}%</span>
            </div>
          </n-progress>

          <div style="flex: 1 1 auto; min-width: 0">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
              <h2 style="margin: 0; font-size: 15px; font-weight: 620">
                {{ user?.trueName || "同学" }}
              </h2>
              <n-tag v-if="user?.logonName" size="small" :bordered="false">
                {{ user.logonName }}
              </n-tag>
            </div>

            <div style="display: flex; flex-direction: column; gap: 6px; font-size: 13px">
              <div style="display: flex; gap: 8px">
                <span style="opacity: 0.55; width: 76px">学年额度</span>
                <b>¥{{ money(sub.perYear) }}</b>
              </div>
              <div style="display: flex; gap: 8px">
                <span style="opacity: 0.55; width: 76px">本学年已用</span>
                <b>¥{{ money(sub.used) }}</b>
                <span style="opacity: 0.45">（{{ sub.pages }} 页 · {{ sub.records }} 条）</span>
              </div>
              <div style="display: flex; gap: 8px">
                <span style="opacity: 0.55; width: 76px">自费支出</span>
                <b>¥{{ money(sub.paid) }}</b>
              </div>
              <div style="display: flex; gap: 8px; align-items: center">
                <span style="opacity: 0.55; width: 76px">学年起算</span>
                <span>{{ fmtDate(sub.academicYearStart) }}</span>
              </div>
            </div>

            <div style="margin-top: 10px; display: flex; align-items: center; gap: 8px">
              <n-tag
                v-if="reconciled !== null"
                size="small"
                :type="reconciled ? 'success' : 'warning'"
                :bordered="false"
              >
                {{ reconciled ? "已同步系统" : `系统报 ¥${money(sub.serverReported)}` }}
              </n-tag>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>快捷操作</h2>
          <div class="spacer" />
          <n-button size="small" quaternary :loading="state.loading.summary" @click="refresh">
            <template #icon>
              <n-icon :component="RefreshOutline" />
            </template>
            刷新
          </n-button>
        </div>
        <div class="panel-body" style="display: flex; flex-direction: column; gap: 10px">
          <n-button type="primary" size="large" block @click="go('upload')">
            <template #icon>
              <n-icon :component="CloudUploadOutline" />
            </template>
            上传文件去打印
          </n-button>
          <div class="grid cols-3" style="gap: 10px">
            <n-button block @click="go('documents')">
              <template #icon>
                <n-icon :component="DocumentTextOutline" />
              </template>
              文档
            </n-button>
            <n-button block @click="go('printers')">
              <template #icon>
                <n-icon :component="PrintOutline" />
              </template>
              打印点
            </n-button>
            <n-button block @click="go('history')">
              <template #icon>
                <n-icon :component="TimeOutline" />
              </template>
              记录
            </n-button>
          </div>
          <p style="margin: 2px 0 0; font-size: 11.5px; opacity: 0.45; line-height: 1.6">
            装了虚拟打印机后，在 Word / 浏览器里直接「打印」到
            <b>「{{ PRINTER_NAME }}」</b>，文件会自动进入队列。
          </p>
        </div>
      </div>
    </div>

    <!-- 指标 -->
    <div class="grid cols-4" style="margin-bottom: 14px">
      <div class="panel metric">
        <div class="label">
          <n-icon :component="DocumentTextOutline" :size="14" />待打印文档
        </div>
        <div class="value">{{ docCount }}<small>份</small></div>
        <div class="hint">含扫描件 {{ state.summary?.counts.scans ?? 0 }} 份</div>
      </div>
      <div class="panel metric">
        <div class="label">
          <n-icon :component="PrintOutline" :size="14" />终端空闲
        </div>
        <div class="value">
          {{ idleCount }}<small>/ {{ state.printers.length }} 台</small>
        </div>
        <div class="hint">{{ busyCount }} 台占用中</div>
      </div>
      <div class="panel metric">
        <div class="label">本学年页数</div>
        <div class="value">{{ sub.pages }}<small>页</small></div>
        <div class="hint">{{ sub.records }} 条记录</div>
      </div>
      <div class="panel metric">
        <div class="label">本学年自费</div>
        <div class="value">¥{{ money(sub.paid) }}</div>
        <div class="hint">补贴支付 ¥{{ money(sub.used) }}</div>
      </div>
    </div>

    <!-- 打印点快照 -->
    <div class="panel">
      <div class="panel-head">
        <h2>打印点快照</h2>
        <div class="spacer" />
        <n-button size="small" quaternary @click="go('printers')">全部 {{ state.printers.length }} 台</n-button>
      </div>
      <div class="panel-body">
        <div v-if="!printersPreview.length" style="opacity: 0.5; font-size: 13px">
          正在获取打印点状态…
        </div>
        <div v-else class="grid cols-3" style="gap: 10px">
          <div
            v-for="p in printersPreview"
            :key="p.id"
            class="panel"
            :class="`status-${printerStatusKind(p.status)}`"
            style="padding: 11px 13px; box-shadow: none"
          >
            <div style="display: flex; align-items: center; gap: 6px">
              <span class="status-dot" />
              <b style="font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                {{ p.name || `#${p.id}` }}
              </b>
            </div>
            <div style="font-size: 11.5px; opacity: 0.55; margin-top: 4px" class="mono">
              {{ p.status || "未知" }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>
