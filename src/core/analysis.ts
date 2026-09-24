/**
 * 脆弱链路（桥）分析与单条虚拟备纤试接。
 *
 * 算法：
 *  - Tarjan 桥检测（无向图，支持平行链路），显式栈迭代实现，
 *    200k 站点 / 400k 链路规模下不占用 JS 递归调用栈；
 *  - DFS 同时统计子树规模，桥断开后较小侧 = min(子树, n − 子树)；
 *  - 桥构成“桥树”：新增边 (a,b) 恰好覆盖 a↔b 在 DFS 树上路径经过的
 *    全部桥（树路径即桥树路径），其余桥仍脆弱。
 *
 * 时间复杂度 O(V+E)，空间 O(V+E)。邻接表使用紧凑类型化数组，
 * 避免约 80 万条邻接记录的装箱开销。Analyzer 只做一次准备与一次
 * Tarjan；试接在其结果上以独立缓冲派生，绝不改写基线。
 */
import { compareUtf8 } from './utf8';
import { MAX_BATCH_PAIRS, MAX_PLAN_STEPS, MAX_QUOTE_CANDIDATES } from './parse';
import { TopologyError } from './types';
import type {
  BaselineResult,
  BatchPair,
  BatchScreenItem,
  BatchScreenResult,
  BridgeCoverageItem,
  BridgeInfo,
  NormalizedTopology,
  OrderedPlanItem,
  OrderedPlanResult,
  OrderedPlanStep,
  QuoteCandidate,
  QuotePlanResult,
  TrialResult,
} from './types';

interface PreparedGraph {
  n: number;
  siteIndex: Map<string, number>;
  linkIdByIndex: string[];
  links: NormalizedTopology['links'];
  /** 每个顶点两条平行的类型化邻接数组：端点下标 / 链路下标 */
  adjTo: Int32Array[];
  adjEdge: Int32Array[];
  /** DFS 树：父顶点、所用链路下标（根为 -1）、深度 */
  parentVertex: Int32Array;
  parentEdge: Int32Array;
  depth: Int32Array;
}

interface TarjanOutput {
  isBridge: Uint8Array;
  /** 桥 e 在 DFS 树中的子端点（非桥为 -1） */
  bridgeChild: Int32Array;
  subtree: Int32Array;
  /** DFS 发现序：order[disc[v]] = v，保证父顶点先于子顶点出现 */
  order: Int32Array;
}

function prepare(t: NormalizedTopology): PreparedGraph {
  const n = t.sites.length;
  const siteIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) siteIndex.set(t.sites[i], i);

  const m = t.links.length;
  const degree = new Int32Array(n);
  for (const l of t.links) {
    degree[siteIndex.get(l.u)!]++;
    degree[siteIndex.get(l.v)!]++;
  }
  const adjTo: Int32Array[] = new Array(n);
  const adjEdge: Int32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    adjTo[i] = new Int32Array(degree[i]);
    adjEdge[i] = new Int32Array(degree[i]);
  }
  const cursor = new Int32Array(n);
  const linkIdByIndex = new Array<string>(m);
  for (let e = 0; e < m; e++) {
    const l = t.links[e];
    linkIdByIndex[e] = l.id;
    const a = siteIndex.get(l.u)!;
    const b = siteIndex.get(l.v)!;
    adjTo[a][cursor[a]] = b;
    adjEdge[a][cursor[a]] = e;
    cursor[a]++;
    adjTo[b][cursor[b]] = a;
    adjEdge[b][cursor[b]] = e;
    cursor[b]++;
  }

  return {
    n,
    siteIndex,
    linkIdByIndex,
    links: t.links,
    adjTo,
    adjEdge,
    parentVertex: new Int32Array(n),
    parentEdge: new Int32Array(n),
    depth: new Int32Array(n),
  };
}

/** 迭代式 Tarjan。图已由解析层保证连通，仍对多分量做防御性遍历。 */
function tarjanBridges(g: PreparedGraph, m: number): TarjanOutput {
  const { n, adjTo, adjEdge, parentVertex, parentEdge, depth } = g;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const subtree = new Int32Array(n).fill(1);
  const isBridge = new Uint8Array(m);
  const bridgeChild = new Int32Array(m).fill(-1);
  const order = new Int32Array(n);
  const nextCursor = new Int32Array(n); // 每个顶点下一条待考察邻接边
  const stack = new Int32Array(n);

  let timer = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1) continue;
    disc[root] = low[root] = timer++;
    order[disc[root]] = root;
    parentVertex[root] = -1;
    parentEdge[root] = -1;
    depth[root] = 0;
    let top = 0;
    stack[top++] = root;

    while (top > 0) {
      const v = stack[top - 1];
      if (nextCursor[v] < adjTo[v].length) {
        const k = nextCursor[v]++;
        const w = adjTo[v][k];
        const eid = adjEdge[v][k];
        // 仅跳过“通向父顶点的同一条树边”；平行边不跳过，
        // 这正是两条平行链路都不成为桥的原因。
        if (eid === parentEdge[v]) continue;
        if (disc[w] === -1) {
          parentVertex[w] = v;
          parentEdge[w] = eid;
          depth[w] = depth[v] + 1;
          disc[w] = low[w] = timer++;
          order[disc[w]] = w;
          stack[top++] = w;
        } else if (disc[w] < low[v]) {
          // 回边（含通向祖先的平行边）降低 low 值
          low[v] = disc[w];
        }
      } else {
        // v 全部邻接考察完毕，收尾：传播 low 与子树规模并判桥
        top--;
        const p = parentVertex[v];
        if (p !== -1) {
          if (low[v] < low[p]) low[p] = low[v];
          subtree[p] += subtree[v];
          if (low[v] > disc[p]) {
            const eid = parentEdge[v];
            isBridge[eid] = 1;
            bridgeChild[eid] = v;
          }
        }
      }
    }
  }
  return { isBridge, bridgeChild, subtree, order };
}

/**
 * 只读批量索引：基于 Tarjan 父树与桥标记构建的桥前缀 + 二进制提升表。
 * 构造一次后仅被读取，批量筛选与单次试接共享，绝不改写基线数据。
 */
interface LcaIndex {
  /** DFS 树深度（根为 0），与 PreparedGraph.depth 共享同一缓冲 */
  depth: Int32Array;
  /** 桥前缀：根到 v 的树路径上的桥数量 */
  bridgePrefix: Int32Array;
  /** 扁平二进制提升表：up[k * n + v] 为 v 的第 2^k 个祖先（根的祖先为其自身） */
  up: Int32Array;
  levels: number;
  /** 全部桥的链路下标，按链路编号 UTF-8 字节序排列（基线与有序计划共享同一份次序） */
  sortedBridgeEdges: Int32Array;
  /** bridgeRank[e]：桥链路下标 e 在 UTF-8 字节序中的名次（非桥为 -1），供有序计划清单排序 */
  bridgeRank: Int32Array;
}

/** 构建只读 LCA 索引：O(n log n)，全程迭代 */
function buildLcaIndex(g: PreparedGraph, tj: TarjanOutput): LcaIndex {
  const { n, parentVertex, parentEdge, depth } = g;
  const { isBridge, order } = tj;

  // 桥前缀：按 DFS 发现序（父先于子）累加“父边是否为桥”
  const bridgePrefix = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = order[i];
    const p = parentVertex[v];
    if (p !== -1) {
      bridgePrefix[v] = bridgePrefix[p] + isBridge[parentEdge[v]];
    }
  }

  // 二进制提升：up[0][v] = 父顶点（根指向自身），up[k][v] = up[k-1][up[k-1][v]]
  const levels = Math.max(1, 32 - Math.clz32(n));
  const up = new Int32Array(levels * n);
  for (let v = 0; v < n; v++) {
    const p = parentVertex[v];
    up[v] = p === -1 ? v : p;
  }
  for (let k = 1; k < levels; k++) {
    const prev = (k - 1) * n;
    const cur = k * n;
    for (let v = 0; v < n; v++) {
      up[cur + v] = up[prev + up[prev + v]];
    }
  }

  // 桥的字节序名次：收集桥链路下标后按编号排序，名次表供有序计划
  // 各步清单以“按下标计数排序”代替逐次字符串比较排序
  const m = g.linkIdByIndex.length;
  const bridgeEdges: number[] = [];
  for (let e = 0; e < m; e++) if (isBridge[e]) bridgeEdges.push(e);
  bridgeEdges.sort((x, y) => compareUtf8(g.linkIdByIndex[x], g.linkIdByIndex[y]));
  const sortedBridgeEdges = Int32Array.from(bridgeEdges);
  const bridgeRank = new Int32Array(m).fill(-1);
  for (let r = 0; r < bridgeEdges.length; r++) bridgeRank[bridgeEdges[r]] = r;

  return { depth, bridgePrefix, up, levels, sortedBridgeEdges, bridgeRank };
}

/** 迭代式最近公共祖先（二进制提升），不占用递归调用栈 */
function lcaOf(idx: LcaIndex, u0: number, v0: number): number {
  const { depth, up, levels } = idx;
  const n = depth.length;
  let u = u0;
  let v = v0;
  if (depth[u] < depth[v]) {
    const t = u;
    u = v;
    v = t;
  }
  // 将较深一端提升到同深
  let diff = depth[u] - depth[v];
  let k = 0;
  while (diff !== 0) {
    if ((diff & 1) !== 0) u = up[k * n + u];
    diff >>>= 1;
    k++;
  }
  if (u === v) return u;
  // 自高向低同步提升，直到二者父顶点相同
  for (let j = levels - 1; j >= 0; j--) {
    const uu = up[j * n + u];
    const vv = up[j * n + v];
    if (uu !== vv) {
      u = uu;
      v = vv;
    }
  }
  return up[u];
}

/** 一次导入对应的完整分析器；基线结果在构造时固定，试接不可改写它。 */
export class Analyzer {
  private readonly g: PreparedGraph;
  private readonly tj: TarjanOutput;
  /** 只读批量索引（桥前缀 + 二进制提升表），构造时一次建成 */
  private readonly lca: LcaIndex;
  readonly baseline: BaselineResult;

  constructor(private readonly t: NormalizedTopology) {
    this.g = prepare(t);
    this.tj = tarjanBridges(this.g, t.links.length);
    this.lca = buildLcaIndex(this.g, this.tj);
    this.baseline = this.buildBaseline();
  }

  private buildBaseline(): BaselineResult {
    const { bridgeChild, subtree } = this.tj;
    const { sortedBridgeEdges } = this.lca;
    const bridges: BridgeInfo[] = new Array(sortedBridgeEdges.length);
    for (let r = 0; r < sortedBridgeEdges.length; r++) {
      const e = sortedBridgeEdges[r];
      const link = this.t.links[e];
      const side = subtree[bridgeChild[e]];
      bridges[r] = { id: link.id, u: link.u, v: link.v, smallerSide: Math.min(side, this.g.n - side) };
    }
    return { siteCount: this.g.n, linkCount: this.t.links.length, bridges };
  }

  /**
   * 试接一条虚拟备纤 (a,b)。返回新的 TrialResult，不修改基线。
   * 端点非法抛 TopologyError，由调用方保留上次试接结果并提示。
   */
  trial(rawA: unknown, rawB: unknown): TrialResult {
    const a = normalizeEndpoint(rawA, '端点 A');
    const b = normalizeEndpoint(rawB, '端点 B');
    if (a === b) {
      throw new TopologyError(`试接失败：两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
    }
    const ia = this.g.siteIndex.get(a);
    const ib = this.g.siteIndex.get(b);
    if (ia === undefined || ib === undefined) {
      const missing = ia === undefined ? a : b;
      throw new TopologyError(`试接失败：端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
    }

    const { parentEdge, parentVertex, depth } = this.g;
    const { isBridge } = this.tj;
    // onPath 为本次试接独立缓冲，绝不触碰基线数据
    const onPath = new Uint8Array(this.t.links.length);
    let x = ia;
    let y = ib;
    const mark = (v: number): void => {
      const e = parentEdge[v];
      if (e !== -1) onPath[e] = 1;
    };
    while (depth[x] > depth[y]) {
      mark(x);
      x = parentVertex[x];
    }
    while (depth[y] > depth[x]) {
      mark(y);
      y = parentVertex[y];
    }
    while (x !== y) {
      mark(x);
      x = parentVertex[x];
      mark(y);
      y = parentVertex[y];
    }

    const removedIds = new Set<string>();
    for (let e = 0; e < this.t.links.length; e++) {
      if (isBridge[e] && onPath[e]) removedIds.add(this.g.linkIdByIndex[e]);
    }

    const stillFragile: BridgeInfo[] = [];
    const removed: BridgeInfo[] = [];
    for (const info of this.baseline.bridges) {
      (removedIds.has(info.id) ? removed : stillFragile).push(info);
    }
    stillFragile.sort((p, q) => compareUtf8(p.id, q.id));
    removed.sort((p, q) => compareUtf8(p.id, q.id));

    return { a, b, stillFragile, removed, baselineCount: this.baseline.bridges.length };
  }

  /**
   * 批量方案筛选：对整批端点对给出各自可消除的基线桥数量（不展开链路清单）。
   *
   * 全批校验（端点存在且互异）全部通过后才开始计数，任一非法即按下标
   * 抛出 TopologyError、不产生任何部分结果；成功时一次性返回整体结果。
   * 每项计数 = bridgePrefix[u] + bridgePrefix[v] − 2·bridgePrefix[lca(u,v)]，
   * 即试接 (u,v) 在桥树路径上覆盖的桥数，与 trial(u,v).removed.length 一致。
   * 全程只读共享 LCA 索引：不循环调用 trial、不为单项分配链路长度缓冲、
   * 不扫描全部链路，每项 O(log n)。
   */
  screenBatch(pairs: BatchPair[]): BatchScreenResult {
    const count = pairs.length;
    if (count === 0) {
      throw new TopologyError('批量方案不能为空：至少包含 1 项端点对');
    }
    if (count > MAX_BATCH_PAIRS) {
      throw new TopologyError(`批量方案项数超过上限 ${MAX_BATCH_PAIRS}，当前为 ${count}`);
    }

    // 第一遍：全批校验并解析端点下标；任何一项非法都按下标报错
    const va = new Int32Array(count);
    const vb = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const { a, b } = pairs[i];
      if (a === b) {
        throw new TopologyError(`批量方案下标 ${i}：两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
      }
      const ia = this.g.siteIndex.get(a);
      const ib = this.g.siteIndex.get(b);
      if (ia === undefined || ib === undefined) {
        const missing = ia === undefined ? a : b;
        throw new TopologyError(`批量方案下标 ${i}：端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
      }
      va[i] = ia;
      vb[i] = ib;
    }

    // 第二遍：校验全部通过后，基于只读索引批量计数（重复候选按原序保留）
    const { bridgePrefix } = this.lca;
    const items: BatchScreenItem[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const u = va[i];
      const v = vb[i];
      const w = lcaOf(this.lca, u, v);
      items[i] = {
        index: i,
        a: pairs[i].a,
        b: pairs[i].b,
        removedCount: bridgePrefix[u] + bridgePrefix[v] - 2 * bridgePrefix[w],
      };
    }
    return { items, baselineCount: this.baseline.bridges.length };
  }

  /**
   * 有序备纤计划复核：按计划顺序逐步“试接”，同一基线桥只归最早覆盖它的步骤。
   *
   * 全批校验（端点存在且互异）全部通过后才开始计算；任一步非法即按下标
   * 抛出 TopologyError、不产生任何部分结果，也不改写基线、单次试接与批量筛选。
   *
   * 计算复用现有 DFS 父树与 LCA 索引，并维护一棵“向父级跳转”的并查集 dsu[v]：
   *  - dsu[v] === v：父边 parentEdge[v] 是尚未归属的桥；
   *  - 否则 dsu[v] 指向一个更高的祖先（父边为非桥，或桥已归更早步骤，或 v 为根）。
   * 每步从路径两端分别向 LCA 跳转：find 命中自属顶点即把该桥首次归本步，
   * 随后把 dsu[v] 压缩到父级（以后各步直接越过）；非桥树边在初始化时预先跳过。
   * 既不逐步调用 trial，也不逐路径扫描全部链路。路径天然在 LCA 处停止，
   * 不会越过 LCA 收集到计划外的桥。
   *
   * 计算全部完成后才一次性组装 OrderedPlanResult（原子替换由 UI 层负责），
   * 各步清单互斥且并集恰为计划覆盖的基线桥。
   */
  reviewOrderedPlan(steps: OrderedPlanStep[]): OrderedPlanResult {
    const count = steps.length;
    if (count === 0) {
      throw new TopologyError('有序备纤计划不能为空：至少包含 1 个步骤');
    }
    if (count > MAX_PLAN_STEPS) {
      throw new TopologyError(`有序备纤计划步数超过上限 ${MAX_PLAN_STEPS}，当前为 ${count}`);
    }

    const { n, parentVertex, parentEdge, depth } = this.g;
    const { bridgeRank } = this.lca;
    const { isBridge } = this.tj;

    // 第一遍：全批校验并解析端点下标；任一步非法都按下标报错，不产生部分结果
    const va = new Int32Array(count);
    const vb = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const { a, b } = steps[i];
      if (a === b) {
        throw new TopologyError(`有序备纤计划下标 ${i}：两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
      }
      const ia = this.g.siteIndex.get(a);
      const ib = this.g.siteIndex.get(b);
      if (ia === undefined || ib === undefined) {
        const missing = ia === undefined ? a : b;
        throw new TopologyError(`有序备纤计划下标 ${i}：端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
      }
      va[i] = ia;
      vb[i] = ib;
    }

    // 第二遍：校验全部通过后，初始化“向父级跳转”的并查集。
    // 根指向自身；非桥树边的子顶点预先指向父顶点（find 时直接越过）；
    // 桥的子顶点自属，等待首次归属。
    const dsu = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      const p = parentVertex[v];
      dsu[v] = p === -1 || isBridge[parentEdge[v]] ? v : p;
    }

    // claimedEdges[i] 为本步首次归属的桥链路下标（已按字节序名次排好）
    const claimed: number[][] = new Array(count);
    const marginal = new Int32Array(count);
    let covered = 0;

    // 迭代式 find（带路径压缩）就地内联在两处爬升循环中，避免闭包调用开销
    for (let i = 0; i < count; i++) {
      const w = lcaOf(this.lca, va[i], vb[i]);
      const list: number[] = [];

      // 从一端向 LCA 跳转：find 落在 LCA 之下才处理其自属（尚未归属的）父边桥
      let x = va[i];
      while (depth[x] > depth[w]) {
        // find(x)：先上溯到自属根，再原路压缩
        let root = x;
        while (dsu[root] !== root) root = dsu[root];
        while (dsu[x] !== x) {
          const next = dsu[x];
          dsu[x] = root;
          x = next;
        }
        x = root;
        if (depth[x] <= depth[w]) break;
        list.push(parentEdge[x]); // find 自属 ⇒ 父边必为尚未归属的桥
        const px = parentVertex[x];
        dsu[x] = px; // 首次归属后压缩到父级，后续步骤直接越过
        x = px;
      }
      // 另一端同样处理（LCA 自身的父边不在 a↔b 路径上，depth 判定天然排除）
      let y = vb[i];
      while (depth[y] > depth[w]) {
        let root = y;
        while (dsu[root] !== root) root = dsu[root];
        while (dsu[y] !== y) {
          const next = dsu[y];
          dsu[y] = root;
          y = next;
        }
        y = root;
        if (depth[y] <= depth[w]) break;
        list.push(parentEdge[y]);
        const py = parentVertex[y];
        dsu[y] = py;
        y = py;
      }

      list.sort((p, q) => bridgeRank[p] - bridgeRank[q]);
      claimed[i] = list;
      marginal[i] = list.length;
      covered += list.length;
    }

    // 第三遍：全部计算完成后一次性组装结果（成功路径才走到这里，保证“原子替换”）
    const baseline = this.baseline.bridges;
    const items: OrderedPlanItem[] = new Array(count);
    let cumulative = 0;
    for (let i = 0; i < count; i++) {
      const edges = claimed[i];
      const firstRemoved: BridgeInfo[] = new Array(edges.length);
      for (let k = 0; k < edges.length; k++) {
        // baseline 已按字节序排列；bridgeRank 与之同序，可直接索引
        firstRemoved[k] = baseline[bridgeRank[edges[k]]];
      }
      cumulative += marginal[i];
      items[i] = {
        index: i,
        a: steps[i].a,
        b: steps[i].b,
        firstRemoved,
        marginal: marginal[i],
        cumulative,
        remaining: baseline.length - cumulative,
      };
    }
    return { items, baselineCount: baseline.length, coveredCount: covered };
  }

  /**
   * 单条候选连线覆盖的树路径计算（与单次试接同一条 DFS 树路径）：
   * 从两端点分别向 LCA 爬升，对路径上的每条树边，若为桥即以其基线名次回调。
   * 复用现有 Tarjan 父树、桥标记与只读 LCA 索引；只读，不改写任何基线数据。
   */
  private visitPathBridges(ia: number, ib: number, visit: (bridgeRank: number) => void): void {
    const { parentVertex, parentEdge } = this.g;
    const { isBridge } = this.tj;
    const { bridgeRank } = this.lca;
    const w = lcaOf(this.lca, ia, ib);
    let x = ia;
    while (x !== w) {
      const e = parentEdge[x];
      if (isBridge[e]) visit(bridgeRank[e]);
      x = parentVertex[x];
    }
    let y = ib;
    while (y !== w) {
      const e = parentEdge[y];
      if (isBridge[e]) visit(bridgeRank[e]);
      y = parentVertex[y];
    }
  }

  /**
   * 最低总价备纤组合（精确求解，至多 16 条候选）。
   *
   * 全批校验（端点存在且互异、整批报价合计仍为安全整数）全部通过后才开始
   * 求解；任一非法按下标抛出 TopologyError、不产生部分结果，也不改写基线、
   * 单次试接、批量筛选与有序计划复核。
   *
   * 求解思路（候选位掩码，n ≤ 16）：
   *  - 每条候选经复用的树路径计算覆盖哪些基线桥；反过来给每座桥记一个
   *    n 位掩码 mask[b]——能消除它的候选集合；
   *  - mask[b] === 0 的桥任何候选都消除不了：直接给出无法覆盖诊断，
   *    feasible=false，绝不伪造一个“成功方案”；
   *  - 否则 S 覆盖全部桥 ⟺ 对每座桥 S ∩ mask[b] ≠ ∅ ⟺ 补集 ~S 不含任何
   *    现存掩码为子集；对“现存掩码 → 其子集闭包”做一次 SOS 子集和 DP
   *    （O(n·2ⁿ)）即可在 O(1) 内判定任意 S 是否可行；
   *  - 枚举全部 2ⁿ 个子集，按三层裁决取唯一最优：**总价 → 条数 →
   *    编号序列**（候选编号 UTF-8 字节序）。第三层等价于“按编号次序
   *    扫描到首个归属差异处，包含该候选的子集序列字典序更小”。
   *
   * 非负报价下，删去任何候选都不会让总价上升；同价又比条数，因此
   * 零价但不增加覆盖的无用候选永远不会被最优组合捎带。
   */
  planQuotes(candidates: QuoteCandidate[]): QuotePlanResult {
    const count = candidates.length;
    if (count === 0) {
      throw new TopologyError('备纤报价不能为空：至少包含 1 条候选连线');
    }
    if (count > MAX_QUOTE_CANDIDATES) {
      throw new TopologyError(`备纤报价候选数超过上限 ${MAX_QUOTE_CANDIDATES}，当前为 ${count}`);
    }

    // 第一遍：全批校验并解析端点下标；任一条非法都按下标报错，不产生部分结果
    const va = new Int32Array(count);
    const vb = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const { a, b } = candidates[i];
      if (a === b) {
        throw new TopologyError(`备纤报价下标 ${i}：两个端点必须不同（均为 ${JSON.stringify(a)}），不得构成自环`);
      }
      const ia = this.g.siteIndex.get(a);
      const ib = this.g.siteIndex.get(b);
      if (ia === undefined || ib === undefined) {
        const missing = ia === undefined ? a : b;
        throw new TopologyError(`备纤报价下标 ${i}：端点 ${JSON.stringify(missing)} 不在当前站点清单中`);
      }
      va[i] = ia;
      vb[i] = ib;
    }
    // 防御性复核（解析层已先校验一次）：确保任何子集合计都精确可比
    let totalGuard = 0;
    for (let i = 0; i < count; i++) {
      const p = candidates[i].price;
      if (p > Number.MAX_SAFE_INTEGER - totalGuard) {
        throw new TopologyError(
          `备纤报价整批拒绝：${i + 1} 条候选报价合计超出安全整数范围（Number.MAX_SAFE_INTEGER），无法精确比较总价`,
        );
      }
      totalGuard += p;
    }

    const baseline = this.baseline.bridges;
    const B = baseline.length;

    // 无桥：空方案——无需加装任何备纤（不产生费用，也不因零价多选）
    if (B === 0) {
      return {
        feasible: true,
        selected: [],
        totalPrice: 0,
        coverage: [],
        uncoverable: [],
        baselineCount: 0,
        candidateCount: count,
      };
    }

    // 第二遍：maskOf[r] = 能消除第 r 名基线桥（字节序名次）的候选位掩码
    const maskOf = new Uint16Array(B);
    for (let i = 0; i < count; i++) {
      const bit = 1 << i;
      this.visitPathBridges(va[i], vb[i], (rank) => {
        maskOf[rank] |= bit;
      });
    }

    // 无法覆盖诊断：任何候选都覆盖不到的桥（基线按字节序，输出天然有序）
    const uncoverable: BridgeInfo[] = [];
    for (let r = 0; r < B; r++) {
      if (maskOf[r] === 0) uncoverable.push(baseline[r]);
    }
    if (uncoverable.length > 0) {
      return {
        feasible: false,
        selected: [],
        totalPrice: 0,
        coverage: [],
        uncoverable,
        baselineCount: B,
        candidateCount: count,
      };
    }

    // 第三遍：精确子集枚举。
    // present[m]：存在某座桥，恰好只有掩码 m 内的候选能消除它。
    // 经 SOS“子集或”传播后 bad[T] 为真 ⟺ 存在现存掩码 m ⊆ T；
    // 于是 S 不可行（漏桥）⟺ 存在 m 与 S 不交 ⟺ m ⊆ ~S ⟺ bad[FULL ^ S]。
    const size = 1 << count;
    const full = size - 1;
    const bad = new Uint8Array(size);
    for (let r = 0; r < B; r++) bad[maskOf[r]] = 1;
    for (let bit = 1, k = 0; k < count; bit <<= 1, k++) {
      for (let s = 0; s < size; s++) {
        if ((s & bit) !== 0 && bad[s ^ bit] !== 0) bad[s] = 1;
      }
    }

    // 子集报价合计与条数按最低位递推；合计始终是安全整数（整批已校验）
    const priceSum = new Float64Array(size);
    const popcount = new Uint8Array(size);
    for (let s = 1; s < size; s++) {
      const lsb = s & -s;
      const i = 31 - Math.clz32(lsb);
      priceSum[s] = priceSum[s ^ lsb] + candidates[i].price;
      popcount[s] = popcount[s ^ lsb] + 1;
    }

    // 候选按编号 UTF-8 字节序排列的输入下标次序（第三层裁决用）
    const order: number[] = Array.from({ length: count }, (_, i) => i);
    order.sort((x, y) => compareUtf8(candidates[x].id, candidates[y].id));

    // 三层裁决：总价低 → 条数少 → 编号序列字典序小。
    // 序列比较：按编号次序找首个归属差异，包含该候选者的有序序列更小。
    const better = (s: number, t: number): boolean => {
      if (priceSum[s] !== priceSum[t]) return priceSum[s] < priceSum[t];
      if (popcount[s] !== popcount[t]) return popcount[s] < popcount[t];
      for (const i of order) {
        const inS = (s >>> i) & 1;
        const inT = (t >>> i) & 1;
        if (inS !== inT) return inS === 1;
      }
      return false;
    };

    let best = -1;
    for (let s = 0; s < size; s++) {
      if (bad[full ^ s]) continue; // 至少一座桥未被该子集覆盖
      if (best === -1 || better(s, best)) best = s;
    }

    // 第四遍：全部计算完成后一次性组装结果（成功路径才走到这里，保证“原子替换”）。
    // 所选候选按编号字节序输出；每座桥的消除来源只保留“被选中”的候选，
    // 同一桥可由多条所选候选重复消除，均按候选编号字节序列出。
    const selected: QuoteCandidate[] = [];
    for (const i of order) {
      if ((best >>> i) & 1) selected.push(candidates[i]);
    }
    const coverage: BridgeCoverageItem[] = new Array(B);
    for (let r = 0; r < B; r++) {
      const m = maskOf[r] & best;
      const coveredBy: string[] = [];
      for (const i of order) {
        if ((m >>> i) & 1) coveredBy.push(candidates[i].id);
      }
      coverage[r] = { bridge: baseline[r], coveredBy };
    }

    return {
      feasible: true,
      selected,
      totalPrice: priceSum[best],
      coverage,
      uncoverable: [],
      baselineCount: B,
      candidateCount: count,
    };
  }
}

/**
 * 试接端点编号规范化：字符串**逐字符原样保留**（首尾空白是站点编号的合法
 * 组成部分，绝不删除——"A"、" A "、"A "是三个不同站点，自动补全选中的
 * 编号也必须原样到达此处），仅空字符串被拒绝；安全整数按其十进制文本承载。
 * 端点存在性随后在 siteIndex 中精确匹配，绝不静默改写到相似编号。
 */
function normalizeEndpoint(value: unknown, label: string): string {
  if (typeof value === 'string') {
    if (value.length === 0) throw new TopologyError(`试接失败：${label}不能为空字符串`);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return String(value);
  }
  throw new TopologyError(`试接失败：${label}必须是已存在的站点编号`);
}
