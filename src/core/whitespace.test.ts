import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { oracleTrial } from './oracle';
import { parseBatchPlans, parseOrderedPlan, parseQuotePlans, parseTopology } from './parse';
import type { NormalizedTopology } from './types';

/**
 * 空白编号身份验收：同一连通图中放入多组仅空白不同的站点编号
 * （"A" / " A " / "A " / " A"、全空白编号 "  "、数字编号 7 与字符串 " 7"），
 * 通过单次试接、批量筛选、有序计划、最低报价四类入口逐一精确引用，
 * 核对桥集合、步骤归属、报价裁决、失败隔离与原结果保留。
 *
 * 拓扑为 9 站点长链（每条链路都是桥，期望可精确手算）：
 *
 *   "A" —L1— " A " —L2— "A " —L3— " A" —L4— "  " —L5— "7" —L6— " 7" —L7— "S1" —L8— "S1 "
 *
 * Lk 断开后较小侧站点数 = min(k, 9−k)。
 */
const TOPOLOGY_JSON = JSON.stringify({
  sites: ['A', ' A ', 'A ', ' A', '  ', 7, ' 7', 'S1', 'S1 '],
  links: [
    { id: 'L1', u: 'A', v: ' A ' },
    { id: 'L2', u: ' A ', v: 'A ' },
    { id: 'L3', u: 'A ', v: ' A' },
    { id: 'L4', u: ' A', v: '  ' },
    { id: 'L5', u: '  ', v: 7 },
    { id: 'L6', u: 7, v: ' 7' },
    { id: 'L7', u: ' 7', v: 'S1' },
    { id: 'L8', u: 'S1', v: 'S1 ' },
  ],
});

const newAnalyzer = (): { topology: NormalizedTopology; analyzer: Analyzer } => {
  const topology = parseTopology(TOPOLOGY_JSON);
  return { topology, analyzer: new Analyzer(topology) };
};

/** 报价验收共用候选：X1–X4 分片覆盖全部 8 座桥（各 5 元），X0 全覆盖但 100 元，Y1 与 X1 同覆盖但更贵 */
const CANDIDATES_JSON = JSON.stringify([
  { id: 'X1', a: 'A', b: ' A ', price: 5 }, // L1
  { id: 'X2', a: ' A ', b: '  ', price: 5 }, // L2,L3,L4
  { id: 'X3', a: '  ', b: ' 7', price: 5 }, // L5,L6
  { id: 'X4', a: ' 7', b: 'S1 ', price: 5 }, // L7,L8
  { id: 'X0', a: 'A', b: 'S1 ', price: 100 }, // 全覆盖但总价更高
  { id: 'Y1', a: 'A', b: ' A ', price: 9 }, // 与 X1 同覆盖但更贵
]);

describe('导入：仅空白不同的编号互不合并', () => {
  it('多组空白变体与全空白编号作为不同站点共存，编号逐字符保留', () => {
    const { topology, analyzer } = newAnalyzer();
    // 站点编号逐字符保留（含数字 7 的十进制文本规范化）
    expect(topology.sites).toEqual(['A', ' A ', 'A ', ' A', '  ', '7', ' 7', 'S1', 'S1 ']);
    // 链路分别连接这些不同站点；长链上 8 条链路全部为桥
    expect(analyzer.baseline.siteCount).toBe(9);
    expect(analyzer.baseline.bridges.map((b) => [b.id, b.u, b.v, b.smallerSide])).toEqual([
      ['L1', 'A', ' A ', 1],
      ['L2', ' A ', 'A ', 2],
      ['L3', 'A ', ' A', 3],
      ['L4', ' A', '  ', 4],
      ['L5', '  ', '7', 4],
      ['L6', '7', ' 7', 3],
      ['L7', ' 7', 'S1', 2],
      ['L8', 'S1', 'S1 ', 1],
    ]);
  });

  it('完全相同的空白编号才算重复；仅空白不同的编号不算重复', () => {
    expect(() =>
      parseTopology(
        JSON.stringify({
          sites: ['A', ' A ', ' A '],
          links: [
            { id: 'x', u: 'A', v: ' A ' },
            { id: 'y', u: ' A ', v: ' A ' },
          ],
        }),
      ),
    ).toThrow(/站点编号重复/);
    // "A"、" A "、"A " 两两不同：合法导入
    expect(
      parseTopology(
        JSON.stringify({
          sites: ['A', ' A ', 'A '],
          links: [
            { id: 'x', u: 'A', v: ' A ' },
            { id: 'y', u: ' A ', v: 'A ' },
          ],
        }),
      ).sites,
    ).toHaveLength(3);
  });
});

describe('单次试接：精确引用与桥集合', () => {
  it('每个空白变体都可寻址，桥集合与删边预言机一致，端点按原字符回显', () => {
    const { topology, analyzer } = newAnalyzer();
    const cases: [string, string, string[]][] = [
      ['A', ' A ', ['L1']],
      [' A ', 'A', ['L1']], // 反向同一对
      [' A ', '  ', ['L2', 'L3', 'L4']],
      ['A ', ' A', ['L3']], // 两个“半空白”变体是相邻的不同站点
      ['  ', ' 7', ['L5', 'L6']], // 全空白站点可直接寻址
      ['7', ' 7', ['L6']], // 数字文本编号与带空白编号互不混淆
      ['S1', 'S1 ', ['L8']],
      ['A', 'S1 ', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']],
    ];
    for (const [a, b, expected] of cases) {
      const r = analyzer.trial(a, b);
      // 端点逐字符回显，绝不修剪改写
      expect(r.a).toBe(a);
      expect(r.b).toBe(b);
      expect(r.removed.map((x) => x.id)).toEqual(expected);
      expect(r.stillFragile.length + r.removed.length).toBe(8);
      // 与删边预言机逐集合一致
      const oracle = oracleTrial(topology, analyzer.baseline, a, b);
      expect(new Set(r.removed.map((x) => x.id))).toEqual(oracle.removed);
      expect(new Set(r.stillFragile.map((x) => x.id))).toEqual(oracle.stillFragile);
    }
    // 数字编号沿用十进制规范：trial(7, " 7") 与 trial("7", " 7") 等同
    const byNumber = analyzer.trial(7, ' 7');
    expect(byNumber.a).toBe('7');
    expect(byNumber.removed.map((x) => x.id)).toEqual(['L6']);
  });

  it('失败隔离：不存在的空白变体报错且不静默改指，原结果保留', () => {
    const { analyzer } = newAnalyzer();
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const okBefore = analyzer.trial('A', ' A ');

    // 每个不存在的变体都必须报“不在当前站点清单”，且错误定位逐字符引用原编号
    for (const ghost of ['  A', 'A  ', '   ', ' 7 ', ' S1', 'S1  ', ' ']) {
      expect(() => analyzer.trial(ghost, 'A')).toThrow(/不在当前站点清单/);
      expect(() => analyzer.trial(ghost, 'A')).toThrow(JSON.stringify(ghost));
    }
    // 空串仍然非法（拓扑契约从不接受空串编号）
    expect(() => analyzer.trial('', 'A')).toThrow(/为空/);
    // 完全相同的两端（含空白编号）构成自环，被拒绝
    expect(() => analyzer.trial(' A ', ' A ')).toThrow(/必须不同/);
    expect(() => analyzer.trial('  ', '  ')).toThrow(/必须不同/);

    // 原结果保留：基线与此前试接结论均未被污染
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    const okAfter = analyzer.trial('A', ' A ');
    expect(okAfter.removed.map((x) => x.id)).toEqual(okBefore.removed.map((x) => x.id));
  });
});

describe('批量筛选：逐字符身份与计数', () => {
  it('解析保留原始字符串，计数与单次试接逐项一致', () => {
    const { analyzer } = newAnalyzer();
    const pairs = parseBatchPlans(
      '[{"a":"A","b":" A "},{"a":" A ","b":"  "},{"a":"  ","b":" 7"},{"a":7,"b":" 7"},{"a":"S1","b":"S1 "},{"a":"A ","b":" A"}]',
    );
    // 解析层不改写任何字符（数字编号仍按十进制文本承载）
    expect(pairs).toEqual([
      { a: 'A', b: ' A ' },
      { a: ' A ', b: '  ' },
      { a: '  ', b: ' 7' },
      { a: '7', b: ' 7' },
      { a: 'S1', b: 'S1 ' },
      { a: 'A ', b: ' A' },
    ]);

    const result = analyzer.screenBatch(pairs);
    expect(result.items.map((it) => [it.a, it.b, it.removedCount])).toEqual([
      ['A', ' A ', 1],
      [' A ', '  ', 3],
      ['  ', ' 7', 2],
      ['7', ' 7', 1],
      ['S1', 'S1 ', 1],
      ['A ', ' A', 1],
    ]);
    for (let i = 0; i < pairs.length; i++) {
      expect(result.items[i].index).toBe(i);
      expect(result.items[i].removedCount).toBe(analyzer.trial(pairs[i].a, pairs[i].b).removed.length);
    }
  });

  it('失败隔离：不存在的空白变体按下标整批拒绝，无部分结果且不污染分析器', () => {
    const { analyzer } = newAnalyzer();
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const good = parseBatchPlans('[{"a":"A","b":" A "},{"a":" A ","b":"  "}]');
    const before = analyzer.screenBatch(good);

    const bad = parseBatchPlans('[{"a":"A","b":" A "},{"a":" A ","b":"  "},{"a":"  A","b":"A"}]');
    expect(() => analyzer.screenBatch(bad)).toThrow(/下标 2.*不在当前站点清单/);
    expect(() => analyzer.screenBatch(bad)).toThrow(JSON.stringify('  A'));
    // 空白不同的两端不是自环；完全相同的空白两端才是
    expect(() => analyzer.screenBatch([{ a: ' A ', b: ' A ' }])).toThrow(/下标 0.*必须不同/);

    // 原结果保留：同输入重放结果一致，基线不变
    expect(JSON.stringify(analyzer.screenBatch(good))).toBe(JSON.stringify(before));
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
  });
});

describe('有序计划：步骤归属', () => {
  it('各步首次消除清单、边际/累计/剩余与端点回显均按逐字符编号', () => {
    const { analyzer } = newAnalyzer();
    const steps = parseOrderedPlan(
      '[{"a":"A","b":" A "},{"a":" A ","b":"  "},{"a":"A ","b":" A"},{"a":"  ","b":" 7"},{"a":" 7","b":"S1 "}]',
    );
    const r = analyzer.reviewOrderedPlan(steps);

    expect(r.items.map((it) => [it.a, it.b])).toEqual([
      ['A', ' A '],
      [' A ', '  '],
      ['A ', ' A'],
      ['  ', ' 7'],
      [' 7', 'S1 '],
    ]);
    // 步骤归属：同一桥只归最早覆盖它的步骤（第 2 步的 L3 已被第 1 步覆盖）
    expect(r.items.map((it) => it.firstRemoved.map((b) => b.id))).toEqual([
      ['L1'],
      ['L2', 'L3', 'L4'],
      [],
      ['L5', 'L6'],
      ['L7', 'L8'],
    ]);
    expect(r.items.map((it) => it.marginal)).toEqual([1, 3, 0, 2, 2]);
    expect(r.items.map((it) => it.cumulative)).toEqual([1, 4, 4, 6, 8]);
    expect(r.items.map((it) => it.remaining)).toEqual([7, 4, 4, 2, 0]);
    expect(r.coveredCount).toBe(8);
    // 各步清单互斥，并集恰为全部基线桥
    const all = r.items.flatMap((it) => it.firstRemoved.map((b) => b.id));
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(analyzer.baseline.bridges.map((b) => b.id)));
  });

  it('失败隔离：末步空白变体不存在则整批拒绝，原结果保留', () => {
    const { analyzer } = newAnalyzer();
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const good = parseOrderedPlan('[{"a":"A","b":" A "},{"a":" A ","b":"  "}]');
    const before = analyzer.reviewOrderedPlan(good);

    const bad = parseOrderedPlan('[{"a":"A","b":" A "},{"a":" A ","b":"   "}]');
    expect(() => analyzer.reviewOrderedPlan(bad)).toThrow(/下标 1.*不在当前站点清单/);
    expect(() => analyzer.reviewOrderedPlan(bad)).toThrow(JSON.stringify('   '));

    expect(JSON.stringify(analyzer.reviewOrderedPlan(good))).toBe(JSON.stringify(before));
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
  });
});

describe('最低报价：裁决与诊断', () => {
  it('按逐字符端点求解：最低总价组合、逐桥来源与端点回显', () => {
    const { analyzer } = newAnalyzer();
    const candidates = parseQuotePlans(CANDIDATES_JSON);
    // 解析层保留端点原始字符
    expect(candidates.map((c) => [c.a, c.b])).toEqual([
      ['A', ' A '],
      [' A ', '  '],
      ['  ', ' 7'],
      [' 7', 'S1 '],
      ['A', 'S1 '],
      ['A', ' A '],
    ]);

    const r = analyzer.planQuotes(candidates);
    expect(r.feasible).toBe(true);
    // 裁决：X1+X2+X3+X4 = 20 优于 X0 = 100；同覆盖的 Y1(9) 输给 X1(5)
    expect(r.selected.map((c) => c.id)).toEqual(['X1', 'X2', 'X3', 'X4']);
    expect(r.totalPrice).toBe(20);
    // 所选连线的端点逐字符回显
    expect(r.selected.map((c) => [c.a, c.b])).toEqual([
      ['A', ' A '],
      [' A ', '  '],
      ['  ', ' 7'],
      [' 7', 'S1 '],
    ]);
    // 逐桥消除来源（仅列出所选候选）
    expect(r.coverage.map((c) => [c.bridge.id, c.coveredBy])).toEqual([
      ['L1', ['X1']],
      ['L2', ['X2']],
      ['L3', ['X2']],
      ['L4', ['X2']],
      ['L5', ['X3']],
      ['L6', ['X3']],
      ['L7', ['X4']],
      ['L8', ['X4']],
    ]);
  });

  it('无法覆盖诊断精确到桥；失败隔离保留原结果', () => {
    const { analyzer } = newAnalyzer();
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const good = parseQuotePlans(CANDIDATES_JSON);
    const before = analyzer.planQuotes(good);

    // 只覆盖 L1：其余 7 座桥逐条列入无法覆盖诊断，不伪造成功
    const partial = analyzer.planQuotes([{ id: 'X1', a: 'A', b: ' A ', price: 5 }]);
    expect(partial.feasible).toBe(false);
    expect(partial.uncoverable.map((b) => b.id)).toEqual(['L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']);

    // 不存在的空白变体按下标整批拒绝，错误定位逐字符引用原编号
    const bad = parseQuotePlans(
      JSON.stringify([
        { id: 'X1', a: 'A', b: ' A ', price: 5 },
        { id: 'X9', a: ' A', b: '  ', price: 1 }, // " A" 与 "  " 均存在：合法
        { id: 'X8', a: '  A', b: 'A', price: 1 }, // "  A"（两个前导空格）不存在：整批拒绝
      ]),
    );
    expect(() => analyzer.planQuotes(bad)).toThrow(/下标 2.*不在当前站点清单/);
    expect(() => analyzer.planQuotes(bad)).toThrow(JSON.stringify('  A'));

    // 原结果保留：同输入重放结论一致，基线不变
    const replay = analyzer.planQuotes(good);
    expect(replay.selected.map((c) => c.id)).toEqual(before.selected.map((c) => c.id));
    expect(replay.totalPrice).toBe(before.totalPrice);
    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
  });
});

describe('四类入口并行后的原结果保留', () => {
  it('基线、试接、批量、计划、报价互不改写', () => {
    const { analyzer } = newAnalyzer();
    const baselineBefore = JSON.stringify(analyzer.baseline);
    const trialBefore = JSON.stringify(analyzer.trial(' A ', '  '));
    analyzer.screenBatch(parseBatchPlans('[{"a":"  ","b":" 7"}]'));
    analyzer.reviewOrderedPlan(parseOrderedPlan('[{"a":"A","b":" A "}]'));
    analyzer.planQuotes(parseQuotePlans(CANDIDATES_JSON));

    expect(JSON.stringify(analyzer.baseline)).toBe(baselineBefore);
    expect(JSON.stringify(analyzer.trial(' A ', '  '))).toBe(trialBefore);
    // 四类入口对同一对空白端点给出一致的覆盖结论
    const t = analyzer.trial(' A ', '  ');
    const b = analyzer.screenBatch([{ a: ' A ', b: '  ' }]);
    expect(b.items[0].removedCount).toBe(t.removed.length);
  });
});
