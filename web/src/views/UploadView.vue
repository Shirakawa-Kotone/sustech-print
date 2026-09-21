<script setup lang="ts">
// 上传打印：拖拽批量上传，逐文件进度，失败自动重试。
import { computed, onMounted, ref } from "vue";
import {
  NButton,
  NIcon,
  NInputNumber,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NTag,
  useMessage,
} from "naive-ui";
import {
  CheckmarkCircleOutline,
  CloudUploadOutline,
  DocumentsOutline,
  RefreshOutline,
  TrashOutline,
} from "@vicons/ionicons5";

import { loadPapers, loadSummary, state } from "../store";
import { uploadFile } from "../api";
import { fmtBytes } from "../format";
import type { UploadOptions } from "../types";

const message = useMessage();

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [1500, 4000];
/** 同时上传几个文件。云打印后端对并发不敏感，3 个是实测比较稳的值。 */
const CONCURRENCY = 3;

const ACCEPT =
  ".jpg,.jpeg,.png,.gif,.bmp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.wps";

type Status = "waiting" | "uploading" | "processing" | "retrying" | "done" | "error";

interface QueueItem {
  id: string;
  file: File;
  status: Status;
  progress: number;
  message: string;
  attempt: number;
  retryable: boolean;
  opts: UploadOptions;
}

const queue = ref<QueueItem[]>([]);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const color = ref(1); // 1=黑白 2=彩色
const paperId = ref(9); // 9=A4 8=A3 -1=不指定
// 取值照抄官方网页客户端（client/new/cprintPc/cprint.html），别按常识猜：
// 2 是**短边**、3 是**长边**。
const duplex = ref(1); // 1=单面 2=双面短边 3=双面长边
const copies = ref(1);

onMounted(() => {
  if (!state.papers.length) loadPapers();
});

/** 只保留「不指定」和 A3/A4——其余纸型自助终端基本用不上。 */
const papers = computed(() => {
  const known = state.papers.filter((p) => [8, 9].includes(p.dwPaperID));
  const list = known.length
    ? known
    : [
        { dwPaperID: 9, szPaperName: "A4" },
        { dwPaperID: 8, szPaperName: "A3" },
      ];
  return [{ dwPaperID: -1, szPaperName: "不指定" }, ...list];
});

const counts = computed(() => ({
  done: queue.value.filter((q) => q.status === "done").length,
  failed: queue.value.filter((q) => q.status === "error").length,
  running: queue.value.filter(
    (q) => q.status === "uploading" || q.status === "processing" || q.status === "retrying",
  ).length,
  total: queue.value.length,
}));

const hasFinished = computed(() =>
  queue.value.some((q) => q.status === "done" || q.status === "error"),
);

function snapshotOptions(): UploadOptions {
  return {
    dwColor: color.value,
    dwPaperId: paperId.value,
    dwDuplex: duplex.value,
    dwCopies: Math.max(1, Math.min(99, Number(copies.value) || 1)),
  };
}

function addFiles(files: FileList | File[]) {
  const opts = snapshotOptions();
  const items: QueueItem[] = [];
  for (const file of Array.from(files)) {
    items.push({
      id: crypto.randomUUID(),
      file,
      status: "waiting",
      progress: 0,
      message: "",
      attempt: 0,
      retryable: false,
      opts,
    });
  }
  if (!items.length) return;
  queue.value = [...queue.value, ...items];
  void runPool();
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = e.dataTransfer?.files;
  if (files?.length) addFiles(files);
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) addFiles(input.files);
  input.value = ""; // 允许再次选择同一个文件
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(item: QueueItem) {
  item.status = "uploading";
  item.progress = 0;

  let outcome;
  try {
    outcome = await uploadFile(item.file, item.opts, {
      onProgress: (p) => {
        item.progress = p;
        // 上传进度走满后，服务端还要做格式转换 + 入库，这段没有进度可报
        if (p >= 100) item.status = "processing";
      },
    });
  } catch (err) {
    outcome = {
      ok: false,
      taskId: "",
      reason: "network",
      retryable: true,
      message: (err as Error).message,
    };
  }

  if (outcome.ok) {
    item.status = "done";
    item.progress = 100;
    item.message = "";
    item.retryable = false;
    return true;
  }

  item.retryable = Boolean(outcome.retryable);
  item.message = outcome.message || "上传失败";

  // 可重试的错误（404 / 5xx / 网络中断 / 未收到确认）退避重试
  if (outcome.retryable && item.attempt < MAX_ATTEMPTS - 1) {
    item.attempt += 1;
    item.status = "retrying";
    const delay = RETRY_DELAYS[item.attempt - 1] ?? 6000;
    await sleep(delay);
    return runOne(item);
  }

  item.status = "error";
  return false;
}

/** 固定并发数的简易工作池。 */
let poolRunning = false;
async function runPool() {
  if (poolRunning) return;
  poolRunning = true;
  try {
    for (;;) {
      const next = queue.value.find((q) => q.status === "waiting");
      if (!next) break;
      const batch = [next];
      // 再凑几个一起并行
      while (batch.length < CONCURRENCY) {
        const more = queue.value.find((q) => q.status === "waiting" && !batch.includes(q));
        if (!more) break;
        batch.push(more);
      }
      batch.forEach((b) => {
        b.status = "uploading";
      });
      await Promise.all(
        batch.map(async (item) => {
          const ok = await runOne(item);
          if (ok) {
            state.summary = null;
          }
        }),
      );
    }
  } finally {
    poolRunning = false;
  }
  // 全部结束且队列空时才刷新概览
  if (counts.value.done > 0) {
    await loadSummary(true).catch(() => {});
  }
}

async function retryFailed() {
  const failed = queue.value.filter((q) => q.status === "error");
  if (!failed.length) return;
  for (const item of failed) {
    item.status = "waiting";
    item.attempt = 0;
    item.progress = 0;
    item.message = "";
  }
  message.info(`重新上传 ${failed.length} 个文件`);
  queue.value = [...queue.value];
  void runPool();
}

function clearFinished() {
  queue.value = queue.value.filter((q) => q.status !== "done");
}

function removeItem(id: string) {
  queue.value = queue.value.filter((q) => q.id !== id);
}

function statusText(item: QueueItem): string {
  switch (item.status) {
    case "waiting":
      return "等待中";
    case "uploading":
      return `上传中 ${item.progress}%`;
    case "processing":
      return "服务器转换中…";
    case "retrying":
      return item.message || `重试 ${item.attempt}/${MAX_ATTEMPTS}`;
    case "done":
      return "已完成";
    default:
      return item.message || "失败";
  }
}

function statusType(item: QueueItem): "default" | "success" | "error" | "warning" | "info" {
  switch (item.status) {
    case "done":
      return "success";
    case "error":
      return "error";
    case "retrying":
      return "warning";
    case "uploading":
    case "processing":
      return "info";
    default:
      return "default";
  }
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1, i + 5).toUpperCase() : "FILE";
}
</script>

<template>
  <div class="grid cols-2" style="align-items: start">
    <!-- 选项 -->
    <div class="panel">
      <div class="panel-head">
        <h2>打印选项</h2>
        <div class="spacer" />
        <span style="font-size: 12px; opacity: 0.5">对本批全部文件生效</span>
      </div>
      <div class="panel-body" style="display: flex; flex-direction: column; gap: 16px">
        <div>
          <div style="font-size: 12.5px; opacity: 0.6; margin-bottom: 7px">颜色</div>
          <n-radio-group v-model:value="color" size="small">
            <n-radio-button :value="1">黑白</n-radio-button>
            <n-radio-button :value="2">彩色</n-radio-button>
          </n-radio-group>
        </div>

        <div>
          <div style="font-size: 12.5px; opacity: 0.6; margin-bottom: 7px">纸型</div>
          <n-radio-group v-model:value="paperId" size="small">
            <n-radio-button v-for="p in papers" :key="p.dwPaperID" :value="p.dwPaperID">
              {{ p.szPaperName }}
            </n-radio-button>
          </n-radio-group>
        </div>

        <div>
          <div style="font-size: 12.5px; opacity: 0.6; margin-bottom: 7px">单双面</div>
          <n-radio-group v-model:value="duplex" size="small">
            <n-radio-button :value="1">单面</n-radio-button>
            <n-radio-button :value="2">双面 · 短边翻转</n-radio-button>
            <n-radio-button :value="3">双面 · 长边翻转</n-radio-button>
          </n-radio-group>
          <div style="font-size: 11.5px; opacity: 0.5; margin-top: 6px; line-height: 1.6">
            「长边」= 沿纸张长边翻，翻出来像<b>书</b>（竖版文档最常用，也是双面打印的默认）；
            「短边」= 沿短边翻，翻出来像<b>便签本</b>（横版表格/PPT 常用）。
          </div>
        </div>

        <div>
          <div style="font-size: 12.5px; opacity: 0.6; margin-bottom: 7px">份数</div>
          <n-input-number v-model:value="copies" :min="1" :max="99" size="small" style="width: 130px" />
        </div>

        <div
          style="
            display: flex;
            gap: 8px;
            padding: 10px 12px;
            border-radius: 9px;
            font-size: 12px;
            line-height: 1.6;
            opacity: 0.72;
            background: rgba(47, 91, 255, 0.055);
          "
        >
          <n-icon :component="DocumentsOutline" :size="15" style="flex: 0 0 auto; margin-top: 2px" />
          <span>
            「不指定」由终端按文档实际纸型处理，A4 最常用。费用从每学年
            ¥{{ state.summary?.subsidy.perYear ?? 100 }} 补贴里扣，用完才转自费。
          </span>
        </div>
      </div>
    </div>

    <!-- 上传队列 -->
    <div class="panel">
      <div class="panel-head">
        <h2>上传队列</h2>
        <div class="spacer" />
        <span style="font-size: 12px; opacity: 0.55">
          {{ counts.done }} / {{ counts.total }} 完成
          <template v-if="counts.failed"> · {{ counts.failed }} 失败</template>
        </span>
      </div>

      <div class="panel-body">
        <div
          class="dropzone"
          :class="{ over: dragging }"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <n-icon :component="CloudUploadOutline" class="big-icon" />
          <div class="dz-title">拖拽文件到这里，或点击选择</div>
          <div class="dz-sub">
            支持 jpg / png / pdf / word / excel / ppt / txt，可一次选多个
          </div>
          <input
            ref="fileInput"
            type="file"
            multiple
            hidden
            :accept="ACCEPT"
            @change="onPick"
          />
        </div>
      </div>

      <div v-if="queue.length" style="padding: 0 18px 4px">
        <div v-for="item in queue" :key="item.id" class="queue-item">
          <div
            style="
              flex: 0 0 38px;
              height: 38px;
              display: grid;
              place-items: center;
              border-radius: 10px;
              font-size: 11px;
              font-weight: 600;
              background: rgba(47, 91, 255, 0.09);
              color: var(--brand);
            "
          >
            {{ ext(item.file.name) }}
          </div>

          <div class="meta">
            <div class="name" :title="item.file.name">{{ item.file.name }}</div>
            <div class="sub">{{ fmtBytes(item.file.size) }} · {{ statusText(item) }}</div>
            <n-progress
              v-if="item.status !== 'error'"
              type="line"
              :percentage="item.status === 'done' ? 100 : item.progress"
              :height="4"
              :show-indicator="false"
              :status="item.status === 'done' ? 'success' : 'default'"
              style="margin-top: 7px"
            />
          </div>

          <n-tag size="small" :type="statusType(item)" :bordered="false">
            <template v-if="item.status === 'done'">
              <n-icon :component="CheckmarkCircleOutline" />
            </template>
            <template v-else-if="item.status === 'error'">失败</template>
            <template v-else-if="item.status === 'retrying'">
              重试 {{ item.attempt }}/{{ MAX_ATTEMPTS }}
            </template>
            <template v-else>{{ item.progress }}%</template>
          </n-tag>

          <n-button
            v-if="item.status === 'error' || item.status === 'done'"
            size="tiny"
            quaternary
            @click="removeItem(item.id)"
          >
            <template #icon>
              <n-icon :component="TrashOutline" />
            </template>
          </n-button>
        </div>
      </div>

      <div
        v-if="hasFinished"
        class="panel-body"
        style="border-top: 1px solid var(--line-soft); display: flex; gap: 9px"
      >
        <n-button size="small" @click="clearFinished">
          <template #icon>
            <n-icon :component="TrashOutline" />
          </template>
          清空已完成
        </n-button>
        <div class="spacer" />
        <n-button
          v-if="counts.failed"
          size="small"
          type="primary"
          secondary
          @click="retryFailed"
        >
          <template #icon>
            <n-icon :component="RefreshOutline" />
          </template>
          重试失败项（{{ counts.failed }}）
        </n-button>
      </div>
    </div>
  </div>
</template>
