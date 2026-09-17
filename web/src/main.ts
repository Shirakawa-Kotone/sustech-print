import { createApp } from "vue";

import App from "./App.vue";
import "./styles/global.css";

// macOS 用 hiddenInset 标题栏时，系统的三个红绿灯按钮会压在网页左上角。
// 把平台告诉 CSS，让侧边栏顶部让出那块安全区（浏览器里没有按钮，不用让）。
document.documentElement.dataset.platform = window.sustechDesktop?.platform ?? "web";

createApp(App).mount("#app");
