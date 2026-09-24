import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { oracleTrial } from './oracle';
import { MAX_PLAN_STEPS, parseOrderedPlan } from './parse';
import { Rng } from './rng';
import type { NormalizedTopology, OrderedPlanStep } from './types';

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

describe('parseOrderedPlan 输入契约', () => {
  it('接受单步骤与数字编号（按单次试接规则规范化）', () => {
    expect(parseOrderedPlan('[{"a": 1, "b": 2}]')).toEqual([{ a: '1', b: '2' }]);
    expect(parseOrderedPlan('[{"a": "  s1 ", "b":"s2"}]')).toEqual([{ a: 's1', b: 's2' }]);
  });

  it('重复/反向步骤按原序保留', () => {
    const steps = parseOrderedPlan('[{"a":"x","b":"y"},{"a":"x","b":"y"},{"a":"y","b":"x"}]');
    expect(steps).toEqual([
      { a: 'x', b: 'y' },
      { a: 'x', b: 'y' },
      { a: 'y', b: 'x' },
    ]);
  });

  it('拒绝非数组与空数组', () => {
    expect(() => parseOrderedPlan('{"a":"x","b":"y"}')).toThrow(/必须是一个 JSON 数组/);
    expect(() => parseOrderedPlan('[]')).toThrow(/空数组/);
    expect(() => parseOrderedPlan('{坏的')).toThrow(/JSON 语法错误/);
  });

  it('拒绝超过上限（整体拒绝）', () => {
    const big = JSON.stringify(Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ a: 'x', b: 'y' })));
    expect(() => parseOrderedPlan(big)).toThrow(/超过上限/);
  });

  it('拒绝非对象项、缺字段与额外字段，并指出零起下标', () => {
    expect(() => parseOrderedPlan('[{"a":"x","b":"y"},["a","b"]]')).toThrow(/下标 1/);
    expect(() => parseOrderedPlan('[{"a":"x","b":"y"},{"a":"z"}]')).toThrow(/下标 1.*缺少字段 "b"/);
    expect(() => parseOrderedPlan('[{"b":"y"},{"a":"x","b":"y"}]')).toThrow(/下标 0.*缺少字段 "a"/);
    expect(() => parseOrderedPlan('[{"a":"x","b":"y","c":1}]')).toThrow(/下标 0.*额外字段/);
    expect(() => parseOrderedPlan('[{"a":"x","b":"y"},{"a":"p","b":"q","note":"备用"}]')).toThrow(
      /下标 1.*额外字段/,
    );
  });

  it('拒绝非法端点类型并按下标报错', () => {
    expect(() => parseOrderedPlan('[{"a":"","b":"y"}]')).toThrow(/下标 0.*为空/);
    expect(() => parseOrderedPlan('[{"a":true,"b":"y"}]')).toThrow(/下标 0/);
    expect(() => parseOrderedPlan('[{"a":"x","b":null}]')).toThrow(/下标 0/);
    expect(() => parseOrderedPlan('[{"a":"x","b":1.5}]')).toThrow(/下标 0/);
  });
});

describe('Analyzer.reviewOrderedPlan 顺序归属', () => {
  const chain = (n: number): NormalizedTopology => ({
    sites: Array.from({ length: n }, (_, i) => `v${i}`),
    links: Array.from(
      { length: n - 1 },
      (_, i) => ({ id: `L${String(i).padStart(3, '0')}`, u: `v${i}`, v: `v${i + 1}` }),
    ),
  });

  it('同一桥只归最早覆盖步骤；重复、反向、交叠、包含路径后续可为零', () => {
    const az = new Analyzer(chain(6)); // L000..L004 全是桥
    const r = az.reviewOrderedPlan([
      { a: 'v0', b: 'v3' }, // 首次：L000,L001,L002
      { a: 'v3', b: 'v0' }, // 反向重复：0
      { a: 'v0', b: 'v3' }, // 重复：0
      { a: 'v2', b: 'v5' }, // 与首步交叠并延伸：仅新增 L003,L004
      { a: 'v1', b: 'v4' }, // 完全包含于已覆盖区间：0
    ]);
    expect(r.items.map((it) => it.marginal)).toEqual([3, 0, 0, 2, 0]);
    expect(r.items.map((it) => it.cumulative)).toEqual([3, 3, 3, 5, 5]);
    expect(r.items.map((it) => it.remaining)).toEqual([2, 2, 2, 0, 0]);
    expect(r.coveredCount).toBe(5);
    expect(r.baselineCount).toBe(5);
    expect(r.items[0].firstRemoved.map((b) => b.id)).toEqual(['L000', 'L001', 'L002']);
    expect(r.items[3].firstRemoved.map((b) => b.id)).toEqual(['L003', 'L004']);
    expect(r.items[1].firstRemoved).toEqual([]);
  });

  it('各步清单按链路编号 UTF-8 字节序（L10 < L2）', () => {
    const t: NormalizedTopology = {
      sites: ['a', 'b', 'c', 'd'],
      links: [
        { id: 'L10', u: 'a', v: 'b' },
        { id: 'L2', u: 'b', v: 'c' },
        { id: 'L1', u: 'c', v: 'd' },
      ],
    };
    const r = new Analyzer(t).reviewOrderedPlan([{ a: 'a', b: 'd' }]);
    expect(r.items[0].firstRemoved.map((b) => b.id)).toEqual(['L1', 'L10', 'L2']);
  });

  it('各步清单互斥且并集等于计划覆盖的基线桥', () => {
    const az = new Analyzer(chain(10));
    const r = az.reviewOrderedPlan([
      { a: 'v0', b: 'v2' },
      { a: 'v8', b: 'v5' },
      { a: 'v1', b: 'v9' },
      { a: 'v3', b: 'v4' },
    ]);
    const seen = new Set<string>();
    let unionSize = 0;
    for (const it of r.items) {
      for (const b of it.firstRemoved) {
        expect(seen.has(b.id)).toBe(false); // 互斥
        seen.add(b.id);
        unionSize++;
      }
    }
    // 计划覆盖 v0..v9 全部 9 座桥（各步延伸后并集）
    expect(unionSize).toBe(9);
    expect(r.coveredCount).toBe(9);
    // 与单次试接逐桥求并集的预言一致：覆盖集合 = 各步 trial().removed 的并集
    const expected = new Set<string>();
    for (const s of [{ a: 'v0', b: 'v2' }, { a: 'v8', b: 'v5' }, { a: 'v1', b: 'v9' }, { a: 'v3', b: 'v4' }]) {
      for (const b of az.trial(s.a, s.b).removed) expected.add(b.id);
    }
    expect(seen).toEqual(expected);
  });

  it('桥树分叉：两支路径在 LCA 处正确停止，不收集计划外的桥', () => {
    const t: NormalizedTopology = {
      sites: ['r', 'a', 'b', 'c', 'd'],
      links: [
        { id: 'e1', u: 'r', v: 'a' },
        { id: 'e2', u: 'a', v: 'b' },
        { id: 'e3', u: 'r', v: 'c' },
        { id: 'e4', u: 'c', v: 'd' },
      ],
    };
    const r = new Analyzer(t).reviewOrderedPlan([
      { a: 'a', b: 'c' }, // e1,e3（LCA=r，不含 r 的父边）
      { a: 'b', b: 'd' }, // e2,e4
    ]);
    expect(r.items[0].firstRemoved.map((x) => x.id)).toEqual(['e1', 'e3']);
    expect(r.items[1].firstRemoved.map((x) => x.id)).toEqual(['e2', 'e4']);
    expect(r.items.map((it) => it.remaining)).toEqual([2, 0]);
  });

  it('空计划与超限整体拒绝', () => {
    const az = new Analyzer(chain(5));
    expect(() => az.reviewOrderedPlan([])).toThrow(/不能为空/);
    const big: OrderedPlanStep[] = Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ a: 'v0', b: 'v1' }));
    expect(() => az.reviewOrderedPlan(big)).toThrow(/超过上限/);
  });

  it('末项非法时抛出下标错误且无部分结果、分析器不被污染', () => {
    const az = new Analyzer(chain(6));
    const baselineBefore = JSON.stringify(az.baseline);
    const bad: OrderedPlanStep[] = [
      { a: 'v0', b: 'v5' },
      { a: 'v1', b: 'v4' },
      { a: 'v2', b: 'ghost' },
    ];
    expect(() => az.reviewOrderedPlan(bad)).toThrow(/下标 2.*不在当前站点清单/);
    expect(() => az.reviewOrderedPlan([{ a: 'v1', b: 'v1' }])).toThrow(/下标 0.*必须不同/);
    expect(JSON.stringify(az.baseline)).toBe(baselineBefore);
    // 随后合法计划仍正常
    const ok = az.reviewOrderedPlan([{ a: 'v0', b: 'v5' }]);
    expect(ok.items[0].marginal).toBe(5);
    expect(ok.coveredCount).toBe(5);
  });

  it('无桥拓扑（三角形）上每步边际均为 0', () => {
    const t: NormalizedTopology = {
      sites: ['x', 'y', 'z'],
      links: [
        { id: 't1', u: 'x', v: 'y' },
        { id: 't2', u: 'y', v: 'z' },
        { id: 't3', u: 'z', v: 'x' },
      ],
    };
    const r = new Analyzer(t).reviewOrderedPlan([
      { a: 'x', b: 'z' },
      { a: 'y', b: 'z' },
    ]);
    expect(r.items.map((it) => [it.marginal, it.cumulative, it.remaining])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(r.coveredCount).toBe(0);
  });

  it('有序计划不改写基线、单次试接与批量筛选结果', () => {
    const az = new Analyzer(chain(8));
    const baselineBefore = JSON.stringify(az.baseline);
    const trialBefore = az.trial('v0', 'v7');
    const batchInput = [
      { a: 'v0', b: 'v7' },
      { a: 'v2', b: 'v5' },
    ];
    const batchBefore = JSON.stringify(az.screenBatch(batchInput));
    az.reviewOrderedPlan([
      { a: 'v0', b: 'v3' },
      { a: 'v2', b: 'v7' },
    ]);
    expect(JSON.stringify(az.baseline)).toBe(baselineBefore);
    const trialAfter = az.trial('v0', 'v7');
    expect(trialAfter.removed.map((x) => x.id)).toEqual(trialBefore.removed.map((x) => x.id));
    // 同输入结果稳定，分析器内部状态未被污染
    expect(JSON.stringify(az.screenBatch(batchInput))).toBe(batchBefore);
  });
});

describe('有序备纤计划 vs 单次试接顺序合并（随机连通多重小图预言机）', () => {
  /** 与 batch.test 不同种子序列的小型 RNG 包装（mulberry32 同款实现） */
  const makeRng = (seed: number): Rng => new Rng((seed * 0x9e3779b9) ^ 0x51ed270b);

  it('每步首次消除清单 = 本步 trial().removed 剔除此前各步已消除桥；并集与删边预言机一致', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = makeRng(seed);
      const n = 2 + rng.int(9); // 2–10 站点
      const g = randomConnectedGraph(rng, n, rng.int(n * 3));
      const az = new Analyzer(g);

      const steps: OrderedPlanStep[] = [];
      const q = 1 + rng.int(10);
      for (let k = 0; k < q; k++) {
        const a = g.sites[rng.int(n)];
        let b = g.sites[rng.int(n)];
        while (b === a) b = g.sites[rng.int(n)];
        steps.push({ a, b });
        if (rng.int(3) === 0) steps.push({ a, b }); // 注入重复步骤
        if (rng.int(4) === 0) steps.push({ a: b, b: a }); // 注入反向步骤
      }

      const r = az.reviewOrderedPlan(steps);
      expect(r.items).toHaveLength(steps.length);

      // 预言机：按顺序合并单次试接结果
      const coveredBefore = new Set<string>();
      const coveredUnion = new Set<string>();
      for (let i = 0; i < steps.length; i++) {
        const { a, b } = steps[i];
        const trial = az.trial(a, b);
        const expectedFirst = trial.removed
          .filter((br) => !coveredBefore.has(br.id))
          .map((br) => br.id)
          .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        expect(r.items[i].firstRemoved.map((br) => br.id)).toEqual(expectedFirst);
        expect(r.items[i].marginal).toBe(expectedFirst.length);
        expect(r.items[i].cumulative).toBe(coveredUnion.size + expectedFirst.length);
        expect(r.items[i].remaining).toBe(az.baseline.bridges.length - coveredUnion.size - expectedFirst.length);

        for (const id of expectedFirst) {
          coveredBefore.add(id);
          coveredUnion.add(id);
        }

        // 删边预言机：本步覆盖的桥集合与 trial 一致
        const oracle = oracleTrial(g, az.baseline, a, b);
        expect(new Set(trial.removed.map((br) => br.id))).toEqual(oracle.removed);
      }
      expect(r.coveredCount).toBe(coveredUnion.size);

      // 互斥性终检 + 并集等于计划覆盖的基线桥
      const all: string[] = [];
      for (const it of r.items) all.push(...it.firstRemoved.map((br) => br.id));
      expect(new Set(all).size).toBe(all.length);
      const trialUnion = new Set<string>();
      for (const s of steps) for (const br of az.trial(s.a, s.b).removed) trialUnion.add(br.id);
      expect(new Set(all)).toEqual(trialUnion);
    }
  });

  it('末项非法：随机图整批拒绝，无部分结果', () => {
    const rng = makeRng(0x7e57);
    const g = randomConnectedGraph(rng, 9, 8);
    const az = new Analyzer(g);
    const before = JSON.stringify(az.baseline);
    const steps: OrderedPlanStep[] = [];
    for (let k = 0; k < 6; k++) {
      steps.push({ a: g.sites[k % g.sites.length], b: g.sites[(k + 4) % g.sites.length] });
    }
    steps.push({ a: g.sites[0], b: 'ghost-site' });
    expect(() => az.reviewOrderedPlan(steps)).toThrow(/下标 6/);
    expect(JSON.stringify(az.baseline)).toBe(before);
    const ok = az.reviewOrderedPlan(steps.slice(0, 6));
    expect(ok.items).toHaveLength(6);
  });

  it('较深随机图上大计划与顺序合并的单次试接逐项一致（锤炼多级提升与压缩）', () => {
    // 300 站点随机连通多重图 + 800 步（含重复/反向注入）
    const rng = new Rng(0xbada55);
    const g = randomConnectedGraph(rng, 300, 450);
    const az = new Analyzer(g);
    const steps: OrderedPlanStep[] = [];
    for (let k = 0; k < 800; k++) {
      const a = g.sites[rng.int(g.sites.length)];
      let b = g.sites[rng.int(g.sites.length)];
      while (b === a) b = g.sites[rng.int(g.sites.length)];
      steps.push({ a, b });
      if (k % 37 === 0) steps.push({ a, b });
      if (k % 53 === 0) steps.push({ a: b, b: a });
    }
    const r = az.reviewOrderedPlan(steps);

    const covered = new Set<string>();
    const all: string[] = [];
    let cum = 0;
    for (let i = 0; i < steps.length; i++) {
      const removed = az.trial(steps[i].a, steps[i].b).removed.map((br) => br.id);
      const expected = removed.filter((id) => !covered.has(id));
      // 清单按 UTF-8 字节序
      const expectedSorted = [...expected].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      expect(r.items[i].firstRemoved.map((br) => br.id)).toEqual(expectedSorted);
      expected.forEach((id) => covered.add(id));
      all.push(...expectedSorted);
      cum += expectedSorted.length;
      expect(r.items[i].cumulative).toBe(cum);
      expect(r.items[i].remaining).toBe(az.baseline.bridges.length - cum);
    }
    expect(r.coveredCount).toBe(cum);
    expect(new Set(all).size).toBe(all.length); // 互斥
    expect(all).toHaveLength(cum);
  });
});
