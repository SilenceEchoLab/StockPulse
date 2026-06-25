import { useState, useEffect, useCallback } from "react";
import { Cpu, TrendingUp, AlertTriangle, ChevronRight, Activity, ArrowRight, ShieldCheck, Zap, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/Button";

const STRATEGY_LABEL: Record<string, string> = {
  three_cycle: '三周期', macd_cross: 'MACD', rsi_reversal: 'RSI', ma520: 'MA520',
};

interface AIPick {
  marketCode: string;
  name: string;
  score: number;
  reason: string;
  signals: { type: string; name: string; confidence: number }[];
  trendScore?: number | null;
  scoreBreakdown?: { trend: number; structure: number; volumePrice: number; timing: number } | null;
  // AutoResearch 反哺：经回测验证的策略多策略共识
  researchConsensus?: { buyCount: number; totalStrategies: number; consensusScore: number; buyVotes: string[] } | null;
}

// 策略缓存 + 模块级请求序列号，用于丢弃过期响应，消除竞态
type CacheEntry = { picks: AIPick[]; generatedAt: string; timing?: any };
const frontendCache: Record<string, CacheEntry> = {};
let requestSeq = 0;

export default function AiPicks() {
  const navigate = useNavigate();
  const [activeStrategy, setActiveStrategy] = useState("value");
  const [picks, setPicks] = useState<AIPick[]>([]);
  const [loading, setLoading] = useState(true);        // 初次加载/切换策略的检查
  const [generating, setGenerating] = useState(false);  // AI 推理中（强制遮罩）
  const [generatedAt, setGeneratedAt] = useState("");
  const [needsGeneration, setNeedsGeneration] = useState(false);
  const [addedCodes, setAddedCodes] = useState<Set<string>>(new Set());
  const [timing, setTiming] = useState<any>(null);   // 大盘择时上下文（regime/仓位上限）

  const addToPool = async (code: string, name: string) => {
    if (addedCodes.has(code)) return;
    await fetch('/api/pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name })
    });
    setAddedCodes(prev => new Set(prev).add(code));
  };

  const strategies = [
    { id: "value", name: "价值发现", desc: "基于基本面与低估值模型", icon: ShieldCheck },
    { id: "momentum", name: "动量追踪", desc: "强势股趋势跟随策略", icon: TrendingUp },
    { id: "contrarian", name: "逆向反转", desc: "超跌反弹与底部结构捕捉", icon: Zap },
  ];

  // 拉取选股结果。force=true 时触发 AI 推理（耗时较长），用序列号丢弃过期响应
  const fetchPicks = useCallback(async (strategy: string, force = false) => {
    if (force) setGenerating(true); else setLoading(true);
    const seq = ++requestSeq;
    try {
      const res = await fetch("/api/ai/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy, count: 5, forceRefresh: force })
      });
      // 响应到达时若已被后续请求取代，则丢弃，避免旧结果覆盖新状态
      if (seq !== requestSeq) return;
      if (res.ok) {
        const json = await res.json();
        if (seq !== requestSeq) return;
        if (json.needsGeneration) {
          setPicks([]);
          setNeedsGeneration(true);
        } else {
          const list = json.picks || [];
          // AI 评分统一按分数降序排列，保证排名稳定
          list.sort((a: AIPick, b: AIPick) => b.score - a.score);
          const t = json.timing || null;
          setPicks(list);
          setTiming(t);
          setGeneratedAt(json.generatedAt || new Date().toISOString());
          setNeedsGeneration(false);
          frontendCache[strategy] = {
            picks: list,
            generatedAt: json.generatedAt || new Date().toISOString(),
            timing: t,
          };
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (seq !== requestSeq) return;
      if (force) setGenerating(false); else setLoading(false);
    }
  }, []);

  // 切换策略：命中缓存立即展示，否则静默检查是否已生成
  useEffect(() => {
    const cached = frontendCache[activeStrategy];
    if (cached) {
      setPicks(cached.picks);
      setTiming(cached.timing);
      setGeneratedAt(cached.generatedAt);
      setNeedsGeneration(false);
      setLoading(false);
    } else {
      fetchPicks(activeStrategy, false);
    }
  }, [activeStrategy, fetchPicks]);

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

      {/* 大盘择时上下文：选股结果须与大盘环境挂钩（手册 STEP1） */}
      {timing && (
        <div className="mb-6 shrink-0 flex items-center gap-4 p-3 rounded-lg bg-surface-card-dark border border-hairline-dark">
          <div className={`px-2.5 py-1 rounded text-[12px] font-medium ${timing.regime === 'bull' ? 'bg-trading-up/15 text-trading-up' : timing.regime === 'bear' ? 'bg-trading-down/15 text-trading-down' : 'bg-yellow-400/15 text-yellow-400'}`}>
            {timing.regimeLabel}
          </div>
          <div className="text-[12px] text-muted">
            建议总仓位上限 <span className="text-white font-mono font-semibold">{Math.round(timing.maxPosition * 100)}%</span>
          </div>
          <div className="text-[12px] text-body-dark flex-1 min-w-0 truncate">
            当前选股在大盘 <span className="text-white">{timing.regime === 'bull' ? '多头' : timing.regime === 'bear' ? '空头' : '震荡'}</span> 环境下生成，{timing.regime === 'bear' ? '宜轻仓/防御' : timing.regime === 'bull' ? '可积极配置' : '半仓滚动'}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 shrink-0">
        {strategies.map(s => {
          const Icon = s.icon;
          const isActive = activeStrategy === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setActiveStrategy(s.id)}
              className={`p-5 rounded-lg border text-left transition-all cursor-pointer ${
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
            </div>
          )
        })}
      </div>

      <div className="flex-1 bg-surface-card-dark border border-hairline-dark rounded-lg overflow-hidden flex flex-col relative">
        {/* AI 推理中：强制全屏遮罩，避免用户误以为卡死或重复点击 */}
        {generating ? (
           <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-surface-card-dark bg-opacity-90">
              <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
              <span className="text-[14px] text-primary font-medium">模型运算中，请稍候...</span>
              <span className="text-[11px] text-muted mt-2">大模型正在分析全量技术面与基本面数据，通常需要 5-15 秒</span>
           </div>
        ) : null}

        <div className="overflow-y-auto p-4 custom-scrollbar flex-1">
           {needsGeneration && !generating ? (
             <div className="flex flex-col items-center justify-center h-full text-muted">
               <Cpu className="w-10 h-10 mb-3 text-primary" />
               <p className="text-[14px] text-white mb-2">今日该策略的 AI 选股尚未生成</p>
               <p className="text-[12px] mb-6">点击下方按钮，调用大模型对全量数据进行特征推断</p>
               <Button onClick={() => fetchPicks(activeStrategy, true)} className="px-6">
                 立即生成策略
               </Button>
             </div>
           ) : loading && !generating ? (
             <div className="flex flex-col items-center justify-center h-full text-muted">
               <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3"></div>
               <span className="text-[13px]">加载选股结果...</span>
             </div>
           ) : picks.length === 0 && !generating ? (
             <div className="flex flex-col items-center justify-center h-full text-muted">
               <AlertTriangle className="w-10 h-10 mb-3 opacity-20" />
               <p className="text-[13px]">当前策略下暂无推荐标的</p>
             </div>
           ) : (
             <div className="space-y-4">
                {picks.map((pick, i) => {
                  const scoreColor = pick.score >= 85 ? 'text-trading-up' : pick.score >= 70 ? 'text-info' : 'text-muted';
                  const scoreBg = pick.score >= 85 ? 'bg-trading-up' : pick.score >= 70 ? 'bg-info' : 'bg-muted';
                  return (
                  <div key={pick.marketCode} className="bg-canvas-dark border border-hairline-dark rounded p-5 hover:border-body-dark transition-colors group">
                     <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">

                        <div className="flex-[2]">
                           <div className="flex items-center gap-3 mb-2">
                             {/* 排名徽章 */}
                             <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${i < 3 ? 'bg-primary text-ink' : 'bg-surface-elevated-dark text-muted'}`}>{i + 1}</span>
                             <div className="flex items-baseline gap-2 cursor-pointer hover:underline" onClick={() => navigate(`/pool/${pick.marketCode}`)}>
                               <span className="text-[18px] font-bold text-white">{pick.name}</span>
                               <span className="text-[13px] text-muted font-mono uppercase">{pick.marketCode}</span>
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
                             {pick.researchConsensus && pick.researchConsensus.buyCount > 0 && (
                               <span className="text-[11px] px-2 py-1 rounded bg-primary/10 border border-primary/30 text-primary flex items-center gap-1" title={`经回测验证的策略：${pick.researchConsensus.buyVotes.map(v => STRATEGY_LABEL[v] || v).join('、')}`}>
                                 <ShieldCheck className="w-3 h-3" /> {pick.researchConsensus.buyCount}/{pick.researchConsensus.totalStrategies} 策略验证
                               </span>
                             )}
                           </div>
                        </div>

                        <div className="flex flex-col items-end justify-between gap-3 shrink-0 md:pl-6 md:border-l border-hairline-dark md:min-w-[140px]">
                           {/* AI 评分 + 可视化进度条 */}
                           <div className="w-full">
                             <div className="flex items-center justify-between mb-1">
                               <span className="text-[11px] text-muted">AI 综合评分</span>
                               <span className={`text-[18px] font-mono font-bold ${scoreColor}`}>{pick.score}</span>
                             </div>
                             <div className="w-full h-1.5 bg-surface-elevated-dark rounded-full overflow-hidden">
                               <div className={`h-full ${scoreBg} transition-all`} style={{ width: `${pick.score}%` }} />
                             </div>
                             {/* 引擎评分维度 */}
                             {pick.scoreBreakdown && (
                               <div className="grid grid-cols-4 gap-1.5 mt-2.5">
                                 {[
                                   { label: '趋势', val: pick.scoreBreakdown.trend, max: 40 },
                                   { label: '结构', val: pick.scoreBreakdown.structure, max: 30 },
                                   { label: '量价', val: pick.scoreBreakdown.volumePrice, max: 15 },
                                   { label: '时机', val: pick.scoreBreakdown.timing, max: 15 },
                                 ].map(d => (
                                   <div key={d.label} className="flex flex-col items-center">
                                     <div className="w-full h-0.5 bg-surface-elevated-dark rounded-full overflow-hidden mb-0.5">
                                       <div className="bg-primary h-full" style={{ width: `${d.max > 0 ? (d.val / d.max) * 100 : 0}%` }} />
                                     </div>
                                     <span className="text-[9px] text-muted">{d.label}</span>
                                   </div>
                                 ))}
                               </div>
                             )}
                           </div>
                           <div className="flex items-center gap-2">
                             <button
                               onClick={() => addToPool(pick.marketCode, pick.name)}
                               disabled={addedCodes.has(pick.marketCode)}
                               className={`text-[12px] underline decoration-hairline-dark underline-offset-4 transition-colors ${addedCodes.has(pick.marketCode) ? 'text-trading-up' : 'text-muted hover:text-white'}`}
                             >
                               {addedCodes.has(pick.marketCode) ? '已加入' : '加入自选'}
                             </button>
                             <Button onClick={() => navigate(`/pool/${pick.marketCode}`)} className="px-4 text-[13px]">
                               详情 <ArrowRight className="w-3.5 h-3.5 ml-1" />
                             </Button>
                           </div>
                        </div>
                     </div>
                  </div>
                  );
                })}
             </div>
           )}
        </div>
      </div>
    </div>
  );
}
