// Naive UI 主题：把品牌色和圆角/阴影统一到一套值上。
//
// 设计意图：蓝色作为唯一强调色，中性灰做底，圆角偏大、阴影很浅——
// 目标是"干净的工具"，而不是"花哨的后台模板"。

import type { GlobalThemeOverrides } from "naive-ui";

export const BRAND = {
  primary: "#2f5bff",
  primaryHover: "#4a70ff",
  primaryPressed: "#1f45d8",
  primarySuppl: "#4a70ff",
  primarySoft: "#eaefff",
  primaryText: "#1c3fd0",
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

const shared: GlobalThemeOverrides["common"] = {
  primaryColor: BRAND.primary,
  primaryColorHover: BRAND.primaryHover,
  primaryColorPressed: BRAND.primaryPressed,
  primaryColorSuppl: BRAND.primarySuppl,
  infoColor: "#0b6fa4",
  successColor: "#12a06a",
  warningColor: "#c07d0a",
  errorColor: "#d63b4a",
  borderRadius: "10px",
  borderRadiusSmall: "8px",
  fontFamily: FONT,
  fontSize: "14px",
  fontSizeSmall: "13px",
  fontWeightStrong: "600",
  heightMedium: "36px",
  heightLarge: "40px",
  lineHeight: "1.6",
};

export const lightThemeOverrides: GlobalThemeOverrides = {
  common: {
    ...shared,
    bodyColor: "#f4f6fa",
    cardColor: "#ffffff",
    modalColor: "#ffffff",
    popoverColor: "#ffffff",
    tableColor: "#ffffff",
    inputColor: "#ffffff",
    borderColor: "#e4e7ee",
    dividerColor: "#eceff5",
    textColorBase: "#131720",
    textColor1: "#131720",
    textColor2: "#414a5a",
    textColor3: "#7d879a",
    hoverColor: "rgba(47, 91, 255, .06)",
  },
  Card: {
    borderRadius: "14px",
    color: "#ffffff",
    borderColor: "#e8ebf2",
    paddingMedium: "20px 22px",
    titleFontSizeMedium: "15px",
  },
  Button: {
    borderRadiusMedium: "9px",
    fontWeight: "500",
  },
  Input: { borderRadius: "9px", color: "#fbfcfe" },
  DataTable: {
    thColor: "#f7f9fc",
    thTextColor: "#5d6675",
    thFontWeight: "600",
    tdColorHover: "#f7f9ff",
    borderRadius: "12px",
    thPaddingMedium: "12px 14px",
    tdPaddingMedium: "12px 14px",
  },
  Tag: { borderRadius: "7px" },
  Progress: { railColor: "#e9edf5" },
  Menu: {
    itemTextColor: "#4c5566",
    itemIconColor: "#6b7488",
    itemTextColorActive: BRAND.primaryText,
    itemIconColorActive: BRAND.primary,
    itemTextColorHover: "#131720",
    itemColorActive: BRAND.primarySoft,
    itemColorActiveHover: BRAND.primarySoft,
    itemColorHover: "rgba(47,91,255,.06)",
    borderRadius: "9px",
  },
};

export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    ...shared,
    bodyColor: "#0d1017",
    cardColor: "#161a23",
    modalColor: "#161a23",
    popoverColor: "#1a1f29",
    tableColor: "#161a23",
    inputColor: "#1a1f29",
    borderColor: "#262c38",
    dividerColor: "#232936",
    textColorBase: "#e7eaf1",
    textColor1: "#e7eaf1",
    textColor2: "#a4adbd",
    textColor3: "#727c8e",
    hoverColor: "rgba(108, 140, 255, .12)",
    primaryColor: "#6c8cff",
    primaryColorHover: "#8099ff",
    primaryColorPressed: "#5a7bf0",
    primaryColorSuppl: "#8099ff",
  },
  Card: {
    borderRadius: "14px",
    color: "#161a23",
    borderColor: "#242a36",
    paddingMedium: "20px 22px",
    titleFontSizeMedium: "15px",
  },
  Button: { borderRadiusMedium: "9px", fontWeight: "500" },
  Input: { borderRadius: "9px", color: "#1a1f29" },
  DataTable: {
    thColor: "#1b202b",
    thTextColor: "#98a2b4",
    thFontWeight: "600",
    tdColorHover: "#1c2230",
    borderRadius: "12px",
    thPaddingMedium: "12px 14px",
    tdPaddingMedium: "12px 14px",
  },
  Tag: { borderRadius: "7px" },
  Progress: { railColor: "#242a36" },
  Menu: {
    itemTextColor: "#a4adbd",
    itemIconColor: "#828d9f",
    itemTextColorActive: "#b9c8ff",
    itemIconColorActive: "#6c8cff",
    itemTextColorHover: "#e7eaf1",
    itemColorActive: "rgba(108,140,255,.16)",
    itemColorActiveHover: "rgba(108,140,255,.2)",
    itemColorHover: "rgba(108,140,255,.1)",
    borderRadius: "9px",
  },
};
