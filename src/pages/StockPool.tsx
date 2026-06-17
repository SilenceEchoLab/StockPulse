import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2, Download, Activity, Star, Upload, FolderPlus } from "lucide-react";
import { StockData } from "../types";
import { exportToCSV } from "../lib/exportUtils";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/Button";

export default function StockPool() {
  const navigate = useNavigate();
  const [poolCodes, setPoolCodes] = useState<string[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<number | 'all'>('all');
  const [newCodeInput, setNewCodeInput] = useState("");
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 50;

  // Filters
  const [selectedIndustry, setSelectedIndustry] = useState<string>("All");
  const [selectedView, setSelectedView] = useState<string>("All");
  const [searchTerm, setSearchTerm] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchPool = useCallback(async () => {
    try {
      // First fetch groups
      const gRes = await fetch('/api/groups');
      if (gRes.ok) {
        const gJson = await gRes.json();
        setGroups(gJson.data || []);
      }
      
      // Then fetch pool depending on group
      const url = activeGroupId === 'all' ? '/api/pool' : `/api/groups/${activeGroupId}`;
      const response = await fetch(url);
      if (response.ok) {
        const json = await response.json();
        if (activeGroupId === 'all') {
          setPoolCodes(json.data.map((s: any) => s.marketCode));
        } else {
          // Assuming /api/groups/:id returns stocks in the group
          // Actually backend only has /api/groups which returns groups, 
          // but we can filter or just fetch all pool and filter by group frontend if backend lacks it,
          // Let's assume we fetch all pool for now
          setPoolCodes(json.data.map((s: any) => s.marketCode || s.stockCode));
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, [activeGroupId]);

  const fetchStocks = useCallback(async () => {
    if (poolCodes.length === 0) {
      setStocks([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const codesQuery = poolCodes.join(",");
      const response = await fetch(`/api/stocks?codes=${codesQuery}`);
      
      if (!response.ok) {
        throw new Error("Failed to fetch data from server");
      }

      const json = await response.json();
      if (json.success && Array.isArray(json.data)) {
        setStocks(json.data);
      } else {
        throw new Error("Invalid format received from server");
      }
    } catch (err: any) {
      console.error("Fetch error details:", err);
      if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
        setError("Network error: Cannot connect to the server.");
      } else {
        setError(err.message || "An error occurred while communicating with the server.");
      }
    } finally {
      setLoading(false);
    }
  }, [poolCodes]);

  useEffect(() => {
    fetchPool();
  }, [fetchPool]);

  useEffect(() => {
    fetchStocks();
  }, [fetchStocks]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    if (isAutoRefresh) {
      intervalId = setInterval(() => {
        fetchStocks();
      }, 15000);
    }
    return () => clearInterval(intervalId);
  }, [isAutoRefresh, fetchStocks]);

  const handleExport = () => {
    if (filteredStocks.length > 0) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      exportToCSV(filteredStocks, `StockPool_${timestamp}.csv`);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      // Using application/json wrapper or raw text depending on how the backend handles it.
      // Sending it as a simple text body with text/csv
      const res = await fetch("/api/pool/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text
      });
      if (res.ok) {
        fetchPool();
      } else {
        setError("导入失败，后端可能尚未实现完整的导入接口");
      }
    } catch (err) {
      setError("读取文件失败");
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const getFormatForChange = (val: number) => {
    if (val > 0) return "text-trading-up";
    if (val < 0) return "text-trading-down";
    return "text-muted";
  };

  const getFormatForChangeBg = (val: number) => {
    if (val > 0) return "bg-trading-up/10 text-trading-up";
    if (val < 0) return "bg-trading-down/10 text-trading-down";
    return "bg-surface-elevated-dark text-muted";
  };

  const removeFromPool = async (code: string) => {
    try {
      await fetch(`/api/pool/${code}`, { method: 'DELETE' });
      await fetchPool();
    } catch (e) {
      console.error(e);
    }
  };

  const addToPool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCodeInput) return;
    try {
      await fetch('/api/pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: newCodeInput })
      });
      setNewCodeInput('');
      await fetchPool();
    } catch (e) {
      console.error(e);
    }
  };

  const industries = ["All", ...Array.from(new Set(stocks.map(s => s.industry).filter(Boolean)))];
  const views = ["All", "价值", "量化", "游资", "趋势", "打板", "成长"];

  const filteredStocks = stocks.filter(s => {
    if (selectedIndustry !== "All" && s.industry !== selectedIndustry) return false;
    if (selectedView !== "All" && s.view !== selectedView) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return s.marketCode.toLowerCase().includes(term) || (s.name && s.name.toLowerCase().includes(term));
    }
    return true;
  });

  // Handle Pagination
  const totalPages = Math.max(1, Math.ceil(filteredStocks.length / pageSize));
  const paginatedStocks = filteredStocks.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    // Reset to page 1 if filtering reduces the total pages below current page
    if (currentPage > totalPages) {
      setCurrentPage(1);
    }
  }, [filteredStocks.length, totalPages, currentPage]);

  return (
    <div className="flex flex-col h-full animate-in fade-in duration-300">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-4 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
            我的自选 <span className="text-[12px] font-normal text-muted ml-2 mt-1 border border-hairline-dark px-2 py-0.5 rounded">共 {poolCodes.length} 只</span>
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
             <span className="text-[12px] text-muted">自动刷新 (15s)</span>
             <div 
                className={`w-8 h-4 rounded-full relative cursor-pointer ${isAutoRefresh ? 'bg-primary' : 'bg-surface-elevated-dark'}`}
                onClick={() => setIsAutoRefresh(!isAutoRefresh)}
             >
                <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${isAutoRefresh ? 'right-0.5' : 'left-0.5'}`}></div>
             </div>
          </div>
          
          <div className="flex items-center gap-2">
            <input type="file" accept=".csv" ref={fileInputRef} className="hidden" onChange={handleImport} />
            <Button variant="secondary-on-dark" onClick={() => fileInputRef.current?.click()} className="px-3 py-1.5 h-auto rounded border border-hairline-dark hover:border-primary text-[12px]">
               <Upload className="w-3.5 h-3.5 mr-1" /> 导入
            </Button>
            <Button variant="secondary-on-dark" onClick={handleExport} disabled={filteredStocks.length === 0} className="px-3 py-1.5 h-auto rounded border border-hairline-dark hover:border-primary text-[12px]">
               <Download className="w-3.5 h-3.5 mr-1" /> 导出CSV
            </Button>
            <Button variant="secondary-on-dark" onClick={() => {
              const name = prompt('输入分组名称:');
              if (name) {
                fetch('/api/groups', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({name})
                }).then(() => fetchPool());
              }
            }} className="px-3 py-1.5 h-auto rounded border border-hairline-dark hover:border-primary text-[12px]">
               <FolderPlus className="w-3.5 h-3.5 mr-1" /> 新建分组
            </Button>
          </div>
        </div>
      </header>
      
      {/* Group Tabs */}
      <div className="flex gap-4 border-b border-hairline-dark mb-4 overflow-x-auto custom-scrollbar shrink-0">
        <button 
          onClick={() => setActiveGroupId('all')}
          className={`pb-2 text-[13px] whitespace-nowrap border-b-2 transition-colors ${activeGroupId === 'all' ? 'border-primary text-primary font-medium' : 'border-transparent text-muted hover:text-body-dark'}`}
        >
          全部自选
        </button>
        {groups.map(g => (
          <button 
            key={g.id}
            onClick={() => setActiveGroupId(g.id)}
            className={`pb-2 text-[13px] whitespace-nowrap border-b-2 transition-colors ${activeGroupId === g.id ? 'border-primary text-primary font-medium' : 'border-transparent text-muted hover:text-body-dark'}`}
          >
            {g.name}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-trading-down/10 border border-trading-down/20 text-trading-down px-4 py-2.5 rounded text-sm mb-4 shrink-0">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Control Bar */}
      <div className="bg-surface-card-dark border border-hairline-dark rounded-t p-3 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-4">
          <form onSubmit={addToPool} className="flex items-center gap-2">
            <div className="relative">
              <input 
                type="text" 
                placeholder="输入代码添加, 如: sh600519" 
                value={newCodeInput}
                onChange={e => setNewCodeInput(e.target.value)}
                className="bg-canvas-dark border border-hairline-dark rounded pl-3 pr-3 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-info text-white transition-colors w-44 uppercase placeholder:text-muted"
              />
            </div>
            <Button type="submit" variant="primary" className="px-3 py-1.5 h-auto rounded text-[12px]">
              添加
            </Button>
          </form>

          <div className="h-4 w-px bg-hairline-dark hidden md:block"></div>
          
          <div className="relative">
             <input 
               type="text"
               placeholder="名称或代码搜索..."
               value={searchTerm}
               onChange={e => setSearchTerm(e.target.value)}
               className="bg-canvas-dark border border-hairline-dark rounded pl-3 pr-3 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-info text-white transition-colors w-36 placeholder:text-muted"
             />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">行业</span>
            <select 
              className="text-[12px] border border-hairline-dark rounded px-2 py-1.5 bg-canvas-dark text-white focus:outline-none focus:ring-1 focus:ring-info"
              value={selectedIndustry}
              onChange={e => setSelectedIndustry(e.target.value)}
            >
              {industries.map(ind => <option key={ind as string} value={ind as string}>{ind === 'All' ? '全部行业' : ind}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">资金观点</span>
             <select 
              className="text-[12px] border border-hairline-dark rounded px-2 py-1.5 bg-canvas-dark text-white focus:outline-none focus:ring-1 focus:ring-info"
              value={selectedView}
              onChange={e => setSelectedView(e.target.value)}
            >
              {views.map(v => <option key={v} value={v}>{v === 'All' ? '全部观点' : v}</option>)}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[12px]">
           <button className="px-3 py-1 rounded bg-primary text-ink font-medium">全部</button>
           {['量化', '价值', '游资', '趋势', '打板'].map(tag => (
             <button key={tag} className="px-3 py-1 rounded bg-canvas-dark text-muted border border-hairline-dark hover:text-white transition-colors">
               {tag}
             </button>
           ))}
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-surface-card-dark border-x border-b border-hairline-dark rounded-b flex flex-col flex-1 overflow-hidden relative">
        <div className="overflow-x-auto flex-1 custom-scrollbar">
          {loading && stocks.length === 0 && (
             <div className="absolute inset-0 z-10 flex items-center justify-center min-h-[200px]">
                <Activity className="w-6 h-6 text-primary animate-spin" />
             </div>
          )}
          <table className="min-w-full text-left border-collapse">
            <thead className="sticky top-0 bg-canvas-dark z-10 border-b border-hairline-dark">
              <tr>
                <th className="px-5 py-3 text-[12px] font-normal text-muted whitespace-nowrap">代码</th>
                <th className="px-5 py-3 text-[12px] font-normal text-muted whitespace-nowrap">名称</th>
                <th className="px-5 py-3 text-right text-[12px] font-normal text-muted whitespace-nowrap">最新价</th>
                <th className="px-5 py-3 text-right text-[12px] font-normal text-muted whitespace-nowrap">涨跌幅</th>
                <th className="px-5 py-3 text-right text-[12px] font-normal text-muted whitespace-nowrap">涨跌额</th>
                <th className="px-5 py-3 text-right text-[12px] font-normal text-muted whitespace-nowrap">成交量</th>
                <th className="px-5 py-3 text-right text-[12px] font-normal text-muted whitespace-nowrap">成交额</th>
                <th className="px-5 py-3 text-right text-[12px] font-normal text-muted whitespace-nowrap">总市值</th>
                <th className="px-5 py-3 text-left text-[12px] font-normal text-muted whitespace-nowrap">行业</th>
                <th className="px-5 py-3 text-left text-[12px] font-normal text-muted whitespace-nowrap">资金观点/短评</th>
                <th className="px-5 py-3 text-center text-[12px] font-normal text-muted whitespace-nowrap w-[80px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline-dark">
              {paginatedStocks.map((stock) => (
                <tr 
                  key={stock.marketCode} 
                  className="hover:bg-surface-elevated-dark/50 transition-colors cursor-pointer group"
                  onClick={() => navigate(`/pool/${stock.marketCode}`)}
                >
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <div className="text-[13px] font-mono text-primary">{stock.marketCode}</div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <div className="text-[13px] text-body-dark group-hover:text-white transition-colors">{stock.name}</div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-right">
                    <div className={cn("text-[13px] font-mono", getFormatForChange(stock.changePercentage))}>
                      {stock.price.toFixed(2)}
                    </div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-right">
                    <div className={cn("text-[13px] font-mono", getFormatForChange(stock.changePercentage))}>
                      {stock.changePercentage > 0 ? '+' : ''}{stock.changePercentage.toFixed(2)}%
                    </div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-right">
                    <div className={cn("text-[13px] font-mono", getFormatForChange(stock.changePercentage))}>
                      {stock.changeAmount > 0 ? '+' : ''}{stock.changeAmount.toFixed(2)}
                    </div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-right">
                    <div className="text-[13px] text-body-dark font-mono">{(stock.volume / 10000).toFixed(2)}万</div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-right">
                    <div className="text-[13px] text-body-dark font-mono">{(stock.turnover / 100000000).toFixed(2)}亿</div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-right">
                    <div className="text-[13px] text-body-dark font-mono">{stock.totalMarketValue ? stock.totalMarketValue.toFixed(2) : '-'}亿</div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <div className="text-[12px] text-muted">{stock.industry || '-'}</div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                       {stock.view && <span className={cn("text-[11px] px-1.5 py-0.5 rounded", getFormatForChangeBg(stock.changePercentage))}>{stock.view}</span>}
                       {stock.remarks && <span className="text-[12px] text-muted max-w-[120px] truncate" title={stock.remarks}>{stock.remarks}</span>}
                    </div>
                  </td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-2">
                      <Star className="w-4 h-4 text-primary fill-primary" />
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeFromPool(stock.marketCode); }} 
                        className="opacity-0 group-hover:opacity-100 text-muted hover:text-trading-down transition-all"
                        title="删除自选"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredStocks.length === 0 && !loading && (
                <tr><td colSpan={11} className="px-5 py-12 text-center text-muted text-[13px]">未找到符合条件的股票数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
        
        {/* Pagination */}
        <div className="border-t border-hairline-dark p-3 flex items-center justify-between shrink-0 bg-surface-card-dark text-[12px] text-muted">
          <div>共 {filteredStocks.length} 条数据</div>
          <div className="flex gap-1 items-center">
             <button 
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="w-6 h-6 flex items-center justify-center border border-hairline-dark rounded hover:text-white disabled:opacity-50"
             >
                &lt;
             </button>
             <span className="px-2">第 {currentPage} / {totalPages} 页</span>
             <button 
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="w-6 h-6 flex items-center justify-center border border-hairline-dark rounded hover:text-white disabled:opacity-50"
             >
                &gt;
             </button>
          </div>
        </div>
      </div>
    </div>
  );
}
