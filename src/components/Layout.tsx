import { useState, useEffect, useRef } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { 
  Star, Database, Settings, HelpCircle, 
  Search, Bell, Mail, User, Moon,
  LineChart, Cpu, Activity, Briefcase, Globe, Newspaper,
  Library, FileText, PieChart, Users, MessageSquare
} from "lucide-react";
import logoIcon from "../../assets/logo-icon.svg";
import { cn } from "../lib/utils";

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Fetch initial notifications
    fetch('/api/notifications').then(r => r.json()).then(json => {
      if (json.success && json.data) {
        setNotifications(json.data);
        setUnreadCount(json.data.filter((n: any) => !n.isRead).length);
      }
    }).catch(console.error);

    // Subscribe to SSE
    const eventSource = new EventSource('/api/alerts/stream');
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'alert_triggered' || data.type === 'notification') {
        const notif = data.notification;
        setNotifications(prev => [notif, ...prev]);
        setUnreadCount(prev => prev + 1);
        
        // Browser native notification
        if (Notification.permission === 'granted') {
          new Notification(notif.title, { body: notif.content });
        }
      }
    };
    
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }

    return () => eventSource.close();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setSearchResults([]);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        if (res.ok) {
          const json = await res.json();
          setSearchResults(json.data || []);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const navGroups = [
    {
      title: "核心功能",
      items: [
        { name: "我的自选", path: "/pool", icon: Star },
        { name: "AI选股", path: "/ai-picks", icon: Cpu },
        { name: "策略回测", path: "/backtest", icon: Activity },
      ]
    },
    {
      title: "数据与工具",
      items: [
        { name: "数据控制台", path: "/", icon: Database },
      ]
    },
    {
      title: "系统配置",
      items: [
        { name: "⚙️ AI 设置", path: "/settings", icon: Settings },
      ]
    }
  ];

  const breadcrumbMap: Record<string, string> = {
    '/': '数据控制台',
    '/pool': '我的自选',
    '/ai-picks': 'AI选股',
    '/backtest': '策略回测',
    '/settings': '⚙️ AI 设置',
  };

  const currentTitle = breadcrumbMap[location.pathname] || (location.pathname.startsWith('/pool/') ? '个股详情' : '');

  return (
    <div className="flex h-screen bg-canvas-dark text-body-dark font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[220px] bg-surface-card-dark border-r border-hairline-dark flex flex-col flex-shrink-0">
        <div className="h-[60px] flex items-center px-5 border-b border-hairline-dark shrink-0">
          {/* 品牌 Logo 区域 */}
          <div className="flex items-center gap-2.5">
            <img src={logoIcon} alt="StockPulse Logo" className="w-7 h-7 rounded" />
            <span className="text-[16px] font-bold text-white tracking-wide">
              Stock<span className="text-primary text-[14px]">Pulse</span>
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar py-4">
          {navGroups.map((group, idx) => (
            <div key={idx} className="mb-6">
              <div className="px-5 mb-2 text-[12px] text-muted">{group.title}</div>
              <ul className="space-y-1">
                 {group.items.map((item) => {
                   const Icon = item.icon;
                   // Exact match for root, startsWith for others to keep them highlighted if active
                   const isActive = item.path === '/' 
                     ? location.pathname === '/' 
                     : location.pathname.startsWith(item.path);
                   return (
                     <li key={item.path}>
                       <Link
                         to={item.path}
                         className={cn(
                           "flex items-center gap-3 px-5 py-2.5 text-[14px] transition-colors relative",
                           isActive ? "text-primary bg-primary/10 font-medium" : "text-body-dark hover:bg-surface-elevated-dark hover:text-white"
                         )}
                       >
                         {isActive && <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary"></div>}
                         <Icon className="w-[18px] h-[18px]" />
                         {item.name}
                       </Link>
                     </li>
                   );
                 })}
              </ul>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-hairline-dark shrink-0 flex flex-col gap-4 bg-surface-card-dark">
           <button className="flex items-center justify-between w-full px-2 text-[13px] text-muted hover:text-white transition-colors">
              <div className="flex items-center gap-2">
                <Moon className="w-[18px] h-[18px]" />
                深色模式
              </div>
              <div className="w-8 h-4 bg-surface-elevated-dark rounded-full relative">
                 <div className="absolute left-1 top-1 w-2 h-2 bg-muted rounded-full"></div>
              </div>
           </button>
           <div className="flex items-center gap-3 px-2">
              <div className="w-8 h-8 rounded-full bg-surface-elevated-dark flex items-center justify-center shrink-0">
                 <User className="w-4 h-4 text-body-dark" />
              </div>
              <div className="flex flex-col">
                 <span className="text-[13px] text-white font-medium">Investor</span>
                 <span className="text-[11px] text-muted">专业版</span>
              </div>
           </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-[60px] bg-surface-card-dark border-b border-hairline-dark flex items-center justify-between px-6 shrink-0 z-10 w-full overflow-hidden">
           <div className="flex items-center gap-4 text-[14px] text-white font-medium">
             {currentTitle}
           </div>
           
           <div className="flex items-center gap-5 ml-4 shrink-0 hidden sm:flex">
             <div className="relative" ref={searchRef}>
               <input 
                 type="text" 
                 placeholder="代码/名称/拼音" 
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 onFocus={(e) => {
                   if (e.target.value && searchResults.length === 0) {
                     // trigger search again if focused
                     setSearchQuery(e.target.value);
                   }
                 }}
                 className="bg-surface-elevated-dark border border-transparent text-[13px] text-white rounded-lg pl-9 pr-4 py-1.5 focus:outline-none focus:ring-1 focus:ring-info w-48 transition-all placeholder:text-muted"
               />
               <Search className="w-3.5 h-3.5 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
               
               {/* Search Dropdown */}
               {(searchResults.length > 0 || isSearching) && searchQuery.trim() && (
                 <div className="absolute top-full left-0 right-0 mt-2 bg-surface-card-dark border border-hairline-dark rounded shadow-xl max-h-80 overflow-y-auto z-50">
                   {isSearching && searchResults.length === 0 ? (
                     <div className="p-3 text-[12px] text-muted text-center">搜索中...</div>
                   ) : searchResults.length > 0 ? (
                     <ul className="py-1 text-[13px]">
                       {searchResults.map((result) => (
                         <li key={result.marketCode}>
                           <button
                             className="w-full text-left px-4 py-2 hover:bg-surface-elevated-dark transition-colors flex items-center justify-between group"
                             onClick={() => {
                               navigate(`/pool/${result.marketCode}`);
                               setSearchQuery("");
                               setSearchResults([]);
                             }}
                           >
                             <div className="flex flex-col">
                               <span className="text-white group-hover:text-primary transition-colors">{result.name}</span>
                               <span className="text-[11px] text-muted font-mono">{result.marketCode}</span>
                             </div>
                             {result.price && (
                               <span className={result.changePercentage > 0 ? "text-trading-up font-mono text-[12px]" : result.changePercentage < 0 ? "text-trading-down font-mono text-[12px]" : "text-muted font-mono text-[12px]"}>
                                 {result.price.toFixed(2)}
                               </span>
                             )}
                           </button>
                         </li>
                       ))}
                     </ul>
                   ) : (
                     <div className="p-3 text-[12px] text-muted text-center">未找到相关结果</div>
                   )}
                 </div>
               )}
             </div>
             <div className="flex items-center gap-4 text-muted relative" ref={notifRef}>
                <div className="relative cursor-pointer" onClick={() => setShowNotifications(!showNotifications)}>
                  <Bell className="w-[18px] h-[18px] hover:text-white transition-colors" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-trading-up text-white text-[9px] font-bold px-1.5 rounded-full min-w-[14px] h-[14px] flex items-center justify-center">
                      {unreadCount}
                    </span>
                  )}
                </div>

                {/* Notifications Dropdown */}
                {showNotifications && (
                  <div className="absolute top-full right-0 mt-3 w-80 bg-surface-card-dark border border-hairline-dark rounded shadow-xl z-50 overflow-hidden flex flex-col">
                    <div className="flex items-center justify-between p-3 border-b border-hairline-dark bg-surface-elevated-dark">
                      <span className="text-[13px] text-white font-medium">通知中心</span>
                      <button 
                        className="text-[11px] text-primary hover:text-white"
                        onClick={() => {
                          fetch('/api/notifications/read', { method: 'POST' }).then(() => {
                            setNotifications(notifications.map(n => ({...n, isRead: true})));
                            setUnreadCount(0);
                          });
                        }}
                      >
                        全部已读
                      </button>
                    </div>
                    <div className="max-h-80 overflow-y-auto custom-scrollbar flex-1">
                      {notifications.length === 0 ? (
                        <div className="p-6 text-center text-muted text-[12px]">暂无通知</div>
                      ) : (
                        notifications.map((n, i) => (
                          <div key={i} className={`p-3 border-b border-hairline-dark last:border-0 hover:bg-surface-elevated-dark transition-colors ${!n.isRead ? 'bg-primary/5' : ''}`}>
                            <div className="flex justify-between items-start mb-1">
                              <span className={`text-[13px] font-medium ${!n.isRead ? 'text-white' : 'text-body-dark'}`}>{n.title}</span>
                              <span className="text-[10px] text-muted">{new Date(n.createdAt).toLocaleTimeString()}</span>
                            </div>
                            <p className="text-[12px] text-muted leading-relaxed">{n.content}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                <Mail className="w-[18px] h-[18px] hover:text-white cursor-pointer transition-colors" />
             </div>
           </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto bg-canvas-dark p-4 relative">
           <Outlet />
        </main>
      </div>
    </div>
  );
}
