"use client";

import { useMemo, useState } from "react";
import { formatDate } from "@/lib/format";
import type { InBodyTestRow } from "@/lib/inbody-display";

type ChartTest = InBodyTestRow & {
  id: string;
  testedAt: string | null;
};

type MetricKey =
  | "weightKg"
  | "skeletalMuscleMassKg"
  | "bodyFatMassKg"
  | "percentBodyFat"
  | "bmi"
  | "totalBodyWaterKg"
  | "dryLeanMassKg";

const METRICS: { key: MetricKey; label: string; unit: string }[] = [
  { key: "weightKg", label: "Weight", unit: "kg" },
  { key: "skeletalMuscleMassKg", label: "SMM", unit: "kg" },
  { key: "bodyFatMassKg", label: "Body Fat Mass", unit: "kg" },
  { key: "percentBodyFat", label: "PBF", unit: "%" },
  { key: "bmi", label: "BMI", unit: "" },
  { key: "totalBodyWaterKg", label: "Total Body Water", unit: "kg" },
  { key: "dryLeanMassKg", label: "Dry Lean Mass", unit: "kg" },
];

// SVG geometry (viewBox units).
const W = 620;
const H = 200;
const PAD = { top: 24, right: 16, bottom: 28, left: 40 };

export function InBodyChart({ tests }: { tests: ChartTest[] }) {
  // Chronological order (oldest → newest) for a left-to-right trend.
  const ordered = useMemo(
    () =>
      [...tests]
        .filter((t) => t.testedAt)
        .sort((a, b) => new Date(a.testedAt!).getTime() - new Date(b.testedAt!).getTime()),
    [tests],
  );

  // Only offer metrics that have at least 2 data points to plot.
  const availableMetrics = useMemo(
    () =>
      METRICS.filter(
        (m) => ordered.filter((t) => t[m.key] !== null && t[m.key] !== undefined).length >= 2,
      ),
    [ordered],
  );

  const [metric, setMetric] = useState<MetricKey>(availableMetrics[0]?.key ?? "weightKg");
  const [hover, setHover] = useState<number | null>(null);

  if (ordered.length < 2 || availableMetrics.length === 0) return null;

  const active = availableMetrics.find((m) => m.key === metric) ?? availableMetrics[0];

  const points = ordered
    .map((t, i) => ({ i, value: t[active.key] as number | null, date: t.testedAt! }))
    .filter((p): p is { i: number; value: number; date: string } => p.value !== null);

  if (points.length < 2) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // Pad the domain a little so the line isn't flush against the edges.
  const domainMin = min - span * 0.15;
  const domainMax = max + span * 0.15;
  const domainSpan = domainMax - domainMin || 1;

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xFor = (idx: number) =>
    PAD.left + (points.length === 1 ? innerW / 2 : (idx / (points.length - 1)) * innerW);
  const yFor = (v: number) => PAD.top + innerH - ((v - domainMin) / domainSpan) * innerH;

  const coords = points.map((p, idx) => ({ ...p, cx: xFor(idx), cy: yFor(p.value) }));
  const linePath = coords.map((c) => `${c.cx},${c.cy}`).join(" ");
  const areaPath = `${PAD.left},${PAD.top + innerH} ${linePath} ${coords[coords.length - 1].cx},${PAD.top + innerH}`;

  const first = points[0].value;
  const last = points[points.length - 1].value;
  const delta = last - first;
  const deltaLabel =
    (delta >= 0 ? "+" : "") + `${Math.round(delta * 10) / 10}${active.unit}`;
  // For weight/fat, down is good (green); for muscle/water/lean, up is good.
  const higherIsBetter = ["skeletalMuscleMassKg", "totalBodyWaterKg", "dryLeanMassKg"].includes(
    active.key,
  );
  const good = higherIsBetter ? delta > 0 : delta < 0;
  const deltaColor = delta === 0 ? "text-slate-500" : good ? "text-emerald-600" : "text-rose-600";

  const fmt = (v: number) => `${Math.round(v * 10) / 10}${active.unit}`;

  return (
    <div className="card-pad">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900">InBody trend</h3>
        <span className={`text-xs font-medium ${deltaColor}`}>
          {deltaLabel} since first test
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {availableMetrics.map((m) => (
          <button
            key={m.key}
            onClick={() => {
              setMetric(m.key);
              setHover(null);
            }}
            className={
              m.key === metric
                ? "text-xs px-2.5 py-1 rounded-full bg-indigo-600 text-white"
                : "text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
            }
          >
            {m.label}
          </button>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="inbodyArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y reference lines (max / mid / min of actual data) */}
        {[max, (max + min) / 2, min].map((v, k) => {
          const y = yFor(v);
          return (
            <g key={k}>
              <line
                x1={PAD.left}
                y1={y}
                x2={W - PAD.right}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text x={PAD.left - 6} y={y + 3} textAnchor="end" className="fill-slate-400" fontSize="9">
                {Math.round(v * 10) / 10}
              </text>
            </g>
          );
        })}

        {/* Area + line */}
        <polygon points={areaPath} fill="url(#inbodyArea)" />
        <polyline
          points={linePath}
          fill="none"
          stroke="#6366f1"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Dots + hover targets */}
        {coords.map((c, idx) => (
          <g key={idx}>
            <circle cx={c.cx} cy={c.cy} r={hover === idx ? 5 : 3.5} fill="#4f46e5" stroke="#fff" strokeWidth={1.5} />
            <rect
              x={c.cx - innerW / (points.length * 2)}
              y={PAD.top}
              width={innerW / points.length}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHover(idx)}
            />
            {/* X-axis date labels: first, last, and hovered */}
            {(idx === 0 || idx === points.length - 1 || hover === idx) && (
              <text
                x={c.cx}
                y={H - 10}
                textAnchor={idx === 0 ? "start" : idx === points.length - 1 ? "end" : "middle"}
                className="fill-slate-400"
                fontSize="9"
              >
                {shortDate(c.date)}
              </text>
            )}
          </g>
        ))}

        {/* Hover tooltip */}
        {hover !== null && coords[hover] && (
          <g>
            <line
              x1={coords[hover].cx}
              y1={PAD.top}
              x2={coords[hover].cx}
              y2={PAD.top + innerH}
              stroke="#c7d2fe"
              strokeWidth={1}
            />
            <text
              x={clamp(coords[hover].cx, PAD.left + 20, W - PAD.right - 20)}
              y={Math.max(coords[hover].cy - 10, PAD.top + 8)}
              textAnchor="middle"
              className="fill-slate-900 font-semibold"
              fontSize="11"
            >
              {fmt(coords[hover].value)}
            </text>
          </g>
        )}
      </svg>

      <p className="text-[11px] text-slate-400 mt-1">
        {active.label} across {points.length} tests · {formatDate(points[0].date)} –{" "}
        {formatDate(points[points.length - 1].date)}
      </p>
    </div>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
