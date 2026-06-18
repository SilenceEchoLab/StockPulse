import { useState, useRef, useEffect } from "react";
import { Activity, Play, Settings2, BarChart2 } from "lucide-react";
import { Button } from "../components/ui/Button";
import { createChart, IChartApi, LineSeries, LineStyle } from 'lightweight-charts';

export default function Backtest() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null);

  const [formData, setFormData] = useState({
    codes: "sh600519",
    strategy: "macd_cross",
    startDate: "2025-01-01",
    endDate: "2026-06-01",
    initialCapital: "100000"
  });

  const runBacktest = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codes: formData.codes.split(",").map(s => s.trim()),
          strategy: { type: formData.strategy, params: {} },
          startDate: formData.startDate,
          endDate: formData.endDate,
          initialCapital: Number(formData.initialCapital)
        })
      });
      if (res.ok) {
        const json = await res.json();
        if (json.results && json.results.length > 0) {
          const firstResult = json.results[0];
          setResult({
            ...firstResult.metrics,
            trades: firstResult.trades,
            equityCurve: firstResult.equityCurve
          });
        } else {
          setResult(null);
        }
      } else {
        alert("回测请求失败");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!result || !chartRef.current) return;
    
    if (chartInstance) {
      chartInstance.remove();
    }

    const chart = createChart(chartRef.current, {
      layout: {
        background: { type: 'solid', color: 'transparent' } as any,
        textColor: '#787b86',
      },
      grid: {
        vertLines: { color: '#232733', style: LineStyle.Dotted },
        horzLines: { color: '#232733', style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: '#232733',
      },
      timeScale: {
        borderColor: '#232733',
        timeVisible: true,
      },
      autoSize: true,
    });

    const equitySeries = chart.addSeries(LineSeries, {
      color: '#f23645',
      lineWidth: 2,
    });

    if (result.equityCurve && result.equityCurve.length > 0) {
      equitySeries.setData(result.equityCurve.map((d: any) => ({
        time: Math.floor(new Date(d.date).getTime() / 1000) as any,
        value: d.equity
      })));
    }

    chart.timeScale().fitContent();
    setChartInstance(chart);

    return () => {
      chart.remove();
    };
  }, [result]);

  return (
    <div className="flex flex-col h-full w-full max-w-6xl mx-auto animate-in fade-in duration-300">
      <header className="mb-6 shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" /> 策略回测引擎
          </h1>
          <p className="text-[13px] text-muted">
            基于本地全量历史数据的量化策略模拟与收益评估
          </p>
        </div>
      </header>

      <div className="flex gap-6 h-full min-h-0">
        {/* Left Col: Config */}
        <div className="w-[300px] shrink-0 bg-surface-card-dark border border-hairline-dark rounded-lg p-5 flex flex-col gap-5 overflow-y-auto custom-scrollbar">
          <div className="flex items-center gap-2 mb-2 pb-2 border-b border-hairline-dark">
             <Settings2 className="w-4 h-4 text-muted" />
             <h3 className="text-[14px] font-medium text-white">回测参数</h3>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[12px] text-muted">测试标的 (英文逗号分隔)</label>
            <input 
              type="text" 
              value={formData.codes}
              onChange={e => setFormData({...formData, codes: e.target.value})}
              className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[12px] text-muted">策略类型</label>
            <select 
              value={formData.strategy}
              onChange={e => setFormData({...formData, strategy: e.target.value})}
              className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
            >
              <option value="macd_cross">MACD 金叉死叉</option>
              <option value="rsi_overbought">RSI 超买超卖</option>
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-2 flex-1">
              <label className="text-[12px] text-muted">开始日期</label>
              <input 
                type="date" 
                value={formData.startDate}
                onChange={e => setFormData({...formData, startDate: e.target.value})}
                className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
              />
            </div>
            <div className="flex flex-col gap-2 flex-1">
              <label className="text-[12px] text-muted">结束日期</label>
              <input 
                type="date" 
                value={formData.endDate}
                onChange={e => setFormData({...formData, endDate: e.target.value})}
                className="bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
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
                <><Play className="w-4 h-4 mr-2" /> 开始运行</>
              )}
            </Button>
          </div>
        </div>

        {/* Right Col: Results */}
        <div className="flex-1 bg-surface-card-dark border border-hairline-dark rounded-lg p-5 flex flex-col min-w-0">
          {!result && !running && (
             <div className="flex-1 flex flex-col items-center justify-center text-muted">
               <BarChart2 className="w-12 h-12 mb-4 opacity-20" />
               <p className="text-[13px]">配置参数后点击“开始运行”</p>
             </div>
          )}
          {running && (
             <div className="flex-1 flex flex-col items-center justify-center text-primary">
               <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
               <p className="text-[13px]">策略回测中，请稍候...</p>
             </div>
          )}
          {result && !running && (
            <div className="flex flex-col h-full">
               <div className="grid grid-cols-5 gap-4 mb-6 shrink-0">
                 <div className="bg-canvas-dark border border-hairline-dark rounded p-4">
                    <div className="text-[12px] text-muted mb-1">总收益率</div>
                    <div className={`text-[20px] font-mono font-bold ${result.totalReturn >= 0 ? 'text-trading-up' : 'text-trading-down'}`}>
                      {(result.totalReturn * 100).toFixed(2)}%
                    </div>
                 </div>
                 <div className="bg-canvas-dark border border-hairline-dark rounded p-4">
                    <div className="text-[12px] text-muted mb-1">年化收益</div>
                    <div className={`text-[20px] font-mono font-bold ${result.annualizedReturn >= 0 ? 'text-trading-up' : 'text-trading-down'}`}>
                      {(result.annualizedReturn * 100).toFixed(2)}%
                    </div>
                 </div>
                 <div className="bg-canvas-dark border border-hairline-dark rounded p-4">
                    <div className="text-[12px] text-muted mb-1">夏普比率</div>
                    <div className={`text-[20px] font-mono font-bold ${result.sharpeRatio >= 1 ? 'text-trading-up' : 'text-body-dark'}`}>
                      {result.sharpeRatio ? result.sharpeRatio.toFixed(2) : '0.00'}
                    </div>
                 </div>
                 <div className="bg-canvas-dark border border-hairline-dark rounded p-4">
                    <div className="text-[12px] text-muted mb-1">最大回撤</div>
                    <div className="text-[20px] font-mono font-bold text-trading-down">
                      {(result.maxDrawdown * 100).toFixed(2)}%
                    </div>
                 </div>
                 <div className="bg-canvas-dark border border-hairline-dark rounded p-4">
                    <div className="text-[12px] text-muted mb-1">交易胜率</div>
                    <div className="text-[20px] font-mono font-bold text-info">
                      {(result.winRate * 100).toFixed(2)}%
                    </div>
                 </div>
              </div>

              <div className="mb-4">
                 <h3 className="text-[14px] font-medium text-white mb-4">资金曲线 (Equity Curve)</h3>
                 <div ref={chartRef} className="h-[250px] w-full" />
              </div>

              <div className="flex-1 flex flex-col min-h-0">
                 <h3 className="text-[14px] font-medium text-white mb-3">交易记录 ({result.trades?.length || 0})</h3>
                 <div className="flex-1 overflow-y-auto custom-scrollbar border border-hairline-dark rounded bg-canvas-dark">
                    <table className="w-full text-left border-collapse text-[12px]">
                      <thead className="bg-surface-elevated-dark sticky top-0">
                        <tr>
                          <th className="py-2.5 px-4 font-medium text-muted border-b border-hairline-dark">日期</th>
                          <th className="py-2.5 px-4 font-medium text-muted border-b border-hairline-dark">类型</th>
                          <th className="py-2.5 px-4 font-medium text-muted border-b border-hairline-dark">价格</th>
                          <th className="py-2.5 px-4 font-medium text-muted border-b border-hairline-dark">盈亏</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades?.map((t: any, i: number) => (
                          <tr key={i} className="border-b border-hairline-dark hover:bg-surface-elevated-dark/50">
                            <td className="py-2.5 px-4 text-body-dark">{t.date}</td>
                            <td className="py-2.5 px-4">
                              <span className={`px-2 py-0.5 rounded ${t.type === 'buy' ? 'bg-trading-up/10 text-trading-up' : 'bg-trading-down/10 text-trading-down'}`}>
                                {t.type === 'buy' ? '买入' : '卖出'}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-white font-mono">{t.price.toFixed(2)}</td>
                            <td className="py-2.5 px-4 font-mono">
                              {t.profit ? (
                                <span className={t.profit > 0 ? 'text-trading-up' : 'text-trading-down'}>
                                  {t.profit > 0 ? '+' : ''}{(t.profit * 100).toFixed(2)}%
                                </span>
                              ) : '-'}
                            </td>
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
