import { useState, useCallback, useEffect } from "react";
import { Play, Activity, Download, HardDrive, ShieldCheck, Database, RefreshCw, Settings2 } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { exportToCSV } from "../lib/exportUtils";

interface SyncState {
  status: "idle" | "syncing" | "completed" | "error";
  progress: number;
  current: number;
  total: number;
  logs: { time: string; type: string; message: string; sub: string }[];
  totalRequests: number;
  errorCount: number;
  diskUsageBytes: number;
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState(0);
  const [syncConfig, setSyncConfig] = useState<{ concurrency: number; mode: string; granularities: string[]; days: number }>({
    concurrency: 3,
    mode: 'incremental',
    granularities: ['day', 'week', 'month', 'm30', 'm60'],
    days: 800,
  });
  const [overviewData, setOverviewData] = useState<any>(null);

  // 可同步粒度：日线/周线/月线（fqkline，3年+）+ 5/30/60分钟（mkline，仅近期）
  const GRAN_OPTIONS: { key: string; label: string; desc: string }[] = [
    { key: 'day', label: '日线', desc: '3年+' },
    { key: 'week', label: '周线', desc: '大周期' },
    { key: 'month', label: '月线', desc: '看周期' },
    { key: 'm5', label: '5分钟', desc: '近1-2月' },
    { key: 'm15', label: '15分钟', desc: '近1-2月' },
    { key: 'm30', label: '30分钟', desc: '近1年' },
    { key: 'm60', label: '60分钟', desc: '近1年' },
  ];
  const toggleGran = (k: string) => setSyncConfig(s => {
    const has = s.granularities.includes(k);
    return { ...s, granularities: has ? s.granularities.filter(g => g !== k) : [...s.granularities, k] };
  });

  const [syncState, setSyncState] = useState<SyncState>({
    status: "idle", progress: 0, current: 0, total: 0, logs: [], totalRequests: 0, errorCount: 0, diskUsageBytes: 0
  });

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status");
      if (res.ok) {
        const data = await res.json();
        setSyncState(data);
      }
    } catch (e) {}
  }, []);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/overview");
      if (res.ok) {
        const data = await res.json();
        setOverviewData(data.data);
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    fetchSyncStatus();
    fetchOverview();
  }, [fetchSyncStatus, fetchOverview]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;
    if (syncState.status === "syncing") {
      intervalId = setInterval(() => {
        fetchSyncStatus();
      }, 1000);
    }
    return () => clearInterval(intervalId);
  }, [syncState.status, fetchSyncStatus]);

  const startHistoricalSync = async () => {
    try {
      const poolRes = await fetch('/api/pool');
      let poolCodes = [];
      if (poolRes.ok) {
        const json = await poolRes.json();
        poolCodes = json.data.map((s: any) => s.marketCode);
      }
      
      const res = await fetch("/api/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: poolCodes, options: syncConfig }),
      });
      if (res.ok) {
        fetchSyncStatus();
      }
    } catch (e) {
      console.error("Failed to start sync", e);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024, sizes = ["B", "KB", "MB", "GB"], i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  // 导出当前股票池实时行情为 CSV（复用前端 exportUtils，无需服务端打包）
  const handleExport = async () => {
    try {
      const poolRes = await fetch('/api/pool');
      if (!poolRes.ok) return;
      const json = await poolRes.json();
      const codes = (json.data || []).map((s: any) => s.marketCode);
      if (codes.length === 0) { alert('股票池为空，无可导出数据'); return; }
      const stocksRes = await fetch(`/api/stocks?codes=${codes.join(',')}`);
      const stocksJson = await stocksRes.json();
      exportToCSV(stocksJson.data || [], `StockPool_Export_${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      console.error('Export failed', e);
      alert('导出失败，请检查网络或服务状态');
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-300 h-full flex flex-col">
      <header className="mb-2 shrink-0">
        <h1 className="text-2xl font-bold tracking-tight text-white mb-1">
          数据监控控制台
        </h1>
        <p className="text-[13px] text-muted">
          历史行情数据同步与存储监控
        </p>
      </header>

      <div className="flex items-center gap-6 border-b border-hairline-dark mb-4 shrink-0">
         {['同步任务', '进程日志', '数据概览', '数据工具'].map((tab, idx) => (
           <div 
             key={tab} 
             onClick={() => setActiveTab(idx)}
             className={`pb-3 text-[14px] cursor-pointer ${activeTab === idx ? 'text-primary border-b-2 border-primary font-medium' : 'text-muted hover:text-body-dark border-b-2 border-transparent'}`}>
             {tab}
           </div>
         ))}
      </div>

      <div className="flex-1 flex flex-col min-h-0 relative">
        {activeTab === 0 && (
          <div className="flex flex-col gap-4 h-full">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">
              <Card variant="card-dark" className="relative overflow-hidden flex flex-col">
                <h3 className="text-[14px] font-medium text-white mb-4">同步配置</h3>
                <div className="space-y-4">
                  <div>
                    <label className="text-[12px] text-muted mb-1 block">同步粒度（可多选）</label>
                    <div className="grid grid-cols-3 gap-2">
                      {GRAN_OPTIONS.map(opt => {
                        const active = syncConfig.granularities.includes(opt.key);
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => toggleGran(opt.key)}
                            className={`px-2 py-1.5 rounded text-[12px] border transition-colors text-left ${active ? 'bg-primary/15 border-primary text-white' : 'bg-surface-elevated-dark border-hairline-dark text-muted hover:text-body-dark'}`}
                          >
                            <div className="font-medium">{opt.label}</div>
                            <div className="text-[10px] opacity-70">{opt.desc}</div>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted mt-1.5">日/周/月线走 fqkline（可取 3 年+）；分钟线走 mkline，腾讯仅保留近期数据。</p>
                  </div>
                  <div>
                    <label className="text-[12px] text-muted mb-1 block">日线历史深度（天，全量模式生效）</label>
                    <input
                      type="number" min="30" max="800"
                      value={syncConfig.days}
                      onChange={e => setSyncConfig({ ...syncConfig, days: parseInt(e.target.value) || 800 })}
                      className="w-full bg-surface-elevated-dark border border-hairline-dark rounded px-3 py-1.5 text-[13px] text-white focus:border-primary transition-colors outline-none"
                    />
                    <p className="text-[10px] text-muted mt-1">800 ≈ 3 年交易日，足够稳定计算 MA250。增量模式自动取 max(30, 300) 保证指标预热。</p>
                  </div>
                  <div>
                    <label className="text-[12px] text-muted mb-1 block">并发请求数</label>
                    <input
                      type="number" min="1" max="10"
                      value={syncConfig.concurrency}
                      onChange={e => setSyncConfig({...syncConfig, concurrency: parseInt(e.target.value) || 1})}
                      className="w-full bg-surface-elevated-dark border border-hairline-dark rounded px-3 py-1.5 text-[13px] text-white focus:border-primary transition-colors outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[12px] text-muted mb-1 block">同步模式</label>
                    <select
                      value={syncConfig.mode}
                      onChange={e => setSyncConfig({...syncConfig, mode: e.target.value})}
                      className="w-full bg-surface-elevated-dark border border-hairline-dark rounded px-3 py-1.5 text-[13px] text-white focus:border-primary transition-colors outline-none"
                    >
                      <option value="incremental">增量同步 (仅拉取最新数据)</option>
                      <option value="full">全量同步 (覆盖所有本地数据)</option>
                    </select>
                  </div>
                </div>
              </Card>

              <Card variant="card-dark" className="relative overflow-hidden flex flex-col">
                <h3 className="text-[14px] font-medium text-white mb-4">执行任务</h3>
                <p className="text-[13px] text-body-dark mb-4 flex-1">基于当前股票池与配置参数，从腾讯证券行情接口获取历史K线数据并计算 MACD/RSI/KDJ/估值指标。</p>
                <div className="mt-auto">
                   {syncState.status === "idle" && (
                      <Button onClick={startHistoricalSync} className="w-full h-10" disabled={syncConfig.granularities.length === 0}>
                        <Play className="w-4 h-4 mr-2" />
                        {syncConfig.granularities.length === 0 ? '请至少选择一个粒度' : '开始同步任务'}
                      </Button>
                   )}
                   {syncState.status === "syncing" && (
                     <div className="flex items-center gap-3">
                       <div className="w-12 h-12 rounded-full border-2 border-primary/30 border-t-primary animate-spin shrink-0"></div>
                       <div className="flex-1">
                          <div className="flex justify-between text-[13px] mb-1">
                            <span className="text-body-dark">同步进行中...</span>
                            <span className="text-white font-mono">{syncState.progress.toFixed(1)}%</span>
                          </div>
                          <div className="w-full bg-surface-elevated-dark h-1.5 rounded-full overflow-hidden">
                             <div className="bg-primary h-full transition-all duration-500" style={{ width: `${syncState.progress}%` }}></div>
                          </div>
                          <div className="text-[12px] text-muted mt-2 font-mono text-center">
                            {syncState.current} / {syncState.total} 标的
                          </div>
                       </div>
                     </div>
                   )}
                   {(syncState.status === "completed" || syncState.status === "error") && (
                      <div className="space-y-2">
                        <Button onClick={startHistoricalSync} className="w-full h-10">
                          <Play className="w-4 h-4 mr-2" />
                          重新同步
                        </Button>
                        <Button variant="outline" className="w-full h-10 text-primary border-primary hover:bg-primary/10" onClick={() => setActiveTab(1)}>
                          查看执行日志
                        </Button>
                      </div>
                   )}
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeTab === 1 && (
          <div className="flex flex-col gap-4 h-full">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 shrink-0">
              <Card variant="card-dark" className="relative flex flex-col">
                <h3 className="text-[14px] font-medium text-white mb-2">任务统计</h3>
                <div className="flex-1 flex items-center mt-2">
                  <div className="w-[80px] h-[80px] relative shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={[
                            { name: '成功', value: Math.max(1, syncState.totalRequests - syncState.errorCount), color: 'var(--color-trading-up)' },
                            { name: '失败', value: syncState.errorCount, color: 'var(--color-trading-down)' }
                          ]}
                          cx="50%" cy="50%" innerRadius={28} outerRadius={36} paddingAngle={2} dataKey="value" stroke="none" isAnimationActive={false}
                        >
                          {[
                            { name: '成功', value: Math.max(1, syncState.totalRequests - syncState.errorCount), color: 'var(--color-trading-up)' },
                            { name: '失败', value: syncState.errorCount, color: 'var(--color-trading-down)' }
                          ].map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 ml-6 space-y-3">
                     <div>
                        <div className="flex justify-between text-[13px] mb-1">
                           <span className="text-trading-up flex items-center"><span className="w-2 h-2 rounded-full bg-trading-up mr-2"></span>成功请求</span>
                           <span className="text-white font-mono">{syncState.totalRequests - syncState.errorCount}</span>
                        </div>
                     </div>
                     <div>
                        <div className="flex justify-between text-[13px] mb-1">
                           <span className="text-trading-down flex items-center"><span className="w-2 h-2 rounded-full bg-trading-down mr-2"></span>失败请求</span>
                           <span className="text-white font-mono">{syncState.errorCount}</span>
                        </div>
                     </div>
                  </div>
                </div>
              </Card>

              <Card variant="card-dark" className="relative flex flex-col">
                <h3 className="text-[14px] font-medium text-white mb-2">存储占用</h3>
                <div className="flex items-center gap-5 mt-2 flex-1">
                  <div className="w-12 h-12 bg-surface-elevated-dark rounded-full flex items-center justify-center shrink-0">
                     <HardDrive className="w-5 h-5 text-muted" />
                  </div>
                  <div>
                    <p className="text-[13px] text-muted mb-1">当前数据目录大小 (CSV缓存)</p>
                    <p className="text-[20px] text-white font-mono font-medium leading-none">
                       {formatSize(syncState.diskUsageBytes)}
                    </p>
                  </div>
                </div>
              </Card>
            </div>

            <Card variant="card-dark" className="flex-1 flex flex-col min-h-[300px]">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h3 className="text-[14px] font-medium text-white">实时日志</h3>
              </div>
              <div className="bg-canvas-dark border border-hairline-dark rounded-lg p-4 font-mono text-[12px] leading-relaxed flex-1 overflow-y-auto custom-scrollbar">
                {syncState.logs.length === 0 ? (
                  <p className="text-muted">暂无执行日志...</p>
                ) : (
                  syncState.logs.map((log, i) => (
                    <div key={i} className="flex gap-3 mb-1.5 hover:bg-surface-elevated-dark px-1 -mx-1 rounded">
                      <span className="text-muted shrink-0 w-20">{log.time}</span>
                      <span className={`shrink-0 w-12 ${log.type === 'ERROR' ? 'text-trading-down' : 'text-trading-up'}`}>{log.type}</span>
                      <span className="text-body-dark break-all">{log.message}</span>
                      <span className="text-muted shrink-0 ml-auto pl-2">{log.sub}</span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        )}

        {activeTab === 2 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card variant="card-dark" className="flex flex-col items-center justify-center py-8">
              <Database className="w-8 h-8 text-primary mb-3" />
              <div className="text-[28px] font-mono font-medium text-white">{overviewData?.stocks || 0}</div>
              <div className="text-[13px] text-muted mt-1">本地股票池</div>
            </Card>
            <Card variant="card-dark" className="flex flex-col items-center justify-center py-8">
              <Activity className="w-8 h-8 text-trading-up mb-3" />
              <div className="text-[28px] font-mono font-medium text-white">{overviewData?.snapshots || 0}</div>
              <div className="text-[13px] text-muted mt-1">估值快照数据</div>
            </Card>
            <Card variant="card-dark" className="flex flex-col items-center justify-center py-8">
              <Settings2 className="w-8 h-8 text-muted mb-3" />
              <div className="text-[28px] font-mono font-medium text-white">{overviewData?.settings || 0}</div>
              <div className="text-[13px] text-muted mt-1">系统配置项</div>
            </Card>
          </div>
        )}

        {activeTab === 3 && (
          <div className="grid grid-cols-1 max-w-2xl gap-4">
             <Card variant="card-dark" className="flex flex-col">
                <h3 className="text-[14px] font-medium text-white mb-2 flex items-center">
                  <Download className="w-4 h-4 mr-2 text-primary" /> 数据导出
                </h3>
                <p className="text-[13px] text-muted mb-6">
                  导出当前股票池的实时行情快照（代码、名称、价格、涨跌幅、PE/PB、市值等）为 CSV，供本地投研环境使用。
                </p>
                <div className="mt-auto">
                  <Button variant="outline" onClick={handleExport} className="w-full text-primary border-primary hover:bg-primary/10">
                    导出行情 CSV
                  </Button>
                </div>
             </Card>
          </div>
        )}
      </div>
    </div>
  );
}
