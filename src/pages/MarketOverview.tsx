import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useNavigate } from "react-router-dom";
import { TrendingUp, TrendingDown, Activity, Bell, Cpu, Database, Zap, Flame, ChevronRight, Trash2 } from "lucide-react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { cn } from "../lib/utils";
import { fetcher } from "../lib/api";

const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtPrice = (v: number) => v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function MarketOverview() {
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();
  const { data, isLoading } = useSWR("/api/market/overview", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });

  const overview = data?.data;

  const removeAlert = useCallback(async (id: number) => {
    await fetch(`/api/alerts/${id}`, { method: "DELETE" });
    mutate("/api/market/overview");
  }, [mutate]);

  if (isLoading || !overview) {
    return (
      <div className="flex h-full items-center justify-center">
        <Activity className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  const { indices, breadth, industries, topGainers, topLosers, activeAlerts, poolCount } = overview;
  const upRatio = breadth.total > 0 ? breadth.up / breadth.total : 0;

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-300 overflow-y-auto custom-scrollbar">
      <header className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Flame className="w-6 h-6 text-primary" /> 投资大盘
          </h1>
          <p className="text-[13px] text-muted">沪深 300 智能投研 · 市场全景与持仓监控</p>
        </div>
        <div className="text-[12px] text-muted flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-trading-up animate-pulse" />
          监控 {poolCount} 只标的 · 实时刷新 60s
        </div>
      </header>

      {/* 市场全景：指数 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 shrink-0">
        {indices.map((idx: any) => {
          const up = idx.changePercentage >= 0;
          return (
            <Card key={idx.marketCode} variant="card-dark" className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px] text-muted">{idx.name}</span>
                {up ? <TrendingUp className="w-3.5 h-3.5 text-trading-up" /> : <TrendingDown className="w-3.5 h-3.5 text-trading-down" />}
              </div>
              <div className={cn("text-[22px] font-mono font-medium leading-none mb-1", up ? "text-trading-up" : "text-trading-down")}>
                {fmtPrice(idx.price)}
              </div>
              <div className={cn("text-[12px] font-mono", up ? "text-trading-up" : "text-trading-down")}>
                {fmtPct(idx.changePercentage)} ({up ? "+" : ""}{idx.changeAmount?.toFixed(2)})
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4 shrink-0">
        {/* 市场温度计 */}
        <Card variant="card-dark" className="p-4 flex flex-col">
          <h3 className="text-[14px] font-medium text-white mb-3">市场温度</h3>
          <div className="flex items-center gap-2 mb-3">
            <div className="flex-1 h-2 rounded-full overflow-hidden bg-trading-down flex">
              <div className="bg-trading-up h-full" style={{ width: `${upRatio * 100}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[18px] font-mono font-bold text-trading-up">{breadth.up}</div>
              <div className="text-[11px] text-muted">上涨</div>
            </div>
            <div>
              <div className="text-[18px] font-mono font-bold text-muted">{breadth.flat}</div>
              <div className="text-[11px] text-muted">平盘</div>
            </div>
            <div>
              <div className="text-[18px] font-mono font-bold text-trading-down">{breadth.down}</div>
              <div className="text-[11px] text-muted">下跌</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-hairline-dark text-center">
            <div>
              <span className="text-[13px] text-trading-up font-mono">{breadth.limitUp}</span>
              <span className="text-[11px] text-muted ml-1">涨停</span>
            </div>
            <div>
              <span className="text-[13px] text-trading-down font-mono">{breadth.limitDown}</span>
              <span className="text-[11px] text-muted ml-1">跌停</span>
            </div>
          </div>
        </Card>

        {/* 行业热度 */}
        <Card variant="card-dark" className="p-4 flex flex-col lg:col-span-2">
          <h3 className="text-[14px] font-medium text-white mb-3">行业热度 (按均涨幅)</h3>
          <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1.5 max-h-[180px]">
            {industries.slice(0, 12).map((ind: any) => {
              const up = ind.avgChange >= 0;
              const width = Math.min(100, Math.abs(ind.avgChange) * 20);
              return (
                <div key={ind.name} className="flex items-center gap-2 text-[12px]">
                  <span className="w-16 text-body-dark shrink-0 truncate" title={ind.name}>{ind.name}</span>
                  <div className="flex-1 h-4 bg-canvas-dark rounded relative overflow-hidden">
                    <div className={cn("absolute top-0 bottom-0 left-1/2", up ? "bg-trading-up/60" : "bg-trading-down/60")} style={{ width: `${width / 2}%` }} />
                    <div className="absolute top-0 bottom-0 left-1/2 w-px bg-hairline-dark" />
                  </div>
                  <span className={cn("w-16 text-right font-mono shrink-0", up ? "text-trading-up" : "text-trading-down")}>{fmtPct(ind.avgChange)}</span>
                  <span className="w-8 text-right text-muted shrink-0">{ind.count}</span>
                </div>
              );
            })}
            {industries.length === 0 && <div className="text-[12px] text-muted text-center py-4">暂无行业数据</div>}
          </div>
        </Card>
      </div>

      {/* 自选监控：涨跌幅龙虎榜 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 shrink-0">
        <Card variant="card-dark" className="p-4 flex flex-col">
          <h3 className="text-[14px] font-medium text-trading-up mb-3 flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4" /> 涨幅榜
          </h3>
          <div className="flex-1 space-y-1">
            {topGainers.map((s: any) => (
              <button key={s.marketCode} onClick={() => navigate(`/pool/${s.marketCode}`)} className="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-elevated-dark transition-colors group">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[13px] text-white group-hover:text-primary truncate">{s.name}</span>
                  <span className="text-[10px] text-muted font-mono shrink-0">{s.marketCode}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] text-muted hidden sm:inline">{s.industry}</span>
                  <span className={cn("text-[13px] font-mono w-16 text-right", s.changePercentage >= 0 ? "text-trading-up" : "text-trading-down")}>{s.price.toFixed(2)}</span>
                  <span className={cn("text-[12px] font-mono w-16 text-right", s.changePercentage >= 0 ? "text-trading-up" : "text-trading-down")}>{fmtPct(s.changePercentage)}</span>
                </div>
              </button>
            ))}
            {topGainers.length === 0 && <div className="text-[12px] text-muted text-center py-4">暂无数据</div>}
          </div>
        </Card>
        <Card variant="card-dark" className="p-4 flex flex-col">
          <h3 className="text-[14px] font-medium text-trading-down mb-3 flex items-center gap-1.5">
            <TrendingDown className="w-4 h-4" /> 跌幅榜
          </h3>
          <div className="flex-1 space-y-1">
            {topLosers.map((s: any) => (
              <button key={s.marketCode} onClick={() => navigate(`/pool/${s.marketCode}`)} className="w-full flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-elevated-dark transition-colors group">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[13px] text-white group-hover:text-primary truncate">{s.name}</span>
                  <span className="text-[10px] text-muted font-mono shrink-0">{s.marketCode}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] text-muted hidden sm:inline">{s.industry}</span>
                  <span className={cn("text-[13px] font-mono w-16 text-right", s.changePercentage >= 0 ? "text-trading-up" : "text-trading-down")}>{s.price.toFixed(2)}</span>
                  <span className={cn("text-[12px] font-mono w-16 text-right", s.changePercentage >= 0 ? "text-trading-up" : "text-trading-down")}>{fmtPct(s.changePercentage)}</span>
                </div>
              </button>
            ))}
            {topLosers.length === 0 && <div className="text-[12px] text-muted text-center py-4">暂无数据</div>}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 shrink-0">
        {/* 活跃预警监控 */}
        <Card variant="card-dark" className="p-4 flex flex-col lg:col-span-2">
          <h3 className="text-[14px] font-medium text-white mb-3 flex items-center gap-1.5">
            <Bell className="w-4 h-4 text-primary" /> 预警监控
            <span className="text-[11px] text-muted font-normal ml-1">{activeAlerts.length} 条活跃</span>
          </h3>
          <div className="flex-1 overflow-y-auto custom-scrollbar max-h-[180px]">
            {activeAlerts.length === 0 ? (
              <div className="text-[12px] text-muted text-center py-6">
                暂无活跃预警<br />
                <span className="text-[11px]">前往个股详情页设置价格预警</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {activeAlerts.map((a: any) => {
                  const isAbove = a.type === "price_above";
                  const approaching = a.distance !== null && a.distance < 0.03;
                  return (
                    <div key={a.id} className="flex items-center gap-2 text-[12px] py-1.5 px-2 rounded hover:bg-surface-elevated-dark group">
                      <button onClick={() => navigate(`/pool/${a.marketCode}`)} className="flex items-center gap-2 flex-1 text-left min-w-0">
                        <span className="text-white hover:text-primary truncate">{a.name}</span>
                        <span className="text-muted font-mono shrink-0">{a.marketCode}</span>
                      </button>
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] shrink-0", isAbove ? "bg-trading-up/10 text-trading-up" : "bg-trading-down/10 text-trading-down")}>
                        {isAbove ? "≥" : "≤"} {a.threshold}
                      </span>
                      <span className="text-muted font-mono shrink-0">现价 {a.currentPrice?.toFixed(2) || "-"}</span>
                      {approaching && <span className="text-[10px] text-primary shrink-0 animate-pulse">即将触发</span>}
                      <button onClick={() => removeAlert(a.id)} className="text-muted hover:text-trading-down opacity-0 group-hover:opacity-100 shrink-0">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* 快捷入口 */}
        <Card variant="card-dark" className="p-4 flex flex-col">
          <h3 className="text-[14px] font-medium text-white mb-3">快捷入口</h3>
          <div className="flex-1 flex flex-col gap-2">
            <QuickLink icon={Cpu} title="AI 智能选股" desc="多因子模型盘中选股" onClick={() => navigate("/ai-picks")} />
            <QuickLink icon={Activity} title="策略回测" desc="历史数据量化验证" onClick={() => navigate("/backtest")} />
            <QuickLink icon={Database} title="数据控制台" desc="行情同步与存储管理" onClick={() => navigate("/sync")} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function QuickLink({ icon: Icon, title, desc, onClick }: { icon: any; title: string; desc: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 p-3 rounded-lg bg-canvas-dark border border-hairline-dark hover:border-primary transition-colors text-left group">
      <div className="p-2 rounded-md bg-surface-elevated-dark text-primary group-hover:bg-primary group-hover:text-ink transition-colors shrink-0">
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-white font-medium">{title}</div>
        <div className="text-[11px] text-muted">{desc}</div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted group-hover:text-primary shrink-0" />
    </button>
  );
}
