import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import StockPool from "./pages/StockPool";
import StockDetail from "./pages/StockDetail";
import AiPicks from "./pages/AiPicks";
import Backtest from "./pages/Backtest";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="pool" element={<StockPool />} />
          <Route path="pool/:code" element={<StockDetail />} />
          <Route path="ai-picks" element={<AiPicks />} />
          <Route path="backtest" element={<Backtest />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Router>
  );
}
