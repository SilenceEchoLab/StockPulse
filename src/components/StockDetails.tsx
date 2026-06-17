import { useState, useEffect } from "react";
import { Plus, Bell, Minus } from "lucide-react";
import { StockData } from "../types";
import { KLineChart } from "./KLineChart";
import { Button } from "./ui/Button";
import { useNavigate } from "react-router-dom";

interface KlineData {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  macd?: number;
  macdSignal?: number;
  macdHist?: number;
  rsi14?: number;
  bollMid?: number;
  bollUpper?: number;
  bollLower?: number;
  kdjK?: number;
  kdjD?: number;
  kdjJ?: number;
}

export default function StockDetails({ stock, onBack }: { stock: StockData; onBack: () => void }) {
  const [klineData, setKlineData] = useState<KlineData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>('day');
  const [activeIndicator, setActiveIndicator] = useState<'MACD' | 'KDJ' | 'RSI'>('MACD');
  const [inPool, setInPool] = useState<boolean>(false);

  const [aiSentiment, setAiSentiment] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState<boolean>(true);
  const [aiError, setAiError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchAi = async () => {
      try {
        setAiLoading(true);
        setAiError(null);
        const res = await fetch(`/api/ai/sentiment/${stock.marketCode}`);
        const json = await res.json();
        if (res.ok && json.success) {
          setAiSentiment(json.data);
        } else {
          if (json.error === 'AI_NOT_CONFIGURED') {
            setAiError('AI_NOT_CONFIGURED');
          } else {
            console.error(json.error);
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        setAiLoading(false);
      }
    };
    fetchAi();
  }, [stock.marketCode]);

  useEffect(() => {
    const checkPool = async () => {
      try {
        const response = await fetch('/api/pool');
        if (response.ok) {
          const json = await response.json();
          const pCodes = json.data.map((s: any) => s.marketCode);
          setInPool(pCodes.includes(stock.marketCode));
        }
      } catch (e) {
        console.error(e);
      }
    };
    checkPool();
  }, [stock.marketCode]);

  const togglePool = async () => {
    try {
      if (inPool) {
        await fetch(`/api/pool/${stock.marketCode}`, { method: 'DELETE' });
        setInPool(false);
      } else {
        await fetch('/api/pool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: stock.marketCode, name: stock.name })
        });
        setInPool(true);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    const fetchKlineData = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/kline/${stock.marketCode}?period=${period}`);
        if (!response.ok) {
          throw new Error("Failed to fetch historical data.");
        }
        const result = await response.json();
        if (result.success) {
          setKlineData(result.data);
        } else {
          throw new Error(result.error || "Failed to fetch historical data.");
        }
      } catch (e: any) {
        console.error("Kline fetch error:", e);
        if (e.name === 'TypeError' && e.message === 'Failed to fetch') {
          setError("网络错误: 无法连接服务器。");
        } else {
          setError(e.message || "发生未知错误。");
        }
      } finally {
        setLoading(false);
      }
    };
    fetchKlineData();
  }, [stock.marketCode, period]);

  const getFormatForChange = (val: number) => {
    if (val > 0) return "text-trading-up"; // trading-up is green, Wait, standard market: red is up in China. But I'll stick to original Binance logic where green is up. Wait, original used #f23645 (red) for > 0 and #1bb154 (green) for < 0 because it's a Chinese stock tracker!
    // In China: Red (#f23645) is UP. Green (#1bb154) is DOWN.
    // In DESIGN.md Binance style: Green (#0ecb81) is UP. Red (#f6465d) is DOWN.
    // So let's map: > 0 to trading-down (red) so it displays red? NO, wait.
    // Binance style `trading-up` is Green. If the user expects Red for UP, we should map it properly.
    // But since DESIGN.md says `trading-up` is green, let's keep Binance semantics: green is up, red is down.
    if (val > 0) return "text-trading-up";
    if (val < 0) return "text-trading-down";
    return "text-muted";
  };

  // Keep Chinese market color conventions for the chart itself but using CSS variables
  const colorUp = "var(--color-trading-down)"; // Red for UP (A-share)
  const colorDown = "var(--color-trading-up)"; // Green for DOWN (A-share)

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-surface-card-dark border border-hairline-dark px-3 py-2 shadow-lg text-[12px] relative pointer-events-none z-50 min-w-[120px] rounded">
          <p className="text-muted mb-1 pb-1 border-b border-hairline-dark">{label}</p>
          {payload.map((p: any, i: number) => {
            const val = typeof p.value === 'number' ? p.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p.value;
            let color = p.color || 'var(--color-body-dark)';
            if (color === '#4d7bf3') color = 'var(--color-primary)';
            return (
              <p key={i} style={{ color }} className="font-mono mt-1 flex justify-between">
                <span>{p.name}</span> <span className="ml-4">{val}</span>
              </p>
            );
          })}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-surface-card-dark border border-hairline-dark rounded animate-in fade-in duration-300 h-full flex flex-col">
      {/* Top Bar with Name & Value */}
      <div className="border-b border-hairline-dark p-5 flex flex-col xl:flex-row xl:items-start gap-8 relative shrink-0">
        
        <div className="flex flex-col xl:min-w-[400px]">
          <div className="flex items-center justify-between mb-4">
             <div className="flex items-baseline gap-3">
               <h1 className="text-[22px] font-bold text-white leading-tight">{stock.name}</h1>
               <span className="text-[14px] text-muted uppercase font-mono">{stock.marketCode}</span>
             </div>
             <div className="flex items-center gap-2 xl:hidden">
                <Button onClick={togglePool} variant="secondary-on-dark" className={`flex items-center gap-1.5 px-3 py-1.5 border border-hairline-dark rounded text-[12px] transition-colors ${inPool ? 'text-primary' : 'text-body-dark'}`}>
                  {inPool ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {inPool ? '删自选' : '加自选'}
                </Button>
             </div>
          </div>

          <div className="flex items-end gap-5">
            <span className={`text-[36px] leading-[1] font-mono font-medium ${getFormatForChange(stock.changePercentage)}`}>
              {stock.price.toFixed(2)}
            </span>
            <div className={`flex flex-col text-[13px] font-mono font-medium leading-tight pb-1 gap-1 ${getFormatForChange(stock.changePercentage)}`}>
              <span>{stock.changeAmount > 0 ? '+' : ''}{stock.changeAmount.toFixed(2)}</span>
              <span>{stock.changePercentage > 0 ? '+' : ''}{stock.changePercentage.toFixed(2)}%</span>
            </div>
          </div>
        </div>

        {/* Dense Grid of Details */}
        <div className="flex-1 grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-3 text-[13px] mt-4 xl:mt-0 xl:ml-8 font-mono">
          <div className="flex flex-col gap-1 justify-between">
            <span className="text-muted">今开</span>
            <span className={`${getFormatForChange(stock.open - stock.previousClose)}`}>{stock.open.toFixed(2)}</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">最高</span>
            <span className={`${getFormatForChange(stock.high - stock.previousClose)}`}>{stock.high.toFixed(2)}</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">成交量</span>
            <span className="text-white">{(stock.volume / 10000).toFixed(2)}万</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">流通市值</span>
            <span className="text-white">{stock.circulatingMarketValue ? stock.circulatingMarketValue.toFixed(2) : '-'}亿</span>
          </div>

          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">昨收</span>
            <span className="text-white">{stock.previousClose.toFixed(2)}</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">最低</span>
            <span className={`${getFormatForChange(stock.low - stock.previousClose)}`}>{stock.low.toFixed(2)}</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">成交额</span>
            <span className="text-white">{(stock.turnover / 100000000).toFixed(2)}亿</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">总市值</span>
            <span className="text-white">{stock.totalMarketValue ? stock.totalMarketValue.toFixed(2) : '-'}亿</span>
          </div>
        </div>
        
        <div className="absolute top-5 right-5 hidden xl:flex gap-2">
           <Button onClick={togglePool} variant="secondary-on-dark" className={`flex items-center gap-1.5 px-3 py-1.5 border border-hairline-dark rounded text-[12px] transition-colors ${inPool ? 'text-primary' : 'text-body-dark'}`}>
             {inPool ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {inPool ? '删自选' : '加自选'}
           </Button>
           <Button variant="secondary-on-dark" className="flex items-center gap-1.5 px-3 py-1.5 border border-hairline-dark rounded text-[12px] text-body-dark transition-colors">
             <Bell className="w-3.5 h-3.5" /> 预警
           </Button>
           <Button 
             onClick={onBack}
             variant="secondary-on-dark"
             className="px-3 py-1.5 border border-hairline-dark rounded text-[12px] text-body-dark transition-colors"
           >
             返回
           </Button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        {/* Left Col: Charts */}
        <div className="flex-[3] border-r border-hairline-dark flex flex-col">
          <div className="flex gap-6 border-b border-hairline-dark px-5 pt-3 relative shrink-0">
            {[
              { id: 'time', label: '分时' },
              { id: 'm5', label: '5分' },
              { id: 'm30', label: '30分' },
              { id: 'm60', label: '60分' },
              { id: 'day', label: '日K' },
              { id: 'week', label: '周K' },
              { id: 'month', label: '月K' },
            ].map(p => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={`pb-2 text-[13px] font-medium transition-colors border-b-2 ${period === p.id ? 'text-primary border-primary' : 'text-muted border-transparent hover:text-body-dark'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          
          <div className="flex-1 relative pt-4 pr-6 pl-2 pb-2 min-h-[300px]">
            {loading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-card-dark bg-opacity-80">
                <span className="text-[13px] text-muted">加载K线数据...</span>
              </div>
            )}
            
            {error && (
              <div className="absolute inset-0 z-10 flex items-center justify-center p-6 text-center bg-surface-card-dark">
                <div className="text-trading-down text-[13px]">
                  数据请求失败: {error}
                </div>
              </div>
            )}

            <KLineChart data={klineData} activeIndicator={activeIndicator} period={period} />
          </div>
          <div className="flex gap-6 pt-3 px-5 border-t border-hairline-dark shrink-0">
             {['MACD', 'KDJ', 'RSI'].map(ind => (
               <button
                 key={ind}
                 onClick={() => setActiveIndicator(ind as 'MACD' | 'KDJ' | 'RSI')}
                 className={`pb-2 text-[12px] font-medium transition-colors border-b-2 ${activeIndicator === ind ? 'text-primary border-primary' : 'text-muted border-transparent hover:text-body-dark'}`}
               >
                 {ind}
               </button>
             ))}
          </div>
        </div>

        {/* Right Col: AI Insights */}
        <div className="flex-[1] p-5 flex flex-col gap-6 bg-surface-card-dark overflow-y-auto custom-scrollbar">
           <div>
             <div className="flex items-center justify-between mb-3">
               <h4 className="text-[13px] font-medium text-white pl-2 border-l-2 border-primary">
                 AI 情绪指标
               </h4>
               {aiSentiment?.updatedAt && (
                 <span className="text-[11px] text-muted font-mono">{new Date(aiSentiment.updatedAt).toLocaleTimeString()}</span>
               )}
             </div>
             
             {aiLoading ? (
               <div className="bg-canvas-dark border border-hairline-dark rounded p-4 flex flex-col items-center justify-center min-h-[140px]">
                  <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mb-2"></div>
                  <span className="text-[12px] text-muted">AI 深度分析中...</span>
               </div>
             ) : aiError === 'AI_NOT_CONFIGURED' ? (
               <div className="bg-canvas-dark border border-hairline-dark rounded p-4 flex flex-col items-center justify-center py-6">
                 <div className="text-[13px] text-muted mb-3">暂无 AI 提供商配置</div>
                 <Button onClick={() => navigate('/settings')} variant="secondary-on-dark" className="px-4 py-1.5 border border-primary text-primary rounded text-[12px] hover:bg-primary/10 transition-colors">
                   ⚙️ 前往设置配置 AI
                 </Button>
               </div>
             ) : aiSentiment ? (
               <div className="bg-canvas-dark border border-hairline-dark rounded p-4 flex flex-col">
                 <div className="flex items-center justify-between mb-4 pb-4 border-b border-hairline-dark">
                    <div className="flex flex-col">
                      <span className={`text-[32px] font-mono leading-none ${aiSentiment.score >= 60 ? 'text-trading-up' : aiSentiment.score <= 40 ? 'text-trading-down' : 'text-info'}`}>
                        {aiSentiment.score}
                      </span>
                      <span className="text-[11px] text-muted mt-1">综合评分 (0-100)</span>
                    </div>
                    <div className={`px-3 py-1.5 rounded-md text-[13px] font-medium ${
                      aiSentiment.label === '积极' ? 'bg-trading-up/10 text-trading-up' : 
                      aiSentiment.label === '消极' ? 'bg-trading-down/10 text-trading-down' : 'bg-surface-elevated-dark text-info'
                    }`}>
                      {aiSentiment.label}
                    </div>
                 </div>

                 <div className="mb-4">
                   <h5 className="text-[12px] text-muted mb-2">📊 技术信号</h5>
                   <div className="flex flex-col gap-2">
                     {aiSentiment.signals?.map((sig: any, idx: number) => (
                       <div key={idx} className="flex items-center justify-between text-[12px]">
                         <div className="flex items-center gap-1.5">
                           <span className={sig.type === 'bullish' ? 'text-trading-up' : 'text-trading-down'}>
                             {sig.type === 'bullish' ? '▲' : '▼'}
                           </span>
                           <span className="text-body-dark">{sig.name}</span>
                         </div>
                         <span className="text-muted font-mono">{(sig.confidence * 100).toFixed(0)}%</span>
                       </div>
                     ))}
                     {(!aiSentiment.signals || aiSentiment.signals.length === 0) && (
                       <span className="text-[12px] text-muted">暂无显著信号</span>
                     )}
                   </div>
                 </div>

                 <div>
                   <h5 className="text-[12px] text-muted mb-2">💬 AI 点评</h5>
                   <p className="text-[13px] text-body-dark leading-relaxed">
                     "{aiSentiment.summary}"
                   </p>
                 </div>
               </div>
             ) : (
               <div className="bg-canvas-dark border border-hairline-dark rounded p-4 text-center py-8">
                 <div className="text-[12px] text-muted">暂无 AI 分析数据</div>
               </div>
             )}
           </div>
           
           <div>
             <h4 className="text-[13px] font-medium text-white mb-3 pl-2 border-l-2 border-primary">
               主力资金分析
             </h4>
             <div className="bg-canvas-dark border border-hairline-dark rounded p-4 text-center py-8 text-[12px] text-muted">
               等待 L2 数据源接入...
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}
