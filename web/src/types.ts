// 云打印接口的数据形状。
//
// 上游是 ASP.NET + 匈牙利命名（sz 字符串 / dw 数字），字段名别改，
// 服务端原样透传，改了就取不到值。

export interface SessionUser {
  logonName: string;
  trueName: string;
  cardNo?: string;
  sex?: number;
}

export interface SummaryUser {
  logonName: string;
  trueName: string;
  cardNo?: string;
  /** 服务端自己报的补贴剩余（元）。用来和本地累计值交叉校验。 */
  serverSubsidy: number;
}

export interface Subsidy {
  perYear: number;
  academicYearStart: string;
  academicYearEnd: string;
  used: number;
  remainingComputed: number;
  serverReported: number;
  paid: number;
  pages: number;
  records: number;
}

/** 待打印文档。 */
export interface PrintJob {
  dwJobId: number;
  szJobName?: string;
  /** JSON 字符串，形如 `[{"dwPaperID":9}]`，要 parse 之后才拿得到纸型。 */
  szPaperDetail?: string;
  /** 含 "single"/"double"/"color" 等关键字。 */
  szAttribe?: string;
  dwPages?: number;
  dwCopies?: number;
  dwDuplex?: number;
  dwColor?: number;
  /** YYYYMMDD */
  dwCreateDate?: string | number;
  /** HHMMSS */
  dwCreateTime?: string | number;
  [key: string]: unknown;
}

/** 扫描件。 */
export interface ScanJob {
  dwJobId: number;
  szName?: string;
  szJobName?: string;
  szFileName?: string;
  dwPages?: number;
  dwTime?: number;
  dwCreateTime?: number;
  [key: string]: unknown;
}

/** 使用记录（打印 / 复印 / 扫描）。 */
export interface HistoryRow {
  dwSID?: number;
  /** 新接口：YYYYMMDD */
  dwDate?: string;
  /** 新接口是 HHMMSS；旧接口曾是 Unix 秒 */
  dwTime?: number | string;
  /** 上面两个字段合出来的 Unix 秒，展示统一用它 */
  dwTimestamp?: number;
  /** 已规整成 1=打印 2=扫描 3=复印（新接口的 dwType 是位掩码） */
  dwType?: number;
  dwTypeRaw?: number;
  /** 旧接口才有；新接口已不再返回文档名 */
  szDocName?: string;
  dwPaperID?: number;
  dwPages?: number;
  /** 单价，单位分 */
  dwUnitFee?: number;
  /** 补贴支付，单位分 */
  dwUsedFreeMoney?: number;
  /** 自费，单位分 */
  dwUsedMoney?: number;
  dwUsedCardMoney?: number;
  /** 终端编号 */
  dwMFPSN?: number;
  [key: string]: unknown;
}

export interface Printer {
  id: number;
  name: string;
  ip: string;
  mac?: string;
  /** 中英混杂，例如「系统空闲」/「System Idle」。 */
  status: string;
  driver?: string;
  function?: number;
  tray1?: number;
  tray2?: number;
  openTime?: number;
  closeTime?: number;
  updatedAt?: number;
}

export interface Paper {
  dwPaperID: number;
  szPaperName: string;
}

export interface Summary {
  user: SummaryUser;
  subsidy: Subsidy;
  history: HistoryRow[];
  counts: {
    pendingJobs: number;
    scans: number;
  };
}

export interface SessionResponse {
  loggedIn: boolean;
  user?: SessionUser;
}

export interface PrintersResponse {
  printers: Printer[];
  servers: unknown[];
}

export interface HistoryResponse {
  begin: string;
  end: string;
  types: number[];
  rows: HistoryRow[];
}

/** 打印/删除这类操作的结果。 */
export interface BulkResult {
  ok: boolean;
  deleted: number;
  failed: number;
  results: { id: number; ok: boolean; message?: string }[];
}

export interface UploadOptions {
  dwColor: number;
  dwPaperId: number;
  dwDuplex: number;
  dwCopies: number;
}

export interface UploadOutcome {
  ok: boolean;
  taskId: string;
  stage?: string;
  reason?: string;
  retryable?: boolean;
  message?: string;
  progress?: number | null;
}
