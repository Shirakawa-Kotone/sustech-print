<script setup lang="ts">
// 设置：账号、外观、自动保存的密码、虚拟打印机。
import { computed, onMounted, ref } from "vue";
import {
  NAlert,
  NButton,
  NDivider,
  NIcon,
  NRadioButton,
  NRadioGroup,
  NTag,
  useDialog,
  useMessage,
} from "naive-ui";
import {
  InformationCircleOutline,
  KeyOutline,
  LogOutOutline,
  PrintOutline,
  TrashOutline,
} from "@vicons/ionicons5";

import { logout, setThemeMode, state } from "../store";
import { fmtDate, money } from "../format";
import { PRINTER_NAME } from "../const";
import {
  backendLabel,
  clearCredential,
  desktopBridge,
  keychainAvailable,
  keychainBackend,
  loadCredential,
} from "../credentials";

const message = useMessage();
const dialog = useDialog();

const savedAt = ref<number | null>(null);
const savedUser = ref("");
const hasSaved = ref(false);
const canRemember = ref(false);
const backendName = ref("系统安全存储");
const busy = ref(false);

const bridge = computed(() => desktopBridge());
const platform = computed(() => {
  const p = bridge.value as unknown as { platform?: string } | undefined;
  return p?.platform ?? "";
});

const isMac = computed(() => platform.value === "darwin" || platform.value === "");
const isWin = computed(() => platform.value === "win32");

const account = computed(() => state.summary?.user ?? null);
const session = computed(() => state.session?.user ?? null);
const subsidy = computed(() => state.summary?.subsidy ?? null);

onMounted(refreshCredentialState);

async function refreshCredentialState() {
  canRemember.value = await keychainAvailable();
  if (canRemember.value) {
    backendName.value = backendLabel(await keychainBackend());
    const saved = await loadCredential();
    if (saved?.username) {
      savedUser.value = saved.username;
      savedAt.value = saved.savedAt ?? null;
      hasSaved.value = true;
    }
  }
}

function confirmClearCredential() {
  dialog.warning({
    title: "删除已保存的密码",
    content: "删除后重开应用需要重新输入学工号和密码。",
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      busy.value = true;
      try {
        await clearCredential();
        hasSaved.value = false;
        savedUser.value = "";
        savedAt.value = null;
        message.success("已删除本地保存的密码");
      } finally {
        busy.value = false;
      }
    },
  });
}

async function onLogout() {
  busy.value = true;
  try {
    await logout();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid cols-2" style="align-items: start">
    <!-- 账号 -->
    <div class="panel">
      <div class="panel-head">
        <n-icon :component="InformationCircleOutline" :size="16" style="opacity: 0.6" />
        <h2>账号</h2>
      </div>
      <div class="panel-body" style="display: flex; flex-direction: column; gap: 11px">
        <div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px">
          <span style="opacity: 0.55">姓名</span>
          <b>{{ account?.trueName || session?.trueName || "—" }}</b>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px">
          <span style="opacity: 0.55">学工号</span>
          <b class="mono">{{ account?.logonName || session?.logonName || "—" }}</b>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px">
          <span style="opacity: 0.55">卡号</span>
          <b class="mono">{{ account?.cardNo || session?.cardNo || "—" }}</b>
        </div>
        <n-divider style="margin: 3px 0" />
        <div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px">
          <span style="opacity: 0.55">本学年额度</span>
          <b>¥{{ money(subsidy?.perYear ?? 0) }}</b>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px">
          <span style="opacity: 0.55">已用 / 剩余</span>
          <b>
            ¥{{ money(subsidy?.used ?? 0) }}
            <span style="opacity: 0.45"> / </span>
            ¥{{ money(subsidy?.remainingComputed ?? 0) }}
          </b>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 10px; font-size: 13px">
          <span style="opacity: 0.55">学年起算</span>
          <b class="mono">{{ fmtDate(subsidy?.academicYearStart) || "—" }}</b>
        </div>

        <n-button style="margin-top: 6px" type="error" secondary @click="onLogout" :loading="busy">
          <template #icon>
            <n-icon :component="LogOutOutline" />
          </template>
          退出登录
        </n-button>
      </div>
    </div>

    <!-- 外观 + 密码 -->
    <div style="display: flex; flex-direction: column; gap: 14px">
      <div class="panel">
        <div class="panel-head">
          <h2>外观</h2>
        </div>
        <div class="panel-body">
          <n-radio-group
            :value="state.themeMode"
            size="small"
            @update:value="(v: string) => setThemeMode(v as 'auto' | 'light' | 'dark')"
          >
            <n-radio-button value="auto">跟随系统</n-radio-button>
            <n-radio-button value="light">浅色</n-radio-button>
            <n-radio-button value="dark">深色</n-radio-button>
          </n-radio-group>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <n-icon :component="KeyOutline" :size="16" style="opacity: 0.6" />
          <h2>自动保存的密码</h2>
        </div>
        <div class="panel-body" style="display: flex; flex-direction: column; gap: 11px">
          <template v-if="canRemember">
            <n-alert v-if="hasSaved" type="success" :bordered="false" :show-icon="true">
              已用<b>{{ backendName }}</b>加密保存
              <template v-if="savedUser">（{{ savedUser }}）</template>，重开应用会自动登录。
            </n-alert>
            <n-alert v-else type="default" :bordered="false" :show-icon="true">
              还没有保存密码。登录时勾选「自动保存密码」即可。
            </n-alert>

            <div style="font-size: 12px; opacity: 0.55; line-height: 1.7">
              密码经系统密钥加密后存在本机，明文不会落盘，也不会发送到学校以外的任何服务器。
              换台电脑或换系统账户都读不出来。
            </div>

            <n-button
              v-if="hasSaved"
              type="error"
              secondary
              size="small"
              :loading="busy"
              @click="confirmClearCredential"
            >
              <template #icon>
                <n-icon :component="TrashOutline" />
              </template>
              删除已保存的密码
            </n-button>
          </template>

          <n-alert v-else type="warning" :bordered="false" :show-icon="true">
            当前在浏览器里运行，没有系统级加密存储，因此不提供自动保存密码。
            使用桌面版即可在登录时勾选「自动保存密码」。
          </n-alert>
        </div>
      </div>

      <!-- 虚拟打印机 -->
      <div class="panel">
        <div class="panel-head">
          <n-icon :component="PrintOutline" :size="16" style="opacity: 0.6" />
          <h2>虚拟打印机</h2>
          <div class="spacer" />
          <n-tag size="small" :bordered="false">系统级驱动</n-tag>
        </div>
        <div class="panel-body" style="font-size: 12.5px; line-height: 1.75">
          <p style="margin: 0 0 9px; opacity: 0.72">
            装上之后，在任何程序里按 <b>⌘P / Ctrl+P</b>，选择打印机
            <b>「{{ PRINTER_NAME }}」</b>，文件就会自动进云打印队列——不需要手动上传。
          </p>
          <template v-if="isWin">
            <div style="opacity: 0.55; margin-bottom: 5px">Windows 安装（管理员 PowerShell）：</div>
            <code
              style="
                display: block;
                padding: 9px 11px;
                border-radius: 8px;
                background: rgba(127, 140, 165, 0.12);
                font-size: 12px;
                word-break: break-all;
              "
            >
              powershell -ExecutionPolicy Bypass -File driver\windows\install-printer.ps1
            </code>
          </template>
          <template v-else-if="isMac">
            <div style="opacity: 0.55; margin-bottom: 5px">macOS 安装：</div>
            <code
              style="
                display: block;
                padding: 9px 11px;
                border-radius: 8px;
                background: rgba(127, 140, 165, 0.12);
                font-size: 12px;
                word-break: break-all;
              "
            >
              sudo bash driver/macos/install.sh
            </code>
          </template>
          <template v-else>
            <div style="opacity: 0.55">
              请参考项目 <b>driver/</b> 目录下对应平台的安装说明。
            </div>
          </template>
        </div>
      </div>

      <!-- 关于 -->
      <div class="panel">
        <div class="panel-head">
          <h2>关于</h2>
        </div>
        <div class="panel-body" style="font-size: 12.5px; line-height: 1.75; opacity: 0.7">
          <div>南科大云打印 · 本地客户端</div>
          <div>零依赖 Node 服务 + Vue 3 前端；驱动层复用系统自带的打印组件，不安装任何自研内核驱动。</div>
          <div style="margin-top: 6px; opacity: 0.75">
            上游：<b class="mono">pms.sustech.edu.cn</b>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
