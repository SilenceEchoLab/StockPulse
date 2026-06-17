import { useState, useCallback, useEffect } from "react";
import { Play, Activity, Download, HardDrive, ShieldCheck, Database, RefreshCw } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

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

  useEffect(() => {
    fetchSyncStatus();
  }, [fetchSyncStatus]);

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
        body: JSON.stringify({ codes: poolCodes }),
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
           <div key={tab} className={`pb-3 text-[14px] cursor-pointer ${idx === 0 ? 'text-primary border-b-2 border-primary font-medium' : 'text-muted hover:text-body-dark border-b-2 border-transparent'}`}>
             {tab}
           </div>
         ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 shrink-0">
        {/* Sync Task Card */}
        <Card variant="card-dark" className="relative overflow-hidden flex flex-col">
          <h3 className="text-[14px] font-medium text-white mb-6">同步任务</h3>
          <p className="text-[13px] text-body-dark mb-4">历史K线数据同步<br/><span className="text-muted text-[12px]">从腾讯证券行情接口获取历史数据并保存到本地数据库</span></p>
          
          <div className="mt-auto">
             {syncState.status === "idle" && (
                <Button onClick={startHistoricalSync} className="w-full">
                  开始同步任务
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
                    <div className="w-full bg-surface-elevated-dark h-1.5 rounded-full">
                       <div className="bg-primary h-full rounded-full transition-all duration-500" style={{ width: `${syncState.progress}%` }}></div>
                    </div>
                    <div className="text-[12px] text-muted mt-2 font-mono text-center">
                      {syncState.current} / {syncState.total}
                    </div>
                 </div>
               </div>
             )}
             {syncState.status === "completed" && (
                <a href="/api/sync/export" download className="w-full border border-primary text-primary hover:bg-primary/10 py-2 rounded text-[13px] transition-colors flex items-center justify-center font-medium">
                  <Download className="w-4 h-4 mr-1.5" /> 下载数据包
                </a>
             )}
          </div>
        </Card>

        {/* Disk Usage Card */}
        <Card variant="card-dark" className="relative flex flex-col">
          <h3 className="text-[14px] font-medium text-white mb-6">存储空间</h3>
          <div className="flex items-center gap-5 mt-2">
            <div className="w-14 h-14 bg-surface-elevated-dark rounded-full flex items-center justify-center shrink-0">
               <Database className="w-6 h-6 text-muted" />
            </div>
            <div>
              <p className="text-[13px] text-muted mb-1">SQLite 数据库大小</p>
              <p className="text-[24px] text-white font-mono font-medium leading-none">
                 {formatSize(syncState.diskUsageBytes).split(' ')[0]} <span className="text-[14px] text-muted">{formatSize(syncState.diskUsageBytes).split(' ')[1]}</span>
              </p>
            </div>
          </div>
          <div className="mt-8 text-[12px] text-muted flex justify-between border-t border-hairline-dark pt-3">
             <span>数据文件: <span className="text-body-dark">stocks.db</span></span>
             <span>存储利用较小</span>
          </div>
        </Card>

        {/* Task Stats Card */}
        <Card variant="card-dark" className="relative flex flex-col">
          <h3 className="text-[14px] font-medium text-white mb-6">任务统计</h3>
          <div className="flex-1 flex items-center justify-between mt-2">
            <div className="w-[100px] h-[100px] relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: '成功', value: Math.max(1, syncState.totalRequests - syncState.errorCount), color: 'var(--color-trading-up)' },
                      { name: '失败', value: syncState.errorCount, color: 'var(--color-trading-down)' }
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={35}
                    outerRadius={45}
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {[
                      { name: '成功', value: Math.max(1, syncState.totalRequests - syncState.errorCount), color: 'var(--color-trading-up)' },
                      { name: '失败', value: syncState.errorCount, color: 'var(--color-trading-down)' }
                    ].map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'var(--color-surface-card-dark)', borderColor: 'var(--color-hairline-dark)', color: 'var(--color-body-dark)', fontSize: '12px' }}
                    itemStyle={{ color: 'var(--color-body-dark)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                 <span className="text-[16px] font-bold text-white font-mono flex flex-col items-center">
                    {syncState.totalRequests > 0 ? (
                      <>
                        {((syncState.totalRequests - syncState.errorCount) / syncState.totalRequests * 100).toFixed(0)}<span className="text-[10px] text-muted">%</span>
                      </>
                    ) : (
                      <span className="text-muted text-[12px]">--</span>
                    )}
                 </span>
              </div>
            </div>
            
            <div className="flex-1 ml-6 space-y-4">
               <div>
                  <div className="flex justify-between text-[13px] mb-1">
                     <span className="text-trading-up flex items-center"><span className="w-2 h-2 rounded-full bg-trading-up mr-2"></span>成功</span>
                     <span className="text-white font-mono">{syncState.totalRequests - syncState.errorCount}</span>
                  </div>
               </div>
               <div>
                  <div className="flex justify-between text-[13px] mb-1">
                     <span className="text-trading-down flex items-center"><span className="w-2 h-2 rounded-full bg-trading-down mr-2"></span>错误</span>
                     <span className="text-white font-mono">{syncState.errorCount}</span>
                  </div>
               </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Logs Panel */}
      <Card variant="card-dark" className="flex-1 flex flex-col min-h-[300px]">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h3 className="text-[14px] font-medium text-white">
            实时日志 (Sync Engine)
          </h3>
          <div className="flex items-center gap-3">
             <span className="text-[12px] text-muted border border-hairline-dark px-2 py-1 rounded">全部级别 ▾</span>
             <button className="text-[12px] text-muted hover:text-white transition-colors">清空日志</button>
          </div>
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

        <div className="mt-4 flex items-center justify-between text-[11px] text-muted shrink-0 pt-2 border-t border-hairline-dark">
           <div className="flex items-center gap-4">
             <span>数据源: 腾讯证券行情 (web.ifzq.gtimg.cn)</span>
             <span>|</span>
             <span>引擎状态: <span className="text-trading-up">· 运行中</span></span>
             <span>|</span>
             <span>版本: v1.0.0</span>
           </div>
        </div>
      </Card>
    </div>
  );
}
