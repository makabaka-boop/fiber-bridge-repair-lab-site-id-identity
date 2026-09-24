/**
 * 上限性能基准：200000 站点 / 400000 链路。
 * 用法：npx tsx src/core/perf.ts（或 node --import tsx）。
 * 断言总耗时 < 5000ms，且整个分析为显式栈迭代、不触发递归深度问题。
 *
 * 第二段：200000 站点纯长链 + 100000 组批量方案查询，断言分析器构建
 * （含只读 LCA 索引）与整批查询合计 < 5000ms，且每项计数等于站点距离。
 *
 * 第三段：200000 站点纯长链的有序备纤计划——首步全覆盖后再跟 99999 条
 * 子路径，断言仅首步有收益、后续边际均为 0，分析器构建与整批复核
 * 合计 < 5000ms（并查集向父级跳转，全覆盖后每步 O(α(n))）。
 *
 * 第四段：200000 站点纯长链 + 16 条候选（子集枚举上界）的最低总价组合
 * 规划——16 段路径恰好分片覆盖全部桥，断言 16 条全部入选、总价精确，
 * 分析器构建与整批求解（树路径标记 + 2^16 SOS/枚举）合计 < 5000ms。
 */
import { parseTopology } from './parse';
import { Analyzer } from './analysis';
import type { BatchPair, NormalizedTopology, OrderedPlanStep, QuoteCandidate } from './types';

function buildUpperBoundTopology(): string {
  const n = 200_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;

  // 生成树（长链，制造最深的“递归”场景）n-1 条，再补平行/回边到 400k
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `tree-${i}`, u: sites[i - 1], v: sites[i] });
  }
  let extra = 0;
  while (links.length < 400_000) {
    // 随机回边，跨度足够大时会成大环；也插入部分平行边
    const i = Math.floor(Math.random() * n);
    let j = Math.floor(Math.random() * n);
    if (j === i) j = (j + 1) % n;
    links.push({ id: `x-${extra++}`, u: sites[i], v: sites[j] });
  }
  return JSON.stringify({ sites, links });
}

function normalize(t: NormalizedTopology): NormalizedTopology {
  return t;
}

const ms = (a: number, b: number) => (b - a).toFixed(1);

function main(): void {
  const t0 = performance.now();
  const text = buildUpperBoundTopology();
  const t1 = performance.now();
  const parsed = normalize(parseTopology(text));
  const t2 = performance.now();
  const analyzer = new Analyzer(parsed);
  const t3 = performance.now();
  // 再做一次最坏路径试接（两端在链上相距最远）
  const trial = analyzer.trial(parsed.sites[0], parsed.sites[parsed.sites.length - 1]);
  const t4 = performance.now();

  console.log(`构造输入: ${ms(t0, t1)} ms`);
  console.log(`解析校验: ${ms(t1, t2)} ms`);
  console.log(`基线Tarjan(含LCA索引): ${ms(t2, t3)} ms`);
  console.log(`试接: ${ms(t3, t4)} ms`);
  console.log(`解析+基线+试接合计: ${ms(t1, t4)} ms`);
  console.log(`站点=${analyzer.baseline.siteCount} 链路=${analyzer.baseline.linkCount}`);
  console.log(`基线桥=${analyzer.baseline.bridges.length} 试接后仍脆弱=${trial.stillFragile.length} 已消除=${trial.removed.length}`);

  const budget = 5000;
  if (t4 - t1 > budget) {
    console.error(`超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：在上限 ${budget}ms 预算内完成`);

  benchBatch();
}

/** 批量方案筛选基准：200000 站点纯长链 + 100000 组查询，计数应等于距离 */
function benchBatch(): void {
  const n = 200_000;
  const q = 100_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `c-${i}`, u: sites[i - 1], v: sites[i] });
  }

  const b0 = performance.now();
  const chainAnalyzer = new Analyzer(normalize(parseTopology(JSON.stringify({ sites, links }))));
  const b1 = performance.now();

  // 确定性伪随机端点对（线性同余），避免测试间抖动
  let state = 0x9e3779b9;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const pairs: BatchPair[] = new Array(q);
  for (let i = 0; i < q; i++) {
    const a = Math.floor(rand() * n);
    let b = Math.floor(rand() * n);
    if (b === a) b = (b + 1) % n;
    pairs[i] = { a: sites[a], b: sites[b] };
  }

  const b2 = performance.now();
  const result = chainAnalyzer.screenBatch(pairs);
  const b3 = performance.now();

  // 长链上每条边都是桥：可消除数量必须等于两端点的站点距离
  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(sites[i], i);
  for (let i = 0; i < q; i++) {
    const it = result.items[i];
    const dist = Math.abs(indexOf.get(it.a)! - indexOf.get(it.b)!);
    if (it.removedCount !== dist || it.index !== i) {
      console.error(`下标 ${i} 计数错误：期望距离 ${dist}，实际 ${it.removedCount}`);
      process.exit(1);
    }
  }

  console.log(`—— 批量方案筛选（200000 站点长链 / ${q} 组查询）——`);
  console.log(`解析+分析器构建(含LCA索引): ${ms(b0, b1)} ms`);
  console.log(`生成查询: ${ms(b1, b2)} ms`);
  console.log(`整批查询: ${ms(b2, b3)} ms`);
  console.log(`分析器构建+整批查询合计: ${ms(b0, b3)} ms`);

  const budget = 5000;
  if (b3 - b0 > budget) {
    console.error(`批量筛选超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：批量筛选在上限 ${budget}ms 预算内完成，${q} 项计数全部等于距离`);

  benchOrderedPlan();
}

/**
 * 有序备纤计划基准：200000 站点纯长链（199999 座桥）。
 * 首步 (site-0, site-199999) 全覆盖；随后 99999 条子路径全部包含于
 * 已覆盖区间，断言仅首步边际为 199999、后续 99999 步边际均为 0。
 */
function benchOrderedPlan(): void {
  const n = 200_000;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `c-${i}`, u: sites[i - 1], v: sites[i] });
  }

  const b0 = performance.now();
  const chainAnalyzer = new Analyzer(normalize(parseTopology(JSON.stringify({ sites, links }))));
  const b1 = performance.now();

  // 确定性 LCG 生成 99999 条真子路径（端点不同、跨度 >=1，全部落在链内）
  let state = 0x85ebca6b;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const subSteps: OrderedPlanStep[] = new Array(99_999);
  for (let i = 0; i < subSteps.length; i++) {
    const p = Math.floor(rand() * (n - 1));
    const span = 1 + Math.floor(rand() * (n - 1 - p));
    subSteps[i] = { a: sites[p], b: sites[p + span] };
  }
  const steps: OrderedPlanStep[] = [{ a: sites[0], b: sites[n - 1] }, ...subSteps];

  const b2 = performance.now();
  const result = chainAnalyzer.reviewOrderedPlan(steps);
  const b3 = performance.now();

  // 仅首步有收益：199999 座桥全部归首步；后续 99999 条子路径边际均为 0
  if (result.items[0].marginal !== n - 1) {
    console.error(`首步边际错误：期望 ${n - 1}，实际 ${result.items[0].marginal}`);
    process.exit(1);
  }
  for (let i = 1; i < steps.length; i++) {
    if (result.items[i].marginal !== 0) {
      console.error(`下标 ${i} 应为零边际，实际 ${result.items[i].marginal}`);
      process.exit(1);
    }
    if (result.items[i].cumulative !== n - 1 || result.items[i].remaining !== 0) {
      console.error(`下标 ${i} 累计/剩余错误：${result.items[i].cumulative}/${result.items[i].remaining}`);
      process.exit(1);
    }
  }
  if (result.coveredCount !== n - 1 || result.baselineCount !== n - 1) {
    console.error(`覆盖/基线计数错误：${result.coveredCount}/${result.baselineCount}`);
    process.exit(1);
  }

  console.log(`—— 有序备纤计划复核（200000 站点长链 / ${steps.length} 步：首步全覆盖 + 99999 子路径）——`);
  console.log(`解析+分析器构建(含LCA索引): ${ms(b0, b1)} ms`);
  console.log(`生成计划: ${ms(b1, b2)} ms`);
  console.log(`整批复核: ${ms(b2, b3)} ms`);
  console.log(`分析器构建+整批复核合计: ${ms(b0, b3)} ms`);

  const budget = 5000;
  if (b3 - b0 > budget) {
    console.error(`有序备纤计划复核超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：有序备纤计划复核在 ${budget}ms 预算内完成，仅首步有收益、后续 99999 步均为零`);

  benchQuotePlan();
}

/**
 * 最低总价备纤组合基准：200000 站点纯长链（199999 座桥）+ 16 条候选
 * （精确子集枚举的上界）。16 条候选分片覆盖整链，每座桥恰被一条候选
 * 覆盖，故最优组合就是 16 条全选；断言求解可行、16 条入选、总价精确，
 * 且分析器构建与整批求解合计 < 5000ms（树路径标记总步数 ≤ 16n，
 * SOS DP 与子集枚举仅 O(16·2^16 + 2^16)）。
 */
function benchQuotePlan(): void {
  const n = 200_000;
  const segments = 16;
  const sites = new Array<string>(n);
  for (let i = 0; i < n; i++) sites[i] = `site-${i}`;
  const links: { id: string; u: string; v: string }[] = [];
  for (let i = 1; i < n; i++) {
    links.push({ id: `q-${i}`, u: sites[i - 1], v: sites[i] });
  }

  const b0 = performance.now();
  const chainAnalyzer = new Analyzer(normalize(parseTopology(JSON.stringify({ sites, links }))));
  const b1 = performance.now();

  // 确定性分片：候选 i 覆盖站点 [i*12500, (i+1)*12500) 之间的桥，
  // 16 段并集恰为全部 199999 座桥，各段不重叠 ⇒ 16 条均为必需。
  const candidates: QuoteCandidate[] = [];
  for (let i = 0; i < segments; i++) {
    const p = i * 12_500;
    const q = Math.min((i + 1) * 12_500, n - 1);
    candidates.push({ id: `C${String(i).padStart(2, '0')}`, a: sites[p], b: sites[q], price: 1000 - i });
  }

  const b2 = performance.now();
  const result = chainAnalyzer.planQuotes(candidates);
  const b3 = performance.now();

  const expectedTotal = candidates.reduce((s, c) => s + c.price, 0);
  if (!result.feasible) {
    console.error('最低总价组合应为可行，实际不可行');
    process.exit(1);
  }
  if (result.selected.length !== segments) {
    console.error(`所选候选数错误：期望 ${segments}，实际 ${result.selected.length}`);
    process.exit(1);
  }
  if (result.totalPrice !== expectedTotal) {
    console.error(`总价错误：期望 ${expectedTotal}，实际 ${result.totalPrice}`);
    process.exit(1);
  }
  if (result.coverage.length !== n - 1 || result.uncoverable.length !== 0) {
    console.error(
      `覆盖明细错误：覆盖 ${result.coverage.length}/${n - 1}，未覆盖 ${result.uncoverable.length}`,
    );
    process.exit(1);
  }
  for (const item of result.coverage) {
    if (item.coveredBy.length !== 1) {
      console.error(`桥 ${item.bridge.id} 应恰由一条候选覆盖，实际 ${item.coveredBy.length}`);
      process.exit(1);
    }
  }

  console.log(`—— 最低总价备纤组合（200000 站点长链 / ${segments} 条候选分片全覆盖）——`);
  console.log(`解析+分析器构建(含LCA索引): ${ms(b0, b1)} ms`);
  console.log(`生成候选: ${ms(b1, b2)} ms`);
  console.log(`整批求解: ${ms(b2, b3)} ms`);
  console.log(`分析器构建+整批求解合计: ${ms(b0, b3)} ms`);

  const budget = 5000;
  if (b3 - b0 > budget) {
    console.error(`最低总价备纤组合超出 ${budget}ms 预算`);
    process.exit(1);
  }
  console.log(`OK：最低总价备纤组合在 ${budget}ms 预算内完成，${segments} 条全部入选、总价 ${expectedTotal}`);
}

main();
