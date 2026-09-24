/** 内置示例拓扑（仅用于快速体验，分析结果全部实时计算，不做任何固定） */
import type { NormalizedTopology } from '../core/types';

export function sampleTopology(): NormalizedTopology {
  // 环 a-b-c-a ＋ 链 c-d-e-f（cd/de/ef 为桥）＋ a-b 平行链路
  return {
    sites: ['a', 'b', 'c', 'd', 'e', 'f'],
    links: [
      { id: 'L-01', u: 'a', v: 'b' },
      { id: 'L-02', u: 'b', v: 'c' },
      { id: 'L-03', u: 'c', v: 'a' },
      { id: 'L-04', u: 'a', v: 'b' },
      { id: 'L-05', u: 'c', v: 'd' },
      { id: 'L-06', u: 'd', v: 'e' },
      { id: 'L-07', u: 'e', v: 'f' },
    ],
  };
}
