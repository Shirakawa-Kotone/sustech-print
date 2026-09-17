<script setup lang="ts">
import { onMounted, ref } from "vue";
import { NButton, NCheckbox, NIcon, NInput, useMessage } from "naive-ui";
import { KeyOutline, PersonOutline } from "@vicons/ionicons5";

import { login } from "../store";
import {
  backendLabel,
  clearCredential,
  keychainAvailable,
  keychainBackend,
  loadCredential,
  saveCredential,
} from "../credentials";

const message = useMessage();

const username = ref("");
const password = ref("");
const remember = ref(true);
const canRemember = ref(false);
const backend = ref("");
const backendName = ref("");
const busy = ref(false);
const error = ref("");

onMounted(async () => {
  canRemember.value = await keychainAvailable();
  if (!canRemember.value) return;
  backend.value = await keychainBackend();
  backendName.value = backendLabel(backend.value);

  const saved = await loadCredential();
  if (saved) {
    username.value = saved.username;
    password.value = saved.password;
    remember.value = true;
  }
});

async function submit() {
  if (busy.value) return;
  error.value = "";
  if (!username.value.trim() || !password.value) {
    error.value = "请填写学工号与校园卡密码";
    return;
  }
  busy.value = true;
  try {
    await login(username.value.trim(), password.value);
    if (canRemember.value && remember.value) {
      await saveCredential({
        username: username.value.trim(),
        password: password.value,
        savedAt: Date.now(),
      });
    } else if (canRemember.value) {
      // 用户这次不想记住了，把之前存的清掉，别留着
      await clearCredential();
    }
    message.success("登录成功");
  } catch (err) {
    error.value = (err as Error).message || "登录失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-bg">
    <div class="login-card">
      <div class="login-brand">
        <div class="brand-tile">印</div>
        <h1>南科大云打印</h1>
        <p>
          用学工号 + 校园卡密码登录<br />
          需要连接校园网或学校 VPN
        </p>
      </div>

      <form style="display: flex; flex-direction: column; gap: 14px" @submit.prevent="submit">
        <n-input
          v-model:value="username"
          size="large"
          placeholder="学工号"
          :input-props="{ autocomplete: 'username', autocapitalize: 'off' }"
        >
          <template #prefix>
            <n-icon :component="PersonOutline" :size="17" style="opacity: 0.5" />
          </template>
        </n-input>

        <n-input
          v-model:value="password"
          type="password"
          size="large"
          show-password-on="click"
          placeholder="校园卡密码"
          :input-props="{ autocomplete: 'current-password' }"
          @keyup.enter="submit"
        >
          <template #prefix>
            <n-icon :component="KeyOutline" :size="17" style="opacity: 0.5" />
          </template>
        </n-input>

        <div v-if="canRemember" style="display: flex; align-items: center; gap: 8px; margin-top: -2px">
          <n-checkbox v-model:checked="remember" size="small" />
          <span style="font-size: 12.5px; opacity: 0.72">
            自动保存密码（加密存放在{{ backendName }}）
          </span>
        </div>

        <div
          v-if="error"
          style="
            padding: 9px 12px;
            border-radius: 9px;
            font-size: 12.5px;
            color: #d63b4a;
            background: rgba(214, 59, 74, 0.09);
          "
        >
          {{ error }}
        </div>

        <n-button type="primary" size="large" block :loading="busy" attr-type="submit">
          登录
        </n-button>
      </form>

      <p style="margin: 18px 0 0; font-size: 11.5px; opacity: 0.45; text-align: center; line-height: 1.6">
        凭据只用于向学校统一认证换取会话，不会上传到任何第三方。<br />
        勾选「自动保存密码」后，重开应用即可自动登录。
      </p>
    </div>
  </div>
</template>
