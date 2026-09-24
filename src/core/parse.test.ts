import { describe, expect, it } from 'vitest';
import { parseTopology, MAX_SITES, MAX_LINKS } from './parse';
import type { NormalizedTopology } from './types';

const json = (sites: unknown[], links: unknown[]) =>
  JSON.stringify({ sites, links });

describe('parseTopology 输入契约', () => {
  it('接受最小合法拓扑（2 站点 1 链路）', () => {
    const t = parseTopology(json(['s1', 's2'], [{ id: 'l1', u: 's1', v: 's2' }]));
    expect(t.sites).toEqual(['s1', 's2']);
    expect(t.links).toHaveLength(1);
  });

  it('接受数字编号并规范化为字符串', () => {
    const t = parseTopology(json([1, 2], [{ id: 10, u: 1, v: 2 }]));
    expect(t.links[0]).toEqual({ id: '10', u: '1', v: '2' });
  });

  it('接受平行链路', () => {
    const t = parseTopology(
      json(['a', 'b'], [
        { id: 'p1', u: 'a', v: 'b' },
        { id: 'p2', u: 'b', v: 'a' },
      ]),
    );
    expect(t.links).toHaveLength(2);
  });

  it('拒绝非法 JSON 语法', () => {
    expect(() => parseTopology('{sites:')).toThrow(/JSON 语法错误/);
  });

  it('拒绝站点数不足 2', () => {
    expect(() => parseTopology(json(['only'], []))).toThrow(/至少为 2/);
  });

  it('拒绝空站点编号与重复站点', () => {
    expect(() => parseTopology(json(['a', ''], [{ id: 'l', u: 'a', v: '' }]))).toThrow(/为空/);
    expect(() => parseTopology(json(['a', 'a'], []))).toThrow(/重复/);
  });

  it('拒绝重复链路编号', () => {
    expect(() =>
      parseTopology(
        json(['a', 'b', 'c'], [
          { id: 'x', u: 'a', v: 'b' },
          { id: 'x', u: 'b', v: 'c' },
        ]),
      ),
    ).toThrow(/链路编号重复/);
  });

  it('拒绝不存在的端点', () => {
    expect(() => parseTopology(json(['a', 'b'], [{ id: 'l', u: 'a', v: 'zzz' }]))).toThrow(/不在站点清单/);
  });

  it('拒绝自环', () => {
    expect(() => parseTopology(json(['a', 'b'], [{ id: 'l', u: 'a', v: 'a' }]))).toThrow(/自环/);
  });

  it('拒绝非连通图', () => {
    expect(() =>
      parseTopology(
        json(['a', 'b', 'c', 'd'], [
          { id: 'l1', u: 'a', v: 'b' },
          { id: 'l2', u: 'c', v: 'd' },
        ]),
      ),
    ).toThrow(/必须连通/);
  });

  it('拒绝布尔/null/对象类型的编号', () => {
    expect(() => parseTopology(json(['a', true], []))).toThrow(/字符串或整数/);
    expect(() => parseTopology(json(['a', null], []))).toThrow(/字符串或整数/);
  });

  it('拒绝超过上限', () => {
    const sites: string[] = [];
    for (let i = 0; i <= MAX_SITES; i++) sites.push(`s${i}`);
    expect(() => parseTopology(JSON.stringify({ sites, links: [] }))).toThrow(/超过上限/);
    void MAX_LINKS;
  });

  it('链路可用 id 字符串含任意非空 UTF-8 文本', () => {
    const t: NormalizedTopology = parseTopology(
      json(['站-甲', '站-乙'], [{ id: '光纤/环-01', u: '站-甲', v: '站-乙' }]),
    );
    expect(t.links[0].id).toBe('光纤/环-01');
  });
});
