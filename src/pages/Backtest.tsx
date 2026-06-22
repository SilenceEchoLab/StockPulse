import { useState, useRef, useEffect } from "react";
import { Activity, Play, Settings2, BarChart2, TrendingUp, Shield, Clock } from "lucide-react";
import { Button } from "../components/ui/Button";
import { createChart, IChartApi, LineSeries, LineStyle } from 'lightweight-charts';

const STRATEGIES = [
  { value: 'three_cycle', label: '三周期共振', desc: '周线趋势+日线结构+时机确认' },
  { value: 'macd_cross', label: 'MACD 金叉死叉', desc: '经典 MACD 信号' },
  { value: 'rsi_reversal', label: 'RSI 超买超卖', desc: 'RSI 反转信号' },
  { value: 'ma520', label: '520 战法', desc: 'MA5/MA20 金叉死叉' },
];

export default function Backtest() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState({
    codes: "sh600036,sh601318,sh600031",
    strategy: "three_cycle",
    startDate: "",
    endDate: "",
    initialCapital: "100000",
    useMarketTiming: true,
    scoreThreshold: "55",
  });

  const runBacktest = async () => {
    setRunning(true);
    setResult(null);
    try {
      const codes = formData.codes.split(",").map(s => s.trim()).filter(Boolean);
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codes,
          strategy: formData.strategy,
          startDate: formData.startDate || undefined,
          endDate: formData.endDate || undefined,
          initialCapital: Number(formData.initialCapital),
          useMarketTiming: formData.useMarketTiming && formData.strategy === 'three_cycle',
          params: {
            scoreThreshold: Number(formData.scoreThreshold),
          },
        })
      });
      if (res.ok) {
        const json = await res.json();
        setResult(json);
      } else {
        const err = await res.json();
        alert(err.error || "回测请求失败");
      }
    } catch (e: any) {
      alert("网络错误: " + e.message);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!result?.results?.[0]?.equityCurve || !chartRef.current) return;

    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: 'solid', color: 'transparent' } as any,
        textColor: '#787b86',
      },
      grid: {
        vertLines: { color: '#232733', style: LineStyle.Dotted },
        horzLines: { color: '#232733', style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: '#232733' },
      timeScale: { borderColor: '#232733', timeVisible: true },
      autoSize: true,
    });

    const colors = ['#f23645', '#26a69a', '#2962ff', '#ff6d00'];
    result.results.forEach((r: any, idx: number) => {
      if (!r?.equityCurve?.length) return;
      const series = chart.addSeries(LineSeries, {
        color: colors[idx % colors.length],
        lineWidth: 2,
        title: r.marketCode,
      });
      const unique = Array.from(new Map(r.equityCurve.map((d: any) => [d.date, d])).values());
      const sorted = unique.sort((a: any, b: any) => a.date.localeCompare(b.date));
      series.setData(sorted.map((d: any) => ({ time: d.date, value: d.equity })));
    });

    chart.timeScale().fitContent();
    return () => { chart.remove(); };
  }, [result]);

  const metrics = result?.results?.[0]?.metrics;

  return (
    <div className="flex flex-col h-full w-full max-w-7xl mx-auto animate-in fade-in duration-300">
      <header className="mb-6 shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" /> 策略回测引擎
          </h1>
          <p className="text-[13px] text-muted">
            三周期共振 + 大盘择时 + 完整风控的量化回测系统
          </p>
        </div>
        {result?.marketTiming && (
          <div className="flex items-center gap-2 bg-surface-card-dark border border-hairline-dark rounded-lg px-4 py-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="text-[13px] text-white">大盘：</span>
            <span className={`text-[13px] font-bold ${
              result.marketTiming.regime === 'bull' ? 'text-trading-up' :
              result.marketTiming.regime === 'bear' ? 'text-trading-down' : 'text-warning'
            }`}>
              {result.marketTiming.regime === 'bull' ? '牛市' :
               result.marketTiming.regime === 'bear' ? '熊市' : '震荡'}
            </span>
            <span className="text-[12px] text-muted ml-2">
              仓位上限 {Math.round(result.marketTiming.maxPosition * 100)}%
            </span>
          </div>
        )}
      </header>

      <div className="flex gap-6 h-full min-h-0">
        {/* Left: Config */}
        <div className="w-[320px] shrink-0 bg-surface-card-dark border border-hairline-dark rounded-lg p-5 flex flex-col gap-4 overflow-y-auto custom-scrollbar">
          <div className="flex items-center gap-2 mb-1 pb-2 border-b border-hairline-dark">
             <Settings2 className="w-4 h-4 text-muted" />
             <h3 className="text-[14px] font-medium text-white">回测参数</h3>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-muted">测试标的 (逗号分隔)</label>
            <input
              type="text"
              value={formData.codes}
              onChange={e => setFormData({...formData, codes: e.target.value})}
              placeholder="sh600036,sh601318"
              className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-muted">策略类型</label>
            <select
              value={formData.strategy}
              onChange={e => setFormData({...formData, strategy: e.target.value})}
              className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
            >
              {STRATEGIES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-muted">
              {STRATEGIES.find(s => s.value === formData.strategy)?.desc}
            </p>
          </div>

          {formData.strategy === 'three_cycle' && (
            <>
              <div className="flex items-center gap-2 bg-canvas-dark border border-hairline-dark rounded px-3 py-2">
                <input
                  type="checkbox"
                  id="timing"
                  checked={formData.useMarketTiming}
                  onChange={e => setFormData({...formData, useMarketTiming: e.target.checked})}
                  className="accent-primary"
                />
                <label htmlFor="timing" className="text-[13px] text-white cursor-pointer flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5 text-primary" />
                  大盘择时过滤
                </label>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12px] text-muted">
                  得分阈值 (0-100, 越高越严格)
                </label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.scoreThreshold}
                  onChange={e => setFormData({...formData, scoreThreshold: e.target.value})}
                  className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
                />
              </div>
            </>
          )}

          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 flex-1">
              <label className="text-[12px] text-muted">开始日期</label>
              <input
                type="date"
                value={formData.startDate}
                onChange={e => setFormData({...formData, startDate: e.target.value})}
                className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
              />
            </div>
            <div className="flex flex-col gap-1.5 flex-1">
              <label className="text-[12px] text-muted">结束日期</label>
              <input
                type="date"
                value={formData.endDate}
                onChange={e => setFormData({...formData, endDate: e.target.value})}
                className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] text-muted">初始资金</label>
            <input
              type="number"
              value={formData.initialCapital}
              onChange={e => setFormData({...formData, initialCapital: e.target.value})}
              className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
            />
          </div>

          <div className="mt-auto pt-4">
            <Button onClick={runBacktest} disabled={running} className="w-full h-10">
              {running ? (
                <div className="w-4 h-4 border-2 border-ink border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <><Play className="w-4 h-4 mr-2" /> 开始回测</>
              )}
            </Button>
          </div>
        </div>

        {/* Right: Results */}
        <div className="flex-1 bg-surface-card-dark border border-hairline-dark rounded-lg p-5 flex flex-col min-w-0">
          {!result && !running && (
             <div className="flex-1 flex flex-col items-center justify-center text-muted">
               <BarChart2 className="w-12 h-12 mb-4 opacity-20" />
               <p className="text-[13px]">配置参数后点击"开始回测"</p>
               <p className="text-[11px] mt-1">支持三周期共振、MACD、RSI、520 战法</p>
             </div>
          )}
          {running && (
             <div className="flex-1 flex flex-col items-center justify-center text-primary">
               <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
               <p className="text-[13px]">策略回测中，请稍候...</p>
             </div>
          )}
          {result && !running && metrics && (
            <div className="flex flex-col h-full">
              {/* Metrics Grid */}
               <div className="grid grid-cols-6 gap-3 mb-5 shrink-0">
                 <MetricCard label="总收益率" value={`${(metrics.totalReturn * 100).toFixed(2)}%`} color={metrics.totalReturn >= 0 ? 'up' : 'down'} />
                 <MetricCard label="年化收益" value={`${(metrics.annualizedReturn * 100).toFixed(2)}%`} color={metrics.annualizedReturn >= 0 ? 'up' : 'down'} />
                 <MetricCard label="夏普比率" value={metrics.sharpeRatio?.toFixed(2) ?? '-'} color={metrics.sharpeRatio >= 1 ? 'up' : 'neutral'} />
                 <MetricCard label="最大回撤" value={`${(metrics.maxDrawdown * 100).toFixed(2)}%`} color="down" />
                 <MetricCard label="胜率" value={`${(metrics.winRate * 100).toFixed(1)}%`} color={metrics.winRate >= 0.5 ? 'up' : 'neutral'} />
                 <MetricCard label="盈亏比" value={metrics.profitFactor?.toFixed(2) ?? '-'} color={metrics.profitFactor >= 1.5 ? 'up' : metrics.profitFactor >= 1 ? 'neutral' : 'down'} />
              </div>

              {/* Second row metrics */}
              <div className="grid grid-cols-6 gap-3 mb-5 shrink-0">
                 <MetricCard label="Sortino" value={metrics.sortinoRatio?.toFixed(2) ?? '-'} color={metrics.sortinoRatio >= 1 ? 'up' : 'neutral'} />
                 <MetricCard label="Calmar" value={metrics.calmarRatio?.toFixed(2) ?? '-'} color={metrics.calmarRatio >= 1 ? 'up' : 'neutral'} />
                 <MetricCard label="交易次数" value={String(metrics.tradeCount ?? 0)} color="neutral" />
                 <MetricCard label="平均持仓" value={`${metrics.avgHoldDays?.toFixed(1) ?? '-'}天`} color="neutral" />
                 <MetricCard label="连续亏损" value={String(metrics.maxConsecutiveLosses ?? 0)} color={metrics.maxConsecutiveLosses >= 5 ? 'down' : 'neutral'} />
                 <MetricCard label="Alpha" value={metrics.alpha != null ? `${(metrics.alpha * 100).toFixed(2)}%` : '-'} color={metrics.alpha != null && metrics.alpha > 0 ? 'up' : 'down'} />
              </div>

              {/* Chart */}
              <div className="mb-4 shrink-0">
                 <h3 className="text-[14px] font-medium text-white mb-3">资金曲线</h3>
                 <div ref={chartRef} className="h-[220px] w-full" />
              </div>

              {/* Trades */}
              <div className="flex-1 flex flex-col min-h-0">
                 <h3 className="text-[14px] font-medium text-white mb-3 flex items-center gap-2">
                   <Clock className="w-4 h-4 text-muted" />
                   交易记录 ({result.results[0]?.trades?.length ?? 0})
                 </h3>
                 <div className="flex-1 overflow-y-auto custom-scrollbar border border-hairline-dark rounded bg-canvas-dark">
                    <table className="w-full text-left border-collapse text-[12px]">
                      <thead className="bg-surface-elevated-dark sticky top-0">
                        <tr>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">买入日期</th>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">买入价</th>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">卖出日期</th>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">卖出价</th>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">持仓天数</th>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">盈亏</th>
                          <th className="py-2 px-3 font-medium text-muted border-b border-hairline-dark">退出原因</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.results[0]?.trades?.map((t: any, i: number) => (
                          <tr key={i} className="border-b border-hairline-dark hover:bg-surface-elevated-dark/50">
                            <td className="py-2 px-3 text-body-dark">{t.entryDate}</td>
                            <td className="py-2 px-3 text-white font-mono">{t.entryPrice?.toFixed(2)}</td>
                            <td className="py-2 px-3 text-body-dark">{t.exitDate}</td>
                            <td className="py-2 px-3 text-white font-mono">{t.exitPrice?.toFixed(2)}</td>
                            <td className="py-2 px-3 text-muted">{t.holdDays}天</td>
                            <td className="py-2 px-3 font-mono">
                              <span className={t.pnlPct >= 0 ? 'text-trading-up' : 'text-trading-down'}>
                                {t.pnlPct >= 0 ? '+' : ''}{(t.pnlPct * 100).toFixed(2)}%
                              </span>
                            </td>
                            <td className="py-2 px-3 text-muted text-[11px]">{t.exitReason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                 </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: string; color: 'up' | 'down' | 'neutral' }) {
  const colorClass = color === 'up' ? 'text-trading-up' : color === 'down' ? 'text-trading-down' : 'text-body-dark';
  return (
    <div className="bg-canvas-dark border border-hairline-dark rounded p-3">
      <div className="text-[11px] text-muted mb-1">{label}</div>
      <div className={`text-[16px] font-mono font-bold ${colorClass}`}>{value}</div>
    </div>
  );
}
