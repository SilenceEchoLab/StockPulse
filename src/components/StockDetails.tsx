import { useState, useEffect } from "react";
import { Plus, Bell, Minus, X } from "lucide-react";
import useSWR from "swr";
import { StockData, type KlineData } from "../types";
import { KLineChart } from "./KLineChart";
import { Button } from "./ui/Button";
import { useNavigate } from "react-router-dom";
import { fetcher } from "../lib/api";

export default function StockDetails({ stock, onBack }: { stock: StockData; onBack: () => void }) {
  const [period, setPeriod] = useState<string>('day');
  const [activeIndicator, setActiveIndicator] = useState<'MACD' | 'KDJ' | 'RSI'>('MACD');
  const [inPool, setInPool] = useState<boolean>(false);

  const [aiSentiment, setAiSentiment] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState<boolean>(true);
  const [aiError, setAiError] = useState<string | null>(null);
  const [signalReport, setSignalReport] = useState<any>(null);
  const navigate = useNavigate();

  // 价格预警弹窗状态
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertType, setAlertType] = useState<'price_above' | 'price_below'>('price_above');
  const [alertThreshold, setAlertThreshold] = useState('');
  const [alertSubmitting, setAlertSubmitting] = useState(false);
  const [alertToast, setAlertToast] = useState<string | null>(null);

  const openAlertModal = () => {
    setAlertThreshold(stock.price.toFixed(2));
    setAlertType('price_above');
    setShowAlertModal(true);
  };

  const createAlert = async () => {
    const threshold = parseFloat(alertThreshold);
    if (isNaN(threshold) || threshold <= 0) return;
    setAlertSubmitting(true);
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketCode: stock.marketCode, type: alertType, threshold })
      });
      if (res.ok) {
        setShowAlertModal(false);
        setAlertToast(`预警已设置：${alertType === 'price_above' ? '涨破' : '跌破'} ${threshold}`);
        setTimeout(() => setAlertToast(null), 3000);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setAlertSubmitting(false);
    }
  };

  // 主力资金动向（基于 L1 主动买卖盘估算）
  const outer = stock.outerDisc || 0;
  const inner = stock.innerDisc || 0;
  const totalDisc = outer + inner;
  const netDisc = outer - inner;
  const netRatio = totalDisc > 0 ? netDisc / totalDisc : 0;
  const isNetInflow = netDisc >= 0;

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

  // 量化买卖信号（纯本地引擎，无需 AI Key）
  useEffect(() => {
    const fetchSignals = async () => {
      try {
        const res = await fetch(`/api/ai/signals/${stock.marketCode}`);
        const json = await res.json();
        if (res.ok && json.success) {
          setSignalReport(json.data);
        }
      } catch (e) {
        console.error(e);
      }
    };
    fetchSignals();
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

  // 使用 SWR 缓存 K 线数据，避免切换周期时重复请求
  const { data: klineRes, error: klineSwrError, isLoading: klineLoading } = useSWR(
    `/api/kline/${stock.marketCode}?period=${period}`,
    fetcher,
    {
      dedupingInterval: 60000, // K线数据1分钟内不再重复请求
      revalidateOnFocus: false // 切换回页面不需要立刻刷新长周期K线
    }
  );

  const klineData: KlineData[] = klineRes?.data || [];
  const loading = klineLoading;
  const error = klineSwrError?.message || (klineRes && !klineRes.success ? klineRes.error : null);

  // B2 修复：统一A股配色（红涨绿跌），与CSS令牌一致
  const getFormatForChange = (val: number) => {
    if (val > 0) return "text-trading-up";   // 红 = 涨
    if (val < 0) return "text-trading-down"; // 绿 = 跌
    return "text-muted";
  };

  // K线图配色（与CSS令牌一致：红涨绿跌）
  const colorUp = "var(--color-trading-up)";    // 红 = 涨
  const colorDown = "var(--color-trading-down)"; // 绿 = 跌

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
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">换手率</span>
            <span className="text-white">{stock.turnoverRate ? stock.turnoverRate.toFixed(2) : '-'}%</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">PE(动)</span>
            <span className="text-white">{stock.peRatio ? stock.peRatio.toFixed(2) : '-'}</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1">PB</span>
            <span className="text-white">{stock.pbRatio ? stock.pbRatio.toFixed(2) : '-'}</span>
          </div>
          <div className="flex flex-col justify-between">
            <span className="text-muted mb-1"></span>
            <span className="text-white"></span>
          </div>
        </div>
        
        <div className="absolute top-5 right-5 hidden xl:flex gap-2">
           <Button onClick={togglePool} variant="secondary-on-dark" className={`flex items-center gap-1.5 px-3 py-1.5 border border-hairline-dark rounded text-[12px] transition-colors ${inPool ? 'text-primary' : 'text-body-dark'}`}>
             {inPool ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {inPool ? '删自选' : '加自选'}
           </Button>
           <Button variant="secondary-on-dark" onClick={openAlertModal} className="flex items-center gap-1.5 px-3 py-1.5 border border-hairline-dark rounded text-[12px] text-body-dark transition-colors">
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
                      aiSentiment.score >= 60 ? 'bg-trading-up/10 text-trading-up' : 
                      aiSentiment.score <= 40 ? 'bg-trading-down/10 text-trading-down' : 'bg-surface-elevated-dark text-info'
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

           {/* 量化买卖信号引擎 —— 基于《选股交易操作手册》 */}
           {signalReport && (
             <div>
               <h4 className="text-[13px] font-medium text-white mb-3 pl-2 border-l-2 border-primary">
                 量化交易信号
               </h4>
               <div className="bg-canvas-dark border border-hairline-dark rounded p-4 flex flex-col gap-4">
                 {/* 综合评分 + 多空排列 */}
                 <div className="flex items-center justify-between pb-3 border-b border-hairline-dark">
                   <div className="flex flex-col">
                     <span className={`text-[28px] font-mono leading-none ${signalReport.score >= 60 ? 'text-trading-up' : signalReport.score <= 35 ? 'text-trading-down' : 'text-info'}`}>
                       {signalReport.score}
                     </span>
                     <span className="text-[11px] text-muted mt-1">{signalReport.scoreLabel}</span>
                   </div>
                   <div className={`px-2.5 py-1 rounded text-[11px] font-medium ${
                     signalReport.alignment === 'bullish' ? 'bg-trading-up/10 text-trading-up' :
                     signalReport.alignment === 'bearish' ? 'bg-trading-down/10 text-trading-down' : 'bg-surface-elevated-dark text-muted'
                   }`}>
                     {signalReport.alignment === 'bullish' ? '多头排列' : signalReport.alignment === 'bearish' ? '空头排列' : '方向不明'}
                   </div>
                 </div>

                 {/* 评分维度 */}
                 <div className="grid grid-cols-4 gap-2">
                   {[
                     { label: '趋势', val: signalReport.breakdown.trend, max: 40 },
                     { label: '结构', val: signalReport.breakdown.structure, max: 30 },
                     { label: '量价', val: signalReport.breakdown.volumePrice, max: 15 },
                     { label: '时机', val: signalReport.breakdown.timing, max: 15 },
                   ].map(d => (
                     <div key={d.label} className="flex flex-col items-center">
                       <div className="w-full h-1 bg-surface-elevated-dark rounded-full overflow-hidden mb-1">
                         <div className="bg-primary h-full" style={{ width: `${d.max > 0 ? (d.val / d.max) * 100 : 0}%` }} />
                       </div>
                       <span className="text-[10px] text-muted">{d.label}</span>
                       <span className="text-[11px] font-mono text-body-dark">{d.val}/{d.max}</span>
                     </div>
                   ))}
                 </div>

                 {/* 风险标签 */}
                 {signalReport.riskTags.length > 0 && (
                   <div className="flex flex-wrap gap-1.5">
                     {signalReport.riskTags.map((tag: any, i: number) => (
                       <span key={i} className={`text-[10px] px-2 py-0.5 rounded ${
                         tag.level === 'danger' ? 'bg-trading-down/10 text-trading-down' :
                         tag.level === 'warning' ? 'bg-yellow-500/10 text-yellow-500' : 'bg-surface-elevated-dark text-muted'
                       }`} title={tag.detail}>
                         {tag.name}
                       </span>
                     ))}
                   </div>
                 )}

                 {/* 买入信号 */}
                 {signalReport.buySignals.length > 0 && (
                   <div>
                     <h5 className="text-[11px] text-trading-up mb-2">买入信号 ({signalReport.buySignals.length})</h5>
                     <div className="flex flex-col gap-1.5">
                       {signalReport.buySignals.map((sig: any, i: number) => (
                         <div key={i} className="flex items-start gap-2 text-[12px]">
                           <span className="text-trading-up shrink-0 mt-0.5">▲</span>
                           <div className="flex-1">
                             <span className="text-body-dark">{sig.name}</span>
                             <span className="text-muted ml-1.5 text-[11px]">{sig.detail}</span>
                           </div>
                         </div>
                       ))}
                     </div>
                   </div>
                 )}

                 {/* 卖出信号 */}
                 {signalReport.sellSignals.length > 0 && (
                   <div>
                     <h5 className="text-[11px] text-trading-down mb-2">卖出信号 ({signalReport.sellSignals.length})</h5>
                     <div className="flex flex-col gap-1.5">
                       {signalReport.sellSignals.map((sig: any, i: number) => (
                         <div key={i} className="flex items-start gap-2 text-[12px]">
                           <span className={`shrink-0 mt-0.5 ${sig.urgency === 'high' ? 'text-trading-down font-bold' : 'text-trading-down'}`}>▼</span>
                           <div className="flex-1">
                             <span className="text-body-dark">{sig.name}</span>
                             {sig.urgency === 'high' && <span className="ml-1.5 text-[10px] text-trading-down">[高危]</span>}
                             <span className="text-muted ml-1 text-[11px]">{sig.detail}</span>
                           </div>
                         </div>
                       ))}
                     </div>
                   </div>
                 )}

                 {/* 操作建议 */}
                 <div className="pt-3 border-t border-hairline-dark">
                   <p className="text-[12px] text-primary leading-relaxed">{signalReport.suggestion}</p>
                 </div>
               </div>
             </div>
           )}
           
           <div>
             <h4 className="text-[13px] font-medium text-white mb-3 pl-2 border-l-2 border-primary">
               主力资金动向
             </h4>
             <div className="bg-canvas-dark border border-hairline-dark rounded p-4">
               <div className="flex items-center justify-between mb-3">
                 <span className="text-[12px] text-muted">主动净流向(估)</span>
                 <span className={`text-[16px] font-mono font-bold ${isNetInflow ? 'text-trading-up' : 'text-trading-down'}`}>
                   {isNetInflow ? '+' : ''}{(netDisc * stock.price * 100 / 10000).toFixed(0)}万
                 </span>
               </div>
               <div className="mb-2">
                 <div className="flex justify-between text-[11px] mb-1">
                   <span className="text-trading-up">外盘(主买) {outer.toLocaleString()}</span>
                   <span className="text-trading-down">{inner.toLocaleString()} 内盘(主卖)</span>
                 </div>
                 <div className="flex h-2 rounded-full overflow-hidden bg-trading-down">
                   <div className="bg-trading-up transition-all" style={{ width: `${totalDisc > 0 ? (outer / totalDisc) * 100 : 50}%` }} />
                 </div>
               </div>
               <div className="flex items-center justify-between pt-2 border-t border-hairline-dark">
                 <span className={`text-[11px] px-2 py-0.5 rounded ${isNetInflow ? 'bg-trading-up/10 text-trading-up' : 'bg-trading-down/10 text-trading-down'}`}>
                   {isNetInflow ? '买盘占优 偏多' : '卖盘占优 偏空'}
                 </span>
                 <span className="text-[11px] text-muted font-mono">净比 {(Math.abs(netRatio) * 100).toFixed(1)}%</span>
               </div>
               <p className="text-[10px] text-muted mt-3 leading-relaxed">
                 基于主动买卖盘(L1)估算主力方向。逐笔大单/超大单资金流需接入 L2 行情数据源。
               </p>
             </div>
           </div>
        </div>
      </div>

      {/* 价格预警弹窗 */}
      {showAlertModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAlertModal(false)}>
          <div className="bg-surface-card-dark border border-hairline-dark rounded-lg p-6 w-[360px] relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowAlertModal(false)} className="absolute top-3 right-3 text-muted hover:text-white">
              <X className="w-4 h-4" />
            </button>
            <h3 className="text-[16px] font-bold text-white mb-1">设置价格预警</h3>
            <p className="text-[12px] text-muted mb-4">{stock.name} ({stock.marketCode}) · 现价 {stock.price.toFixed(2)}</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setAlertType('price_above')} className={`py-2 rounded text-[13px] border transition-colors ${alertType === 'price_above' ? 'bg-trading-up/10 text-trading-up border-trading-up' : 'border-hairline-dark text-muted hover:text-white'}`}>涨破 (≥)</button>
                <button onClick={() => setAlertType('price_below')} className={`py-2 rounded text-[13px] border transition-colors ${alertType === 'price_below' ? 'bg-trading-down/10 text-trading-down border-trading-down' : 'border-hairline-dark text-muted hover:text-white'}`}>跌破 (≤)</button>
              </div>
              <div>
                <label className="text-[12px] text-muted mb-1 block">触发价格</label>
                <input type="number" step="0.01" value={alertThreshold} onChange={e => setAlertThreshold(e.target.value)} className="w-full bg-canvas-dark border border-hairline-dark rounded px-3 py-2 text-[13px] text-white focus:outline-none focus:border-primary" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <Button variant="secondary-on-dark" className="flex-1 border border-hairline-dark h-9" onClick={() => setShowAlertModal(false)}>取消</Button>
              <Button className="flex-1 h-9" onClick={createAlert} disabled={alertSubmitting || !alertThreshold}>{alertSubmitting ? '设置中...' : '确认预警'}</Button>
            </div>
          </div>
        </div>
      )}

      {/* 预警设置成功提示 */}
      {alertToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-trading-up text-white px-4 py-2.5 rounded-lg shadow-lg text-[13px] flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          <Bell className="w-4 h-4" /> {alertToast}
        </div>
      )}
    </div>
  );
}
