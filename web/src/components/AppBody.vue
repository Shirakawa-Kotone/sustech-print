<script setup lang="ts">
// 外壳：启动中 → 登录页 → 主界面。
import { onMounted } from "vue";
import { NSpin } from "naive-ui";

import AppSidebar from "./AppSidebar.vue";
import LoginView from "../views/LoginView.vue";
import OverviewView from "../views/OverviewView.vue";
import DocumentsView from "../views/DocumentsView.vue";
import UploadView from "../views/UploadView.vue";
import PrintersView from "../views/PrintersView.vue";
import HistoryView from "../views/HistoryView.vue";
import SettingsView from "../views/SettingsView.vue";

import { bootstrap, isLoggedIn, state, type ViewKey } from "../store";

defineProps<{ isDark: boolean }>();
defineEmits<{ cycleTheme: [] }>();

onMounted(bootstrap);

const VIEWS: Record<ViewKey, { title: string; sub: string }> = {
  overview: { title: "总览", sub: "补贴、用量与打印点概况" },
  documents: { title: "文档", sub: "待打印文档与扫描件" },
  upload: { title: "上传打印", sub: "拖入文件即可加入打印队列" },
  printers: { title: "打印点", sub: "全校自助终端实时状态" },
  history: { title: "使用记录", sub: "打印、复印、扫描明细" },
  settings: { title: "设置", sub: "账号、外观与本地凭据" },
};

const COMPONENTS = {
  overview: OverviewView,
  documents: DocumentsView,
  upload: UploadView,
  printers: PrintersView,
  history: HistoryView,
  settings: SettingsView,
} as const;
</script>

<template>
  <div v-if="state.booting" class="login-bg">
    <div style="display: flex; flex-direction: column; align-items: center; gap: 14px">
      <div class="brand-tile" style="width: 52px; height: 52px; font-size: 26px">印</div>
      <n-spin size="small" />
      <span style="font-size: 13px; opacity: 0.6">正在连接本地服务…</span>
    </div>
  </div>

  <login-view v-else-if="!isLoggedIn" />

  <div v-else class="shell">
    <app-sidebar @cycle-theme="$emit('cycleTheme')" />
    <div class="main">
      <header class="topbar drag-region">
        <div>
          <h1>{{ VIEWS[state.view].title }}</h1>
          <div class="sub">{{ VIEWS[state.view].sub }}</div>
        </div>
        <div class="spacer" />
      </header>
      <main class="content">
        <div class="content-inner">
          <!--
            这里必须有一个单根包裹元素：几个视图的模板是多根的（Fragment），
            而 <transition mode="out-in"> 只能作用于单根节点——直接套在组件上会
            让第一次切换卡住，之后内容区就一直是空的。
          -->
          <transition name="fade" mode="out-in">
            <div :key="state.view">
              <component :is="COMPONENTS[state.view]" />
            </div>
          </transition>
        </div>
      </main>
    </div>
  </div>
</template>
