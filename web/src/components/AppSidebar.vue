<script setup lang="ts">
// 左侧导航。用户卡片放在底部，点它直接进设置。
import { computed, type Component } from "vue";
import { NBadge, NIcon, NTooltip } from "naive-ui";
import {
  CloudUploadOutline,
  ContrastOutline,
  DocumentTextOutline,
  GridOutline,
  LogOutOutline,
  MoonOutline,
  PrintOutline,
  SettingsOutline,
  SunnyOutline,
  TimeOutline,
} from "@vicons/ionicons5";

import { logout, state, type ViewKey } from "../store";

defineEmits<{ cycleTheme: [] }>();

interface NavItem {
  key: ViewKey;
  label: string;
  icon: Component;
  badge?: number;
}

const nav = computed<NavItem[]>(() => {
  const docCount = (state.jobs?.length ?? 0) + (state.scans?.length ?? 0);
  return [
    { key: "overview", label: "总览", icon: GridOutline },
    { key: "documents", label: "文档", icon: DocumentTextOutline, badge: docCount },
    { key: "upload", label: "上传打印", icon: CloudUploadOutline },
    { key: "printers", label: "打印点", icon: PrintOutline },
    { key: "history", label: "使用记录", icon: TimeOutline },
    { key: "settings", label: "设置", icon: SettingsOutline },
  ];
});

const themeIcon = computed(() => {
  if (state.themeMode === "light") return SunnyOutline;
  if (state.themeMode === "dark") return MoonOutline;
  return ContrastOutline;
});

const themeLabel = computed(
  () => ({ auto: "跟随系统", light: "浅色", dark: "深色" })[state.themeMode],
);

const user = computed(() => state.summary?.user ?? null);
const displayName = computed(
  () => user.value?.trueName || state.session?.user?.trueName || "同学",
);
const subName = computed(
  () =>
    user.value?.logonName ||
    state.session?.user?.logonName ||
    state.session?.user?.cardNo ||
    "已登录",
);
const initial = computed(() => displayName.value.slice(0, 1) || "印");

function go(key: ViewKey) {
  state.view = key;
}

async function doLogout() {
  await logout();
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-tile">印</div>
      <div class="brand-text">
        <span class="brand-title">南科大云打印</span>
        <span class="brand-sub">本地客户端</span>
      </div>
    </div>

    <nav class="sidebar-nav">
      <div class="nav-group-label">工作台</div>
      <button
        v-for="item in nav"
        :key="item.key"
        class="user-chip"
        :style="{
          background: state.view === item.key ? 'var(--hover)' : 'transparent',
          borderColor: state.view === item.key ? 'transparent' : 'transparent',
          fontWeight: state.view === item.key ? 600 : 400,
          color: state.view === item.key ? 'var(--brand)' : 'inherit',
        }"
        @click="go(item.key)"
      >
        <n-icon
          :component="item.icon"
          :size="18"
          :color="state.view === item.key ? 'var(--brand)' : undefined"
          :style="{ opacity: state.view === item.key ? 1 : 0.62 }"
        />
        <span style="flex: 1 1 auto; font-size: 13.5px">{{ item.label }}</span>
        <n-badge
          v-if="item.badge"
          :value="item.badge"
          :max="99"
          type="info"
          :offset="[2, 0]"
        />
      </button>
    </nav>

    <div class="sidebar-foot">
      <n-tooltip trigger="hover" placement="top">
        <template #trigger>
          <button
            class="user-chip"
            style="margin-bottom: 4px"
            @click="$emit('cycleTheme')"
          >
            <n-icon :component="themeIcon" :size="17" style="opacity: 0.66" />
            <span style="flex: 1 1 auto; font-size: 13px">外观</span>
            <span style="font-size: 12px; opacity: 0.55">{{ themeLabel }}</span>
          </button>
        </template>
        点击切换：跟随系统 / 浅色 / 深色
      </n-tooltip>

      <button class="user-chip" @click="go('settings')">
        <div class="avatar">{{ initial }}</div>
        <div class="who">
          <b>{{ displayName }}</b>
          <span>{{ subName }}</span>
        </div>
      </button>

      <button class="user-chip" style="color: #d63b4a" @click="doLogout">
        <n-icon :component="LogOutOutline" :size="17" />
        <span style="flex: 1 1 auto; font-size: 13px">退出登录</span>
      </button>
    </div>
  </aside>
</template>
