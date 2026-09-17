<script setup lang="ts">
// 顶层：只负责主题与 Naive UI 的 Provider 嵌套。
// 真正的界面在 AppBody 里，这样它才能用 useMessage()/useDialog()。
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import {
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NMessageProvider,
  NNotificationProvider,
  darkTheme,
  dateZhCN,
  zhCN,
} from "naive-ui";

import AppBody from "./components/AppBody.vue";
import { darkThemeOverrides, lightThemeOverrides } from "./theme";
import { setThemeMode, state } from "./store";

const prefersDark = ref(false);
let mq: MediaQueryList | null = null;

function sync(e: MediaQueryList | MediaQueryListEvent) {
  prefersDark.value = e.matches;
}

onMounted(() => {
  mq = window.matchMedia("(prefers-color-scheme: dark)");
  sync(mq);
  mq.addEventListener("change", sync);
});

onUnmounted(() => mq?.removeEventListener("change", sync));

const isDark = computed(() => {
  if (state.themeMode === "auto") return prefersDark.value;
  return state.themeMode === "dark";
});

// 把解析后的主题写到 <html data-theme>。global.css 里的表面色板靠它切换；
// 不能指望 Naive UI 的 --n-* 变量，那些只在组件自己的元素上有值。
watchEffect(() => {
  document.documentElement.dataset.theme = isDark.value ? "dark" : "light";
});

const theme = computed(() => (isDark.value ? darkTheme : null));
const overrides = computed(() =>
  isDark.value ? darkThemeOverrides : lightThemeOverrides,
);

function cycleTheme() {
  const order = ["auto", "light", "dark"] as const;
  const i = order.indexOf(state.themeMode);
  setThemeMode(order[(i + 1) % order.length]);
}

defineExpose({ cycleTheme });
</script>

<template>
  <n-config-provider
    :theme="theme"
    :theme-overrides="overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
    inline-theme-disabled
  >
    <n-global-style />
    <n-message-provider :max="3" placement="top">
      <n-dialog-provider>
        <n-notification-provider :max="3">
          <app-body :is-dark="isDark" @cycle-theme="cycleTheme" />
        </n-notification-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
