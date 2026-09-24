/**
 * 拓扑工作台核心数据类型。
 *
 * 输入仅允许普通 JSON 基础类型：字符串、数字（站点/链路编号均以字符串承载）、
 * 布尔值、null、数组、对象。解析后统一转换为下列内部类型。
 */

/** 原始导入结构（普通 JSON 对象） */
export interface RawTopology {
  /** 2–200000 个唯一非空站点编号 */
  sites: unknown[];
  /** 0–400000 条唯一编号的无向链路 */
  links: unknown[];
}

/** 规范化后的无向链路 */
export interface NormalizedLink {
  /** 链路编号（唯一、非空） */
  id: string;
  /** 端点站点编号（必须存在，u !== v） */
  u: string;
  v: string;
}

/** 规范化后的拓扑 */
export interface NormalizedTopology {
  /** 站点编号（保持导入顺序） */
  sites: string[];
  links: NormalizedLink[];
}

/** 单条脆弱链路（桥）的基线结论 */
export interface BridgeInfo {
  /** 链路编号 */
  id: string;
  /** 另一站点端点（便于核对，不输出站点清单） */
  u: string;
  v: string;
  /** 断开后两个连通块中较小者的站点数 */
  smallerSide: number;
}

/** 完整基线分析结果（试接不改写此结果） */
export interface BaselineResult {
  siteCount: number;
  linkCount: number;
  /** 按链路编号 UTF-8 字节序排序的全部脆弱链路 */
  bridges: BridgeInfo[];
}

/** 批量方案中的一项端点对（编号已按单次试接规则规范化） */
export interface BatchPair {
  a: string;
  b: string;
}

/** 批量筛选结果中的一项：与输入下标一一对应，重复候选按原序保留 */
export interface BatchScreenItem {
  /** 输入下标（0 起） */
  index: number;
  a: string;
  b: string;
  /** 试接 (a,b) 可消除的基线脆弱链路（桥）数量；不展开链路清单 */
  removedCount: number;
}

/** 批量筛选整体结果：全批校验通过后一次性生成并整体提交 */
export interface BatchScreenResult {
  /** 按输入下标排列，长度与输入一致 */
  items: BatchScreenItem[];
  /** 生成结果时的基线脆弱链路总数（快照，便于核对） */
  baselineCount: number;
}

/** 有序备纤计划中的一步（与批量方案同样的端点对，但步骤顺序有意义） */
export interface OrderedPlanStep {
  a: string;
  b: string;
}

/** 有序备纤计划复核中的一步结论：同一桥只归最早覆盖它的步骤 */
export interface OrderedPlanItem {
  /** 步骤下标（0 起），即计划中的施工顺序 */
  index: number;
  a: string;
  b: string;
  /** 本步首次消除的基线桥（此前各步均未覆盖），按链路编号 UTF-8 字节序 */
  firstRemoved: BridgeInfo[];
  /** 边际数：本步首次消除的桥数（重复/反向/交叠/包含路径的后续步骤可为 0） */
  marginal: number;
  /** 累计数：截至本步（含）已消除的桥数 */
  cumulative: number;
  /** 剩余数：本步之后计划尚未覆盖的基线桥数 */
  remaining: number;
}

/** 有序备纤计划整体复核结果：全批校验通过、计算完成后原子替换 */
export interface OrderedPlanResult {
  /** 按计划顺序排列，长度与输入一致 */
  items: OrderedPlanItem[];
  /** 生成结果时的基线脆弱链路总数（快照） */
  baselineCount: number;
  /** 计划覆盖的基线桥总数（= 末步累计数，= 各步清单并集大小） */
  coveredCount: number;
}

/** 报价备纤候选：带唯一编号与非负安全整数报价的虚拟连线（仅参与规划，不改写原图） */
export interface QuoteCandidate {
  /** 候选编号（唯一、非空） */
  id: string;
  a: string;
  b: string;
  /** 非负安全整数报价 */
  price: number;
}

/** 一条基线桥在最优组合下的消除来源（候选可重复覆盖同一桥） */
export interface BridgeCoverageItem {
  /** 基线桥（编号、端点、较小侧站点数） */
  bridge: BridgeInfo;
  /** 覆盖该桥的所选候选编号，按候选编号 UTF-8 字节序 */
  coveredBy: string[];
}

/**
 * 最低总价备纤组合的精确求解结果（只读规划，不改写基线与既有试算）。
 * 裁决次序：总价低者优先 → 条数少者优先 → 按编号 UTF-8 字节序序列定唯一方案。
 */
export interface QuotePlanResult {
  /** 是否可行：全部基线桥都能被候选组合覆盖（存在无法覆盖的桥时为 false，不伪造成功） */
  feasible: boolean;
  /** 所选候选（按候选编号 UTF-8 字节序）；无桥时为空方案，不可行时为空 */
  selected: QuoteCandidate[];
  /** 所选候选报价合计（安全整数；空方案与不可行时为 0） */
  totalPrice: number;
  /** 每条基线桥由哪些所选候选消除（按桥编号 UTF-8 字节序；仅可行时给出） */
  coverage: BridgeCoverageItem[];
  /** 任何候选都无法覆盖的基线桥（按编号 UTF-8 字节序）；非空即不可行 */
  uncoverable: BridgeInfo[];
  /** 基线脆弱链路总数（快照） */
  baselineCount: number;
  /** 参与求解的候选数（校验通过后的快照） */
  candidateCount: number;
}

/** 试接一条虚拟备纤后的结论 */
export interface TrialResult {
  a: string;
  b: string;
  /** 试接后仍然脆弱的链路（基线桥的子集，按编号 UTF-8 字节序） */
  stillFragile: BridgeInfo[];
  /** 相对基线已消除的链路（按编号 UTF-8 字节序） */
  removed: BridgeInfo[];
  /** 基线脆弱链路总数 */
  baselineCount: number;
}

/** 解析/分析失败时抛出的错误，消息可直接展示给工程师 */
export class TopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopologyError';
  }
}
