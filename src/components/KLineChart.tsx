import { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CrosshairMode, LineStyle, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts';

interface KlineData {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  macd?: number;
  macdSignal?: number;
  macdHist?: number;
  rsi14?: number;
  bollMid?: number;
  bollUpper?: number;
  bollLower?: number;
  kdjK?: number;
  kdjD?: number;
  kdjJ?: number;
}

interface KLineChartProps {
  data: KlineData[];
  activeIndicator: 'MACD' | 'KDJ' | 'RSI';
  period: string;
}

export function KLineChart({ data, activeIndicator, period }: KLineChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const indicatorContainerRef = useRef<HTMLDivElement>(null);
  const [mainChart, setMainChart] = useState<IChartApi | null>(null);
  const [indChart, setIndChart] = useState<IChartApi | null>(null);
  const seriesRef = useRef<any>({});
  const indSeriesRef = useRef<any[]>([]);

  useEffect(() => {
    if (!chartContainerRef.current || !indicatorContainerRef.current) return;

    // Define colors mapped to our theme tokens
    const colorUp = '#f23645'; // Up is RED
    const colorDown = '#1bb154'; // Down is GREEN
    const colorBg = 'transparent';
    const colorGrid = '#232733'; // hairline-dark
    const colorText = '#787b86'; // muted

    // MAIN CHART
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid', color: colorBg } as any,
        textColor: colorText,
      },
      grid: {
        vertLines: { color: colorGrid, style: LineStyle.Dotted },
        horzLines: { color: colorGrid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: colorGrid,
      },
      timeScale: {
        borderColor: colorGrid,
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: colorUp,
      downColor: colorDown,
      borderVisible: false,
      wickUpColor: colorUp,
      wickDownColor: colorDown,
    });

    // Sub-pane for Volume
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '', // set as an overlay
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    // MA Lines (Boll)
    const bollMidSeries = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, crosshairMarkerVisible: false });
    const bollUpperSeries = chart.addSeries(LineSeries, { color: colorUp, lineWidth: 1, lineStyle: LineStyle.Dotted, crosshairMarkerVisible: false });
    const bollLowerSeries = chart.addSeries(LineSeries, { color: colorDown, lineWidth: 1, lineStyle: LineStyle.Dotted, crosshairMarkerVisible: false });

    // INDICATOR CHART
    const indicatorChart = createChart(indicatorContainerRef.current, {
      layout: {
        background: { type: 'solid', color: colorBg } as any,
        textColor: colorText,
      },
      grid: {
        vertLines: { color: colorGrid, style: LineStyle.Dotted },
        horzLines: { color: colorGrid, style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: colorGrid,
      },
      timeScale: {
        borderColor: colorGrid,
        visible: false, // hide time axis on bottom chart, sync with top
      },
      autoSize: true,
    });

    // Sync charts
    const syncCharts = (timeScale1: any, timeScale2: any) => {
      let isSyncing = false;
      timeScale1.subscribeVisibleLogicalRangeChange((range: any) => {
        if (!isSyncing && range) {
          isSyncing = true;
          timeScale2.setVisibleLogicalRange(range);
          isSyncing = false;
        }
      });
      timeScale2.subscribeVisibleLogicalRangeChange((range: any) => {
        if (!isSyncing && range) {
          isSyncing = true;
          timeScale1.setVisibleLogicalRange(range);
          isSyncing = false;
        }
      });
      
      let crosshairSyncing = false;
      chart.subscribeCrosshairMove((param) => {
        if (!crosshairSyncing) {
          crosshairSyncing = true;
          if (param.point && param.time && indSeriesRef.current[0]) {
            const series = indSeriesRef.current[0];
            const dataPoint = param.seriesData.get(seriesRef.current.candleSeries as any);
            const price = dataPoint ? (dataPoint as any).close || (dataPoint as any).value || 0 : 0;
            indicatorChart.setCrosshairPosition(price, param.time, series);
          } else {
            indicatorChart.clearCrosshairPosition();
          }
          crosshairSyncing = false;
        }
      });
      indicatorChart.subscribeCrosshairMove((param) => {
        if (!crosshairSyncing) {
          crosshairSyncing = true;
          if (param.point && param.time && seriesRef.current.candleSeries) {
            const dataPoint = param.seriesData.get(indSeriesRef.current[0] as any);
            const price = dataPoint ? (dataPoint as any).value || 0 : 0;
            chart.setCrosshairPosition(price, param.time, seriesRef.current.candleSeries);
          } else {
            chart.clearCrosshairPosition();
          }
          crosshairSyncing = false;
        }
      });
    };
    
    syncCharts(chart.timeScale(), indicatorChart.timeScale());

    seriesRef.current = { candleSeries, volumeSeries, bollMidSeries, bollUpperSeries, bollLowerSeries };
    setMainChart(chart);
    setIndChart(indicatorChart);

    return () => {
      chart.remove();
      indicatorChart.remove();
    };
  }, []);

  useEffect(() => {
    if (!mainChart || !indChart || !data || data.length === 0) return;

    const formattedData = data.map((d) => {
      // Lightweight charts expects time as UNIX timestamp or string in specific format
      // If we are passing string "YYYY-MM-DD HH:mm:ss", lightweight charts might complain if not daily.
      // So we parse to unix timestamp for safe rendering
      let timeStr = d.date;
      if (timeStr.length === 10) {
        timeStr = timeStr + 'T00:00:00+08:00';
      } else {
        timeStr = timeStr.replace(' ', 'T') + '+08:00';
      }
      const time = Math.floor(new Date(timeStr).getTime() / 1000);
      return { ...d, time: time as any }; 
    }).sort((a, b) => a.time - b.time);

    // Update Main Chart
    const candleData = formattedData.map(d => ({
      time: d.time,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
    }));
    
    const volumeData = formattedData.map(d => ({
      time: d.time,
      value: d.volume,
      color: d.close >= d.open ? 'rgba(242, 54, 69, 0.5)' : 'rgba(27, 177, 84, 0.5)',
    }));

    const { candleSeries, volumeSeries, bollMidSeries, bollUpperSeries, bollLowerSeries } = seriesRef.current;
    
    candleSeries?.setData(candleData);
    volumeSeries?.setData(volumeData);

    bollMidSeries?.setData(formattedData.filter(d => d.bollMid != null).map(d => ({ time: d.time, value: d.bollMid })));
    bollUpperSeries?.setData(formattedData.filter(d => d.bollUpper != null).map(d => ({ time: d.time, value: d.bollUpper })));
    bollLowerSeries?.setData(formattedData.filter(d => d.bollLower != null).map(d => ({ time: d.time, value: d.bollLower })));

    // Update Indicator Chart
    // First clear existing series
    indSeriesRef.current.forEach((s: any) => indChart.removeSeries(s));
    indSeriesRef.current = [];

    if (activeIndicator === 'MACD') {
      const macdSeries = indChart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1 });
      const signalSeries = indChart.addSeries(LineSeries, { color: '#f5cb42', lineWidth: 1 });
      const histSeries = indChart.addSeries(HistogramSeries, {
        color: '#26a69a',
      });

      macdSeries.setData(formattedData.filter(d => d.macd != null).map(d => ({ time: d.time, value: d.macd })));
      signalSeries.setData(formattedData.filter(d => d.macdSignal != null).map(d => ({ time: d.time, value: d.macdSignal })));
      histSeries.setData(formattedData.filter(d => d.macdHist != null).map(d => ({
        time: d.time,
        value: d.macdHist,
        color: (d.macdHist || 0) >= 0 ? 'rgba(242, 54, 69, 0.8)' : 'rgba(27, 177, 84, 0.8)',
      })));
      indSeriesRef.current.push(macdSeries, signalSeries, histSeries);
    } else if (activeIndicator === 'KDJ') {
      const kSeries = indChart.addSeries(LineSeries, { color: '#eab308', lineWidth: 1 });
      const dSeries = indChart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1 });
      const jSeries = indChart.addSeries(LineSeries, { color: '#ec4899', lineWidth: 1 });

      kSeries.setData(formattedData.filter(d => d.kdjK != null).map(d => ({ time: d.time, value: d.kdjK })));
      dSeries.setData(formattedData.filter(d => d.kdjD != null).map(d => ({ time: d.time, value: d.kdjD })));
      jSeries.setData(formattedData.filter(d => d.kdjJ != null).map(d => ({ time: d.time, value: d.kdjJ })));
      indSeriesRef.current.push(kSeries, dSeries, jSeries);
    } else if (activeIndicator === 'RSI') {
      const rsiSeries = indChart.addSeries(LineSeries, { color: '#1bb154', lineWidth: 1 });
      rsiSeries.setData(formattedData.filter(d => d.rsi14 != null).map(d => ({ time: d.time, value: d.rsi14 })));
      indSeriesRef.current.push(rsiSeries);
    }

    mainChart.timeScale().fitContent();

  }, [data, activeIndicator, mainChart, indChart]);

  return (
    <div className="flex flex-col h-full w-full">
      <div ref={chartContainerRef} className="flex-[3] relative min-h-[300px]" />
      <div className="h-px bg-hairline-dark w-full" />
      <div ref={indicatorContainerRef} className="h-[200px] relative shrink-0" />
    </div>
  );
}
