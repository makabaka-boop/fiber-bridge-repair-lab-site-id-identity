import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { oracleTrial } from './oracle';
import { MAX_QUOTE_CANDIDATES, parseQuotePlans, parseTopology } from './parse';
import { Rng } from './rng';
import { compareUtf8 } from './utf8';
import type { BaselineResult, NormalizedTopology, QuoteCandidate, QuotePlanResult } from './types';

/**
 * 生成随机连通无向多重图：先生成一棵随机生成树保证连通，
 * 再追加随机边（允许平行链路、允许重复同一对）。
 */
function randomConnectedGraph(rng: Rng, n: number, extraEdges: number): NormalizedTopology {
  const sites: string[] = [];
  for (let i = 0; i < n; i++) sites[i] = `S-${(1000 + i).toString(16)}`;
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [sites[i], sites[j]] = [sites[j], sites[i]];
  }

  const raw: { id: string; u: string; v: string }[] = [];
  const usedIds = new Set<string>();
  let seq = 0;
  const newId = () => {
    let id: string;
    do {
      id = `e${(rng.int(9000) + 100).toString(36)}-${seq++}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  const order = sites.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 1; i < n; i++) {
    raw.push({ id: newId(), u: order[i], v: order[rng.int(i)] });
  }
  for (let k = 0; k < extraEdges; k++) {
    const u = sites[rng.int(n)];
    let v = sites[rng.int(n)];
    while (v === u) v = sites[rng.int(n)];
    raw.push({ id: newId(), u, v });
  }
  return { sites, links: raw };
}

/** 编号序列字典序：先按 UTF-8 字节序排序再逐位比较（与生产实现的“对称差”写法不同，互为独立） */
function compareIdSequences(a: string[], b: string[]): number {
  const sa = [...a].sort(compareUtf8);
  const sb = [...b].sort(compareUtf8);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const c = compareUtf8(sa[i], sb[i]);
    if (c !== 0) return c;
  }
  return sa.length - sb.length;
}

interface OraclePlan {
  feasible: boolean;
  /** 所选候选编号（按 UTF-8 字节序） */
  selectedIds: string[];
  totalPrice: number;
  /** 桥编号 → 覆盖它的所选候选编号（按 UTF-8 字节序） */
  coveredBy: Map<string, string[]>;
  /** 任何候选都覆盖不了的桥编号（按基线字节序） */
  uncoverable: string[];
}

/**
 * 独立预言机：每条候选的覆盖集合由**删边预言机**给出（在原图 + 该候选连线上
 * 逐边删除核对，完全不经过生产的 Tarjan 父树 / LCA 树路径），随后显式枚举
 * 全部 2^n 个子集，按“总价 → 条数 → 编号序列”三层裁决取最优。
 */
function oracleSolve(t: NormalizedTopology, baseline: BaselineResult, candidates: QuoteCandidate[]): OraclePlan {
  const n = candidates.length;
  const removedSets = candidates.map((c) => oracleTrial(t, baseline, c.a, c.b).removed);
  const bridgeIds = baseline.bridges.map((b) => b.id);

  const uncoverable = bridgeIds.filter((id) => removedSets.every((s) => !s.has(id)));
  if (uncoverable.length > 0) {
    return { feasible: false, selectedIds: [], totalPrice: 0, coveredBy: new Map(), uncoverable };
  }

  let best: number[] | null = null;
  let bestPrice = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    const members: number[] = [];
    let price = 0;
    const covered = new Set<string>();
    for (let i = 0; i < n; i++) {
      if (((mask >>> i) & 1) === 0) continue;
      members.push(i);
      price += candidates[i].price;
      for (const id of removedSets[i]) covered.add(id);
    }
    if (covered.size < bridgeIds.length) continue;
    if (
      best === null ||
      price < bestPrice ||
      (price === bestPrice && members.length < best.length) ||
      (price === bestPrice &&
        members.length === best.length &&
        compareIdSequences(
          members.map((i) => candidates[i].id),
          best.map((i) => candidates[i].id),
        ) < 0)
    ) {
      best = members;
      bestPrice = price;
    }
  }

  const chosen = best ?? [];
  const selectedIds = chosen.map((i) => candidates[i].id).sort(compareUtf8);
  const coveredBy = new Map<string, string[]>();
  for (const id of bridgeIds) {
    const sources = chosen.filter((i) => removedSets[i].has(id)).map((i) => candidates[i].id);
    coveredBy.set(id, sources.sort(compareUtf8));
  }
  return { feasible: true, selectedIds, totalPrice: bestPrice, coveredBy, uncoverable: [] };
}

/** 生产结果与独立预言机逐项核对（含展示次序与诊断字段） */
function expectMatchesOracle(result: QuotePlanResult, oracle: OraclePlan, candidateCount: number): void {
  expect(result.feasible).toBe(oracle.feasible);
  expect(result.candidateCount).toBe(candidateCount);
  expect(result.selected.map((c) => c.id)).toEqual(oracle.selectedIds);
  expect(result.totalPrice).toBe(oracle.totalPrice);
  expect(result.uncoverable.map((b) => b.id)).toEqual(oracle.uncoverable);
  if (!oracle.feasible) {
    // 不伪造成功：不可行时不给出任何方案与覆盖明细
    expect(result.selected).toEqual([]);
    expect(result.coverage).toEqual([]);
    expect(result.totalPrice).toBe(0);
    return;
  }
  // 覆盖明细按基线桥字节序逐桥对应，且每桥至少一条所选连线
  for (const item of result.coverage) {
    expect(item.coveredBy.length).toBeGreaterThan(0);
    expect(item.coveredBy).toEqual(oracle.coveredBy.get(item.bridge.id));
  }
  expect(result.coverage.length).toBe(oracle.coveredBy.size);
}

const chainTopo = (n: number): NormalizedTopology => ({
  sites: Array.from({ length: n }, (_, i) => `v${i}`),
  links: Array.from({ length: n - 1 }, (_, i) => ({ id: `L${i + 1}`, u: `v${i}`, v: `v${i + 1}` })),
});

describe('parseQuotePlans 输入契约', () => {
  it('接受合法候选：数字编号按文本规范化、端点逐字符保留、零价合法', () => {
    expect(parseQuotePlans('[{"id": 7, "a": "  s1 ", "b": 2, "price": 0}]')).toEqual([
      { id: '7', a: '  s1 ', b: '2', price: 0 },
    ]);
  });

  it('拒绝非数组、空数组、坏 JSON 与超过 16 条（整体拒绝）', () => {
    expect(() => parseQuotePlans('{"id":"x"}')).toThrow(/必须是一个 JSON 数组/);
    expect(() => parseQuotePlans('[]')).toThrow(/空数组/);
    expect(() => parseQuotePlans('{坏的')).toThrow(/JSON 语法错误/);
    const big = JSON.stringify(
      Array.from({ length: MAX_QUOTE_CANDIDATES + 1 }, (_, i) => ({ id: `c${i}`, a: 'x', b: 'y', price: 1 })),
    );
    expect(() => parseQuotePlans(big)).toThrow(/超过上限 16/);
    // 恰好 16 条合法
    const ok = JSON.stringify(
      Array.from({ length: MAX_QUOTE_CANDIDATES }, (_, i) => ({ id: `c${i}`, a: 'x', b: 'y', price: 1 })),
    );
    expect(parseQuotePlans(ok)).toHaveLength(16);
  });

  it('拒绝非对象项、缺字段与额外字段，并指出零起下标', () => {
    expect(() => parseQuotePlans('[["id","a","b","price"]]')).toThrow(/下标 0/);
    expect(() => parseQuotePlans('[{"a":"x","b":"y","price":1}]')).toThrow(/下标 0.*缺少字段 "id"/);
    expect(() => parseQuotePlans('[{"id":"x","a":"x","b":"y"}]')).toThrow(/下标 0.*缺少字段 "price"/);
    expect(() => parseQuotePlans('[{"id":"a","a":"x","b":"y","price":1},{"id":"b","a":"x","price":1}]')).toThrow(
      /下标 1.*缺少字段 "b"/,
    );
    expect(() => parseQuotePlans('[{"id":"x","a":"x","b":"y","price":1,"note":2}]')).toThrow(/下标 0.*额外字段/);
  });

  it('候选编号唯一（数字与文本规范化后相同也算重复）', () => {
    expect(() =>
      parseQuotePlans('[{"id":"x","a":"p","b":"q","price":1},{"id":"x","a":"p","b":"q","price":2}]'),
    ).toThrow(/下标 1.*候选编号重复/);
    expect(() =>
      parseQuotePlans('[{"id":7,"a":"p","b":"q","price":1},{"id":"7","a":"p","b":"q","price":2}]'),
    ).toThrow(/候选编号重复/);
    expect(() => parseQuotePlans('[{"id":"","a":"p","b":"q","price":1}]')).toThrow(/不能为空字符串/);
  });

  it('拒绝非法报价：负数、小数、非数字、超出安全整数', () => {
    const mk = (price: unknown) => JSON.stringify([{ id: 'x', a: 'p', b: 'q', price }]);
    expect(() => parseQuotePlans(mk(-1))).toThrow(/下标 0.*不能为负/);
    expect(() => parseQuotePlans(mk(1.5))).toThrow(/下标 0.*整数/);
    expect(() => parseQuotePlans(mk('100'))).toThrow(/下标 0.*必须是数字/);
    expect(() => parseQuotePlans(mk(true))).toThrow(/下标 0.*必须是数字/);
    expect(() => parseQuotePlans(mk(null))).toThrow(/下标 0.*必须是数字/);
    expect(() => parseQuotePlans(mk(Number.MAX_SAFE_INTEGER + 1))).toThrow(/下标 0.*整数/);
    // 边界：单条报价恰为 MAX_SAFE_INTEGER 合法
    expect(parseQuotePlans(mk(Number.MAX_SAFE_INTEGER))[0].price).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('整批报价合计超出安全整数范围即整批拒绝（边界恰等合法）', () => {
    const overflow = JSON.stringify([
      { id: 'a', a: 'p', b: 'q', price: Number.MAX_SAFE_INTEGER },
      { id: 'b', a: 'p', b: 'q', price: 1 },
    ]);
    expect(() => parseQuotePlans(overflow)).toThrow(/合计超出安全整数范围/);
    const bothMax = JSON.stringify([
      { id: 'a', a: 'p', b: 'q', price: Number.MAX_SAFE_INTEGER },
      { id: 'b', a: 'p', b: 'q', price: Number.MAX_SAFE_INTEGER },
    ]);
    expect(() => parseQuotePlans(bothMax)).toThrow(/合计超出安全整数范围/);
    // 合计恰好等于 MAX_SAFE_INTEGER：合法
    const exact = JSON.stringify([
      { id: 'a', a: 'p', b: 'q', price: Number.MAX_SAFE_INTEGER - 1 },
      { id: 'b', a: 'p', b: 'q', price: 1 },
    ]);
    expect(parseQuotePlans(exact)).toHaveLength(2);
  });
});

describe('原图不连通时的导入拒绝', () => {
  it('多分区与孤立站点在导入层即被拒绝，组合规划无从开始', () => {
    expect(() =>
      parseTopology(
        JSON.stringify({
          sites: ['a', 'b', 'c', 'd'],
          links: [
            { id: 'x', u: 'a', v: 'b' },
            { id: 'y', u: 'c', v: 'd' },
          ],
        }),
      ),
    ).toThrow(/原图必须连通/);
    expect(() =>
      parseTopology(JSON.stringify({ sites: ['a', 'b', 'c'], links: [{ id: 'x', u: 'a', v: 'b' }] })),
    ).toThrow(/原图必须连通/);
  });
});

describe('三层裁决（总价 → 条数 → 编号序列）', () => {
  it('总价优先：单条全覆盖与两条拼凑谁便宜选谁', () => {
    const az = new Analyzer(chainTopo(4)); // L1,L2,L3 皆为桥
    let r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v3', price: 10 }, // 全覆盖
      { id: 'Y', a: 'v0', b: 'v1', price: 6 }, // L1
      { id: 'Z', a: 'v1', b: 'v3', price: 6 }, // L2,L3；Y+Z=12 > 10
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X']);
    expect(r.totalPrice).toBe(10);

    r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v3', price: 10 },
      { id: 'Y', a: 'v0', b: 'v1', price: 4 },
      { id: 'Z', a: 'v1', b: 'v3', price: 4 }, // Y+Z=8 < 10
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['Y', 'Z']);
    expect(r.totalPrice).toBe(8);
  });

  it('条数次之：总价相同选条数更少者', () => {
    const az = new Analyzer(chainTopo(4));
    const r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v3', price: 10 }, // 1 条全覆盖
      { id: 'Y', a: 'v0', b: 'v1', price: 5 },
      { id: 'Z', a: 'v1', b: 'v3', price: 5 }, // Y+Z 同为 10 但 2 条
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X']);
    expect(r.totalPrice).toBe(10);
  });

  it('编号序列定唯一：同价同条数取编号序列字典序最小者', () => {
    const az = new Analyzer(chainTopo(3)); // L1: v0-v1，L2: v1-v2
    const r = az.planQuotes([
      { id: 'Y', a: 'v0', b: 'v1', price: 5 },
      { id: 'Z', a: 'v1', b: 'v2', price: 5 },
      { id: 'P', a: 'v0', b: 'v1', price: 5 },
      { id: 'Q', a: 'v1', b: 'v2', price: 5 },
    ]);
    // 最优（10，2 条）的子集：{P,Q} {P,Z} {Y,Q} {Y,Z}；序列最小为 [P,Q]
    expect(r.selected.map((c) => c.id)).toEqual(['P', 'Q']);
    expect(r.totalPrice).toBe(10);
  });

  it('编号序列按 UTF-8 字节序而非数值序（C10 < C2）', () => {
    const az = new Analyzer(chainTopo(3));
    const r = az.planQuotes([
      { id: 'C2', a: 'v0', b: 'v2', price: 5 },
      { id: 'C10', a: 'v0', b: 'v2', price: 5 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['C10']);
  });

  it('大报价在安全整数边界附近精确比较，不丢精度', () => {
    const M = Number.MAX_SAFE_INTEGER;
    const az = new Analyzer(chainTopo(3));

    // 单条报价恰好 M：合计精确等于 M，可选中、总价不丢精度
    let r = az.planQuotes([{ id: 'X', a: 'v0', b: 'v2', price: M }]);
    expect(r.selected.map((c) => c.id)).toEqual(['X']);
    expect(r.totalPrice).toBe(M);

    // 两条候选合计恰好 M
    r = az.planQuotes([
      { id: 'Y', a: 'v0', b: 'v1', price: M - 1 },
      { id: 'Z', a: 'v1', b: 'v2', price: 1 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['Y', 'Z']);
    expect(r.totalPrice).toBe(M);

    // 同价比条数：Y+Z = 2e15 与单条 X 持平 → X（1 条）胜；批次合计 ≈ 4e15 < M，不触发整批拒绝
    const T = 2_000_000_000_000_000;
    r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v2', price: T },
      { id: 'Y', a: 'v0', b: 'v1', price: T - 1 },
      { id: 'Z', a: 'v1', b: 'v2', price: 1 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X']);
    expect(r.totalPrice).toBe(T);

    // Y+Z 合计 T−1 < T：拼凑胜
    r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v2', price: T },
      { id: 'Y', a: 'v0', b: 'v1', price: T - 2 },
      { id: 'Z', a: 'v1', b: 'v2', price: 1 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['Y', 'Z']);
    expect(r.totalPrice).toBe(T - 1);
  });
});

describe('零价候选', () => {
  it('零价无用候选不被擅自加入（同价下条数更少者胜）', () => {
    // v0-v1-v2 链（L1,L2 为桥）＋ v2-v3 平行链路（非桥，R 在环内覆盖不到任何桥）
    const t: NormalizedTopology = {
      sites: ['v0', 'v1', 'v2', 'v3'],
      links: [
        { id: 'L1', u: 'v0', v: 'v1' },
        { id: 'L2', u: 'v1', v: 'v2' },
        { id: 'P1', u: 'v2', v: 'v3' },
        { id: 'P2', u: 'v2', v: 'v3' },
      ],
    };
    const az = new Analyzer(t);
    expect(az.baseline.bridges.map((b) => b.id)).toEqual(['L1', 'L2']);
    const r = az.planQuotes([
      { id: 'R', a: 'v2', b: 'v3', price: 0 }, // 零价但无用
      { id: 'X', a: 'v0', b: 'v2', price: 10 }, // 覆盖 L1,L2
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X']); // 不捎带 R
    expect(r.totalPrice).toBe(10);
  });

  it('零价候选有贡献时正常入选，总价可为 0', () => {
    const az = new Analyzer(chainTopo(3));
    const r = az.planQuotes([
      { id: 'R1', a: 'v0', b: 'v1', price: 0 },
      { id: 'R2', a: 'v1', b: 'v2', price: 0 },
      { id: 'X', a: 'v0', b: 'v2', price: 9 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['R1', 'R2']); // 0 < 9
    expect(r.totalPrice).toBe(0);
    expect(r.coverage.map((c) => [c.bridge.id, c.coveredBy])).toEqual([
      ['L1', ['R1']],
      ['L2', ['R2']],
    ]);
  });
});

describe('平行边与重复覆盖', () => {
  it('平行链路不构成桥；跨平行段的候选只消除真正的桥', () => {
    const t: NormalizedTopology = {
      sites: ['a', 'b', 'c'],
      links: [
        { id: 'P1', u: 'a', v: 'b' },
        { id: 'P2', u: 'a', v: 'b' }, // 平行：a-b 不再是桥
        { id: 'L1', u: 'b', v: 'c' },
      ],
    };
    const az = new Analyzer(t);
    expect(az.baseline.bridges.map((b) => b.id)).toEqual(['L1']);
    const r = az.planQuotes([
      { id: 'X', a: 'a', b: 'c', price: 7 }, // 路径 a-b-c：仅 L1 是桥
      { id: 'Y', a: 'b', b: 'c', price: 3 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['Y']);
    expect(r.totalPrice).toBe(3);
    expect(r.coverage.map((c) => [c.bridge.id, c.coveredBy])).toEqual([['L1', ['Y']]]);
  });

  it('同端点平行候选：价低者胜，同价按编号序列', () => {
    const az = new Analyzer(chainTopo(3));
    let r = az.planQuotes([
      { id: 'X1', a: 'v0', b: 'v2', price: 7 },
      { id: 'X2', a: 'v0', b: 'v2', price: 3 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X2']);
    r = az.planQuotes([
      { id: 'X2', a: 'v0', b: 'v2', price: 5 },
      { id: 'X1', a: 'v0', b: 'v2', price: 5 },
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X1']);
  });

  it('候选可重复覆盖同一桥：消除来源列出全部所选连线', () => {
    const az = new Analyzer(chainTopo(4)); // L1,L2,L3
    const r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v2', price: 4 }, // 覆盖 L1,L2
      { id: 'Y', a: 'v1', b: 'v3', price: 4 }, // 覆盖 L2,L3
    ]);
    expect(r.selected.map((c) => c.id)).toEqual(['X', 'Y']);
    expect(r.coverage.map((c) => [c.bridge.id, c.coveredBy])).toEqual([
      ['L1', ['X']],
      ['L2', ['X', 'Y']], // L2 被两条所选候选重复消除
      ['L3', ['Y']],
    ]);
  });
});

describe('无法覆盖诊断与空方案', () => {
  it('存在无法覆盖的桥：列出具体桥边，不伪造成功', () => {
    const az = new Analyzer(chainTopo(4)); // L1,L2,L3
    const r = az.planQuotes([{ id: 'X', a: 'v0', b: 'v1', price: 1 }]); // 只覆盖 L1
    expect(r.feasible).toBe(false);
    expect(r.selected).toEqual([]);
    expect(r.totalPrice).toBe(0);
    expect(r.coverage).toEqual([]);
    expect(r.uncoverable.map((b) => b.id)).toEqual(['L2', 'L3']);
    expect(r.uncoverable[0]).toMatchObject({ u: 'v1', v: 'v2', smallerSide: 2 });
  });

  it('部分覆盖仍不可行：缺口桥被精确指出', () => {
    const az = new Analyzer(chainTopo(4));
    const r = az.planQuotes([
      { id: 'X', a: 'v0', b: 'v1', price: 1 }, // L1
      { id: 'Y', a: 'v2', b: 'v3', price: 1 }, // L3
    ]);
    expect(r.feasible).toBe(false);
    expect(r.uncoverable.map((b) => b.id)).toEqual(['L2']);
  });

  it('无桥拓扑返回空方案（不选任何候选，总价 0）', () => {
    const t: NormalizedTopology = {
      sites: ['x', 'y', 'z'],
      links: [
        { id: 't1', u: 'x', v: 'y' },
        { id: 't2', u: 'y', v: 'z' },
        { id: 't3', u: 'z', v: 'x' },
      ],
    };
    const az = new Analyzer(t);
    const r = az.planQuotes([
      { id: 'Q', a: 'x', b: 'z', price: 0 },
      { id: 'W', a: 'x', b: 'y', price: 5 },
    ]);
    expect(r.feasible).toBe(true);
    expect(r.selected).toEqual([]);
    expect(r.totalPrice).toBe(0);
    expect(r.coverage).toEqual([]);
    expect(r.uncoverable).toEqual([]);
    expect(r.baselineCount).toBe(0);
    expect(r.candidateCount).toBe(2);
  });
});

describe('Analyzer.planQuotes 契约与不可变性', () => {
  it('空批、超限、端点非法、合计溢出均整批拒绝，分析器不被污染', () => {
    const az = new Analyzer(chainTopo(4));
    const baselineBefore = JSON.stringify(az.baseline);
    expect(() => az.planQuotes([])).toThrow(/不能为空/);
    const big: QuoteCandidate[] = Array.from({ length: MAX_QUOTE_CANDIDATES + 1 }, (_, i) => ({
      id: `c${i}`,
      a: 'v0',
      b: 'v1',
      price: 1,
    }));
    expect(() => az.planQuotes(big)).toThrow(/超过上限 16/);
    expect(() =>
      az.planQuotes([
        { id: 'ok', a: 'v0', b: 'v3', price: 1 },
        { id: 'bad', a: 'v1', b: 'ghost', price: 1 },
      ]),
    ).toThrow(/下标 1.*不在当前站点清单/);
    expect(() => az.planQuotes([{ id: 'x', a: 'v1', b: 'v1', price: 1 }])).toThrow(/下标 0.*必须不同/);
    // 直接调用 Analyzer 时整批合计溢出同样整批拒绝
    expect(() =>
      az.planQuotes([
        { id: 'a', a: 'v0', b: 'v1', price: Number.MAX_SAFE_INTEGER },
        { id: 'b', a: 'v1', b: 'v2', price: 1 },
      ]),
    ).toThrow(/合计超出安全整数范围/);
    expect(JSON.stringify(az.baseline)).toBe(baselineBefore);
    // 拒绝后合法输入仍正常求解
    const ok = az.planQuotes([{ id: 'x', a: 'v0', b: 'v3', price: 2 }]);
    expect(ok.feasible).toBe(true);
    expect(ok.selected.map((c) => c.id)).toEqual(['x']);
  });

  it('规划不改写基线、单次试接、批量筛选与有序计划复核结果', () => {
    const az = new Analyzer(chainTopo(6));
    const baselineBefore = JSON.stringify(az.baseline);
    const trialBefore = JSON.stringify(az.trial('v0', 'v5'));
    const batchBefore = JSON.stringify(az.screenBatch([{ a: 'v0', b: 'v5' }]));
    const planBefore = JSON.stringify(az.reviewOrderedPlan([{ a: 'v0', b: 'v5' }]));
    az.planQuotes([
      { id: 'X', a: 'v0', b: 'v3', price: 3 },
      { id: 'Y', a: 'v3', b: 'v5', price: 2 },
    ]);
    expect(JSON.stringify(az.baseline)).toBe(baselineBefore);
    expect(JSON.stringify(az.trial('v0', 'v5'))).toBe(trialBefore);
    expect(JSON.stringify(az.screenBatch([{ a: 'v0', b: 'v5' }]))).toBe(batchBefore);
    expect(JSON.stringify(az.reviewOrderedPlan([{ a: 'v0', b: 'v5' }]))).toBe(planBefore);
  });

  it('16 条候选上界：长链每桥一条候选，全部入选且合计精确', () => {
    const az = new Analyzer(chainTopo(17)); // 16 座桥
    const candidates: QuoteCandidate[] = [];
    for (let i = 0; i < MAX_QUOTE_CANDIDATES; i++) {
      candidates.push({ id: `C${String(i).padStart(2, '0')}`, a: `v${i}`, b: `v${i + 1}`, price: (i * 7) % 5 });
    }
    const r = az.planQuotes(candidates);
    expect(r.feasible).toBe(true);
    expect(r.selected).toHaveLength(16);
    expect(r.totalPrice).toBe(candidates.reduce((s, c) => s + c.price, 0));
    expect(r.coverage).toHaveLength(16);
    for (const item of r.coverage) expect(item.coveredBy).toHaveLength(1);
  });
});

describe('最低总价备纤组合 vs 独立子集穷举（随机连通多重小图）', () => {
  /** 与其他测试文件不同种子序列的小型 RNG 包装（mulberry32 同款实现） */
  const makeRng = (seed: number): Rng => new Rng((seed * 0x9e3779b9) ^ 0x27d4eb2f);

  it('最优性、三层裁决、逐桥消除来源与无法覆盖诊断：逐种子核对', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = makeRng(seed);
      const n = 2 + rng.int(8); // 2–9 站点
      const g = randomConnectedGraph(rng, n, rng.int(n * 3));
      const az = new Analyzer(g);

      const candidates: QuoteCandidate[] = [];
      const usedIds = new Set<string>();
      const newId = (k: number) => {
        let id: string;
        do {
          id = `C${rng.int(1000).toString(36)}-${k}`;
        } while (usedIds.has(id));
        usedIds.add(id);
        return id;
      };
      const q = 1 + rng.int(8); // 1–8 条候选
      for (let k = 0; k < q; k++) {
        const a = g.sites[rng.int(n)];
        let b = g.sites[rng.int(n)];
        while (b === a) b = g.sites[rng.int(n)];
        // 约 1/4 零价，制造“零价无用/有用”与并列裁决局面
        const price = rng.int(4) === 0 ? 0 : rng.int(13);
        candidates.push({ id: newId(k), a, b, price });
        if (rng.int(4) === 0 && candidates.length < 12) {
          // 注入同端点平行候选（不同编号、不同报价）
          candidates.push({ id: newId(k), a, b, price: rng.int(13) });
        }
      }

      const result = az.planQuotes(candidates);
      expectMatchesOracle(result, oracleSolve(g, az.baseline, candidates), candidates.length);
    }
  });

  it('12–16 条候选的全枚举规模下仍与独立穷举一致', () => {
    for (let seed = 101; seed <= 106; seed++) {
      const rng = makeRng(seed);
      const n = 2 + rng.int(6); // 2–7 站点
      const g = randomConnectedGraph(rng, n, rng.int(n * 2));
      const az = new Analyzer(g);

      const q = 12 + rng.int(5); // 12–16 条候选
      const candidates: QuoteCandidate[] = [];
      for (let k = 0; k < q; k++) {
        const a = g.sites[rng.int(n)];
        let b = g.sites[rng.int(n)];
        while (b === a) b = g.sites[rng.int(n)];
        candidates.push({ id: `K${k}`, a, b, price: rng.int(7) });
      }

      const result = az.planQuotes(candidates);
      expectMatchesOracle(result, oracleSolve(g, az.baseline, candidates), candidates.length);
    }
  });
});
