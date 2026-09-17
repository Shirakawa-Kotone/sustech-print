<script setup lang="ts">
// 打印点：全校自助终端实时状态。
import { computed, onMounted, ref } from "vue";
import { NButton, NEmpty, NIcon, NInput, NRadioButton, NRadioGroup, NTag } from "naive-ui";
import { RefreshOutline, SearchOutline } from "@vicons/ionicons5";

import { isPrinterIdle, loadPrinters, printerStatusKind, state } from "../store";
import { fmtRelative } from "../format";

type Filter = "all" | "free" | "issue";

const filter = ref<Filter>("all");

onMounted(() => {
  if (!state.printers.length) loadPrinters();
});

const list = computed(() => {
  const q = state.search.trim().toLowerCase();
  let rows = state.printers;
  if (filter.value === "free") rows = rows.filter((p) => isPrinterIdle(p.status));
  else if (filter.value === "issue") rows = rows.filter((p) => !isPrinterIdle(p.status));
  if (q) {
    rows = rows.filter((p) =>
      `${p.name} ${p.driver} ${p.ip}`.toLowerCase().includes(q),
    );
  }
  // 空闲的排前面
  return [...rows].sort(
    (a, b) => Number(isPrinterIdle(b.status)) - Number(isPrinterIdle(a.status)),
  );
});

const idleCount = computed(() => state.printers.filter((p) => isPrinterIdle(p.status)).length);

function trays(p: { tray1?: number; tray2?: number }): string {
  const t = [p.tray1, p.tray2].filter((v) => v != null && v >= 0);
  return t.length ? t.join(" / ") : "—";
}

/**
 * 终端的开放时段。
 *
 * dwOpenTime / dwCloseTime 的单位是**从零点起的分钟数**，不是 HHMMSS。
 * 实测全是 openTime=0、closeTime=1439（= 23:59），也就是全天开放。
 * 早先按 HHMMSS 解析会把它显示成「00:00 – 14:39」，是错的。
 */
function minutesToHHMM(v?: number): string {
  const m = Math.max(0, Math.min(1439, Math.round(Number(v) || 0)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function hours(p: { openTime?: number; closeTime?: number }): string {
  if (p.openTime == null && p.closeTime == null) return "—";
  const open = Number(p.openTime) || 0;
  const close = Number(p.closeTime) || 0;
  if (open === 0 && close >= 1439) return "全天开放";
  return `${minutesToHHMM(open)} – ${minutesToHHMM(close)}`;
}
</script>

<template>
  <div class="panel" style="margin-bottom: 14px">
    <div class="panel-head">
      <h2>自助终端</h2>
      <n-tag size="small" type="success" :bordered="false">{{ idleCount }} 台空闲</n-tag>
      <n-tag size="small" :bordered="false">共 {{ state.printers.length }} 台</n-tag>
      <div class="spacer" />
      <n-radio-group v-model:value="filter" size="small">
        <n-radio-button value="all">全部</n-radio-button>
        <n-radio-button value="free">空闲</n-radio-button>
        <n-radio-button value="issue">占用/异常</n-radio-button>
      </n-radio-group>
      <n-input
        v-model:value="state.search"
        size="small"
        placeholder="搜索名称 / 驱动 / IP…"
        clearable
        style="width: 220px"
      >
        <template #prefix>
          <n-icon :component="SearchOutline" :size="15" style="opacity: 0.5" />
        </template>
      </n-input>
      <n-button size="small" :loading="state.loading.printers" @click="loadPrinters">
        <template #icon>
          <n-icon :component="RefreshOutline" />
        </template>
        刷新
      </n-button>
    </div>
  </div>

  <div v-if="list.length" class="grid cols-3">
    <div
      v-for="p in list"
      :key="p.id"
      class="panel"
      :class="`status-${printerStatusKind(p.status)}`"
      style="padding: 15px 16px"
    >
      <div style="display: flex; align-items: flex-start; gap: 8px">
        <div style="flex: 1 1 auto; min-width: 0">
          <div style="display: flex; align-items: center; gap: 6px">
            <span class="status-dot" />
            <b
              style="
                font-size: 13.5px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              "
              :title="p.name"
            >
              {{ p.name || `#${p.id}` }}
            </b>
          </div>
          <div style="font-size: 11.5px; opacity: 0.55; margin-top: 3px">
            {{ p.status || "未知" }}
          </div>
        </div>
        <n-tag size="tiny" :bordered="false">{{ p.id }}</n-tag>
      </div>

      <div
        style="
          margin-top: 11px;
          padding-top: 11px;
          border-top: 1px solid var(--line-soft);
          display: flex;
          flex-direction: column;
          gap: 5px;
          font-size: 12px;
        "
      >
        <div style="display: flex; justify-content: space-between; gap: 8px">
          <span style="opacity: 0.5">驱动</span>
          <span class="mono" style="text-align: right; overflow: hidden; text-overflow: ellipsis">
            {{ p.driver || "—" }}
          </span>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 8px">
          <span style="opacity: 0.5">纸盒</span>
          <span class="mono">{{ trays(p) }}</span>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 8px">
          <span style="opacity: 0.5">开放时间</span>
          <span class="mono">{{ hours(p) }}</span>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 8px">
          <span style="opacity: 0.5">上报</span>
          <span class="mono">{{ fmtRelative(p.updatedAt) }}</span>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="panel">
    <n-empty description="没有匹配的打印点" style="padding: 46px 0" />
  </div>
</template>
