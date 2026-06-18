import { useParams, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { StockData } from "../types";
import StockDetails from "../components/StockDetails";
import { Activity, ArrowLeft } from "lucide-react";

const fetcher = (url: string) => fetch(url).then((res) => {
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
});

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
        <Activity className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (error || !stock) {
    return (
      <div className="bg-red-50 text-red-600 p-6 rounded-2xl flex flex-col items-center">
        <p className="mb-4">Error: {error || "Stock not found"}</p>
        <button onClick={() => navigate(-1)} className="flex items-center text-red-600 hover:text-red-800 font-bold">
          <ArrowLeft className="w-4 h-4 mr-2" /> 返回
        </button>
      </div>
    );
  }

  return <StockDetails stock={stock} onBack={() => navigate(-1)} />;
}
