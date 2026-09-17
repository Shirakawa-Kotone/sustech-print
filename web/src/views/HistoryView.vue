<script setup lang="ts">
// 使用记录：按类型/时间筛选，导出 CSV。
import { computed, onMounted, h } from "vue";
import {
  NButton,
  NDataTable,
  NEmpty,
  NIcon,
  NRadioButton,
  NRadioGroup,
  NTag,
  type DataTableColumns,
} from "naive-ui";
import { DownloadOutline, RefreshOutline } from "@vicons/ionicons5";

import { loadHistory, paperName, printerName, state } from "../store";
import { exportHistoryCsv } from "../api";
import type { HistoryRow } from "../types";
import { fmtRowTime, money } from "../format";

onMounted(() => {
  if (!state.history.length) loadHistory();
});

const TYPE_LABEL: Record<number, string> = { 1: "打印", 2: "扫描", 3: "复印" };
const TYPE_TAG: Record<number, "info" | "success" | "warning"> = {
  1: "info",
  2: "success",
  3: "warning",
};

/**
 * 类型筛选在前端做。
 *
 * 上游的 Report 接口已经不认 dwType 参数了 —— 按类型分别请求会把同一批
 * 记录重复拿回来（实测补贴被算成 3 倍），所以改成一次全量、本地过滤，
 * 顺带切类型时也不用重新请求。
 */
const rows = computed<HistoryRow[]>(() => {
  if (state.historyType === "all") return state.history;
  const want = Number(state.historyType);
  return state.history.filter((r) => Number(r.dwType) === want);
});

/** 新接口不再返回文档名，只有旧部署才有；没有就整列不显示，免得一列全是「—」。 */
const hasDocName = computed(() => state.history.some((r) => Boolean(r.szDocName)));

const totals = computed(() => {
  const list = rows.value;
  const pages = list.reduce((s, r) => s + (Number(r.dwPages) || 0), 0);
  const free = list.reduce((s, r) => s + (Number(r.dwUsedFreeMoney) || 0), 0) / 100;
  const paid =
    list.reduce(
      (s, r) => s + (Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0),
      0,
    ) / 100;
  return { count: list.length, pages, free, paid };
});

const columns = computed<DataTableColumns<HistoryRow>>(() => [
  {
    title: "时间",
    key: "dwTime",
    width: 152,
    render: (r) => h("span", { class: "mono" }, fmtRowTime(r)),
  },
  {
    title: "类型",
    key: "dwType",
    width: 78,
    render: (r) =>
      h(
        NTag,
        { size: "small", bordered: false, type: TYPE_TAG[Number(r.dwType)] ?? "default" },
        { default: () => TYPE_LABEL[Number(r.dwType)] ?? "—" },
      ),
  },
  // 新接口不再返回文档名；只有旧部署才有，所以整列按需出现
  ...(hasDocName.value
    ? [{
        title: "文件",
        key: "szDocName",
        ellipsis: { tooltip: true },
        render: (r: HistoryRow) => h("span", { class: "doc-name", title: r.szDocName ?? "" }, r.szDocName || "—"),
      } as DataTableColumns<HistoryRow>[number]]
    : []),
  {
    title: "单价",
    key: "dwUnitFee",
    width: 78,
    align: "right",
    render: (r) => (r.dwUnitFee != null ? `¥${money(Number(r.dwUnitFee) / 100)}` : "—"),
  },
  { title: "纸型", key: "paper", width: 86, render: (r) => paperName(r.dwPaperID) },
  { title: "页数", key: "dwPages", width: 72, align: "right", render: (r) => String(r.dwPages ?? 0) },
  {
    title: "补贴",
    key: "free",
    width: 92,
    align: "right",
    render: (r) => `¥${money((Number(r.dwUsedFreeMoney) || 0) / 100)}`,
  },
  {
    title: "自费",
    key: "paid",
    width: 92,
    align: "right",
    render: (r) =>
      `¥${money(((Number(r.dwUsedMoney) || 0) + (Number(r.dwUsedCardMoney) || 0)) / 100)}`,
  },
  {
    title: "终端",
    key: "dwMFPSN",
    width: 150,
    ellipsis: { tooltip: true },
    render: (r) => h("span", { class: "mono" }, printerName(r.dwMFPSN)),
  },
]);

function onExport() {
  exportHistoryCsv(
    rows.value,
    `南科大云打印-使用记录-${new Date().toISOString().slice(0, 10)}.csv`,
  );
}

function onType(v: "all" | "1" | "2" | "3") {
  // 纯本地筛选，不用重新请求
  state.historyType = v;
}

function onRange(days: number) {
  void loadHistory(days);
}
</script>

<template>
  <div class="grid cols-4" style="margin-bottom: 14px">
    <div class="panel metric">
      <div class="label">记录数</div>
      <div class="value">{{ totals.count }}<small>条</small></div>
    </div>
    <div class="panel metric">
      <div class="label">总页数</div>
      <div class="value">{{ totals.pages }}<small>页</small></div>
    </div>
    <div class="panel metric">
      <div class="label">补贴支付</div>
      <div class="value">¥{{ money(totals.free) }}</div>
    </div>
    <div class="panel metric">
      <div class="label">自费</div>
      <div class="value">¥{{ money(totals.paid) }}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h2>使用记录</h2>
      <div class="spacer" />
      <n-radio-group
        :value="state.historyType"
        size="small"
        @update:value="(v: string) => onType(v as 'all' | '1' | '2' | '3')"
      >
        <n-radio-button value="all">全部</n-radio-button>
        <n-radio-button value="1">打印</n-radio-button>
        <n-radio-button value="3">复印</n-radio-button>
        <n-radio-button value="2">扫描</n-radio-button>
      </n-radio-group>

      <n-radio-group
        :value="state.historyDays"
        size="small"
        @update:value="(v: number) => onRange(v)"
      >
        <n-radio-button :value="30">近 30 天</n-radio-button>
        <n-radio-button :value="90">近 90 天</n-radio-button>
        <n-radio-button :value="365">本学年</n-radio-button>
        <n-radio-button :value="3650">全部</n-radio-button>
      </n-radio-group>

      <n-button size="small" :loading="state.loading.history" @click="loadHistory()">
        <template #icon>
          <n-icon :component="RefreshOutline" />
        </template>
        刷新
      </n-button>
      <n-button size="small" :disabled="!rows.length" @click="onExport">
        <template #icon>
          <n-icon :component="DownloadOutline" />
        </template>
        导出 CSV
      </n-button>
    </div>

    <div style="padding: 8px 10px 12px">
      <n-data-table
        v-if="rows.length"
        :columns="columns"
        :data="rows"
        :row-key="(r: HistoryRow) => r.dwSID ?? `${r.dwTimestamp}-${r.dwPages}`"
        :loading="state.loading.history"
        size="small"
        :bordered="false"
        :max-height="560"
        virtual-scroll
      />
      <n-empty v-else description="该时间段没有记录" style="padding: 46px 0" />
    </div>
  </div>
</template>
