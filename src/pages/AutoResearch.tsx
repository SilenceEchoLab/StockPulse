import { useState, useEffect, useCallback } from "react";
import { FlaskConical, Play, TrendingUp, Target, Award, RefreshCw, Zap, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { cn } from "../lib/utils";

type Status = 'idle' | 'running' | 'completed' | 'error';

interface ResearchStatus {
  status: Status;
  strategy: string;
  total: number;
  current: number;
  progress: number;
  profitable: number;
  logs: { time: string; msg: string }[];
}

interface Recommendation {
  id: number;
  marketCode: string;
  name: string;
  action: string;
  confidence: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reason: string;
  status: string;
  returnPct: number | null;
  holdDays: number | null;
  date: string;
}

interface PerfStats {
  overview: {
    total: number;
    active: number;
    resolved: number;
    hitTP: number;
    hitSL: number;
    expired: number;
    avgReturn: number | null;
    avgHoldDays: number | null;
    winRate: number | null;
  };
  byStrategy: { strategy: string; total: number; winRate: number; avgReturn: number }[];
}

export default function AutoResearch() {
  const [optimizing, setOptimizing] = useState(false);
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [perf, setPerf] = useState<PerfStats | null>(null);
  const [recommending, setRecommending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [recTab, setRecTab] = useState<'active' | 'resolved'>('active');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/research/status');
      const json = await res.json();
      if (json.success) {
        setStatus(json.data);
        setOptimizing(json.data.status === 'running');
      }
    } catch { /* ignore */ }
  }, []);

  const fetchRecs = useCallback(async () => {
    try {
      const res = await fetch(`/api/research/recommendations?status=${recTab}&limit=50`);
      const json = await res.json();
      if (json.success) setRecs(json.data || []);
    } catch { /* ignore */ }
  }, [recTab]);

  const fetchPerf = useCallback(async () => {
    try {
      const res = await fetch('/api/research/performance');
      const json = await res.json();
      if (json.success) setPerf(json.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchRecs();
    fetchPerf();
  }, []);

  // 轮询优化进度
  useEffect(() => {
    if (!optimizing) return;
    const timer = setInterval(() => { fetchStatus(); }, 2000);
    return () => clearInterval(timer);
  }, [optimizing, fetchStatus]);

  const startOptimize = async () => {
    setOptimizing(true);
    try {
      await fetch('/api/research/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      fetchStatus();
    } catch {
      setOptimizing(false);
    }
  };

  const generateRecs = async () => {
    setRecommending(true);
    try {
      const res = await fetch('/api/research/recommend', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        fetchRecs(); fetchPerf();
      } else {
        alert(json.message || json.error || '生成推荐失败');
      }
    } finally { setRecommending(false); }
  };

  const resolveRecs = async () => {
    setResolving(true);
    try {
      await fetch('/api/research/resolve', { method: 'POST' });
      fetchRecs(); fetchPerf();
    } finally { setResolving(false); }
  };

  const o = perf?.overview;
  const winRatePct = o?.winRate ? Math.round(o.winRate * 100) : 0;
  const avgRetPct = o?.avgReturn ? (o.avgReturn * 100).toFixed(1) : '0.0';

  return (
    <div className="space-y-5 max-w-7xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-2">
        <FlaskConical className="w-7 h-7 text-primary" />
        <h1 className="text-2xl font-bold text-white">AutoResearch 自动优化引擎</h1>
      </div>

      {/* 闭环流程图 */}
      <div className="bg-surface-card-dark rounded-xl p-4 border border-hairline-dark">
        <div className="flex items-center justify-between gap-2 text-sm">
          {[
            { icon: Zap, label: '参数搜索', desc: '网格采样', color: 'text-yellow-400' },
            { icon: Target, label: 'Walk-Forward', desc: 'Train 60% / Test 40%', color: 'text-blue-400' },
            { icon: Award, label: '防过拟合', desc: '调和均值评分', color: 'text-purple-400' },
            { icon: TrendingUp, label: '多策略共识', desc: '每日推荐', color: 'text-green-400' },
            { icon: RefreshCw, label: '绩效反馈', desc: '结算收益', color: 'text-orange-400' },
          ].map((step, i, arr) => (
            <div key={i} className="flex items-center gap-2 flex-1">
              <div className="flex flex-col items-center gap-1 flex-1">
                <step.icon className={cn('w-6 h-6', step.color)} />
                <span className="text-white font-medium text-xs">{step.label}</span>
                <span className="text-muted text-[10px]">{step.desc}</span>
              </div>
              {i < arr.length - 1 && <div className="text-muted text-lg">→</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 优化控制面板 */}
        <div className="lg:col-span-2 bg-surface-card-dark rounded-xl p-5 border border-hairline-dark">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">策略优化</h2>
            {optimizing ? (
              <span className="flex items-center gap-1.5 text-sm text-yellow-400">
                <div className="w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                优化中...
              </span>
            ) : status?.status === 'completed' ? (
              <span className="flex items-center gap-1 text-sm text-green-400"><CheckCircle2 className="w-4 h-4" /> 已完成</span>
            ) : null}
          </div>

          {status && status.total > 0 && (
            <div className="mb-4">
              <div className="flex justify-between text-sm text-muted mb-1">
                <span>{status.strategy || '准备中'}</span>
                <span>{status.current} / {status.total} ({status.progress.toFixed(0)}%)</span>
              </div>
              <div className="h-2 bg-canvas-dark rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${status.progress}%` }}
                />
              </div>
              {status.profitable > 0 && (
                <p className="text-xs text-green-400 mt-1">已找到 {status.profitable} 个盈利方案</p>
              )}
            </div>
          )}

          {status?.logs && status.logs.length > 0 && (
            <div className="bg-canvas-dark rounded-lg p-3 max-h-32 overflow-y-auto text-xs font-mono space-y-1 mb-4">
              {status.logs.slice(0, 8).map((log, i) => (
                <div key={i} className="text-muted">
                  <span className="text-primary">[{log.time}]</span> {log.msg}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={startOptimize}
            disabled={optimizing}
            className="w-full flex items-center justify-center gap-2 bg-primary text-ink py-2.5 rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Play className="w-4 h-4" />
            {optimizing ? '优化进行中...' : '启动全量策略优化'}
          </button>
        </div>

        {/* 绩效面板 */}
        <div className="bg-surface-card-dark rounded-xl p-5 border border-hairline-dark">
          <h2 className="text-lg font-semibold text-white mb-4">推荐绩效</h2>
          <div className="grid grid-cols-2 gap-3">
            <MetricCard label="总推荐" value={o?.total ?? 0} />
            <MetricCard label="胜率" value={`${winRatePct}%`} color={winRatePct >= 50 ? 'text-green-400' : 'text-red-400'} />
            <MetricCard label="平均收益" value={`${avgRetPct}%`} color={o?.avgReturn != null && o.avgReturn > 0 ? 'text-green-400' : 'text-red-400'} />
            <MetricCard label="平均持仓" value={`${o?.avgHoldDays != null ? Math.round(o.avgHoldDays) : 0}天`} />
          </div>
          <div className="mt-3 flex gap-2 text-xs">
            <span className="flex items-center gap-1 text-green-400"><CheckCircle2 className="w-3 h-3" />止盈 {o?.hitTP ?? 0}</span>
            <span className="flex items-center gap-1 text-red-400"><AlertCircle className="w-3 h-3" />止损 {o?.hitSL ?? 0}</span>
            <span className="flex items-center gap-1 text-muted"><Clock className="w-3 h-3" />过期 {o?.expired ?? 0}</span>
          </div>
        </div>
      </div>

      {/* 推荐操作栏 */}
      <div className="flex items-center gap-3">
        <button
          onClick={generateRecs}
          disabled={recommending}
          className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
        >
          <TrendingUp className="w-4 h-4" />
          {recommending ? '生成中...' : '生成今日推荐'}
        </button>
        <button
          onClick={resolveRecs}
          disabled={resolving}
          className="flex items-center gap-2 bg-orange-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-4 h-4', resolving && 'animate-spin')} />
          {resolving ? '结算中...' : '结算绩效'}
        </button>
      </div>

      {/* 推荐列表 */}
      <div className="bg-surface-card-dark rounded-xl border border-hairline-dark overflow-hidden">
        <div className="flex border-b border-hairline-dark">
          <button
            onClick={() => setRecTab('active')}
            className={cn('px-5 py-3 text-sm font-medium transition-colors', recTab === 'active' ? 'text-primary border-b-2 border-primary' : 'text-muted hover:text-white')}
          >
            活跃推荐 ({recs.length})
          </button>
          <button
            onClick={() => setRecTab('resolved')}
            className={cn('px-5 py-3 text-sm font-medium transition-colors', recTab === 'resolved' ? 'text-primary border-b-2 border-primary' : 'text-muted hover:text-white')}
          >
            已结算 ({recs.length})
          </button>
        </div>

        {recs.length === 0 ? (
          <div className="p-12 text-center text-muted">
            <Target className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>暂无{recTab === 'active' ? '活跃' : '已结算'}推荐</p>
            <p className="text-xs mt-1">{recTab === 'active' ? '先启动优化，再生成今日推荐' : '点击"结算绩效"按钮查看已完成的推荐'}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline-dark text-muted text-xs">
                  <th className="px-4 py-2 text-left">代码</th>
                  <th className="px-4 py-2 text-right">置信度</th>
                  <th className="px-4 py-2 text-right">买入价</th>
                  <th className="px-4 py-2 text-right">止损</th>
                  <th className="px-4 py-2 text-right">止盈</th>
                  {recTab === 'resolved' && <th className="px-4 py-2 text-right">收益</th>}
                  {recTab === 'resolved' && <th className="px-4 py-2 text-right">持仓</th>}
                  <th className="px-4 py-2 text-left">理由</th>
                  <th className="px-4 py-2 text-center">状态</th>
                </tr>
              </thead>
              <tbody>
                {recs.map((r) => (
                  <tr key={r.id} className="border-b border-hairline-dark/50 hover:bg-canvas-dark/50">
                    <td className="px-4 py-2.5">
                      <div className="text-white font-medium">{r.name}</div>
                      <div className="text-muted text-xs">{r.marketCode}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className={cn('px-2 py-0.5 rounded text-xs font-bold', r.confidence >= 0.6 ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400')}>
                        {(r.confidence * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-white">{r.entryPrice?.toFixed(2) ?? '-'}</td>
                    <td className="px-4 py-2.5 text-right text-red-400">{r.stopLoss?.toFixed(2) ?? '-'}</td>
                    <td className="px-4 py-2.5 text-right text-green-400">{r.takeProfit?.toFixed(2) ?? '-'}</td>
                    {recTab === 'resolved' && (
                      <td className={cn('px-4 py-2.5 text-right font-bold', (r.returnPct ?? 0) > 0 ? 'text-green-400' : 'text-red-400')}>
                        {((r.returnPct ?? 0) * 100).toFixed(1)}%
                      </td>
                    )}
                    {recTab === 'resolved' && (
                      <td className="px-4 py-2.5 text-right text-muted">{r.holdDays ?? 0}天</td>
                    )}
                    <td className="px-4 py-2.5 text-muted text-xs max-w-[200px] truncate">{r.reason}</td>
                    <td className="px-4 py-2.5 text-center">
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-canvas-dark rounded-lg p-3">
      <div className="text-muted text-xs">{label}</div>
      <div className={cn('text-lg font-bold mt-0.5', color || 'text-white')}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: '活跃', cls: 'bg-blue-500/20 text-blue-400' },
    hit_tp: { label: '止盈', cls: 'bg-green-500/20 text-green-400' },
    hit_sl: { label: '止损', cls: 'bg-red-500/20 text-red-400' },
    expired: { label: '过期', cls: 'bg-gray-500/20 text-gray-400' },
    closed: { label: '平仓', cls: 'bg-gray-500/20 text-gray-400' },
  };
  const s = map[status] || { label: status, cls: 'bg-gray-500/20 text-gray-400' };
  return <span className={cn('px-2 py-0.5 rounded text-xs', s.cls)}>{s.label}</span>;
}
