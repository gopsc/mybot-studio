import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

const HIDDEN_BY_DEFAULT = /^(count|nvals|values\.\d+)$/;

interface Props {
  series: Map<string, (number | null)[]>;
  xLabels: string[];
  visible: boolean;
}

export function Chart({ series, xLabels, visible }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const instance = echarts.init(host.current!, "dark", { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    const names = [...series.keys()];
    const key = names.join("\n");
    const data = names.map((name) => ({ name, data: series.get(name) }));
    // Streaming updates with the same series merge, keeping legend toggles and zoom.
    if (key === shown.current) {
      chart.current?.setOption({ xAxis: { data: xLabels }, series: data });
      return;
    }
    shown.current = key;
    chart.current?.setOption({
      backgroundColor: "transparent",
      animation: false,
      tooltip: { trigger: "axis" },
      legend: { type: "scroll", top: 0, selected: Object.fromEntries(names.map((n) => [n, !HIDDEN_BY_DEFAULT.test(n)])) },
      grid: { left: 60, right: 20, top: 36, bottom: 50 },
      xAxis: { type: "category", data: xLabels, name: "样本", nameLocation: "middle", nameGap: 26 },
      yAxis: { type: "value", scale: true },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 14, bottom: 6 }],
      series: data.map((item) => ({ ...item, type: "line", showSymbol: false, connectNulls: false })),
    }, { notMerge: true });
  }, [series, xLabels]);

  useEffect(() => {
    if (visible) chart.current?.resize();
  }, [visible]);

  return <div ref={host} className="chart" />;
}
