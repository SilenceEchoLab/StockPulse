import { HashRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import MarketOverview from "./pages/MarketOverview";

// A1 修复：路由级代码分割，延迟加载重型页面（图表库等）
const Dashboard = lazy(() => import("./pages/Dashboard"));
const StockPool = lazy(() => import("./pages/StockPool"));
const StockDetail = lazy(() => import("./pages/StockDetail"));
const AiPicks = lazy(() => import("./pages/AiPicks"));
const Backtest = lazy(() => import("./pages/Backtest"));
const Settings = lazy(() => import("./pages/Settings"));

const PageFallback = () => (
  <div className="flex items-center justify-center h-[400px]">
    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
  </div>
);

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<MarketOverview />} />
          <Route path="sync" element={<Suspense fallback={<PageFallback />}><Dashboard /></Suspense>} />
          <Route path="pool" element={<Suspense fallback={<PageFallback />}><StockPool /></Suspense>} />
          <Route path="pool/:code" element={<Suspense fallback={<PageFallback />}><ErrorBoundary><StockDetail /></ErrorBoundary></Suspense>} />
          <Route path="ai-picks" element={<Suspense fallback={<PageFallback />}><AiPicks /></Suspense>} />
          <Route path="backtest" element={<Suspense fallback={<PageFallback />}><ErrorBoundary><Backtest /></ErrorBoundary></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<PageFallback />}><Settings /></Suspense>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
