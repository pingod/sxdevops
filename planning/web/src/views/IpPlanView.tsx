/**
 * 网段级 IP 规划（FR-3.8 轻量版）。
 *
 * ## 这一页回答的唯一问题：「地址段规划得下不下、有没有撞段」
 *
 * 源是 V13 的「IP地址段规划」表（应用范围 → IP地址段，10 行）。
 * 产品规划明确**不做 IPAM**（逐地址分配是过度设计），这里只做网段级：
 * 把自由文本的网段登记解析成结构化模型，算容量、查冲突、统计使用率。
 *
 * ## 两个必须在界面上说清的事（否则用户会误读）
 *
 * 1. **使用率是规划占用口径，不是实际分配率**：源表只有规划网段，没有逐地址
 *    分配数据。分母是「最小覆盖超网容量」，分子是「规划地址数」。界面照此标注，
 *    后端 notes 也强制下发这句披露。
 * 2. **冲突是网段级重叠**：两条登记网段共享地址才算冲突，不是主机路由冲突。
 *    真实 V13 的 10 条网段互不重叠，所以正常态是「无冲突」绿条。
 */

import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import { api, downloadAuthenticated } from '../api/client';
import type { IpPlanPayload } from '../api/client';

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function IpPlanView(): JSX.Element {
  const [data, setData] = useState<IpPlanPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .ipplan()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function onExport(): Promise<void> {
    setExporting(true);
    setErr(null);
    try {
      await downloadAuthenticated('/api/ipplan/export', 'IP地址段规划.xlsx');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  if (err) {
    return (
      <div className="panel">
        <div className="error-box">
          <b>IP 规划加载失败：</b>
          {err}
        </div>
      </div>
    );
  }

  const conflictRaws = new Set<string>();
  for (const c of data?.conflicts ?? []) {
    conflictRaws.add(c.aRaw);
    conflictRaws.add(c.bRaw);
  }
  const u = data?.utilization;
  const totals = data?.totals;

  return (
    <div className="ipplan-view">
      <section className="panel">
        <div className="panel-head">
          <h2>网段级 IP 规划</h2>
          <div className="ipplan-actions">
            <button type="button" onClick={() => void onExport()} disabled={exporting || !data}>
              {exporting ? '导出中…' : '导出 Excel'}
            </button>
          </div>
        </div>

        <div className="consume-headline">
          <div className="consume-big">
            <span className="consume-num">{totals ? fmt(totals.segments) : '—'}</span>
            <span className="consume-label">登记网段</span>
          </div>
          <div className="consume-big">
            <span className="consume-num">{totals ? fmt(totals.purposes) : '—'}</span>
            <span className="consume-label">应用用途</span>
          </div>
          <div className="consume-big">
            <span className="consume-num">{totals ? fmt(totals.subnets) : '—'}</span>
            <span className="consume-label">子网数</span>
          </div>
          <div className="consume-big">
            <span className="consume-num">{totals ? fmt(totals.addresses) : '—'}</span>
            <span className="consume-label">规划地址</span>
          </div>
          <div className="consume-big">
            <span className="consume-num">{u ? pct(u.ratio) : '—'}</span>
            <span className="consume-label">地址空间使用率</span>
          </div>
        </div>

        <div className="coverage-bar">
          <div className="coverage-track">
            <div className="coverage-fill" style={{ width: pct(u?.ratio ?? 0) }} />
          </div>
          <span className="coverage-text">
            {u
              ? `${fmt(u.planned)} / ${fmt(u.capacity)}（最小覆盖超网 ${u.supernet}）`
              : '—'}
          </span>
        </div>

        <p className="subtle consume-scope">
          {data ? `来源：${data.source}` : '加载中…'}
          {loading && ' 加载中…'}
        </p>
      </section>

      <section className="panel">
        <h2>网段明细</h2>
        <table className="consume-table ip-seg-table">
          <thead>
            <tr>
              <th>应用用途</th>
              <th>网段（原文）</th>
              <th className="num">子网数</th>
              <th className="num">地址数</th>
              <th>起始地址</th>
              <th>结束地址</th>
            </tr>
          </thead>
          <tbody>
            {(data?.segments ?? []).map((s, i) => (
              <tr key={`${s.purpose}-${s.raw}-${i}`} className={conflictRaws.has(s.raw) ? 'conflict-row' : ''}>
                <td>{s.purpose}</td>
                <td>
                  <code className="ip-raw">{s.raw}</code>
                  <span className={`ip-kind ip-kind-${s.kind}`}>
                    {s.kind === 'range' ? '区间' : '单网段'}
                  </span>
                </td>
                <td className="num">{fmt(s.subnetCount)}</td>
                <td className="num strong">{fmt(s.addressCount)}</td>
                <td className="ip-addr">{s.start}</td>
                <td className="ip-addr">{s.end}</td>
              </tr>
            ))}
            {(data?.segments ?? []).length === 0 && (
              <tr>
                <td colSpan={6} className="empty-row">
                  {loading ? '加载中…' : '源表没有 IP 地址段规划数据'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>按用途汇总</h2>
        <table className="consume-table">
          <thead>
            <tr>
              <th>应用用途</th>
              <th className="num">网段数</th>
              <th className="num">子网数</th>
              <th className="num">地址数</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byPurpose ?? []).map((p) => (
              <tr key={p.purpose}>
                <td>{p.purpose}</td>
                <td className="num">{fmt(p.segmentCount)}</td>
                <td className="num">{fmt(p.subnetCount)}</td>
                <td className="num strong">{fmt(p.addressCount)}</td>
              </tr>
            ))}
            {(data?.byPurpose ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="empty-row">
                  暂无汇总
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>冲突校验</h2>
          {data &&
            (data.conflicts.length === 0 ? (
              <span className="ip-badge ip-badge-ok">无重叠</span>
            ) : (
              <span className="ip-badge ip-badge-bad">{data.conflicts.length} 处重叠</span>
            ))}
        </div>

        {data && data.conflicts.length > 0 && (
          <table className="consume-table ip-conflict-table">
            <thead>
              <tr>
                <th>用途 A</th>
                <th>网段 A</th>
                <th>用途 B</th>
                <th>网段 B</th>
                <th className="num">重叠子网</th>
                <th>示例</th>
              </tr>
            </thead>
            <tbody>
              {data.conflicts.map((c, i) => (
                <tr key={`${c.aRaw}-${c.bRaw}-${i}`} className="conflict-row">
                  <td>{c.aPurpose}</td>
                  <td><code className="ip-raw">{c.aRaw}</code></td>
                  <td>{c.bPurpose}</td>
                  <td><code className="ip-raw">{c.bRaw}</code></td>
                  <td className="num">{c.shared}</td>
                  <td className="ip-addr">{c.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {data && data.conflicts.length === 0 && (
          <p className="callout ip-ok">
            全部 {totals?.segments ?? 0} 条登记网段互不重叠，地址段规划无冲突。
          </p>
        )}

        {data && data.issues.length > 0 && (
          <p className="callout warn">
            <b>解析提示：</b>
            {data.issues.join('；')}
          </p>
        )}

        {(data?.notes ?? []).map((n) => (
          <p className="callout warn" key={n}>
            {n}
          </p>
        ))}
      </section>
    </div>
  );
}