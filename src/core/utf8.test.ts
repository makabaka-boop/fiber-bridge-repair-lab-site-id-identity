import { describe, expect, it } from 'vitest';
import { TextEncoder } from 'util';
import { compareUtf8 } from './utf8';

/**
 * 差分核对：JavaScript 字符串比较（生产实现）必须与真正的 UTF-8
 * 字节序（TextEncoder + 逐字节比较）一致，覆盖多字节与代理对。
 */
describe('compareUtf8 与真实 UTF-8 字节序一致', () => {
  const enc = new TextEncoder();
  const byteCompare = (a: string, b: string): number => {
    const x = enc.encode(a);
    const y = enc.encode(b);
    const len = Math.min(x.length, y.length);
    for (let i = 0; i < len; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  };

  const samples = [
    'L1', 'L2', 'L10', '链路-α', '链路-β', 'a', 'A', '0', '9', '中', '串',
    '😀', '🅰️', 'é', 'é', 'L-001', 'L-010', '站点1', '站点２', '',
  ];

  it('全对偶比较一致', () => {
    for (const a of samples) {
      for (const b of samples) {
        if (a === '' || b === '') continue;
        expect(Math.sign(compareUtf8(a, b))).toBe(Math.sign(byteCompare(a, b)));
      }
    }
  });

  it('随机 Unicode 字符串批量一致', () => {
    let seed = 123456789;
    const rand = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const pool = [0x41, 0x7a, 0x30, 0x4e2d, 0x6587, 0x1f600, 0xe9, 0x3b1, 0x2014];
    const make = (): string => {
      const len = 1 + Math.floor(rand() * 5);
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCodePoint(pool[Math.floor(rand() * pool.length)]);
      return s;
    };
    for (let i = 0; i < 2000; i++) {
      const a = make();
      const b = make();
      expect(Math.sign(compareUtf8(a, b))).toBe(Math.sign(byteCompare(a, b)));
    }
  });

  it('数字编号按 UTF-8 字节序（非数值大小）：L10 在 L2 之前', () => {
    expect(['L10', 'L2', 'L1'].sort(compareUtf8)).toEqual(['L1', 'L10', 'L2']);
  });
});
