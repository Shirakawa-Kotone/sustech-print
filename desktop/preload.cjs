// 预加载脚本：渲染进程只能通过这里暴露的窄接口接触主进程。
//
// contextIsolation 打开、nodeIntegration 关掉，所以网页那边拿不到 require
// 或 fs，只能调用下面这几个明确的方法。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sustechDesktop", {
  platform: process.platform,

  credentials: {
    available: () => ipcRenderer.invoke("credentials:available"),
    backend: () => ipcRenderer.invoke("credentials:backend"),
    save: (credential) => ipcRenderer.invoke("credentials:save", credential),
    load: () => ipcRenderer.invoke("credentials:load"),
    clear: () => ipcRenderer.invoke("credentials:clear"),
    arm: () => ipcRenderer.invoke("credentials:arm"),
  },

  app: {
    info: () => ipcRenderer.invoke("app:info"),
  },
});
