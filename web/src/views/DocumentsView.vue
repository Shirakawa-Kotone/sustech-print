<script setup lang="ts">
// 文档：待打印队列 + 扫描件。都支持多选批量删除。
import { computed, h, onMounted, ref } from "vue";
import {
  NButton,
  NDataTable,
  NEmpty,
  NIcon,
  NInput,
  NPopconfirm,
  NTag,
  useMessage,
  type DataTableColumns,
} from "naive-ui";
import { DownloadOutline, RefreshOutline, SearchOutline, TrashOutline } from "@vicons/ionicons5";

import {
  jobPages,
  jobSpec,
  loadDocuments,
  removeJobs,
  removeScans,
  state,
} from "../store";
import type { PrintJob, ScanJob } from "../types";
import { fmtDate, fmtStamp, fmtTime } from "../format";

const message = useMessage();
const deleting = ref(false);

onMounted(() => {
  if (!state.jobs && !state.scans) loadDocuments();
});

const q = computed(() => state.search.trim().toLowerCase());

const jobs = computed(() => {
  const list = state.jobs ?? [];
  if (!q.value) return list;
  return list.filter((j) => String(j.szJobName || "").toLowerCase().includes(q.value));
});

const scans = computed(() => {
  const list = state.scans ?? [];
  if (!q.value) return list;
  return list.filter((j) =>
    String(j.szName || j.szJobName || j.szFileName || "").toLowerCase().includes(q.value),
  );
});

const jobColumns = computed<DataTableColumns<PrintJob>>(() => [
  { type: "selection" },
  {
    title: "文件名",
    key: "szJobName",
    ellipsis: { tooltip: true },
    render: (row) => h("span", { class: "doc-name", title: row.szJobName ?? "" }, row.szJobName || "—"),
  },
  {
    title: "规格",
    key: "spec",
    width: 190,
    render: (row) => h("span", { style: "font-size:12.5px;opacity:.75" }, jobSpec(row)),
  },
  {
    title: "页数",
    key: "dwPages",
    width: 76,
    align: "right",
    // 上游的 PrintJob/Get 不返回 dwPages，页数要从 szPaperDetail 里算（见 jobPages）
    render: (r) => {
      const n = jobPages(r);
      return n === null ? "—" : String(n);
    },
  },
  { title: "份数", key: "dwCopies", width: 76, align: "right", render: (r) => String(r.dwCopies ?? 1) },
  {
    title: "提交时间",
    key: "time",
    width: 168,
    render: (row) =>
      h("span", { class: "mono" }, `${fmtDate(row.dwCreateDate)} ${fmtTime(row.dwCreateTime)}`),
  },
]);

const scanColumns = computed<DataTableColumns<ScanJob>>(() => [
  { type: "selection" },
  {
    title: "文件名",
    key: "name",
    ellipsis: { tooltip: true },
    render: (row) =>
      h(
        "span",
        { class: "doc-name" },
        row.szName || row.szJobName || row.szFileName || "扫描件",
      ),
  },
  {
    title: "页数",
    key: "dwPages",
    width: 76,
    align: "right",
    render: (r) => String(r.dwPages ?? "—"),
  },
  {
    title: "时间",
    key: "time",
    width: 168,
    render: (row) => h("span", { class: "mono" }, fmtStamp(row.dwTime || row.dwCreateTime)),
  },
  {
    title: "",
    key: "actions",
    width: 96,
    align: "right",
    render: (row) =>
      h(
        NButton,
        {
          size: "small",
          quaternary: true,
          tag: "a",
          href: `/api/scan-download?id=${encodeURIComponent(String(row.dwJobId))}`,
          target: "_blank",
          rel: "noopener",
        },
        { icon: () => h(NIcon, { component: DownloadOutline }), default: () => "下载" },
      ),
  },
]);

async function doDeleteJobs() {
  const ids = [...state.selectedJobs];
  if (!ids.length) return;
  deleting.value = true;
  try {
    const res = await removeJobs(ids);
    if (res.failed) message.warning(`已删除 ${res.deleted} 份，${res.failed} 份失败`);
    else message.success(`已删除 ${res.deleted} 份文档`);
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    deleting.value = false;
  }
}

async function doDeleteScans() {
  const ids = [...state.selectedScans];
  if (!ids.length) return;
  deleting.value = true;
  try {
    const res = await removeScans(ids);
    if (res.failed) message.warning(`已删除 ${res.deleted} 份，${res.failed} 份失败`);
    else message.success(`已删除 ${res.deleted} 份扫描件`);
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="panel" style="margin-bottom: 14px">
    <div class="panel-head">
      <h2>待打印文档</h2>
      <n-tag size="small" :bordered="false">{{ jobs.length }}</n-tag>
      <div class="spacer" />
      <n-input
        v-model:value="state.search"
        size="small"
        placeholder="搜索文件名…"
        clearable
        style="width: 210px"
      >
        <template #prefix>
          <n-icon :component="SearchOutline" :size="15" style="opacity: 0.5" />
        </template>
      </n-input>
      <n-button size="small" :loading="state.loading.documents" @click="loadDocuments">
        <template #icon>
          <n-icon :component="RefreshOutline" />
        </template>
        刷新
      </n-button>
      <n-popconfirm :show-icon="false" @positive-click="doDeleteJobs">
        <template #trigger>
          <n-button
            size="small"
            type="error"
            secondary
            :disabled="!state.selectedJobs.length"
            :loading="deleting"
          >
            <template #icon>
              <n-icon :component="TrashOutline" />
            </template>
            删除所选<template v-if="state.selectedJobs.length">
              ({{ state.selectedJobs.length }})</template
            >
          </n-button>
        </template>
        确定删除选中的 {{ state.selectedJobs.length }} 份文档？此操作不可撤销。
      </n-popconfirm>
    </div>

    <div style="padding: 8px 10px 12px">
      <n-data-table
        v-if="jobs.length"
        :columns="jobColumns"
        :data="jobs"
        :row-key="(r: PrintJob) => r.dwJobId"
        :checked-row-keys="state.selectedJobs"
        :loading="state.loading.documents"
        size="small"
        :bordered="false"
        @update:checked-row-keys="(k: (string | number)[]) => (state.selectedJobs = k as number[])"
      />
      <n-empty
        v-else
        description="没有待打印的文档"
        style="padding: 34px 0"
      />
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h2>扫描件</h2>
      <n-tag size="small" :bordered="false">{{ scans.length }}</n-tag>
      <div class="spacer" />
      <n-popconfirm :show-icon="false" @positive-click="doDeleteScans">
        <template #trigger>
          <n-button
            size="small"
            type="error"
            secondary
            :disabled="!state.selectedScans.length"
            :loading="deleting"
          >
            <template #icon>
              <n-icon :component="TrashOutline" />
            </template>
            删除所选<template v-if="state.selectedScans.length">
              ({{ state.selectedScans.length }})</template
            >
          </n-button>
        </template>
        确定删除选中的 {{ state.selectedScans.length }} 份扫描件？此操作不可撤销。
      </n-popconfirm>
    </div>

    <div style="padding: 8px 10px 12px">
      <n-data-table
        v-if="scans.length"
        :columns="scanColumns"
        :data="scans"
        :row-key="(r: ScanJob) => r.dwJobId"
        :checked-row-keys="state.selectedScans"
        :loading="state.loading.documents"
        size="small"
        :bordered="false"
        @update:checked-row-keys="(k: (string | number)[]) => (state.selectedScans = k as number[])"
      />
      <n-empty v-else description="没有扫描件" style="padding: 34px 0" />
    </div>
  </div>
</template>
