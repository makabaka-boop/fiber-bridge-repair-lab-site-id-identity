/// <reference types="vitest/globals" />
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

const validJson = JSON.stringify({
  sites: ['a', 'b', 'c'],
  // 链：a-b 桥（小侧 a=1），b-c 桥（小侧 c=1）
  links: [
    { id: 'L1', u: 'a', v: 'b' },
    { id: 'L2', u: 'b', v: 'c' },
  ],
});

const inputBox = () => screen.getByLabelText('拓扑 JSON 输入') as HTMLTextAreaElement;
const importButton = () => screen.getByRole('button', { name: '导入并分析' });
const trialButton = () => screen.getByRole('button', { name: '试接并核对' });
const batchBox = () => screen.getByLabelText('批量方案 JSON 输入') as HTMLTextAreaElement;
const batchButton = () => screen.getByRole('button', { name: '批量筛选' });
const planBox = () => screen.getByLabelText('有序备纤计划 JSON 输入') as HTMLTextAreaElement;
const planButton = () => screen.getByRole('button', { name: '按序复核' });
const quoteBox = () => screen.getByLabelText('备纤报价 JSON 输入') as HTMLTextAreaElement;
const quoteButton = () => screen.getByRole('button', { name: '求解最低总价组合' });

/** 读取“脆弱链路总数”统计卡数值（该卡始终随基线渲染，非法导入后也保留） */
const fragileStatValue = () => {
  const label = screen.getByText('脆弱链路总数');
  const card = label.closest('.stat') as HTMLElement;
  return card.querySelector('.stat-value')?.textContent;
};

/** 读取批量结果区指定统计卡数值 */
const batchStatValue = (label: string) => {
  const el = screen.getByText(label);
  const card = el.closest('.stat') as HTMLElement;
  return card.querySelector('.stat-value')?.textContent;
};

/** 当前批量结果表的所有行（下标、端点 A、端点 B、可消除数量） */
const batchRows = () =>
  Array.from(document.querySelectorAll('.batch-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  );

/** 当前有序计划结果表的步骤行（步骤、A、B、桥清单单元、边际、累计、剩余） */
const planRows = () =>
  Array.from(document.querySelectorAll('.plan-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  );

/** 读取有序计划结果区指定统计卡数值 */
const planStatValue = (label: string) => batchStatValue(label);

async function importJson(text: string) {
  fireEvent.change(inputBox(), { target: { value: text } });
  // 等待受控输入值提交后再点击，避免同批次事件读到旧输入
  await waitFor(() => expect(inputBox().value).toBe(text));
  fireEvent.click(importButton());
}

async function submitTrial(a: string, b: string) {
  const [inputA, inputB] = screen.getAllByPlaceholderText(/端点/) as HTMLInputElement[];
  fireEvent.change(inputA, { target: { value: a } });
  fireEvent.change(inputB, { target: { value: b } });
  await waitFor(() => {
    expect(inputA.value).toBe(a);
    expect(inputB.value).toBe(b);
  });
  fireEvent.click(trialButton());
}

async function submitBatch(text: string) {
  fireEvent.change(batchBox(), { target: { value: text } });
  await waitFor(() => expect(batchBox().value).toBe(text));
  fireEvent.click(batchButton());
}

async function submitPlan(text: string) {
  fireEvent.change(planBox(), { target: { value: text } });
  await waitFor(() => expect(planBox().value).toBe(text));
  fireEvent.click(planButton());
}

async function submitQuote(text: string) {
  fireEvent.change(quoteBox(), { target: { value: text } });
  await waitFor(() => expect(quoteBox().value).toBe(text));
  fireEvent.click(quoteButton());
}

/** 第 6 区（最低总价备纤组合）的卡片，统计卡查询限定在本区内避免同名卡歧义 */
const quoteSection = () =>
  screen.getByText('6. 最低总价备纤组合').closest('section') as HTMLElement;

const quoteStat = (label: string) => {
  const el = within(quoteSection()).getByText(label);
  const card = el.closest('.stat') as HTMLElement;
  return card.querySelector('.stat-value')?.textContent;
};

/** 所选连线表行（#、候选编号、端点 A、端点 B、报价） */
const quoteSelectedRows = () =>
  Array.from(document.querySelectorAll('.quote-selected-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  );

/** 逐桥消除来源表行（#、桥编号、端点、消除它的所选连线） */
const quoteCoverageRows = () =>
  Array.from(document.querySelectorAll('.quote-coverage-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  );

/** 无法覆盖诊断表行（第 6 区内的桥表） */
const quoteUncoverableRows = () =>
  Array.from(quoteSection().querySelectorAll('.bridge-table tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent),
  );

afterEach(cleanup);

/**
 * 含多组仅首尾空白不同站点编号的连通链（全部为桥）：
 *   'A' - ' A ' - 'A ' - ' A' - 'X' - 'Y' - ' ' - 'Z'
 */
const whitespaceJson = JSON.stringify({
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

describe('空白敏感站点编号 UI：逐字符身份贯穿四类入口', () => {
  it('试接：自动补全选中的 " A " 原样提交，不改写成 "A"，桥集合按变体身份', async () => {
    render(<App />);
    await importJson(whitespaceJson);
    await waitFor(() => expect(fragileStatValue()).toBe('7'));

    // 自动补全清单中变体编号逐字符存在（option value 原样）
    const options = Array.from(document.querySelectorAll('#site-list option')).map((o) => o.getAttribute('value'));
    expect(options).toContain(' A ');
    expect(options).toContain('A ');
    expect(options).toContain(' A');
    expect(options).toContain(' ');

    // 从变体 " A " 试接到 Z：只消除 L2..L7，不含 L1（旧实现会 trim 成 "A"）
    await submitTrial(' A ', 'Z');
    await waitFor(() => expect(screen.getByText(/已消除 6 条/)).toBeTruthy());
    // 头部回显逐字符保留（code 内保留首尾空白）
    const head = document.querySelector('.trial-head')?.textContent ?? '';
    expect(head).toContain(' A ');
    // 已消除区含 L2 不含 L1；仍脆弱区为 L1（两张表在同一 section 内，按标题取其后续兄弟）
    const tableAfterHeading = (re: RegExp) => {
      const h = screen.getByText(re) as HTMLElement;
      let node: Element | null = h.nextElementSibling;
      while (node && !node.querySelector('table')) node = node.nextElementSibling;
      return node?.textContent ?? '';
    };
    expect(tableAfterHeading(/相对基线已消除的链路/)).toContain('L2');
    expect(tableAfterHeading(/相对基线已消除的链路/)).not.toContain('L1');
    expect(tableAfterHeading(/仍脆弱的链路/)).toContain('L1');
    expect(tableAfterHeading(/仍脆弱的链路/)).not.toContain('L2');

    // 全空白站点 " " 也可精确引用
    await submitTrial(' ', 'Z');
    await waitFor(() => expect(screen.getByText(/已消除 1 条/)).toBeTruthy());

    // 带空白的不存在编号精确失败且保留上次结果（不静默重定向到 "A"）
    await submitTrial('  A ', 'Z');
    await waitFor(() => expect(screen.getByText(/不在当前站点清单/)).toBeTruthy());
    expect(screen.getByText(/已消除 1 条/)).toBeTruthy();
  });

  it('批量/有序/报价：仅空白不同的端点逐字符展示与裁决，失败按下标隔离', async () => {
    render(<App />);
    await importJson(whitespaceJson);
    await waitFor(() => expect(fragileStatValue()).toBe('7'));

    // 批量筛选：四个变体计数各不相同，端点逐字符回显
    await submitBatch(
      JSON.stringify([
        { a: 'A', b: 'Z' },
        { a: ' A ', b: 'Z' },
        { a: 'A ', b: 'Z' },
        { a: ' A', b: 'Z' },
        { a: ' ', b: 'Z' },
      ]),
    );
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('5'));
    expect(batchRows()).toEqual([
      ['0', 'A', 'Z', '7'],
      ['1', ' A ', 'Z', '6'],
      ['2', 'A ', 'Z', '5'],
      ['3', ' A', 'Z', '4'],
      ['4', ' ', 'Z', '1'],
    ]);
    // 末项不存在的带空白编号：按下标拒绝，上次 5 行结果保留
    await submitBatch(JSON.stringify([{ a: 'A', b: 'Z' }, { a: ' A  ', b: 'Z' }]));
    await waitFor(() => expect(screen.getByText(/下标 1/)).toBeTruthy());
    expect(batchRows()).toHaveLength(5);

    // 有序计划：首步变体 " A "→Z 拿 L2..L7（6），第二步 "A"→Z 只新增 L1（1）
    await submitPlan(JSON.stringify([{ a: ' A ', b: 'Z' }, { a: 'A', b: 'Z' }]));
    await waitFor(() => expect(planStatValue('计划覆盖基线桥')).toBe('7'));
    const rows = planRows();
    expect(rows[0][1]).toBe(' A ');
    expect(rows[0][4]).toBe('6');
    expect(rows[1][4]).toBe('1'); // L1 归使用 "A" 的步骤，不被 trim 改写抢走

    // 最低报价：三段变体候选缺一不可，旧 trim 会误判
    await submitQuote(
      JSON.stringify([
        { id: 'P', a: 'A', b: ' A ', price: 5 },
        { id: 'Q', a: ' A ', b: ' A', price: 5 },
        { id: 'R', a: ' A', b: 'Z', price: 5 },
      ]),
    );
    const quote = screen.getByText('6. 最低总价备纤组合').closest('section') as HTMLElement;
    await waitFor(() => expect(within(quote).getByText('最低总价').closest('.stat')?.querySelector('.stat-value')?.textContent).toBe('15'));
    expect(
      Array.from(quote.querySelectorAll('.quote-selected-table tbody tr')).map((tr) => tr.querySelector('td:nth-child(2)')?.textContent),
    ).toEqual(['P', 'Q', 'R']);
  });
});

describe('拓扑工作台 UI', () => {
  it('完整流程：导入 → 基线 → 试接消险 → 非法试接保留上次结果', async () => {
    render(<App />);

    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    // 基线列出两条桥
    expect(screen.getByText('L1')).toBeTruthy();
    expect(screen.getByText('L2')).toBeTruthy();

    // 非法导入：损坏 JSON，必须保留上次有效拓扑
    await importJson('{坏的');
    await waitFor(() => expect(screen.getByText('导入被拒绝，')).toBeTruthy());
    // 基线区仍在（脆弱链路总数统计卡仍为 2）
    expect(fragileStatValue()).toBe('2');
    expect(screen.getByText('L1')).toBeTruthy();

    // 合法试接 a-c：跨越两座桥，全部消除
    await submitTrial('a', 'c');
    await waitFor(() => expect(screen.getByText(/已消除 2 条/)).toBeTruthy());
    expect(screen.getByText(/试接后原基线脆弱链路已全部消除/)).toBeTruthy();

    // 非法试接：端点不存在；上次试接结果必须保留，并显示明确错误
    await submitTrial('a', 'ghost');
    await waitFor(() => expect(screen.getByText('试接被拒绝。')).toBeTruthy());
    expect(screen.getByText(/已消除 2 条/)).toBeTruthy();
    expect(screen.getByText(/不在当前站点清单/)).toBeTruthy();

    // 相同端点也被拒绝
    await submitTrial('b', 'b');
    await waitFor(() => expect(screen.getByText(/两个端点必须不同/)).toBeTruthy());
    // 上次成功结果仍保留
    expect(screen.getByText(/已消除 2 条/)).toBeTruthy();
  });

  it('部分消险：试接平行于一座桥只消除该桥', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await submitTrial('b', 'c');
    await waitFor(() => expect(screen.getByText(/仍脆弱 1 条/)).toBeTruthy());
    expect(screen.getByText(/已消除 1 条/)).toBeTruthy();

    // 仍脆弱区为 L1，已消除区为 L2
    const stillBlock = screen.getByText(/仍脆弱的链路/).closest('section') ?? document.body;
    expect(stillBlock.textContent).toContain('L1');
    const removedBlock = screen.getByText(/相对基线已消除/).closest('section') ?? document.body;
    expect(removedBlock.textContent).toContain('L2');
  });

  it('非连通 / 自环等非法导入均被拒绝且保留上次基线', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await importJson(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd'],
        links: [
          { id: 'x', u: 'a', v: 'b' },
          { id: 'y', u: 'c', v: 'd' },
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText(/原图必须连通/)).toBeTruthy());

    await importJson(
      JSON.stringify({
        sites: ['a', 'b'],
        links: [{ id: 'z', u: 'a', v: 'a' }],
      }),
    );
    await waitFor(() => expect(screen.getByText(/自环非法/)).toBeTruthy());

    // 旧基线依旧保留（脆弱链路总数统计卡仍为 2，桥行仍在）
    expect(fragileStatValue()).toBe('2');
    expect(screen.getByText('L2')).toBeTruthy();
  });
});

describe('批量方案筛选 UI', () => {
  it('合法批次整体替换；末项非法按下标报错并保留上次结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // 合法批次：含重复候选，按输入下标原序显示
    await submitBatch('[{"a":"a","b":"c"},{"a":"a","b":"b"},{"a":"b","b":"c"},{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('4'));
    expect(batchStatValue('基线脆弱链路总数')).toBe('2');
    expect(batchStatValue('可全消方案数')).toBe('2');
    expect(batchRows()).toEqual([
      ['0', 'a', 'c', '2'],
      ['1', 'a', 'b', '1'],
      ['2', 'b', 'c', '1'],
      ['3', 'a', 'c', '2'],
    ]);

    // 末项非法（端点不存在）：按下标报错，上次结果完整保留
    await submitBatch('[{"a":"a","b":"c"},{"a":"a","b":"ghost"}]');
    await waitFor(() => expect(screen.getByText('批量导入被拒绝。')).toBeTruthy());
    expect(screen.getByText(/下标 1/)).toBeTruthy();
    expect(screen.getByText(/不在当前站点清单/)).toBeTruthy();
    expect(batchRows()).toHaveLength(4);

    // 空批次、额外字段同样整体拒绝且保留上次结果
    await submitBatch('[]');
    await waitFor(() => expect(screen.getByText(/空数组/)).toBeTruthy());
    expect(batchRows()).toHaveLength(4);
    await submitBatch('[{"a":"a","b":"c","note":"x"}]');
    await waitFor(() => expect(screen.getByText(/额外字段/)).toBeTruthy());
    expect(batchRows()).toHaveLength(4);

    // 再次合法批次：整体替换旧结果
    await submitBatch('[{"a":"a","b":"b"}]');
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('1'));
    expect(batchRows()).toEqual([['0', 'a', 'b', '1']]);

    // 批量操作不改写单次试接：试接仍正常
    await submitTrial('a', 'c');
    await waitFor(() => expect(screen.getByText(/已消除 2 条/)).toBeTruthy());
    expect(batchStatValue('方案总数')).toBe('1');
  });

  it('合法新拓扑清空批量结果；非法导入保留批量结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    await submitBatch('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchRows()).toHaveLength(1));

    // 合法新拓扑（三角形，无桥）：旧批量结果清空
    await importJson(
      JSON.stringify({
        sites: ['x', 'y', 'z'],
        links: [
          { id: 'r1', u: 'x', v: 'y' },
          { id: 'r2', u: 'y', v: 'z' },
          { id: 'r3', u: 'z', v: 'x' },
        ],
      }),
    );
    await waitFor(() => expect(fragileStatValue()).toBe('0'));
    expect(document.querySelector('.batch-table')).toBeNull();

    // 新拓扑上重新批量筛选（新站点编号）
    await submitBatch('[{"a":"x","b":"z"}]');
    await waitFor(() => expect(batchRows()).toEqual([['0', 'x', 'z', '0']]));

    // 非法导入：保留当前拓扑与批量结果
    await importJson('{坏的');
    await waitFor(() => expect(screen.getByText('导入被拒绝，')).toBeTruthy());
    expect(batchRows()).toEqual([['0', 'x', 'z', '0']]);
  });

  it('批量端点不存在与自环均按下标拒绝', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await submitBatch('[{"a":"a","b":"a"}]');
    await waitFor(() => expect(screen.getByText(/下标 0.*必须不同/)).toBeTruthy());
    expect(document.querySelector('.batch-table')).toBeNull();

    await submitBatch('[{"a":"a","b":"c"},{"a":"b","b":"c"},{"a":"c","b":"zzz"}]');
    await waitFor(() => expect(screen.getByText(/下标 2/)).toBeTruthy());
    expect(document.querySelector('.batch-table')).toBeNull();
  });

  it('大批量结果按输入下标分页显示', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // 60 项：超过单页 50 条，触发分页
    const items = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? { a: 'a', b: 'c' } : { a: 'a', b: 'b' }));
    await submitBatch(JSON.stringify(items));
    await waitFor(() => expect(batchStatValue('方案总数')).toBe('60'));

    // 第一页为下标 0–49
    expect(batchRows()).toHaveLength(50);
    expect(batchRows()[0]).toEqual(['0', 'a', 'c', '2']);
    expect(batchRows()[49][0]).toBe('49');

    // 翻到第二页：下标 50–59，计数仍与输入一一对应
    const batchSection = screen.getByText('4. 批量方案筛选').closest('section') as HTMLElement;
    fireEvent.click(within(batchSection).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(batchRows()).toHaveLength(10));
    expect(batchRows()[0]).toEqual(['50', 'a', 'c', '2']);
    expect(batchRows()[9]).toEqual(['59', 'a', 'b', '1']);
    expect(within(batchSection).getByText(/共 60 条/)).toBeTruthy();
  });
});

describe('有序备纤计划复核 UI', () => {
  it('按序显示端点对/首次消除清单/边际/累计/剩余；重复反向交叠包含步骤后续为零', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // a-c 先覆盖 L1,L2；随后反向、重复、包含路径均为 0
    await submitPlan('[{"a":"a","b":"c"},{"a":"c","b":"a"},{"a":"a","b":"c"},{"a":"a","b":"b"},{"a":"b","b":"c"}]');
    await waitFor(() => expect(planStatValue('计划步骤总数')).toBe('5'));
    expect(planStatValue('计划覆盖基线桥')).toBe('2');
    expect(planStatValue('零边际步骤数')).toBe('4');
    expect(planStatValue('计划后仍剩余')).toBe('0');

    const rows = planRows();
    expect(rows).toHaveLength(5);
    // 步骤 0：清单预览含 L1、L2（字节序），边际 2，累计 2，剩余 0
    expect(rows[0][0]).toBe('0');
    expect(rows[0][1]).toBe('a');
    expect(rows[0][2]).toBe('c');
    expect(rows[0][3]).toContain('L1');
    expect(rows[0][3]).toContain('L2');
    expect(rows[0][4]).toBe('2');
    expect(rows[0][5]).toBe('2');
    expect(rows[0][6]).toBe('0');
    // 反向 / 重复 / 包含路径：无（0），边际 0，累计保持 2
    for (const i of [1, 2, 3, 4]) {
      expect(rows[i][3]).toContain('无（0）');
      expect(rows[i][4]).toBe('0');
      expect(rows[i][5]).toBe('2');
      expect(rows[i][6]).toBe('0');
    }

    // 展开/收起本步清单
    fireEvent.click(screen.getByRole('button', { name: '展开清单（2）' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '收起清单' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '收起清单' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '展开清单（2）' })).toBeTruthy());
  });

  it('末项非法按下标整批拒绝并保留上次成功结果；空数组/额外字段/自环同样拒绝', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    await submitPlan('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(planRows()).toHaveLength(1));

    // 末项非法（端点不存在）：按下标报错，上次结果完整保留
    await submitPlan('[{"a":"a","b":"c"},{"a":"a","b":"ghost"}]');
    await waitFor(() => expect(screen.getByText('有序备纤计划被拒绝。')).toBeTruthy());
    expect(screen.getByText(/下标 1/)).toBeTruthy();
    expect(screen.getByText(/不在当前站点清单/)).toBeTruthy();
    expect(planRows()).toHaveLength(1);

    await submitPlan('[]');
    await waitFor(() => expect(screen.getByText(/空数组/)).toBeTruthy());
    expect(planRows()).toHaveLength(1);

    await submitPlan('[{"a":"a","b":"c","x":1}]');
    await waitFor(() => expect(screen.getByText(/额外字段/)).toBeTruthy());
    expect(planRows()).toHaveLength(1);

    await submitPlan('[{"a":"a","b":"a"}]');
    await waitFor(() => expect(screen.getByText(/下标 0.*必须不同/)).toBeTruthy());
    expect(planRows()).toHaveLength(1);

    // 草稿文本与基线、单次试接、批量筛选互不影响
    await submitTrial('a', 'c');
    await waitFor(() => expect(screen.getByText(/已消除 2 条/)).toBeTruthy());
    await submitBatch('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchRows()).toHaveLength(1));
    expect(planRows()).toHaveLength(1);
  });

  it('合法新拓扑清空计划结果；非法导入继续保留', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    await submitPlan('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(planRows()).toHaveLength(1));

    // 合法新拓扑（三角形，无桥）：旧计划结果清空
    await importJson(
      JSON.stringify({
        sites: ['x', 'y', 'z'],
        links: [
          { id: 'r1', u: 'x', v: 'y' },
          { id: 'r2', u: 'y', v: 'z' },
          { id: 'r3', u: 'z', v: 'x' },
        ],
      }),
    );
    await waitFor(() => expect(fragileStatValue()).toBe('0'));
    expect(document.querySelector('.plan-table')).toBeNull();

    // 新拓扑上复核：边际 0、剩余 0
    await submitPlan('[{"a":"x","b":"z"}]');
    await waitFor(() => expect(planRows()).toHaveLength(1));
    expect(planRows()[0][3]).toContain('无（0）');
    expect(planRows()[0][4]).toBe('0');

    // 非法导入：当前拓扑与计划结果继续保留
    await importJson('{坏的');
    await waitFor(() => expect(screen.getByText('导入被拒绝，')).toBeTruthy());
    expect(planRows()).toHaveLength(1);
  });

  it('计划步骤分页显示，且不影响批量筛选结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    const steps = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? { a: 'a', b: 'c' } : { a: 'a', b: 'b' }));
    await submitPlan(JSON.stringify(steps));
    await waitFor(() => expect(planStatValue('计划步骤总数')).toBe('60'));

    expect(planRows()).toHaveLength(50);
    expect(planRows()[0][0]).toBe('0');
    expect(planRows()[0][4]).toBe('2'); // 首步边际 2
    expect(planRows()[49][0]).toBe('49');
    expect(planRows()[49][4]).toBe('0'); // 后续全部已覆盖

    const planSection = screen.getByText('5. 有序备纤计划复核').closest('section') as HTMLElement;
    fireEvent.click(within(planSection).getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(planRows()).toHaveLength(10));
    expect(planRows()[0][0]).toBe('50');
    expect(planRows()[9][0]).toBe('59');
    expect(planRows()[9][5]).toBe('2'); // 累计始终为 2
    expect(planRows()[9][6]).toBe('0');
    expect(within(planSection).getByText(/共 60 条/)).toBeTruthy();

    // 批量筛选区独立存在
    await submitBatch('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchRows()).toHaveLength(1));
    expect(planStatValue('计划步骤总数')).toBe('60');
  });
});

describe('最低总价备纤组合 UI', () => {
  it('求解最优组合并展示所选连线/费用/逐桥消除来源/未覆盖诊断；非法报价保留上次结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // X 全覆盖 10；Y+Z 各 6 合计 12 → 只选 X
    await submitQuote(
      '[{"id":"X","a":"a","b":"c","price":10},{"id":"Y","a":"a","b":"b","price":6},{"id":"Z","a":"b","b":"c","price":6}]',
    );
    await waitFor(() => expect(quoteStat('所选连线数')).toBe('1'));
    expect(quoteStat('候选连线数')).toBe('3');
    expect(quoteStat('基线脆弱链路总数')).toBe('2');
    expect(quoteStat('最低总价')).toBe('10');
    expect(quoteSelectedRows()).toEqual([['1', 'X', 'a', 'c', '10']]);
    expect(quoteCoverageRows()).toEqual([
      ['1', 'L1', 'a – b', 'X'],
      ['2', 'L2', 'b – c', 'X'],
    ]);
    expect(screen.getByText(/未覆盖诊断：全部基线桥均被所选组合覆盖/)).toBeTruthy();

    // 零价：Y 覆盖 L1（0 元）、Z 覆盖 L2（6 元）→ 总价 6，两条都入选
    await submitQuote(
      '[{"id":"X","a":"a","b":"c","price":10},{"id":"Y","a":"a","b":"b","price":0},{"id":"Z","a":"b","b":"c","price":6}]',
    );
    await waitFor(() => expect(quoteStat('最低总价')).toBe('6'));
    expect(quoteStat('所选连线数')).toBe('2');
    expect(quoteSelectedRows()).toEqual([
      ['1', 'Y', 'a', 'b', '0'],
      ['2', 'Z', 'b', 'c', '6'],
    ]);
    expect(quoteCoverageRows()).toEqual([
      ['1', 'L1', 'a – b', 'Y'],
      ['2', 'L2', 'b – c', 'Z'],
    ]);

    // 非法报价（负数）：整批拒绝，上次结果完整保留
    await submitQuote('[{"id":"Bad","a":"a","b":"c","price":-5}]');
    await waitFor(() => expect(screen.getByText('备纤报价被拒绝。')).toBeTruthy());
    expect(screen.getByText(/下标 0/)).toBeTruthy();
    expect(screen.getByText(/不能为负/)).toBeTruthy();
    expect(quoteStat('最低总价')).toBe('6');
    expect(quoteSelectedRows()).toHaveLength(2);

    // 编号重复同样整体拒绝并保留上次结果
    await submitQuote(
      '[{"id":"X","a":"a","b":"b","price":1},{"id":"X","a":"b","b":"c","price":2}]',
    );
    await waitFor(() => expect(screen.getByText(/候选编号重复/)).toBeTruthy());
    expect(quoteSelectedRows()).toHaveLength(2);
  });

  it('无法覆盖时给出具体桥边诊断且不伪造方案；重复覆盖同一桥列出全部来源', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));

    // 只有 Y（a-b，覆盖 L1）：L2 无法覆盖 → 不可行
    await submitQuote('[{"id":"Y","a":"a","b":"b","price":6}]');
    await waitFor(() => expect(screen.getByText(/无法组成全覆盖方案/)).toBeTruthy());
    expect(quoteStat('所选连线数')).toBe('0');
    expect(quoteStat('最低总价')).toBe('0');
    expect(document.querySelector('.quote-selected-table')).toBeNull();
    expect(document.querySelector('.quote-coverage-table')).toBeNull();
    expect(quoteUncoverableRows()).toEqual([['1', 'L2', 'b – c', '1']]);

    // 4 站链 a-b-c-d（L1,L2,L3）：X 覆盖 L1,L2；Y 覆盖 L2,L3 → L2 重复消除
    await importJson(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd'],
        links: [
          { id: 'L1', u: 'a', v: 'b' },
          { id: 'L2', u: 'b', v: 'c' },
          { id: 'L3', u: 'c', v: 'd' },
        ],
      }),
    );
    await waitFor(() => expect(fragileStatValue()).toBe('3'));
    await submitQuote(
      '[{"id":"X","a":"a","b":"c","price":4},{"id":"Y","a":"b","b":"d","price":4}]',
    );
    await waitFor(() => expect(quoteStat('最低总价')).toBe('8'));
    expect(quoteCoverageRows()).toEqual([
      ['1', 'L1', 'a – b', 'X'],
      ['2', 'L2', 'b – c', 'X、Y'],
      ['3', 'L3', 'c – d', 'Y'],
    ]);
  });

  it('合法新拓扑清空组合结果；不连通等非法导入保留；无桥拓扑返回空方案', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    await submitQuote('[{"id":"X","a":"a","b":"c","price":10}]');
    await waitFor(() => expect(quoteStat('所选连线数')).toBe('1'));

    // 不连通导入被拒绝：基线与组合结果均保留
    await importJson(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd'],
        links: [
          { id: 'x', u: 'a', v: 'b' },
          { id: 'y', u: 'c', v: 'd' },
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText(/原图必须连通/)).toBeTruthy());
    expect(fragileStatValue()).toBe('2');
    expect(quoteStat('所选连线数')).toBe('1');

    // 合法新拓扑（三角形，无桥）：旧组合结果清空
    await importJson(
      JSON.stringify({
        sites: ['x', 'y', 'z'],
        links: [
          { id: 'r1', u: 'x', v: 'y' },
          { id: 'r2', u: 'y', v: 'z' },
          { id: 'r3', u: 'z', v: 'x' },
        ],
      }),
    );
    await waitFor(() => expect(fragileStatValue()).toBe('0'));
    expect(document.querySelector('.quote-selected-table')).toBeNull();

    // 无桥拓扑：即使候选带零价也返回空方案，不擅自多选
    await submitQuote('[{"id":"Q","a":"x","b":"z","price":0}]');
    await waitFor(() => expect(screen.getByText(/空方案，无需加装任何备纤/)).toBeTruthy());
    expect(quoteStat('最低总价')).toBe('0');
    expect(quoteStat('所选连线数')).toBe('0');
  });

  it('组合规划不改写基线、单次试接、批量筛选与有序计划结果', async () => {
    render(<App />);
    await importJson(validJson);
    await waitFor(() => expect(fragileStatValue()).toBe('2'));
    await submitTrial('a', 'c');
    await waitFor(() => expect(screen.getByText(/已消除 2 条/)).toBeTruthy());
    await submitBatch('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(batchRows()).toHaveLength(1));
    await submitPlan('[{"a":"a","b":"c"}]');
    await waitFor(() => expect(planRows()).toHaveLength(1));

    await submitQuote('[{"id":"X","a":"a","b":"c","price":10}]');
    await waitFor(() => expect(quoteStat('所选连线数')).toBe('1'));

    // 既有结果原样保留
    expect(fragileStatValue()).toBe('2');
    expect(screen.getByText(/已消除 2 条/)).toBeTruthy();
    expect(batchRows()).toHaveLength(1);
    expect(planRows()).toHaveLength(1);
  });
});
