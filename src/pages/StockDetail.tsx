import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { StockData } from "../types";
import StockDetails from "../components/StockDetails";
import { Activity, ArrowLeft } from "lucide-react";

export default function StockDetail() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [stock, setStock] = useState<StockData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStock = async () => {
      if (!code) return;
      try {
        setLoading(true);
        const res = await fetch(`/api/stocks?codes=${code}`);
        if (!res.ok) throw new Error("Failed to fetch stock real-time data");
        const json = await res.json();
        if (json.success && json.data && json.data.length > 0) {
          setStock(json.data[0]);
        } else {
          setError("Stock not found or invalid format");
        }
      } catch (err: any) {
        setError(err.message || "Failed to load stock data");
      } finally {
        setLoading(false);
      }
    };
    fetchStock();
  }, [code]);

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
