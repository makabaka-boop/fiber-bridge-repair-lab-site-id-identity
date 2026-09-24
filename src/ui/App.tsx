import { useCallback, useMemo, useRef, useState } from 'react';
import { Analyzer } from '../core/analysis';
import { parseBatchPlans, parseOrderedPlan, parseQuotePlans, parseTopology } from '../core/parse';
import { TopologyError } from '../core/types';
import type {
  BaselineResult,
  BatchScreenResult,
  NormalizedTopology,
  OrderedPlanResult,
  QuotePlanResult,
  TrialResult,
} from '../core/types';
import { sampleTopology } from './sample';
import { BridgeTable, Pagination, usePagination } from './BridgeTable';

interface ValidState {
  topology: NormalizedTopology;
  analyzer: Analyzer;
  baseline: BaselineResult;
  importedAt: string;
}

interface TrialState {
  /** 上次成功试接结果；非法试接时保留不变 */
  result: TrialResult | null;
  error: string | null;
  /** 最近一次输入，便于非法时保留表单与上次结果 */
  a: string;
  b: string;
}

interface BatchState {
  /** 上次成功批量筛选结果；非法批量导入时保留不变 */
  result: BatchScreenResult | null;
  error: string | null;
}

interface PlanState {
  /** 上次成功的有序备纤计划复核结果；非法导入时保留不变（草稿文本由输入区自管） */
  result: OrderedPlanResult | null;
  error: string | null;
  reviewing: boolean;
}

interface QuoteState {
  /** 上次成功的最低总价组合求解结果（含“不可行”诊断）；非法报价导入时保留不变 */
  result: QuotePlanResult | null;
  error: string | null;
}

export function App() {
  const [valid, setValid] = useState<ValidState | null>(null);
  const [rawText, setRawText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const [trial, setTrial] = useState<TrialState | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  /** 拓扑代次：每次成功导入递增，作废在途的异步复核回调，防止旧拓扑结果复活 */
  const topologyRev = useRef(0);

  const loadTopology = useCallback((text: string, label: string | null) => {
    setImporting(true);
    // 让出一帧以展示“分析中”，避免上限数据时长时间无反馈
    setTimeout(() => {
      try {
        const topology = parseTopology(text);
        const analyzer = new Analyzer(topology);
        topologyRev.current++; // 新拓扑生效：作废此前所有在途计划复核
        setValid({
          topology,
          analyzer,
          baseline: analyzer.baseline,
          importedAt: new Date().toLocaleTimeString(),
        });
        setImportError(null);
        setFileName(label);
        // 新拓扑导入后旧试接、旧批量、旧有序计划与旧组合规划结果不再适用，清空（基线本身不受历史操作影响）
        setTrial(null);
        setBatch(null);
        setPlan(null);
        setQuote(null);
      } catch (e) {
        const msg = e instanceof TopologyError ? e.message : `分析失败：${(e as Error).message}`;
        setImportError(msg); // 保留 valid（上次有效拓扑）与既有试接/批量结果不变
      } finally {
        setImporting(false);
      }
    }, 0);
  }, []);

  const onImportText = () => {
    if (rawText.trim() === '') {
      setImportError('导入内容为空，请粘贴 JSON 或选择文件');
      return;
    }
    loadTopology(rawText, null);
  };

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setRawText(text);
      loadTopology(text, file.name);
    };
    reader.onerror = () => setImportError(`文件读取失败：${reader.error?.message ?? '未知错误'}`);
    reader.readAsText(file);
  };

  const onTrial = (a: string, b: string) => {
    if (!valid) return;
    try {
      const result = valid.analyzer.trial(a.trim(), b.trim());
      setTrial({ result, error: null, a: result.a, b: result.b });
    } catch (e) {
      const msg = e instanceof TopologyError ? e.message : `试接失败：${(e as Error).message}`;
      // 非法试接：保留上次试接结果（若有），仅更新错误与当前输入
      setTrial((prev) => ({ result: prev?.result ?? null, error: msg, a, b }));
    }
  };

  const onBatch = (text: string) => {
    if (!valid) return;
    try {
      // 全批校验（结构/字段 → 端点存在且互异）全部通过后才生成结果
      const pairs = parseBatchPlans(text);
      const result = valid.analyzer.screenBatch(pairs);
      // 成功：整体替换上次批量结果；基线与单次试接结果不受影响
      setBatch({ result, error: null });
    } catch (e) {
      const msg = e instanceof TopologyError ? e.message : `批量筛选失败：${(e as Error).message}`;
      // 非法批量导入：保留上次批量结果（若有），仅更新错误
      setBatch((prev) => ({ result: prev?.result ?? null, error: msg }));
    }
  };

  const onPlan = (text: string) => {
    if (!valid || plan?.reviewing) return;
    const rev = topologyRev.current;
    const analyzer = valid.analyzer;
    setPlan((prev) => ({ result: prev?.result ?? null, error: prev?.error ?? null, reviewing: true }));
    // 让出一帧以展示“复核中”，避免 100000 步大计划时长时间无反馈
    setTimeout(() => {
      // 期间若已导入新拓扑（代次变化），本次结果一律作废
      if (rev !== topologyRev.current) return;
      try {
        // 全批校验（结构/字段 → 端点存在且互异）通过后才计算；计算完成才原子替换
        const steps = parseOrderedPlan(text);
        const result = analyzer.reviewOrderedPlan(steps);
        setPlan((prev) =>
          rev === topologyRev.current ? { result, error: null, reviewing: false } : prev,
        );
      } catch (e) {
        const msg = e instanceof TopologyError ? e.message : `有序备纤计划复核失败：${(e as Error).message}`;
        // 非法计划：保留上次成功结果（若有）与草稿，仅更新错误
        setPlan((prev) =>
          rev === topologyRev.current
            ? { result: prev?.result ?? null, error: msg, reviewing: false }
            : prev,
        );
      }
    }, 0);
  };

  const onQuote = (text: string) => {
    if (!valid) return;
    try {
      // 全批校验（结构/编号/报价 → 端点存在且互异 → 合计不溢出）全部通过后才求解
      const candidates = parseQuotePlans(text);
      const result = valid.analyzer.planQuotes(candidates);
      // 成功（含“不可行”诊断）：整体替换上次结果；基线、试接、批量与有序计划均不受影响
      setQuote({ result, error: null });
    } catch (e) {
      const msg = e instanceof TopologyError ? e.message : `备纤组合求解失败：${(e as Error).message}`;
      // 非法报价导入：保留上次求解结果（若有），仅更新错误
      setQuote((prev) => ({ result: prev?.result ?? null, error: msg }));
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>园区光纤环网 · 拓扑工作台</h1>
        <p className="subtitle">
          识别单链路断开即隔离站点的<strong>脆弱链路（桥）</strong>，并通过试接一条虚拟备纤核对消险效果。
        </p>
      </header>

      <section className="card">
        <h2>1. 导入拓扑</h2>
        <p className="hint">
          契约：<code>{'{'}"sites": [非空唯一编号…]{'}'}</code>，2–200000 个站点；
          <code>links</code> 为 0–400000 条 <code>{'{id,u,v}'}</code>，编号唯一、端点必须存在、
          禁止自环、允许平行链路、原图须连通。
        </p>
        <textarea
          className="json-input"
          aria-label="拓扑 JSON 输入"
          rows={6}
          placeholder='{"sites": ["a","b","c"], "links": [{"id":"L1","u":"a","v":"b"}, ...]}'
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          spellCheck={false}
        />
        <div className="row">
          <button className="primary" onClick={onImportText} disabled={importing}>
            {importing ? '分析中…' : '导入并分析'}
          </button>
          <label className="file-btn">
            选择 JSON 文件
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = '';
              }}
            />
          </label>
          <button
            onClick={() => {
              const t = sampleTopology();
              setRawText(JSON.stringify(t, null, 2));
            }}
          >
            填入示例
          </button>
          {fileName && <span className="filename">当前文件：{fileName}</span>}
        </div>
        {importError && (
          <div className="alert error" role="alert">
            <strong>导入被拒绝，</strong>仍保留上次有效拓扑。
            <div className="alert-detail">{importError}</div>
          </div>
        )}
        {valid && !importError && (
          <div className="alert ok" role="status">
            已载入有效拓扑（{valid.importedAt}）：{valid.baseline.siteCount} 个站点 /{' '}
            {valid.baseline.linkCount} 条链路，脆弱链路 {valid.baseline.bridges.length} 条。
          </div>
        )}
      </section>

      {valid && (
        <>
          <BaselineSection valid={valid} />
          <TrialSection
            valid={valid}
            trial={trial}
            onSubmit={onTrial}
            onDismissError={() => setTrial((p) => (p ? { ...p, error: null } : p))}
          />
          <BatchSection
            batch={batch}
            onSubmit={onBatch}
            onDismissError={() => setBatch((p) => (p ? { ...p, error: null } : p))}
          />
          <OrderedPlanSection
            plan={plan}
            onSubmit={onPlan}
            onDismissError={() => setPlan((p) => (p ? { ...p, error: null } : p))}
          />
          <QuoteSection
            quote={quote}
            onSubmit={onQuote}
            onDismissError={() => setQuote((p) => (p ? { ...p, error: null } : p))}
          />
        </>
      )}

      {!valid && (
        <section className="card empty">
          <p>尚未载入有效拓扑。粘贴 JSON、选择文件，或点击“填入示例”开始。</p>
        </section>
      )}

      <footer className="footer">
        所有结论由当前输入实时计算（Tarjan 桥算法，迭代实现），无固定结果；上限 200k 站点 / 400k 链路。
      </footer>
    </div>
  );
}

function BaselineSection({ valid }: { valid: ValidState }) {
  const { bridges } = valid.baseline;
  const page = usePagination(bridges.length);
  const slice = useMemo(() => bridges.slice(page.start, page.end), [bridges, page.start, page.end]);

  return (
    <section className="card">
      <h2>2. 基线复核：原网脆弱链路</h2>
      <p className="hint">
        按<strong>链路编号 UTF-8 字节序</strong>列出；“较小侧站点数”为断开该链路后两个连通块中较小者的站点数
        （不输出站点清单）。
      </p>
      <div className="stat-row">
        <Stat label="脆弱链路总数" value={bridges.length} />
        <Stat label="站点总数" value={valid.baseline.siteCount} />
        <Stat label="链路总数" value={valid.baseline.linkCount} />
      </div>
      {bridges.length === 0 ? (
        <div className="alert ok">原网不存在脆弱链路：任意单条链路断开都不会隔离站点。</div>
      ) : (
        <>
          <BridgeTable rows={slice} offset={page.start} showSmallerSide />
          <Pagination page={page} total={bridges.length} />
        </>
      )}
    </section>
  );
}

function TrialSection({
  valid,
  trial,
  onSubmit,
  onDismissError,
}: {
  valid: ValidState;
  trial: TrialState | null;
  onSubmit: (a: string, b: string) => void;
  onDismissError: () => void;
}) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');

  const submit = () => {
    onSubmit(a, b);
  };

  // 仅当存在成功试接结果时展示；非法试接时 result 保持为上次结果
  const result = trial?.result ?? null;
  const stillPage = usePagination(result?.stillFragile.length ?? 0, 'still');
  const removedPage = usePagination(result?.removed.length ?? 0, 'removed');

  return (
    <section className="card">
      <h2>3. 试接虚拟备纤</h2>
      <p className="hint">
        从现有站点选择两个不同端点，页面独立给出试接后<strong>仍脆弱</strong>与相对基线
        <strong>已消除</strong>的链路。试接只用于本次计算，<strong>不改写基线</strong>。
      </p>
      <div className="row trial-row">
        <input
          list="site-list"
          className="endpoint"
          placeholder="端点 A（站点编号）"
          value={a}
          onChange={(e) => setA(e.target.value)}
        />
        <span className="dash">⇄</span>
        <input
          list="site-list"
          className="endpoint"
          placeholder="端点 B（站点编号）"
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
        <datalist id="site-list">
          {valid.topology.sites.slice(0, 2000).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <button className="primary" onClick={submit}>
          试接并核对
        </button>
      </div>
      {valid.topology.sites.length > 2000 && (
        <p className="hint">站点较多，输入框支持直接键入编号精确匹配（自动补全仅列前 2000 项）。</p>
      )}

      {trial?.error && (
        <div className="alert error" role="alert">
          <strong>试接被拒绝。</strong>{' '}
          {result ? '上次试接结果保留如下。' : '尚无有效试接结果。'}
          <div className="alert-detail">{trial.error}</div>
          <button className="link" onClick={onDismissError}>
            关闭提示
          </button>
        </div>
      )}

      {result && (
        <div className="trial-result">
          <div className="trial-head">
            备纤 <code>{result.a}</code> ⇄ <code>{result.b}</code> ｜ 基线脆弱链路{' '}
            {result.baselineCount} 条 → 仍脆弱 {result.stillFragile.length} 条 / 已消除{' '}
            {result.removed.length} 条
          </div>

          <h3 className="still">仍脆弱的链路（{result.stillFragile.length}）</h3>
          {result.stillFragile.length === 0 ? (
            <div className="alert ok">试接后原基线脆弱链路已全部消除。</div>
          ) : (
            <>
              <BridgeTable
                rows={result.stillFragile.slice(stillPage.start, stillPage.end)}
                offset={stillPage.start}
                showSmallerSide
              />
              <Pagination page={stillPage} total={result.stillFragile.length} />
            </>
          )}

          <h3 className="removed">相对基线已消除的链路（{result.removed.length}）</h3>
          {result.removed.length === 0 ? (
            <div className="alert neutral">该备纤未消除任何基线脆弱链路。</div>
          ) : (
            <>
              <BridgeTable rows={result.removed.slice(removedPage.start, removedPage.end)} offset={removedPage.start} />
              <Pagination page={removedPage} total={result.removed.length} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function BatchSection({
  batch,
  onSubmit,
  onDismissError,
}: {
  batch: BatchState | null;
  onSubmit: (text: string) => void;
  onDismissError: () => void;
}) {
  const [text, setText] = useState('');

  // 仅当存在成功批量结果时展示；非法批量导入时 result 保持为上次结果
  const result = batch?.result ?? null;
  const page = usePagination(result?.items.length ?? 0, 'batch');
  const slice = useMemo(
    () => result?.items.slice(page.start, page.end) ?? [],
    [result, page.start, page.end],
  );
  // 可全消方案数（基线无桥时无可消对象，记 0）
  const fullClearCount = useMemo(
    () =>
      result && result.baselineCount > 0
        ? result.items.filter((it) => it.removedCount === result.baselineCount).length
        : 0,
    [result],
  );

  return (
    <section className="card">
      <h2>4. 批量方案筛选</h2>
      <p className="hint">
        粘贴 1–100000 项的 JSON 数组，每项仅含 <code>{'{"a": "站点1", "b": "站点2"}'}</code> 两个字段
        （编号规则同单次试接）。全批校验通过后按<strong>输入下标</strong>分页给出每项可消除的基线脆弱链路数量，
        不展开链路清单；任一项非法则整批拒绝并保留上次结果。
      </p>
      <textarea
        className="json-input"
        aria-label="批量方案 JSON 输入"
        rows={5}
        placeholder='[{"a":"a","b":"c"}, {"a":"b","b":"c"}]'
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="row">
        <button className="primary" onClick={() => onSubmit(text)}>
          批量筛选
        </button>
      </div>

      {batch?.error && (
        <div className="alert error" role="alert">
          <strong>批量导入被拒绝。</strong> {result ? '上次批量结果保留如下。' : '尚无有效批量结果。'}
          <div className="alert-detail">{batch.error}</div>
          <button className="link" onClick={onDismissError}>
            关闭提示
          </button>
        </div>
      )}

      {result && (
        <div className="batch-result">
          <div className="stat-row">
            <Stat label="方案总数" value={result.items.length} />
            <Stat label="基线脆弱链路总数" value={result.baselineCount} />
            <Stat label="可全消方案数" value={fullClearCount} />
          </div>
          <div className="table-wrap">
            <table className="bridge-table batch-table">
              <thead>
                <tr>
                  <th className="col-rank">下标</th>
                  <th className="col-endpoint">端点 A</th>
                  <th className="col-endpoint">端点 B</th>
                  <th className="col-side">可消除的基线脆弱链路数</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((it) => (
                  <tr key={it.index}>
                    <td className="muted">{it.index}</td>
                    <td className="mono">{it.a}</td>
                    <td className="mono">{it.b}</td>
                    <td className="num strong">{it.removedCount.toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={result.items.length} />
        </div>
      )}
    </section>
  );
}

function OrderedPlanSection({
  plan,
  onSubmit,
  onDismissError,
}: {
  plan: PlanState | null;
  onSubmit: (text: string) => void;
  onDismissError: () => void;
}) {
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // 仅当存在上次成功结果时展示；非法计划时 result 保持为上次结果（草稿文本不动）
  const result = plan?.result ?? null;
  const reviewing = plan?.reviewing ?? false;
  const page = usePagination(result?.items.length ?? 0, 'plan');
  const slice = useMemo(
    () => result?.items.slice(page.start, page.end) ?? [],
    [result, page.start, page.end],
  );
  const zeroSteps = useMemo(() => result?.items.filter((it) => it.marginal === 0).length ?? 0, [result]);

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <section className="card">
      <h2>5. 有序备纤计划复核</h2>
      <p className="hint">
        粘贴 1–100000 项的 JSON 数组，每项仅含 <code>{'{"a": "站点1", "b": "站点2"}'}</code> 两个字段，
        <strong>数组顺序即施工顺序</strong>。按顺序给出每一步的端点对、<strong>本步首次消除</strong>的基线桥清单
        （按链路编号 UTF-8 字节序）、边际数、累计数与剩余数；同一桥只归最早覆盖它的步骤，
        重复、反向、交叠或包含路径的后续步骤边际可为 0。全批校验通过、计算完成后才整体替换；
        零项空批次、超过 100000 步、出现 <code>a</code>/<code>b</code> 以外的字段、
        端点不存在或两端相同均整批拒绝并指出<strong>零起下标</strong>，不产生部分结果。
      </p>
      <textarea
        className="json-input"
        aria-label="有序备纤计划 JSON 输入"
        rows={5}
        placeholder='[{"a":"a","b":"f"}, {"a":"c","b":"h"}, ...]'
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="row">
        <button className="primary" onClick={() => onSubmit(text)} disabled={reviewing}>
          {reviewing ? '复核中…' : '按序复核'}
        </button>
      </div>

      {plan?.error && (
        <div className="alert error" role="alert">
          <strong>有序备纤计划被拒绝。</strong> {result ? '上次成功结果保留如下。' : '尚无成功复核结果。'}
          <div className="alert-detail">{plan.error}</div>
          <button className="link" onClick={onDismissError}>
            关闭提示
          </button>
        </div>
      )}

      {result && (
        <div className="plan-result">
          <div className="stat-row">
            <Stat label="计划步骤总数" value={result.items.length} />
            <Stat label="计划覆盖基线桥" value={result.coveredCount} />
            <Stat label="基线脆弱链路总数" value={result.baselineCount} />
            <Stat label="零边际步骤数" value={zeroSteps} />
            <Stat label="计划后仍剩余" value={result.baselineCount - result.coveredCount} />
          </div>
          <div className="table-wrap">
            <table className="bridge-table plan-table">
              <thead>
                <tr>
                  <th className="col-rank">步骤</th>
                  <th className="col-endpoint">端点 A</th>
                  <th className="col-endpoint">端点 B</th>
                  <th>本步首次消除的基线桥（UTF-8 字节序）</th>
                  <th className="col-side">边际数</th>
                  <th className="col-side">累计数</th>
                  <th className="col-side">剩余数</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((it) => {
                  const open = expanded.has(it.index);
                  const preview = it.firstRemoved.slice(0, 8).map((b) => b.id).join('、');
                  return (
                    <tr key={it.index} className={it.marginal === 0 ? 'zero-step' : ''}>
                      <td className="muted">{it.index}</td>
                      <td className="mono">{it.a}</td>
                      <td className="mono">{it.b}</td>
                      <td>
                        {it.firstRemoved.length === 0 ? (
                          <span className="muted">无（0）</span>
                        ) : (
                          <div className="bridge-cell">
                            <span className="mono bridge-preview">{open ? '' : preview}</span>
                            {!open && it.firstRemoved.length > 8 && (
                              <span className="muted"> …等 {it.firstRemoved.length} 条</span>
                            )}
                            {open && (
                              <ul className="bridge-list">
                                {it.firstRemoved.map((b) => (
                                  <li key={b.id} className="mono">
                                    {b.id}
                                    <span className="muted">
                                      {' '}
                                      （{b.u} <span className="dash">–</span> {b.v}）
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <button className="link expand-btn" onClick={() => toggle(it.index)}>
                              {open ? '收起清单' : `展开清单（${it.firstRemoved.length}）`}
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="num strong">{it.marginal.toLocaleString('zh-CN')}</td>
                      <td className="num">{it.cumulative.toLocaleString('zh-CN')}</td>
                      <td className="num">{it.remaining.toLocaleString('zh-CN')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} total={result.items.length} />
        </div>
      )}
    </section>
  );
}

function QuoteSection({
  quote,
  onSubmit,
  onDismissError,
}: {
  quote: QuoteState | null;
  onSubmit: (text: string) => void;
  onDismissError: () => void;
}) {
  const [text, setText] = useState('');

  // 仅当存在成功求解结果时展示；非法报价导入时 result 保持为上次结果（草稿文本不动）
  const result = quote?.result ?? null;
  const covPage = usePagination(result?.coverage.length ?? 0, 'quote-coverage');
  const covSlice = useMemo(
    () => result?.coverage.slice(covPage.start, covPage.end) ?? [],
    [result, covPage.start, covPage.end],
  );
  const uncPage = usePagination(result?.uncoverable.length ?? 0, 'quote-uncoverable');
  const uncSlice = useMemo(
    () => result?.uncoverable.slice(uncPage.start, uncPage.end) ?? [],
    [result, uncPage.start, uncPage.end],
  );

  return (
    <section className="card">
      <h2>6. 最低总价备纤组合</h2>
      <p className="hint">
        粘贴 1–16 条候选的 JSON 数组，每项仅含{' '}
        <code>{'{"id": "候选1", "a": "站点1", "b": "站点2", "price": 100}'}</code> 四个字段：
        编号唯一、报价为非负安全整数，且整批报价合计不得超出安全整数范围（否则整批拒绝）。
        精确求出覆盖全部基线桥的最低总价组合；总价相同比条数，再相同按候选编号序列定唯一方案。
        候选可重复覆盖同一桥，但不会因零价而多选无用连线。存在无法覆盖的桥时给出具体桥边诊断，
        不伪造成功。本区仅作规划，<strong>不改写原图、基线与既有试算结果</strong>。
      </p>
      <textarea
        className="json-input"
        aria-label="备纤报价 JSON 输入"
        rows={5}
        placeholder='[{"id":"X1","a":"a","b":"c","price":100}, {"id":"X2","a":"c","b":"f","price":60}]'
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="row">
        <button className="primary" onClick={() => onSubmit(text)}>
          求解最低总价组合
        </button>
      </div>

      {quote?.error && (
        <div className="alert error" role="alert">
          <strong>备纤报价被拒绝。</strong> {result ? '上次求解结果保留如下。' : '尚无有效求解结果。'}
          <div className="alert-detail">{quote.error}</div>
          <button className="link" onClick={onDismissError}>
            关闭提示
          </button>
        </div>
      )}

      {result && (
        <div className="quote-result">
          <div className="stat-row">
            <Stat label="候选连线数" value={result.candidateCount} />
            <Stat label="基线脆弱链路总数" value={result.baselineCount} />
            <Stat label="所选连线数" value={result.selected.length} />
            <Stat label="最低总价" value={result.totalPrice} />
          </div>

          {!result.feasible ? (
            <>
              <div className="alert error" role="alert">
                <strong>无法组成全覆盖方案：</strong>以下 {result.uncoverable.length}{' '}
                条基线桥不被任何候选连线覆盖，未给出任何方案（不伪造成功）。
              </div>
              <BridgeTable rows={uncSlice} offset={uncPage.start} showSmallerSide />
              <Pagination page={uncPage} total={result.uncoverable.length} />
            </>
          ) : result.baselineCount === 0 ? (
            <div className="alert ok">原网不存在脆弱链路：空方案，无需加装任何备纤（总价 0）。</div>
          ) : (
            <>
              <div className="alert ok">未覆盖诊断：全部基线桥均被所选组合覆盖，无遗漏。</div>

              <h3 className="removed">
                所选连线（{result.selected.length}）｜ 最低总价 {result.totalPrice.toLocaleString('zh-CN')}
              </h3>
              <div className="table-wrap">
                <table className="bridge-table quote-selected-table">
                  <thead>
                    <tr>
                      <th className="col-rank">#</th>
                      <th>候选编号（UTF-8 字节序）</th>
                      <th className="col-endpoint">端点 A</th>
                      <th className="col-endpoint">端点 B</th>
                      <th className="col-side">报价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.selected.map((c, i) => (
                      <tr key={c.id}>
                        <td className="muted">{i + 1}</td>
                        <td className="mono">{c.id}</td>
                        <td className="mono">{c.a}</td>
                        <td className="mono">{c.b}</td>
                        <td className="num strong">{c.price.toLocaleString('zh-CN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3>每条基线桥的消除来源（{result.coverage.length}）</h3>
              <div className="table-wrap">
                <table className="bridge-table quote-coverage-table">
                  <thead>
                    <tr>
                      <th className="col-rank">#</th>
                      <th>基线桥（UTF-8 字节序）</th>
                      <th className="col-endpoint">端点</th>
                      <th>消除它的所选连线（可重复覆盖）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {covSlice.map((item, i) => (
                      <tr key={item.bridge.id}>
                        <td className="muted">{covPage.start + i + 1}</td>
                        <td className="mono">{item.bridge.id}</td>
                        <td className="muted">
                          {item.bridge.u} <span className="dash">–</span> {item.bridge.v}
                        </td>
                        <td className="mono">{item.coveredBy.join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={covPage} total={result.coverage.length} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value.toLocaleString('zh-CN')}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
