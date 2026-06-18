import { useState, useEffect } from "react";
import { Cpu, TrendingUp, AlertTriangle, ChevronRight, Activity, ArrowRight, ShieldCheck, Zap, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";

interface AIPick {
  marketCode: string;
  name: string;
  score: number;
  reason: string;
  signals: { type: string; name: string; confidence: number }[];
}
const frontendCache: Record<string, { picks: AIPick[], generatedAt: string }> = {};

export default function AiPicks() {
  const navigate = useNavigate();
  const [activeStrategy, setActiveStrategy] = useState("value");
  const [picks, setPicks] = useState<AIPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [generatedAt, setGeneratedAt] = useState("");
  const [needsGeneration, setNeedsGeneration] = useState(false);

  const strategies = [
    { id: "value", name: "价值发现", desc: "基于基本面与低估值模型", icon: ShieldCheck },
    { id: "momentum", name: "动量追踪", desc: "强势股趋势跟随策略", icon: TrendingUp },
    { id: "contrarian", name: "逆向反转", desc: "超跌反弹与底部结构捕捉", icon: Zap },
  ];

  const fetchPicks = async (strategy: string, force = false) => {
    if (force) setLoading(true);
    if (!force) setNeedsGeneration(false); // only reset if we're silently checking
    try {
      const res = await fetch("/api/ai/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy, count: 5, forceRefresh: force })
      });
      if (res.ok) {
        const json = await res.json();
        if (json.needsGeneration) {
          setPicks([]);
          setNeedsGeneration(true);
        } else {
          setPicks(json.picks || []);
          setGeneratedAt(json.generatedAt || new Date().toISOString());
          frontendCache[strategy] = {
            picks: json.picks || [],
            generatedAt: json.generatedAt || new Date().toISOString()
          };
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (force) setLoading(false);
    }
  };

  useEffect(() => {
    if (frontendCache[activeStrategy]) {
      setPicks(frontendCache[activeStrategy].picks);
      setGeneratedAt(frontendCache[activeStrategy].generatedAt);
      setNeedsGeneration(false);
    } else {
      fetchPicks(activeStrategy, false);
    }
  }, [activeStrategy]);

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-300 w-full max-w-5xl mx-auto">
      <header className="mb-6 shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1 flex items-center gap-2">
            <Cpu className="w-6 h-6 text-primary" /> AI 智能选股
          </h1>
          <p className="text-[13px] text-muted">
            基于大语言模型与多因子模型的盘中实时选股推荐
          </p>
        </div>
        {generatedAt && !needsGeneration && (
          <div className="text-[12px] text-muted bg-surface-elevated-dark px-3 py-1.5 rounded-full flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-primary" /> 更新于 {new Date(generatedAt).toLocaleTimeString()}
          </div>
        )}
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 shrink-0">
        {strategies.map(s => {
          const Icon = s.icon;
          const isActive = activeStrategy === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActiveStrategy(s.id)}
              className={`p-5 rounded-lg border text-left transition-all ${
                isActive 
                  ? 'bg-primary/10 border-primary ring-1 ring-primary/20' 
                  : 'bg-surface-card-dark border-hairline-dark hover:border-body-dark hover:bg-surface-elevated-dark'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-md ${isActive ? 'bg-primary text-ink' : 'bg-canvas-dark text-muted'}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <h3 className={`text-[15px] font-bold ${isActive ? 'text-primary' : 'text-white'}`}>{s.name}</h3>
                </div>
                {isActive && !needsGeneration && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); fetchPicks(s.id, true); }}
                    title="强制重新生成"
                    className="p-1.5 rounded-md bg-canvas-dark text-primary hover:bg-primary/20 hover:text-white transition-colors border border-primary/20 flex items-center justify-center group/btn"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : 'group-hover/btn:rotate-180 transition-transform duration-500'}`} />
                  </button>
                )}
              </div>
              <p className="text-[12px] text-muted leading-relaxed">{s.desc}</p>
            </button>
          )
        })}
      </div>

      <div className="flex-1 bg-surface-card-dark border border-hairline-dark rounded-lg overflow-hidden flex flex-col relative">
        {loading ? (
           <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-card-dark bg-opacity-80">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
              <span className="text-[13px] text-primary">模型运算中...</span>
           </div>
        ) : null}

        <div className="overflow-y-auto p-4 custom-scrollbar flex-1">
           {needsGeneration && !loading ? (
             <div className="flex flex-col items-center justify-center h-full text-muted">
               <Cpu className="w-10 h-10 mb-3 text-primary" />
               <p className="text-[14px] text-white mb-2">今日该策略的 AI 选股尚未生成</p>
               <p className="text-[12px] mb-6">点击下方按钮，调用大模型对全量数据进行特征推断</p>
               <Button onClick={() => fetchPicks(activeStrategy, true)} className="px-6">
                 立即生成策略
               </Button>
             </div>
           ) : picks.length === 0 && !loading ? (
             <div className="flex flex-col items-center justify-center h-full text-muted">
               <AlertTriangle className="w-10 h-10 mb-3 opacity-20" />
               <p className="text-[13px]">当前策略下暂无推荐标的</p>
             </div>
           ) : (
             <div className="space-y-4">
                {picks.map((pick, i) => (
                  <div key={pick.marketCode} className="bg-canvas-dark border border-hairline-dark rounded p-5 hover:border-body-dark transition-colors group">
                     <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                        
                        <div className="flex-[2]">
                           <div className="flex items-center gap-3 mb-2">
                             <div className="flex items-baseline gap-2 cursor-pointer hover:underline" onClick={() => navigate(`/pool/${pick.marketCode}`)}>
                               <span className="text-[18px] font-bold text-white">{pick.name}</span>
                               <span className="text-[13px] text-muted font-mono uppercase">{pick.marketCode}</span>
                             </div>
                             <div className="px-2 py-0.5 bg-trading-up/10 text-trading-up text-[11px] rounded font-medium border border-trading-up/20">
                               AI 评分 {pick.score}
                             </div>
                           </div>
                           <p className="text-[13px] text-body-dark leading-relaxed mb-4">
                             {pick.reason}
                           </p>
                           <div className="flex flex-wrap items-center gap-2">
                             {pick.signals?.map((sig, idx) => (
                               <span key={idx} className={`text-[11px] px-2 py-1 rounded bg-surface-elevated-dark border border-hairline-dark flex items-center gap-1 ${sig.type === 'bullish' ? 'text-trading-up' : 'text-trading-down'}`}>
                                 {sig.type === 'bullish' ? '▲' : '▼'} {sig.name} ({(sig.confidence * 100).toFixed(0)}%)
                               </span>
                             ))}
                           </div>
                        </div>

                        <div className="flex flex-row md:flex-col items-center md:items-end justify-between md:justify-start gap-4 shrink-0 md:pl-6 md:border-l border-hairline-dark">
                           <Button onClick={() => navigate(`/pool/${pick.marketCode}`)} className="px-4 text-[13px]">
                             查看详情 <ArrowRight className="w-3.5 h-3.5 ml-1" />
                           </Button>
                           <button className="text-[12px] text-muted hover:text-white underline decoration-hairline-dark underline-offset-4">
                             加入自选
                           </button>
                        </div>
                     </div>
                  </div>
                ))}
             </div>
           )}
        </div>
      </div>
    </div>
  );
}
