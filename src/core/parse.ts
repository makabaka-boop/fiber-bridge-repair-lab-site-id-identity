/**
 * 导入契约解析与严格校验。
 *
 * 仅接受普通 JSON 基础类型；所有错误均以 TopologyError 抛出中文消息，
 * 由 UI 保留上次有效拓扑并显示。
 */
import {
  TopologyError,
  type BatchPair,
  type NormalizedLink,
  type NormalizedTopology,
  type OrderedPlanStep,
  type QuoteCandidate,
} from './types';

export const MAX_SITES = 200_000;
export const MAX_LINKS = 400_000;
export const MIN_SITES = 2;
/** 批量方案筛选：单次导入的端点对数量上限 */
export const MAX_BATCH_PAIRS = 100_000;
/** 有序备纤计划：单次导入的步骤数量上限（与批量筛选相同） */
export const MAX_PLAN_STEPS = 100_000;
/** 最低总价备纤组合：单次导入的候选数量上限（精确子集枚举，至多 16 条） */
export const MAX_QUOTE_CANDIDATES = 16;

/**
 * 将一个 JSON 值规范化为非空字符串编号。
 * 允许字符串或“安全整数范围内的数字”（数字编号按十进制文本承载），
 * 拒绝布尔、null、对象、数组、空串、NaN/Infinity。
 */
export function normalizeId(value: unknown, label: string): string {
  if (typeof value === 'string') {
    if (value.length === 0) {
      throw new TopologyError(`${label}不能为空字符串`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TopologyError(`${label}必须是整数或非空字符串`);
    }
    return String(value);
  }
  throw new TopologyError(`${label}必须是字符串或整数编号`);
}

function expectObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TopologyError('导入文件必须是一个 JSON 对象，形如 {"sites": [...], "links": [...]}');
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TopologyError(`${label}必须是数组`);
  }
  return value;
}

/**
 * 解析并校验原始 JSON 文本。
 * 校验规则：
 *  - 顶层为 {"sites": [...], "links": [...]}；
 *  - 站点 2–200000 个，编号唯一且非空；
 *  - 链路至多 400000 条，编号唯一且非空；
 *  - 每条链路端点必须存在、不得自环；平行链路合法；
 *  - 原图必须连通。
 */
export function parseTopology(jsonText: string): NormalizedTopology {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new TopologyError(`JSON 语法错误：${(e as Error).message}`);
  }

  const obj = expectObject(raw);
  if (!('sites' in obj)) throw new TopologyError('缺少必填字段 "sites"');
  if (!('links' in obj)) throw new TopologyError('缺少必填字段 "links"');

  const rawSites = expectArray(obj.sites, 'sites');
  const rawLinks = expectArray(obj.links, 'links');

  if (rawSites.length < MIN_SITES) {
    throw new TopologyError(`站点数至少为 ${MIN_SITES}，当前为 ${rawSites.length}`);
  }
  if (rawSites.length > MAX_SITES) {
    throw new TopologyError(`站点数超过上限 ${MAX_SITES}，当前为 ${rawSites.length}`);
  }
  if (rawLinks.length > MAX_LINKS) {
    throw new TopologyError(`链路数超过上限 ${MAX_LINKS}，当前为 ${rawLinks.length}`);
  }

  // 站点：非空 + 唯一
  const sites: string[] = new Array(rawSites.length);
  const siteSet: Set<string> = new Set();
  for (let i = 0; i < rawSites.length; i++) {
    const id = normalizeId(rawSites[i], `第 ${i + 1} 个站点编号`);
    if (siteSet.has(id)) {
      throw new TopologyError(`站点编号重复：${JSON.stringify(id)}`);
    }
    siteSet.add(id);
    sites[i] = id;
  }

  // 链路：对象结构、唯一编号、端点合法、禁止自环
  const links: NormalizedLink[] = new Array(rawLinks.length);
  const linkIds: Set<string> = new Set();
  for (let i = 0; i < rawLinks.length; i++) {
    const entry = rawLinks[i];
    const where = `第 ${i + 1} 条链路`;
    const linkObj = expectObject(entry);
    if (!('id' in linkObj)) throw new TopologyError(`${where}缺少字段 "id"`);
    if (!('u' in linkObj)) throw new TopologyError(`${where}缺少字段 "u"`);
    if (!('v' in linkObj)) throw new TopologyError(`${where}缺少字段 "v"`);

    const id = normalizeId(linkObj.id, `${where}的编号`);
    if (linkIds.has(id)) {
      throw new TopologyError(`链路编号重复：${JSON.stringify(id)}`);
    }
    linkIds.add(id);

    const u = normalizeId(linkObj.u, `${where}（${id}）的端点 u`);
    const v = normalizeId(linkObj.v, `${where}（${id}）的端点 v`);
    if (!siteSet.has(u) || !siteSet.has(v)) {
      throw new TopologyError(
        `链路 ${JSON.stringify(id)} 的端点 ${JSON.stringify(!siteSet.has(u) ? u : v)} 不在站点清单中`,
      );
    }
    if (u === v) {
      throw new TopologyError(`链路 ${JSON.stringify(id)} 为自环（u 与 v 均为 ${JSON.stringify(u)}），自环非法`);
    }
    links[i] = { id, u, v };
  }

  const topology = { sites, links };
  assertConnected(topology);
  return topology;
}

/**
 * 批量方案端点编号规范化：沿用单次试接规则——字符串去首尾空白后非空，
 * 或安全整数按其十进制文本承载；其余类型（布尔、null、对象、数组、
 * NaN/Infinity）一律拒绝。
 */
export function normalizePairEndpoint(value: unknown, label: string): string {
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.length === 0) {
      throw new TopologyError(`${label}为空`);
    }
    return s;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  throw new TopologyError(`${label}必须是非空字符串或整数站点编号`);
}

/**
 * “仅含 a/b 两字段对象”的 JSON 数组解析，批量方案筛选与有序备纤计划共用
 * 同一份契约：1–maxCount 项，每项端点编号沿用单次试接规则。
 *
 * 仅做结构与字段校验；端点存在性、互异性由 Analyzer 针对当前拓扑校验。
 * 空数组、额外字段、超限、任一项非法均整体拒绝，错误消息携带输入下标（0 起）。
 */
function parsePairArray(jsonText: string, kind: string, maxCount: number): BatchPair[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new TopologyError(`JSON 语法错误：${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new TopologyError(`${kind}必须是一个 JSON 数组，形如 [{"a": "站点1", "b": "站点2"}, ...]`);
  }
  if (raw.length === 0) {
    throw new TopologyError(`${kind}不能为空数组：至少包含 1 项端点对`);
  }
  if (raw.length > maxCount) {
    throw new TopologyError(`${kind}项数超过上限 ${maxCount}，当前为 ${raw.length}`);
  }

  const pairs: BatchPair[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const where = `${kind}下标 ${i}`;
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TopologyError(`${where}：每项必须是仅含 "a"、"b" 两个字段的对象`);
    }
    const obj = entry as Record<string, unknown>;
    if (!('a' in obj)) throw new TopologyError(`${where}：缺少字段 "a"`);
    if (!('b' in obj)) throw new TopologyError(`${where}：缺少字段 "b"`);
    const extra = Object.keys(obj).filter((k) => k !== 'a' && k !== 'b');
    if (extra.length > 0) {
      throw new TopologyError(`${where}：每项仅允许 "a"、"b" 两个字段，发现额外字段 ${JSON.stringify(extra[0])}`);
    }
    pairs[i] = {
      a: normalizePairEndpoint(obj.a, `${where} 的端点 a`),
      b: normalizePairEndpoint(obj.b, `${where} 的端点 b`),
    };
  }
  return pairs;
}

/**
 * 解析批量方案筛选输入：一个 1–100000 项的 JSON 数组，每项为**仅含**
 * "a"、"b" 两个字段的对象（端点编号沿用单次试接规则）。
 *
 * 仅做结构与字段校验；端点存在性、互异性由 Analyzer.screenBatch
 * 针对当前拓扑校验。空批次、额外字段、超限、任一项非法均整体拒绝，
 * 错误消息携带输入下标（0 起）。
 */
export function parseBatchPlans(jsonText: string): BatchPair[] {
  return parsePairArray(jsonText, '批量方案', MAX_BATCH_PAIRS);
}

/**
 * 解析有序备纤计划输入：与批量方案筛选完全相同的 1–100000 项 a/b 数组契约，
 * 区别仅在于步骤顺序决定桥的归属（同一桥只归最早覆盖它的步骤）。
 * 端点存在性、互异性由 Analyzer.reviewOrderedPlan 针对当前拓扑校验。
 */
export function parseOrderedPlan(jsonText: string): OrderedPlanStep[] {
  return parsePairArray(jsonText, '有序备纤计划', MAX_PLAN_STEPS);
}

/**
 * 解析最低总价备纤组合输入：一个 1–16 条候选的 JSON 数组，每项为**仅含**
 * "id"、"a"、"b"、"price" 四个字段的对象：
 *  - id：候选编号，非空且全批唯一（规则同链路编号）；
 *  - a / b：端点编号，沿用单次试接规则；端点存在性、互异性由 Analyzer 校验；
 *  - price：数字、整数、非负、不超过 Number.MAX_SAFE_INTEGER。
 *
 * 空数组、超限、非对象项、缺字段、额外字段、编号重复、报价非法均整体拒绝，
 * 错误消息携带零起下标。整批报价合计若超出安全整数范围同样整批拒绝
 * （此后任意子集合计也必然落在安全整数范围内，精确裁决成立）。
 */
export function parseQuotePlans(jsonText: string): QuoteCandidate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new TopologyError(`JSON 语法错误：${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new TopologyError(
      '备纤报价必须是一个 JSON 数组，形如 [{"id": "候选1", "a": "站点1", "b": "站点2", "price": 100}, ...]',
    );
  }
  if (raw.length === 0) {
    throw new TopologyError('备纤报价不能为空数组：至少包含 1 条候选连线');
  }
  if (raw.length > MAX_QUOTE_CANDIDATES) {
    throw new TopologyError(`备纤报价候选数超过上限 ${MAX_QUOTE_CANDIDATES}，当前为 ${raw.length}`);
  }

  const candidates: QuoteCandidate[] = new Array(raw.length);
  const ids = new Set<string>();
  let total = 0; // 维护不变量：累计合计始终为安全整数
  for (let i = 0; i < raw.length; i++) {
    const where = `备纤报价下标 ${i}`;
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TopologyError(`${where}：每项必须是仅含 "id"、"a"、"b"、"price" 四个字段的对象`);
    }
    const obj = entry as Record<string, unknown>;
    if (!('id' in obj)) throw new TopologyError(`${where}：缺少字段 "id"`);
    if (!('a' in obj)) throw new TopologyError(`${where}：缺少字段 "a"`);
    if (!('b' in obj)) throw new TopologyError(`${where}：缺少字段 "b"`);
    if (!('price' in obj)) throw new TopologyError(`${where}：缺少字段 "price"`);
    const extra = Object.keys(obj).filter((k) => k !== 'id' && k !== 'a' && k !== 'b' && k !== 'price');
    if (extra.length > 0) {
      throw new TopologyError(
        `${where}：每项仅允许 "id"、"a"、"b"、"price" 四个字段，发现额外字段 ${JSON.stringify(extra[0])}`,
      );
    }

    const id = normalizeId(obj.id, `${where} 的候选编号`);
    if (ids.has(id)) {
      throw new TopologyError(`${where}：候选编号重复：${JSON.stringify(id)}`);
    }
    ids.add(id);

    const a = normalizePairEndpoint(obj.a, `${where} 的端点 a`);
    const b = normalizePairEndpoint(obj.b, `${where} 的端点 b`);
    const price = normalizePrice(obj.price, where);

    // 相加前先判溢出：两侧此刻均为安全整数，比较精确，绝不让合计丢精度
    if (price > Number.MAX_SAFE_INTEGER - total) {
      throw new TopologyError(
        `备纤报价整批拒绝：${i + 1} 条候选报价合计超出安全整数范围（Number.MAX_SAFE_INTEGER），无法精确比较总价`,
      );
    }
    total += price;
    candidates[i] = { id, a, b, price };
  }
  return candidates;
}

/** 报价校验：必须是数字、整数、非负且为安全整数（字符串 / 布尔 / null / 1.5 一律拒绝） */
function normalizePrice(value: unknown, where: string): number {
  if (typeof value !== 'number') {
    throw new TopologyError(`${where}：报价必须是数字（非负安全整数）`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TopologyError(
      `${where}：报价必须是不超过 2^53−1 的整数（拒绝小数、NaN、Infinity 与超出安全整数范围的整数）`,
    );
  }
  if (value < 0) {
    throw new TopologyError(`${where}：报价不能为负（允许 0，例如存量免费备纤）`);
  }
  return value;
}

/** 连通性检查（显式栈迭代，避免深递归） */
function assertConnected(t: NormalizedTopology): void {
  const n = t.sites.length;
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(t.sites[i], i);

  const adj: Int32Array[] = new Array(n);
  const head = new Int32Array(n);
  // 先统计度数，再一次性分配邻接缓冲（紧凑且无装箱）
  for (const l of t.links) {
    head[index.get(l.u)!]++;
    head[index.get(l.v)!]++;
  }
  for (let i = 0; i < n; i++) {
    adj[i] = new Int32Array(head[i]);
    head[i] = 0;
  }
  for (const l of t.links) {
    const a = index.get(l.u)!;
    const b = index.get(l.v)!;
    adj[a][head[a]++] = b;
    adj[b][head[b]++] = a;
  }

  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  stack[top++] = 0;
  seen[0] = 1;
  let reached = 0;
  while (top > 0) {
    const x = stack[--top];
    reached++;
    const nb = adj[x];
    for (let k = 0; k < nb.length; k++) {
      const y = nb[k];
      if (!seen[y]) {
        seen[y] = 1;
        stack[top++] = y;
      }
    }
  }
  if (reached !== n) {
    throw new TopologyError(`原图必须连通：仅 ${reached}/${n} 个站点可达，存在孤立站点或分区`);
  }
}
