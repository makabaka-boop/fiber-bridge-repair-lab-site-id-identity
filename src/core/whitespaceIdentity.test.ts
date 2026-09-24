/**
 * 空白敏感站点编号的逐字符身份验收。
 *
 * 拓扑契约接受任意非空字符串站点编号，因此 "A"、" A "、"A "、" A" 乃至
 * 全空白的 " " 是彼此不同且合法的站点。本测试在同一张连通图（一条链，
 * 每条链路都是桥）中并排放置多组仅首尾空白不同的编号，通过四类后续入口
 * （单次试接 / 批量筛选 / 有序计划 / 最低报价）逐一精确引用，并核对：
 *
 *  - 桥集合：每个变体只寻址自身，不被静默改写到 trim 后的相似编号；
 *  - 步骤归属：首次消除的桥按变体身份各归其步；
 *  - 报价裁决：依赖变体区分才能可行的组合被正确选出；
 *  - 失败隔离：不存在的带空白编号按下标/端点精确报错，原结果保留；
 *  - 数字编号继续按十进制文本工作，普通编号行为不变。
 */
import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { oracleTrial } from './oracle';
import { parseBatchPlans, parseOrderedPlan, parseQuotePlans, parseTopology } from './parse';
import { TopologyError } from './types';
import type { NormalizedTopology } from './types';

/**
 * 8 站点链（7 条链路全部为桥），下标 0–7。其中下标 1/2/3/4 为四个仅首尾
 * 空白不同的编号，下标 6 为全空白编号 " "：
 *
 *   'A' — ' A ' — 'A ' — ' A' — 'X' — 'Y' — ' ' — 'Z'
 *   L1     L2      L3      L4     L5    L6    L7
 */
function whitespaceChain(): NormalizedTopology {
  return {
    sites: ['A', ' A ', 'A ', ' A', 'X', 'Y', ' ', 'Z'],
    links: [
      { id: 'L1', u: 'A', v: ' A ' },
      { id: 'L2', u: ' A ', v: 'A ' },
      { id: 'L3', u: 'A ', v: ' A' },
      { id: 'L4', u: ' A', v: 'X' },
      { id: 'L5', u: 'X', v: 'Y' },
      { id: 'L6', u: 'Y', v: ' ' },
      { id: 'L7', u: ' ', v: 'Z' },
    ],
  };
}

/** 与 whitespaceChain 等价的原始 JSON 文本（含数字编号规则的回归核对） */
const WHITESPACE_CHAIN_JSON = JSON.stringify({
  sites: ['A', ' A ', 'A ', ' A', 'X', 'Y', ' ', 'Z'],
  links: [
    { id: 'L1', u: 'A', v: ' A ' },
    { id: 'L2', u: ' A ', v: 'A ' },
    { id: 'L3', u: 'A ', v: ' A' },
    { id: 'L4', u: ' A', v: 'X' },
    { id: 'L5', u: 'X', v: 'Y' },
    { id: 'L6', u: 'Y', v: ' ' },
    { id: 'L7', u: ' ', v: 'Z' },
  ],
});

describe('导入：仅空白不同的编号在同一拓扑中全部合法且互不重复', () => {
  it('四个 A 变体与全空白站点作为不同站点导入，编号逐字符保留', () => {
    const t = parseTopology(WHITESPACE_CHAIN_JSON);
    expect(t.sites).toEqual(['A', ' A ', 'A ', ' A', 'X', 'Y', ' ', 'Z']);
    // 任一变体都不与 trim 后的编号合并：去掉任意首尾空白都会与已有站点冲突
    expect(new Set(t.sites).size).toBe(8);
    expect(t.links.map((l) => [l.u, l.v])).toEqual([
      ['A', ' A '],
      [' A ', 'A '],
      ['A ', ' A'],
      [' A', 'X'],
      ['X', 'Y'],
      ['Y', ' '],
      [' ', 'Z'],
    ]);
  });

  it('trim 后相同的编号重复导入才报重复（逐字符判定，不做归一化）', () => {
    // 逐字符相同才是重复："A " 出现两次
    const dup = JSON.stringify({
      sites: ['A', 'A ', 'A '],
      links: [{ id: 'e1', u: 'A', v: 'A ' }],
    });
    expect(() => parseTopology(dup)).toThrow(/站点编号重复："A "/);
    // "A" 与 " A" 逐字符不同，合法
    const ok = JSON.stringify({
      sites: ['A', ' A'],
      links: [{ id: 'e1', u: 'A', v: ' A' }],
    });
    expect(parseTopology(ok).sites).toEqual(['A', ' A']);
  });
});

describe('单次试接：端点编号逐字符寻址', () => {
  const az = new Analyzer(whitespaceChain());

  it.each([
    [' A ', ['L2', 'L3', 'L4', 'L5', 'L6', 'L7']],
    ['A ', ['L3', 'L4', 'L5', 'L6', 'L7']],
    [' A', ['L4', 'L5', 'L6', 'L7']],
  ] as const)('变体 %s 到 Z 的桥路径与删边预言机一致（旧实现会静默重定向到 "A"）', (variant, expected) => {
    const result = az.trial(variant, 'Z');
    // 回显逐字符保留，绝不改写成 trim 后的文本
    expect(result.a).toBe(variant);
    expect(result.b).toBe('Z');
    const removed = result.removed.map((b) => b.id);
    // 旧实现 trim 后一律寻址 "A"，会错误地把 L1 计入且漏掉变体自己的桥
    expect(removed).toEqual(expected);
    expect(removed).not.toContain('L1');
    // 与删边预言机在逐字符编号上的结论完全一致
    const oracle = oracleTrial(whitespaceChain(), az.baseline, variant, 'Z');
    expect(new Set(removed)).toEqual(oracle.removed);
  });

  it('"A" 自身到 Z 只消除 L1 及右侧各桥，不含变体桥', () => {
    const result = az.trial('A', 'Z');
    expect(result.removed.map((b) => b.id)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  });

  it('全空白站点 " " 可精确寻址（导入成功后所有流程都能引用）', () => {
    const result = az.trial(' ', 'Z');
    expect(result.a).toBe(' ');
    expect(result.removed.map((b) => b.id)).toEqual(['L7']);
    const oracle = oracleTrial(whitespaceChain(), az.baseline, ' ', 'Z');
    expect(new Set(result.removed.map((b) => b.id))).toEqual(oracle.removed);
  });

  it('带空白的不存在编号精确报错，消息保留原字符；上次试接结果不动', () => {
    const first = az.trial('A', 'Z');
    // " A" 存在，但 "  A "（两个空格）不存在：trim 会错误命中 "A"
    expect(() => az.trial('  A ', 'Z')).toThrow(/"  A " 不在当前站点清单/);
    // 纯空白但非该站点（三个空格）同样精确失败，不静默落到 " "
    expect(() => az.trial('   ', 'Z')).toThrow(/"   " 不在当前站点清单/);
    // 两端都是已存在的不同变体时合法；同一变体自环才拒绝
    expect(() => az.trial(' A ', ' A ')).toThrow(/两个端点必须不同/);
    // 失败后分析器与上次结果不被污染
    expect(az.trial('A', 'Z').removed.map((b) => b.id)).toEqual(first.removed.map((b) => b.id));
  });

  it('空字符串端点被拒绝（全空白字符串不视为空）', () => {
    expect(() => az.trial('', 'Z')).toThrow(/不能为空字符串/);
    expect(() => az.trial('A', '')).toThrow(/不能为空字符串/);
    // " " 是合法非空站点，绝不能按“空”处理
    expect(az.trial(' ', 'A').removed.length).toBeGreaterThan(0);
  });

  it('数字编号继续按十进制文本寻址，普通编号行为不变', () => {
    const t: NormalizedTopology = {
      sites: ['7', '11', 'x'],
      links: [
        { id: 'e1', u: '7', v: '11' },
        { id: 'e2', u: '11', v: 'x' },
      ],
    };
    const a = new Analyzer(t);
    expect(a.trial(7, 'x').removed.map((b) => b.id)).toEqual(['e1', 'e2']);
    expect(a.trial('7', 'x').removed.map((b) => b.id)).toEqual(['e1', 'e2']);
  });
});

describe('批量筛选：解析与计数逐字符保留', () => {
  it('解析层不删除首尾空白，全空白项也是非空编号', () => {
    const pairs = parseBatchPlans('[{"a": " A ", "b": "Z"}, {"a": " ", "b": "A "}]');
    expect(pairs).toEqual([
      { a: ' A ', b: 'Z' },
      { a: ' ', b: "A " },
    ]);
  });

  it('同一连通图中多组仅空白不同的端点对各自给出正确桥覆盖数', () => {
    const az = new Analyzer(whitespaceChain());
    const result = az.screenBatch([
      { a: 'A', b: 'Z' }, // L1..L7 = 7
      { a: ' A ', b: 'Z' }, // L2..L7 = 6
      { a: 'A ', b: 'Z' }, // L3..L7 = 5
      { a: ' A', b: 'Z' }, // L4..L7 = 4
      { a: ' ', b: 'Z' }, // L7 = 1
      { a: 'A', b: ' A ' }, // L1 = 1
      { a: ' A ', b: ' A' }, // L2,L3 = 2
    ]);
    expect(result.items.map((it) => it.removedCount)).toEqual([7, 6, 5, 4, 1, 1, 2]);
    // 回显逐字符保留
    expect(result.items.map((it) => [it.a, it.b])).toEqual([
      ['A', 'Z'],
      [' A ', 'Z'],
      ['A ', 'Z'],
      [' A', 'Z'],
      [' ', 'Z'],
      ['A', ' A '],
      [' A ', ' A'],
    ]);
    // 与单次试接（以及删边预言机）逐项一致
    for (const [i, pair] of [
      ['A', 'Z'],
      [' A ', 'Z'],
      ['A ', 'Z'],
      [' A', 'Z'],
      [' ', 'Z'],
      ['A', ' A '],
      [' A ', ' A'],
    ].entries()) {
      expect(result.items[i].removedCount).toBe(az.trial(pair[0], pair[1]).removed.length);
    }
  });

  it('失败隔离：带空白的不存在端点按下标精确报错，无部分结果且基线不动', () => {
    const az = new Analyzer(whitespaceChain());
    const before = JSON.stringify(az.baseline);
    const pairs = [
      { a: 'A', b: 'Z' },
      { a: '  A ', b: 'Z' }, // 下标 1：多两个空格，不存在（旧实现会误命中 "A"）
    ];
    expect(() => az.screenBatch(pairs)).toThrow(/下标 1：端点 "  A " 不在当前站点清单/);
    // 同一变体自环按下标拒绝
    expect(() => az.screenBatch([{ a: 'A ', b: 'A ' }])).toThrow(/下标 0：两个端点必须不同/);
    expect(JSON.stringify(az.baseline)).toBe(before);
    // 合法批次随后照常工作（" A"→" " 路径为 L4,L5,L6）
    expect(az.screenBatch([{ a: ' A', b: ' ' }]).items[0].removedCount).toBe(3);
  });
});

describe('有序计划：首次消除步骤按变体身份归属', () => {
  it('四个变体分别首步覆盖自身桥，互不抢归属', () => {
    const az = new Analyzer(whitespaceChain());
    // 每步从一个 A 变体到 Z：第一步 (" A "→Z) 覆盖 L2..L7；
    // 后续变体路径中 L5..L7 已被覆盖，只各自首次拿到 L3 / L4；
    // "A"→Z 只首次拿到 L1。
    const result = az.reviewOrderedPlan([
      { a: ' A ', b: 'Z' }, // 首次：L2,L3,L4,L5,L6,L7（6）
      { a: 'A ', b: 'Z' }, // L3,L4 已覆盖 → 0
      { a: ' A', b: 'Z' }, // L4 已覆盖 → 0
      { a: 'A', b: 'Z' }, // 仅 L1 新增（1）
    ]);
    expect(result.items.map((it) => it.marginal)).toEqual([6, 0, 0, 1]);
    expect(result.items.map((it) => it.cumulative)).toEqual([6, 6, 6, 7]);
    expect(result.items.map((it) => it.remaining)).toEqual([1, 1, 1, 0]);
    expect(result.coveredCount).toBe(7);
    // 各步清单互斥且并集恰为全部 7 座基线桥
    const union = new Set<string>();
    for (const it of result.items) for (const b of it.firstRemoved) union.add(b.id);
    expect([...union].sort()).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
    // 关键归属：L1 必须归使用 "A" 的第 4 步，绝不归 trim 后同名为 "A" 的前几步
    expect(result.items[3].firstRemoved.map((b) => b.id)).toEqual(['L1']);
    expect(result.items[0].firstRemoved.map((b) => b.id)).toEqual(['L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  });

  it('步骤端点逐字符回显；不存在的带空白编号按下标整批拒绝', () => {
    const az = new Analyzer(whitespaceChain());
    const ok = az.reviewOrderedPlan(parseOrderedPlan('[{"a":" A ","b":" "},{"a":"A","b":"Z"}]'));
    expect(ok.items[0]).toMatchObject({ a: ' A ', b: ' ' });
    expect(ok.items[1]).toMatchObject({ a: 'A', b: 'Z' });

    const bad = parseOrderedPlan('[{"a":"A","b":"Z"},{"a":" A  ","b":"Z"}]');
    expect(bad[1].a).toBe(' A  '); // 草稿解析仍逐字符
    expect(() => az.reviewOrderedPlan(bad)).toThrow(/下标 1：端点 " A  " 不在当前站点清单/);
  });
});

describe('最低报价组合：裁决依赖变体的逐字符区分', () => {
  // 链：A - " A " - "A " - " A" - X - Y - " " - Z，桥 L1..L7。
  // 三段互不包含的候选把 7 座桥切成三段：
  //  - P（"A"→" A "）只覆盖 L1，报价 5；
  //  - Q（" A "→" A"）覆盖变体段 L2,L3，报价 5；
  //  - R（" A"→"Z"）覆盖 L4,L5,L6,L7，报价 5。
  // 三者合起来才全覆盖。旧 trim 行为下：
  //  Q 的两端被改写成 "A"→"A"（自环，整批按下标 1 拒绝）——合法组合无法提交；
  //  R 的起点被改写成 "A"，路径错认为 L1..L7，会错误地只选 R 一条。
  const buildCandidates = () => [
    { id: 'P', a: 'A', b: ' A ', price: 5 },
    { id: 'Q', a: ' A ', b: ' A', price: 5 },
    { id: 'R', a: ' A', b: 'Z', price: 5 },
  ];

  it('解析层逐字符保留：Q 的两端 trim 后相同但逐字符不同，是合法候选而非自环', () => {
    const parsed = parseQuotePlans(JSON.stringify(buildCandidates()));
    expect(parsed.map((c) => [c.a, c.b])).toEqual([
      ['A', ' A '],
      [' A ', ' A'],
      [' A', 'Z'],
    ]);
  });

  it('三段变体候选缺一不可：精确枚举裁决 P+Q+R（旧 trim 会误拒 Q 或误选 R 单条）', () => {
    const az = new Analyzer(whitespaceChain());
    const result = az.planQuotes(buildCandidates());
    expect(result.feasible).toBe(true);
    expect(result.selected.map((c) => c.id)).toEqual(['P', 'Q', 'R']);
    expect(result.totalPrice).toBe(15);
    const byBridge = new Map(result.coverage.map((it) => [it.bridge.id, it.coveredBy]));
    expect(byBridge.get('L1')).toEqual(['P']);
    expect(byBridge.get('L2')).toEqual(['Q']);
    expect(byBridge.get('L3')).toEqual(['Q']);
    expect(byBridge.get('L4')).toEqual(['R']);
    expect(byBridge.get('L5')).toEqual(['R']);
    expect(byBridge.get('L6')).toEqual(['R']);
    expect(byBridge.get('L7')).toEqual(['R']);
  });

  it('三层裁决在变体身份上同样生效：Q 与 Q2 路径相同只留更便宜者，零价冗余候选不捎带', () => {
    const az = new Analyzer(whitespaceChain());
    // Q2（" A "→" A"）与 Q 路径完全相同但更贵；零价的无用候选 U（L4 已被
    // R 覆盖）不得因零价被捎带。
    const result = az.planQuotes([
      ...buildCandidates(),
      { id: 'Q2', a: ' A ', b: ' A', price: 9 },
      { id: 'U', a: ' A', b: 'X', price: 0 }, // 仅 L4，R 已覆盖
    ]);
    expect(result.feasible).toBe(true);
    expect(result.selected.map((c) => c.id)).toEqual(['P', 'Q', 'R']);
    expect(result.totalPrice).toBe(15);
  });

  it('变体身份直接改变可行性：缺少变体段 Q 时 L2/L3 具体诊断，不伪造成功', () => {
    const az = new Analyzer(whitespaceChain());
    const result = az.planQuotes([
      { id: 'P', a: 'A', b: ' A ', price: 5 },
      { id: 'R', a: ' A', b: 'Z', price: 5 },
    ]);
    expect(result.feasible).toBe(false);
    expect(result.uncoverable.map((b) => b.id)).toEqual(['L2', 'L3']);
    expect(result.selected).toEqual([]);
    expect(result.totalPrice).toBe(0);
  });

  it('失败隔离：候选端点为不存在的带空白编号按下标拒绝，上次求解结果保留', () => {
    const az = new Analyzer(whitespaceChain());
    const first = az.planQuotes(buildCandidates());
    expect(first.feasible).toBe(true);

    const bad = JSON.stringify([
      { id: 'P', a: 'A', b: ' A ', price: 5 },
      { id: 'T', a: ' A', b: ' Z', price: 1 },
    ]);
    expect(() => az.planQuotes(parseQuotePlans(bad))).toThrow(/下标 1：端点 " Z" 不在当前站点清单/);
    // 候选自身编号仍走非空字符串规则；空串拒绝、全空白串是合法候选编号
    expect(() => parseQuotePlans('[{"id":"","a":"A","b":" A ","price":1}]')).toThrow(/候选编号/);
    expect(parseQuotePlans('[{"id":" ","a":"A","b":" A ","price":0}]')[0].id).toBe(' ');
    // 上次成功结果不被失败请求改写
    const again = az.planQuotes(buildCandidates());
    expect(again.selected.map((c) => c.id)).toEqual(first.selected.map((c) => c.id));
  });
});

describe('普通编号与既有行为回归', () => {
  it('不含首尾空白的普通字符串编号各入口行为不变', () => {
    const t: NormalizedTopology = {
      sites: ['v0', 'v1', 'v2', 'v3'],
      links: [
        { id: 'b1', u: 'v0', v: 'v1' },
        { id: 'b2', u: 'v1', v: 'v2' },
        { id: 'b3', u: 'v2', v: 'v3' },
      ],
    };
    const az = new Analyzer(t);
    expect(az.trial('v0', 'v3').removed.map((x) => x.id)).toEqual(['b1', 'b2', 'b3']);
    expect(az.screenBatch([{ a: 'v0', b: 'v1' }]).items[0].removedCount).toBe(1);
    const plan = az.reviewOrderedPlan([
      { a: 'v0', b: 'v2' },
      { a: 'v2', b: 'v3' },
    ]);
    expect(plan.items.map((it) => it.marginal)).toEqual([2, 1]);
    const quote = az.planQuotes([{ id: 'X', a: 'v0', b: 'v3', price: 5 }]);
    expect(quote.feasible).toBe(true);
    expect(quote.selected.map((c) => c.id)).toEqual(['X']);
  });

  it('TopologyError 可被调用方按类型捕获用于失败隔离', () => {
    const az = new Analyzer(whitespaceChain());
    try {
      az.trial(' 不存在 ', 'Z');
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(TopologyError);
      expect((e as TopologyError).message).toMatch(/不在当前站点清单/);
    }
  });
});
