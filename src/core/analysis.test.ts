import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { parseTopology } from './parse';
import { oracleBaseline, oracleTrial } from './oracle';
import { Rng } from './rng';
import type { NormalizedTopology } from './types';

/**
 * 生成随机连通无向多重图：先生成一棵随机生成树保证连通，
 * 再追加随机边（允许平行边、允许重复同一对）。编号使用
 * 与插入顺序无关的字符串，强制考验 UTF-8 排序稳定性。
 */
function randomConnectedGraph(rng: Rng, n: number, extraEdges: number): NormalizedTopology {
  const sites: string[] = [];
  for (let i = 0; i < n; i++) sites[i] = `S-${(1000 + i).toString(16)}`;
  // 打乱站点顺序，使邻接下标与编号序无关
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

  // 随机生成树：顶点 1..n-1 连向某个更早的顶点
  const order = sites.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 1; i < n; i++) {
    const u = order[i];
    const v = order[rng.int(i)];
    raw.push({ id: newId(), u, v });
  }
  // 追加随机边（可能产生平行链路、可能落在同一 2-边连通分量内）
  for (let k = 0; k < extraEdges; k++) {
    const u = sites[rng.int(n)];
    let v = sites[rng.int(n)];
    while (v === u) v = sites[rng.int(n)];
    raw.push({ id: newId(), u, v });
  }
  return { sites, links: raw };
}

describe('Analyzer 基线 vs 删边预言机（随机小图）', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i))('随机图 seed=%s', (seed) => {
    const rng = new Rng(0x9e3779b9 ^ (seed * 2654435761));
    const n = 2 + rng.int(9); // 2–10 个站点
    const extra = rng.int(n * 3);
    const g = randomConnectedGraph(rng, n, extra);
    const analyzer = new Analyzer(g);
    const expected = oracleBaseline(g);

    expect(analyzer.baseline.siteCount).toBe(n);
    expect(analyzer.baseline.bridges).toEqual(expected.bridges);
    // 顺序必须严格为 UTF-8 字节序且稳定
    const ids = analyzer.baseline.bridges.map((b) => b.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('试接结论与预言机一致（随机端点，含消险/部分消险）', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(seed * 7919 + 13);
      const g = randomConnectedGraph(rng, 2 + rng.int(9), rng.int(12));
      const analyzer = new Analyzer(g);
      // 每个图随机选 3 对不同端点
      for (let k = 0; k < 3; k++) {
        const a = g.sites[rng.int(g.sites.length)];
        let b = g.sites[rng.int(g.sites.length)];
        while (b === a) b = g.sites[rng.int(g.sites.length)];
        const got = analyzer.trial(a, b);
        const want = oracleTrial(g, analyzer.baseline, a, b);
        expect(new Set(got.stillFragile.map((x) => x.id))).toEqual(want.stillFragile);
        expect(new Set(got.removed.map((x) => x.id))).toEqual(want.removed);
        expect(got.stillFragile.length + got.removed.length).toBe(analyzer.baseline.bridges.length);
      }
    }
  });

  it('试接不改写基线', () => {
    const g = randomConnectedGraph(new Rng(42), 6, 3);
    const analyzer = new Analyzer(g);
    const before = JSON.stringify(analyzer.baseline);
    analyzer.trial(g.sites[0], g.sites[1]);
    analyzer.trial(g.sites[2], g.sites[3]);
    expect(JSON.stringify(analyzer.baseline)).toBe(before);
  });
});

describe('典型拓扑：长链 / 大环 / 平行链路 / 蝴蝶结', () => {
  it('长链：每条边都是桥，较小侧为到近端的站点数', () => {
    const n = 50;
    const sites = Array.from({ length: n }, (_, i) => `v${i}`);
    const links = sites.slice(1).map((v, i) => ({ id: `c${i}`, u: sites[i], v }));
    const a = new Analyzer({ sites, links });
    expect(a.baseline.bridges).toHaveLength(n - 1);
    // 中间一桥断开为 25/25；两端桥断开为 1/49
    const byId = new Map(a.baseline.bridges.map((b) => [b.id, b.smallerSide]));
    expect(byId.get('c0')).toBe(1);
    expect(byId.get('c48')).toBe(1);
    expect(byId.get('c24')).toBe(25);
  });

  it('大环：无桥', () => {
    const n = 1000;
    const sites = Array.from({ length: n }, (_, i) => `v${i}`);
    const links = sites.map((v, i) => ({ id: `r${i}`, u: v, v: sites[(i + 1) % n] }));
    const a = new Analyzer({ sites, links });
    expect(a.baseline.bridges).toHaveLength(0);
  });

  it('平行链路：两条平行边均非桥，悬挂边为桥', () => {
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: 'p1', u: 'a', v: 'b' },
          { id: 'p2', u: 'a', v: 'b' },
          { id: 'tail', u: 'b', v: 'c' },
        ],
      }),
    );
    const a = new Analyzer(t);
    expect(a.baseline.bridges.map((x) => x.id)).toEqual(['tail']);
    expect(a.baseline.bridges[0].smallerSide).toBe(1);
  });

  it('蝴蝶结（两个三角形共享一个站点）：无桥', () => {
    const t = parseTopology(
      JSON.stringify({
        sites: ['c', 'a', 'b', 'd', 'e'],
        links: [
          { id: '1', u: 'c', v: 'a' },
          { id: '2', u: 'a', v: 'b' },
          { id: '3', u: 'b', v: 'c' },
          { id: '4', u: 'c', v: 'd' },
          { id: '5', u: 'd', v: 'e' },
          { id: '6', u: 'e', v: 'c' },
        ],
      }),
    );
    expect(new Analyzer(t).baseline.bridges).toHaveLength(0);
  });

  it('环+悬挂链：仅跨环与链之间的边及其余链边为桥', () => {
    // 环 a-b-c-a，链 c-d-e
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd', 'e'],
        links: [
          { id: 'ab', u: 'a', v: 'b' },
          { id: 'bc', u: 'b', v: 'c' },
          { id: 'ca', u: 'c', v: 'a' },
          { id: 'cd', u: 'c', v: 'd' },
          { id: 'de', u: 'd', v: 'e' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    expect(analyzer.baseline.bridges.map((x) => x.id).sort()).toEqual(['cd', 'de']);
    // 试接 a-e：覆盖 de、cd 两桥，全部消除
    const trial = analyzer.trial('a', 'e');
    expect(trial.removed.map((x) => x.id)).toEqual(['cd', 'de']);
    expect(trial.stillFragile).toHaveLength(0);
    // 试接 d-e（平行于 de）只消除 de
    const t2 = analyzer.trial('d', 'e');
    expect(t2.removed.map((x) => x.id)).toEqual(['de']);
    expect(t2.stillFragile.map((x) => x.id)).toEqual(['cd']);
  });
});

describe('非法试接', () => {
  const t = parseTopology(
    JSON.stringify({
      sites: ['a', 'b', 'c'],
      links: [
        { id: 'l1', u: 'a', v: 'b' },
        { id: 'l2', u: 'b', v: 'c' },
      ],
    }),
  );

  it('拒绝相同端点', () => {
    const a = new Analyzer(t);
    expect(() => a.trial('a', 'a')).toThrow(/必须不同/);
  });

  it('拒绝不存在端点与空值', () => {
    const a = new Analyzer(t);
    expect(() => a.trial('a', 'ghost')).toThrow(/不在当前站点清单/);
    expect(() => a.trial('  ', 'b')).toThrow(/为空/);
    expect(() => a.trial(null, 'b')).toThrow(/站点编号/);
  });
});
