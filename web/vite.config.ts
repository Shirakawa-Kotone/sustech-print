import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: false,
    // 开发时把 API 打到本地的 Node 服务上，前端享受 Vite HMR，
    // 后端仍然是那个零依赖的 server.mjs。
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Electron 内置的 Chromium 很新，不需要为老浏览器降级。
    target: "chrome120",
    chunkSizeWarningLimit: 1200,
  },
});
