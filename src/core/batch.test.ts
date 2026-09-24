import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { oracleTrial } from './oracle';
import { MAX_BATCH_PAIRS, parseBatchPlans } from './parse';
import { Rng } from './rng';
import type { BatchPair, NormalizedTopology } from './types';

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

describe('parseBatchPlans 输入契约', () => {
  it('接受单端点对与数字编号（按单次试接规则规范化）', () => {
    expect(parseBatchPlans('[{"a": 1, "b": 2}]')).toEqual([{ a: '1', b: '2' }]);
    // 字符串去首尾空白
    expect(parseBatchPlans('[{"a": "  s1 ", "b": "s2"}]')).toEqual([{ a: 's1', b: 's2' }]);
  });

  it('重复候选按原序保留', () => {
    const pairs = parseBatchPlans('[{"a":"x","b":"y"},{"a":"x","b":"y"},{"a":"y","b":"x"}]');
    expect(pairs).toEqual([
      { a: 'x', b: 'y' },
      { a: 'x', b: 'y' },
      { a: 'y', b: 'x' },
    ]);
  });

  it('拒绝非数组与空批次', () => {
    expect(() => parseBatchPlans('{"a":"x","b":"y"}')).toThrow(/必须是一个 JSON 数组/);
    expect(() => parseBatchPlans('[]')).toThrow(/空数组/);
    expect(() => parseBatchPlans('{坏的')).toThrow(/JSON 语法错误/);
  });

  it('拒绝超过上限（整体拒绝）', () => {
    const big = JSON.stringify(Array.from({ length: MAX_BATCH_PAIRS + 1 }, () => ({ a: 'x', b: 'y' })));
    expect(() => parseBatchPlans(big)).toThrow(/超过上限/);
  });

  it('拒绝非对象项、缺字段与额外字段，并按下标报错', () => {
    expect(() => parseBatchPlans('[{"a":"x","b":"y"},["a","b"]]')).toThrow(/下标 1/);
    expect(() => parseBatchPlans('[{"a":"x","b":"y"},{"a":"z"}]')).toThrow(/下标 1.*缺少字段 "b"/);
    expect(() => parseBatchPlans('[{"b":"y"},{"a":"x","b":"y"}]')).toThrow(/下标 0.*缺少字段 "a"/);
    expect(() => parseBatchPlans('[{"a":"x","b":"y","c":1}]')).toThrow(/下标 0.*额外字段/);
    expect(() => parseBatchPlans('[{"a":"x","b":"y"},{"a":"p","b":"q","note":"备用"}]')).toThrow(/下标 1.*额外字段/);
  });

  it('拒绝非法端点类型并按下标报错', () => {
    expect(() => parseBatchPlans('[{"a":"","b":"y"}]')).toThrow(/下标 0.*为空/);
    expect(() => parseBatchPlans('[{"a":"   ","b":"y"}]')).toThrow(/下标 0.*为空/);
    expect(() => parseBatchPlans('[{"a":true,"b":"y"}]')).toThrow(/下标 0/);
    expect(() => parseBatchPlans('[{"a":"x","b":null}]')).toThrow(/下标 0/);
    expect(() => parseBatchPlans('[{"a":"x","b":1.5}]')).toThrow(/下标 0/);
    expect(() => parseBatchPlans('[{"a":"x","b":"y"},{"a":["z"],"b":"w"}]')).toThrow(/下标 1/);
  });
});

describe('Analyzer.screenBatch 校验与计数', () => {
  const chain = (n: number): NormalizedTopology => ({
    sites: Array.from({ length: n }, (_, i) => `v${i}`),
    links: Array.from({ length: n - 1 }, (_, i) => ({ id: `c${i}`, u: `v${i}`, v: `v${i + 1}` })),
  });

  it('长链上每项计数等于站点距离（全部边均为桥）', () => {
    const n = 500;
    const analyzer = new Analyzer(chain(n));
    const pairs: BatchPair[] = [
      { a: 'v0', b: 'v499' },
      { a: 'v10', b: 'v90' },
      { a: 'v499', b: 'v0' },
      { a: 'v7', b: 'v8' },
    ];
    const result = analyzer.screenBatch(pairs);
    expect(result.items.map((it) => it.removedCount)).toEqual([499, 80, 499, 1]);
    expect(result.items.map((it) => it.index)).toEqual([0, 1, 2, 3]);
    expect(result.baselineCount).toBe(n - 1);
  });

  it('重复候选按原序保留，结果与输入下标一一对应', () => {
    const analyzer = new Analyzer(chain(10));
    const result = analyzer.screenBatch([
      { a: 'v0', b: 'v9' },
      { a: 'v0', b: 'v9' },
      { a: 'v9', b: 'v0' },
    ]);
    expect(result.items.map((it) => [it.a, it.b, it.removedCount])).toEqual([
      ['v0', 'v9', 9],
      ['v0', 'v9', 9],
      ['v9', 'v0', 9],
    ]);
  });

  it('空批次与超限整体拒绝', () => {
    const analyzer = new Analyzer(chain(5));
    expect(() => analyzer.screenBatch([])).toThrow(/不能为空/);
    const big: BatchPair[] = Array.from({ length: MAX_BATCH_PAIRS + 1 }, () => ({ a: 'v0', b: 'v1' }));
    expect(() => analyzer.screenBatch(big)).toThrow(/超过上限/);
  });

  it('末项非法时抛出下标错误且无部分结果', () => {
    const analyzer = new Analyzer(chain(6));
    const pairs: BatchPair[] = [
      { a: 'v0', b: 'v5' },
      { a: 'v1', b: 'v4' },
      { a: 'v2', b: 'ghost' },
    ];
    expect(() => analyzer.screenBatch(pairs)).toThrow(/下标 2.*不在当前站点清单/);
    // 相同端点同样按下标报错
    expect(() => analyzer.screenBatch([{ a: 'v1', b: 'v1' }])).toThrow(/下标 0.*必须不同/);
    // 分析器未被污染：随后合法批次仍正常
    const ok = analyzer.screenBatch([{ a: 'v0', b: 'v5' }]);
    expect(ok.items[0].removedCount).toBe(5);
  });

  it('批量筛选不改写基线与单次试接结果', () => {
    const analyzer = new Analyzer(chain(8));
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const trialBefore = analyzer.trial('v0', 'v7');
    analyzer.screenBatch([
      { a: 'v0', b: 'v7' },
      { a: 'v2', b: 'v5' },
    ]);
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    const trialAfter = analyzer.trial('v0', 'v7');
    expect(trialAfter.removed.map((x) => x.id)).toEqual(trialBefore.removed.map((x) => x.id));
    expect(trialAfter.stillFragile.length).toBe(trialBefore.stillFragile.length);
  });
});

describe('批量计数 vs 删边预言机（随机连通多重小图）', () => {
  it('每项计数与 trial(a,b).removed.length 及预言机一致', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(0x51ed270b ^ (seed * 2246822519));
      const n = 2 + rng.int(9); // 2–10 个站点
      const g = randomConnectedGraph(rng, n, rng.int(n * 3));
      const analyzer = new Analyzer(g);

      // 随机一批端点对（含重复候选），一次提交
      const pairs: BatchPair[] = [];
      const q = 1 + rng.int(12);
      for (let k = 0; k < q; k++) {
        const a = g.sites[rng.int(n)];
        let b = g.sites[rng.int(n)];
        while (b === a) b = g.sites[rng.int(n)];
        pairs.push({ a, b });
        if (rng.int(3) === 0) pairs.push({ a, b }); // 注入重复候选
      }

      const result = analyzer.screenBatch(pairs);
      expect(result.items).toHaveLength(pairs.length);
      expect(result.baselineCount).toBe(analyzer.baseline.bridges.length);

      for (let i = 0; i < pairs.length; i++) {
        const { a, b } = pairs[i];
        // 与单次试接明细一致
        const trial = analyzer.trial(a, b);
        expect(result.items[i].removedCount).toBe(trial.removed.length);
        // 与删边预言机一致
        const oracle = oracleTrial(g, analyzer.baseline, a, b);
        expect(result.items[i].removedCount).toBe(oracle.removed.size);
        // 下标与端点对保持输入原序
        expect(result.items[i].index).toBe(i);
        expect(result.items[i].a).toBe(a);
        expect(result.items[i].b).toBe(b);
      }
    }
  });

  it('末项非法时整批拒绝：无部分结果且基线不变', () => {
    const rng = new Rng(0x9e3779b9);
    const g = randomConnectedGraph(rng, 8, 6);
    const analyzer = new Analyzer(g);
    const baselineBefore = JSON.stringify(analyzer.baseline);

    const pairs: BatchPair[] = [];
    for (let k = 0; k < 5; k++) {
      pairs.push({ a: g.sites[k % g.sites.length], b: g.sites[(k + 3) % g.sites.length] });
    }
    pairs.push({ a: g.sites[0], b: '不存在的站点' }); // 末项非法

    expect(() => analyzer.screenBatch(pairs)).toThrow(/下标 5/);
    // 无任何部分结果返回（异常即整批拒绝），基线保持不动
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    // 合法批次随后仍可整体提交
    const ok = analyzer.screenBatch(pairs.slice(0, 5));
    expect(ok.items).toHaveLength(5);
  });

  it('较深随机图上批量计数与 trial 逐项一致（锤炼二进制提升）', () => {
    // 300 站点随机连通多重图 + 600 组查询，覆盖更深的 DFS 树与多级提升
    const rng = new Rng(0xc0ffee);
    const g = randomConnectedGraph(rng, 300, 450);
    const analyzer = new Analyzer(g);
    const pairs: BatchPair[] = [];
    for (let k = 0; k < 600; k++) {
      const a = g.sites[rng.int(g.sites.length)];
      let b = g.sites[rng.int(g.sites.length)];
      while (b === a) b = g.sites[rng.int(g.sites.length)];
      pairs.push({ a, b });
    }
    const result = analyzer.screenBatch(pairs);
    for (let i = 0; i < pairs.length; i++) {
      expect(result.items[i].removedCount).toBe(analyzer.trial(pairs[i].a, pairs[i].b).removed.length);
    }
  });
});
