import { useEffect, useMemo, useState } from 'react';
import type { BridgeInfo } from '../core/types';

const PAGE_SIZE = 50;

export interface PageState {
  index: number;
  start: number;
  end: number;
  pageCount: number;
  setIndex: (i: number) => void;
}

/** 分页游标；total 变化时自动收敛到合法页（新结果/新拓扑下回到首页） */
export function usePagination(total: number, key = 'default'): PageState {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    // key 区分同组件内多张表；total 变化即重置
  }, [total, key]);
  const clamped = Math.min(index, pageCount - 1);
  const start = clamped * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  return { index: clamped, start, end, pageCount, setIndex };
}

export function Pagination({ page, total }: { page: PageState; total: number }) {
  const pages = useMemo(() => {
    if (page.pageCount <= 7) return Array.from({ length: page.pageCount }, (_, i) => i);
    const cur = page.index;
    const set = new Set<number>([0, page.pageCount - 1, cur - 1, cur, cur + 1]);
    return [...set].filter((i) => i >= 0 && i < page.pageCount).sort((x, y) => x - y);
  }, [page.index, page.pageCount]);

  if (total <= PAGE_SIZE) return null;

  return (
    <div className="pagination">
      <button onClick={() => page.setIndex(0)} disabled={page.index === 0}>
        «
      </button>
      <button onClick={() => page.setIndex(page.index - 1)} disabled={page.index === 0}>
        上一页
      </button>
      {pages.map((p, i) => {
        const prev = pages[i - 1];
        const gap = i > 0 && p - prev > 1;
        return (
          <span key={p} className="page-group">
            {gap && <span className="ellipsis">…</span>}
            <button className={p === page.index ? 'active' : ''} onClick={() => page.setIndex(p)}>
              {p + 1}
            </button>
          </span>
        );
      })}
      <button onClick={() => page.setIndex(page.index + 1)} disabled={page.index >= page.pageCount - 1}>
        下一页
      </button>
      <button onClick={() => page.setIndex(page.pageCount - 1)} disabled={page.index >= page.pageCount - 1}>
        »
      </button>
      <span className="page-info">
        第 {page.start + 1}–{page.end} 条 / 共 {total.toLocaleString('zh-CN')} 条
      </span>
    </div>
  );
}

export function BridgeTable({
  rows,
  offset = 0,
  showSmallerSide = false,
}: {
  rows: BridgeInfo[];
  offset?: number;
  showSmallerSide?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="bridge-table">
        <thead>
          <tr>
            <th className="col-rank">#</th>
            <th>链路编号（UTF-8 字节序）</th>
            <th className="col-endpoint">端点</th>
            {showSmallerSide && <th className="col-side">断开后较小侧站点数</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => (
            <tr key={b.id}>
              <td className="muted">{offset + i + 1}</td>
              <td className="mono">{b.id}</td>
              <td className="muted">
                {b.u} <span className="dash">–</span> {b.v}
              </td>
              {showSmallerSide && <td className="num strong">{b.smallerSide.toLocaleString('zh-CN')}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
