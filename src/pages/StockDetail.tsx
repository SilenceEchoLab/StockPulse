import { useParams, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { StockData } from "../types";
import StockDetails from "../components/StockDetails";
import { Activity, ArrowLeft } from "lucide-react";
import { fetcher } from "../lib/api";

export default function StockDetail() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const { data: stockRes, error: swrError, isLoading: swrLoading } = useSWR(
    code ? `/api/stocks?codes=${code}` : null,
    fetcher,
    {
      refreshInterval: 15000,
      dedupingInterval: 5000,
      revalidateOnFocus: true,
    }
  );

  const stock: StockData | null = stockRes?.data?.[0] || null;
  const loading = swrLoading;
  const error = swrError?.message || (!stock && !loading ? "Stock not found" : null);

  if (loading) {
    return (
      <div className="flex h-[400px] items-center justify-center">
        <Activity className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  // B4 修复：错误态使用深色主题令牌而非浅色
  if (error || !stock) {
    return (
      <div className="bg-trading-down/10 text-trading-down p-6 rounded-lg flex flex-col items-center">
        <p className="mb-4">错误: {error || "未找到该股票"}</p>
        <button onClick={() => navigate(-1)} className="flex items-center text-trading-down hover:opacity-80 font-bold">
          <ArrowLeft className="w-4 h-4 mr-2" /> 返回
        </button>
      </div>
    );
  }

  return <StockDetails stock={stock} onBack={() => navigate(-1)} />;
}
