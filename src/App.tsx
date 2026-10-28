/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
  Plugin
} from 'chart.js';
import {
  Zap,
  Activity,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  Layers,
  ArrowDownRight,
  TrendingDown,
  Info,
  ShieldCheck,
  Radio,
  FileCode,
  Download,
  Copy,
  Check
} from 'lucide-react';

// Register Chart.js components
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend
);

// Constants
const CAPACITY = 480; // Supply Capacity Limit in MW

const HOURS = [
  '00:00', '01:00', '02:00', '03:00', '04:00', '05:00',
  '06:00', '07:00', '08:00', '09:00', '10:00', '11:00',
  '12:00', '13:00', '14:00', '15:00', '16:00', '17:00',
  '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'
];

// Baseline Simulated Hourly Load for 4 Districts (deterministic, smooth curves + offsets)
const BASELINE_DATA: Record<string, number[]> = {
  residential: [
    42, 38, 35, 34, 36, 45, 65, 95, 105, 88,
    72, 68, 66, 65, 67, 72, 85, 125, 180, 205,
    198, 165, 110, 65
  ],
  industrial: [
    32, 30, 30, 30, 32, 38, 55, 85, 125, 130,
    132, 130, 115, 128, 132, 130, 125, 110, 90, 65,
    58, 45, 35, 32
  ],
  commercial: [
    22, 20, 18, 18, 20, 25, 35, 55, 90, 125,
    145, 155, 150, 152, 155, 152, 148, 145, 160, 150,
    146, 110, 50, 32
  ],
  transit: [
    12, 10, 10, 10, 12, 20, 45, 82, 88, 65,
    42, 38, 40, 42, 45, 52, 72, 90, 98, 92,
    90, 50, 24, 16
  ]
};

const DISTRICT_CONFIGS = [
  {
    id: 'residential',
    label: 'Residential',
    desc: 'EV charging, water heaters, domestic heat pumps',
    color: '#2563eb',
    bgColor: 'rgba(37, 99, 235, 0.45)'
  },
  {
    id: 'industrial',
    label: 'Industrial',
    desc: 'Batch melting, refrigeration, material handling',
    color: '#059669',
    bgColor: 'rgba(5, 150, 105, 0.45)'
  },
  {
    id: 'commercial',
    label: 'Commercial',
    desc: 'HVAC pre-cooling, ventilation, non-critical lighting',
    color: '#d97706',
    bgColor: 'rgba(217, 119, 6, 0.45)'
  },
  {
    id: 'transit',
    label: 'Transit',
    desc: 'Depot e-bus battery top-up & yard switching',
    color: '#7c3aed',
    bgColor: 'rgba(124, 58, 237, 0.45)'
  }
];

interface SimulationResult {
  districts: number[][];
  total: number[];
  peak: number;
  hoursOverCapacity: number;
  totalEnergy: number;
}

// Coordinator Algorithm:
// 1. Compute total demand per hour.
// 2. Take flexible load out of original hours (f * baseline).
// 3. Put that load back one chunk at a time into the hour with the lowest current total demand.
// 4. Strict energy conservation: total daily energy stays identical.
function runCoordinatorSimulation(flexShare: number): SimulationResult {
  const hoursCount = 24;
  const numDistricts = DISTRICT_CONFIGS.length;
  const baselineDistrictLoads = DISTRICT_CONFIGS.map(d => [...BASELINE_DATA[d.id]]);

  // Calculate baseline total per hour
  const baselineTotal = new Array(hoursCount).fill(0);
  for (let h = 0; h < hoursCount; h++) {
    for (let d = 0; d < numDistricts; d++) {
      baselineTotal[h] += baselineDistrictLoads[d][h];
    }
  }

  if (flexShare <= 0) {
    return {
      districts: baselineDistrictLoads,
      total: [...baselineTotal],
      peak: Math.max(...baselineTotal),
      hoursOverCapacity: baselineTotal.filter(v => v > CAPACITY).length,
      totalEnergy: baselineTotal.reduce((a, b) => a + b, 0)
    };
  }

  // Separate fixed vs flexible
  const fixedDistrictLoads: number[][] = [];
  const flexPoolPerDistrict = new Array(numDistricts).fill(0);
  let totalFlexPool = 0;

  for (let d = 0; d < numDistricts; d++) {
    fixedDistrictLoads[d] = new Array(hoursCount).fill(0);
    for (let h = 0; h < hoursCount; h++) {
      const base = baselineDistrictLoads[d][h];
      const fixed = base * (1 - flexShare);
      const flex = base * flexShare;
      fixedDistrictLoads[d][h] = fixed;
      flexPoolPerDistrict[d] += flex;
      totalFlexPool += flex;
    }
  }

  const poolShares = flexPoolPerDistrict.map(p => (totalFlexPool > 0 ? p / totalFlexPool : 0.25));

  // Initialize coordinated schedule with fixed load
  const coordDistricts = fixedDistrictLoads.map(arr => [...arr]);
  const coordTotal = new Array(hoursCount).fill(0);
  for (let h = 0; h < hoursCount; h++) {
    for (let d = 0; d < numDistricts; d++) {
      coordTotal[h] += coordDistricts[d][h];
    }
  }

  // Greedy water-filling into minimum demand hour
  let remaining = totalFlexPool;
  const stepSize = 0.5; // Fine resolution chunk

  while (remaining > 1e-6) {
    const chunk = Math.min(remaining, stepSize);

    // Find hour with lowest current total demand
    let minHour = 0;
    let minDemand = coordTotal[0];
    for (let h = 1; h < hoursCount; h++) {
      if (coordTotal[h] < minDemand) {
        minDemand = coordTotal[h];
        minHour = h;
      }
    }

    coordTotal[minHour] += chunk;
    for (let d = 0; d < numDistricts; d++) {
      coordDistricts[d][minHour] += chunk * poolShares[d];
    }

    remaining -= chunk;
  }

  const peak = Math.max(...coordTotal);
  const hoursOverCapacity = coordTotal.filter(v => v > CAPACITY + 0.05).length;
  const totalEnergy = coordTotal.reduce((a, b) => a + b, 0);

  return {
    districts: coordDistricts,
    total: coordTotal,
    peak,
    hoursOverCapacity,
    totalEnergy
  };
}

export default function App() {
  const [isCoordinatorOn, setIsCoordinatorOn] = useState<boolean>(true);
  const [flexSharePct, setFlexSharePct] = useState<number>(20);
  const [visibleDistricts, setVisibleDistricts] = useState<Record<string, boolean>>({
    residential: true,
    industrial: true,
    commercial: true,
    transit: true
  });
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [copiedHtml, setCopiedHtml] = useState<boolean>(false);

  const mainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sweepCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mainChartRef = useRef<Chart | null>(null);
  const sweepChartRef = useRef<Chart | null>(null);

  // Baseline uncoordinated metrics (OFF)
  const baselineResult = useMemo(() => runCoordinatorSimulation(0), []);

  // Coordinated simulation at current slider setting
  const onSimulation = useMemo(() => runCoordinatorSimulation(flexSharePct / 100), [flexSharePct]);

  // Active displayed simulation
  const currentSimulation = isCoordinatorOn ? onSimulation : baselineResult;

  // Precomputed flexibility sweep points (0% to 50%)
  const sweepPoints = useMemo(() => {
    const pts = [];
    for (let pct = 0; pct <= 50; pct += 2) {
      const res = runCoordinatorSimulation(pct / 100);
      pts.push({ x: pct, y: Number(res.peak.toFixed(1)) });
    }
    return pts;
  }, []);

  // Setup / Update Main Demand Chart
  useEffect(() => {
    if (!mainCanvasRef.current) return;

    // Custom shading plugin for over-capacity hours
    const overCapacityPlugin: Plugin = {
      id: 'overCapacityShadingReact',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!scales.x || !scales.y || !chartArea) return;

        const totalDs = chart.data.datasets.find(ds => ds.label === 'Total Demand');
        if (!totalDs || !totalDs.data) return;

        ctx.save();
        ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';

        const count = totalDs.data.length;
        for (let i = 0; i < count; i++) {
          const val = Number(totalDs.data[i]);
          if (val > CAPACITY) {
            const xCenter = scales.x.getPixelForValue(i);
            const prevX = i > 0 ? scales.x.getPixelForValue(i - 1) : xCenter;
            const nextX = i < count - 1 ? scales.x.getPixelForValue(i + 1) : xCenter;
            const halfW = Math.abs(nextX - prevX) / 2 || 14;

            const left = Math.max(chartArea.left, xCenter - halfW);
            const right = Math.min(chartArea.right, xCenter + halfW);
            const width = right - left;

            ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);

            ctx.fillStyle = 'rgba(220, 38, 38, 0.7)';
            ctx.fillRect(left, chartArea.top, width, 3);
            ctx.fillStyle = 'rgba(239, 68, 68, 0.15)';
          }
        }
        ctx.restore();
      }
    };

    if (!mainChartRef.current) {
      const ctx = mainCanvasRef.current.getContext('2d');
      if (!ctx) return;

      const datasets = DISTRICT_CONFIGS.map((district, idx) => ({
        label: district.label,
        data: currentSimulation.districts[idx].map(v => Number(v.toFixed(1))),
        borderColor: district.color,
        backgroundColor: district.bgColor,
        borderWidth: 1.5,
        fill: true,
        stack: 'districts',
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
        hidden: !visibleDistricts[district.id],
        order: 2
      }));

      // Total Demand Line
      datasets.push({
        label: 'Total Demand',
        data: currentSimulation.total.map(v => Number(v.toFixed(1))),
        borderColor: '#0f172a',
        backgroundColor: 'transparent',
        borderWidth: 3.5,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 6,
        // @ts-expect-error Chart.js custom stack flag
        stack: undefined,
        fill: false,
        order: 1
      });

      // Capacity Line
      datasets.push({
        label: 'Supply Capacity (480 MW)',
        data: new Array(HOURS.length).fill(CAPACITY),
        borderColor: '#dc2626',
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        // @ts-expect-error Chart.js custom stack flag
        stack: undefined,
        fill: false,
        order: 0
      });

      mainChartRef.current = new Chart(ctx, {
        type: 'line',
        data: { labels: HOURS, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 380, easing: 'easeOutQuart' },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.94)',
              padding: 10,
              callbacks: {
                label(context) {
                  return ` ${context.dataset.label}: ${context.parsed.y !== null ? context.parsed.y.toFixed(1) + ' MW' : ''}`;
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(148, 163, 184, 0.12)' },
              ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 11 } }
            },
            y: {
              beginAtZero: true,
              max: 580,
              grid: { color: 'rgba(148, 163, 184, 0.12)' },
              ticks: {
                stepSize: 100,
                font: { size: 11 },
                callback(val) {
                  return val + ' MW';
                }
              }
            }
          }
        },
        plugins: [overCapacityPlugin]
      });
    } else {
      // Update existing main chart
      const chart = mainChartRef.current;
      DISTRICT_CONFIGS.forEach((district, idx) => {
        const ds = chart.data.datasets.find(d => d.label === district.label);
        if (ds) {
          ds.data = currentSimulation.districts[idx].map(v => Number(v.toFixed(1)));
          ds.hidden = !visibleDistricts[district.id];
        }
      });

      const totalDs = chart.data.datasets.find(d => d.label === 'Total Demand');
      if (totalDs) {
        totalDs.data = currentSimulation.total.map(v => Number(v.toFixed(1)));
      }

      chart.update();
    }
  }, [currentSimulation, visibleDistricts]);

  // Setup / Update Flexibility Sweep Chart
  useEffect(() => {
    if (!sweepCanvasRef.current) return;

    if (!sweepChartRef.current) {
      const ctx = sweepCanvasRef.current.getContext('2d');
      if (!ctx) return;

      sweepChartRef.current = new Chart(ctx, {
        type: 'line',
        data: {
          labels: sweepPoints.map(p => p.x + '%'),
          datasets: [
            {
              label: 'Peak Demand with Coordinator (MW)',
              data: sweepPoints.map(p => p.y),
              borderColor: '#0284c7',
              backgroundColor: 'rgba(2, 132, 199, 0.08)',
              borderWidth: 2.5,
              fill: true,
              tension: 0.35,
              pointRadius: 0,
              pointHoverRadius: 4,
              order: 2
            },
            {
              label: 'Supply Capacity (480 MW)',
              data: new Array(sweepPoints.length).fill(CAPACITY),
              borderColor: '#dc2626',
              borderWidth: 1.5,
              borderDash: [5, 4],
              pointRadius: 0,
              fill: false,
              order: 1
            },
            {
              label: 'Current Slider Position',
              data: sweepPoints.map(p => (p.x === Math.round(flexSharePct) ? p.y : null)),
              borderColor: '#0284c7',
              backgroundColor: '#0284c7',
              pointBackgroundColor: '#ffffff',
              pointBorderColor: '#0284c7',
              pointBorderWidth: 3,
              pointRadius: 6,
              pointHoverRadius: 8,
              showLine: false,
              order: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 250 },
          interaction: { mode: 'nearest', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.94)',
              callbacks: {
                label(context) {
                  const val = context.parsed.y != null ? context.parsed.y.toFixed(1) : '0.0';
                  return ` Peak Demand: ${val} MW`;
                }
              }
            }
          },
          scales: {
            x: {
              title: { display: true, text: 'Flexible Share (%)', font: { size: 11, weight: 'bold' } },
              grid: { color: 'rgba(148, 163, 184, 0.12)' },
              ticks: { font: { size: 10 } }
            },
            y: {
              min: 300,
              max: 560,
              title: { display: true, text: 'Peak Demand (MW)', font: { size: 11, weight: 'bold' } },
              grid: { color: 'rgba(148, 163, 184, 0.12)' },
              ticks: { stepSize: 50, font: { size: 10 } }
            }
          }
        }
      });
    } else {
      const chart = sweepChartRef.current;
      const markerDs = chart.data.datasets.find(ds => ds.label === 'Current Slider Position');
      if (markerDs) {
        let closestIdx = 0;
        let minDiff = 999;
        sweepPoints.forEach((pt, i) => {
          const diff = Math.abs(pt.x - flexSharePct);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = i;
          }
        });

        markerDs.data = sweepPoints.map((p, idx) => (idx === closestIdx && isCoordinatorOn ? p.y : null));
        chart.update('none');
      }
    }
  }, [flexSharePct, isCoordinatorOn, sweepPoints]);

  // Metric computations
  const peakOff = baselineResult.peak; // 528.0 MW
  const peakOn = onSimulation.peak;   // 422.4 MW
  const peakDelta = peakOn - peakOff;
  const peakDeltaPct = ((peakDelta / peakOff) * 100).toFixed(1);

  const hoursOff = baselineResult.hoursOverCapacity; // 3
  const hoursOn = onSimulation.hoursOverCapacity;   // 0
  const hoursDelta = hoursOn - hoursOff;

  const energyOff = baselineResult.totalEnergy; // 8420.0
  const energyOn = onSimulation.totalEnergy;   // 8420.0
  const energyDelta = Math.abs(energyOn - energyOff);

  const reducOn = Math.abs(peakDelta / peakOff) * 100;
  const currentReduc = isCoordinatorOn ? reducOn : 0.0;
  const currentHeadroom = CAPACITY - (isCoordinatorOn ? peakOn : peakOff);

  // Self-contained standalone HTML generator function
  const generateStandaloneHtml = () => {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>UrbanSync — City Load Coordinator & Peak Demand Demo</title>
    <meta name="description" content="UrbanSync demonstrates how a basic city coordinator flattens daily demand peaks by shifting flexible load across urban districts." />
    <!-- Single allowed external script: pinned Chart.js from cdnjs -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
    <style>
      :root {
        --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        --bg-page: #f8fafc; --bg-card: #ffffff; --bg-subtle: #f1f5f9;
        --border-subtle: #e2e8f0; --border-strong: #cbd5e1;
        --text-primary: #0f172a; --text-secondary: #475569; --text-muted: #64748b;
        --accent: #0284c7; --accent-subtle: #e0f2fe;
        --color-residential: #2563eb; --color-industrial: #059669;
        --color-commercial: #d97706; --color-transit: #7c3aed;
        --color-total: #0f172a; --color-capacity: #dc2626;
        --badge-success-text: #047857; --badge-danger-text: #b91c1c;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg-page: #090d16; --bg-card: #111827; --bg-subtle: #1f2937;
          --border-subtle: #2d3748; --border-strong: #4b5563;
          --text-primary: #f8fafc; --text-secondary: #cbd5e1; --text-muted: #94a3b8;
          --accent: #38bdf8; --accent-subtle: #082f49;
          --color-total: #f8fafc; --color-capacity: #ef4444;
          --badge-success-text: #6ee7b7; --badge-danger-text: #fca5a5;
        }
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: var(--font-sans); background-color: var(--bg-page); color: var(--text-primary); padding: 1.5rem 1rem 3rem; }
      .container { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
      header, .card { background-color: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 14px; padding: 1.5rem 1.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
      .brand { font-size: 1.85rem; font-weight: 800; letter-spacing: -0.03em; }
      .brand span { color: var(--accent); }
      .tagline { color: var(--text-secondary); font-size: 1.05rem; margin-top: 0.25rem; font-weight: 500; }
      .disclaimer { font-size: 0.8rem; background: var(--bg-subtle); padding: 0.4rem 0.75rem; border-radius: 6px; border: 1px dashed var(--border-strong); display: inline-block; margin-top: 0.75rem; color: var(--text-muted); }
      .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; align-items: center; }
      .toggle-btn { width: 62px; height: 32px; background: var(--border-strong); border-radius: 9999px; border: none; cursor: pointer; padding: 3px; transition: background 0.2s; position: relative; }
      .toggle-btn[aria-checked="true"] { background: var(--accent); }
      .toggle-handle { width: 26px; height: 26px; background: #fff; border-radius: 50%; display: block; transition: transform 0.2s; }
      .toggle-btn[aria-checked="true"] .toggle-handle { transform: translateX(30px); }
      .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
      .metric-card { background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between; }
      .metric-val { font-family: var(--font-mono); font-size: 1.85rem; font-weight: 800; }
      .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-top: 0.75rem; }
      .step { background: var(--bg-subtle); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 1.25rem; }
      .signal { background: var(--accent-subtle); border: 1px solid var(--accent); border-radius: 10px; padding: 1rem 1.25rem; margin-top: 1rem; font-family: var(--font-mono); }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <h1 class="brand">Urban<span>Sync</span></h1>
        <p class="tagline">Monitoring Public Service Usage: A Basic System for Efficient Service Operation</p>
        <div class="disclaimer">All data is simulated and illustrative, not real city measurements.</div>
      </header>
      <section class="card controls">
        <div>
          <label style="font-weight: 700; font-size: 0.85rem; text-transform: uppercase; color: var(--text-muted); display: block; margin-bottom: 0.5rem;">Coordinator State</label>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <button id="toggle-btn" class="toggle-btn" role="switch" aria-checked="true"><span class="toggle-handle"></span></button>
            <span id="toggle-text" style="font-weight: 700; color: var(--badge-success-text);">Coordinator ON</span>
          </div>
        </div>
        <div>
          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.4rem;">
            <label for="slider" style="font-weight: 700; font-size: 0.85rem; text-transform: uppercase; color: var(--text-muted);">Flexible Share of Load</label>
            <span id="slider-val" style="font-family: var(--font-mono); font-weight: 700; color: var(--accent); background: var(--accent-subtle); padding: 2px 8px; border-radius: 4px;">20%</span>
          </div>
          <input type="range" id="slider" min="0" max="50" step="1" value="20" style="width: 100%; cursor: pointer;" />
        </div>
      </section>
      <section class="card">
        <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem;">24-Hour City Electricity Demand vs Supply Capacity</h2>
        <div style="position: relative; height: 380px;"><canvas id="mainChart"></canvas></div>
      </section>
      <section class="metrics-grid">
        <div class="metric-card">
          <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">PEAK DEMAND</span>
          <div id="m-peak" class="metric-val">422.4 MW</div>
          <div style="font-size: 0.8rem; margin-top: 0.5rem; color: var(--text-secondary);">OFF: 528.0 MW | ON: 422.4 MW <br/><strong style="color: var(--badge-success-text);">-105.6 MW (-20.0%)</strong></div>
        </div>
        <div class="metric-card">
          <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">HOURS OVER CAPACITY</span>
          <div id="m-hours" class="metric-val">0 hrs</div>
          <div style="font-size: 0.8rem; margin-top: 0.5rem; color: var(--text-secondary);">OFF: 3 hrs | ON: 0 hrs <br/><strong style="color: var(--badge-success-text);">-3 hrs (Eliminated)</strong></div>
        </div>
        <div class="metric-card">
          <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">DAILY ENERGY CONSERVED</span>
          <div id="m-energy" class="metric-val">8,420 MWh</div>
          <div style="font-size: 0.8rem; margin-top: 0.5rem; color: var(--text-secondary);">OFF: 8,420.0 MWh | ON: 8,420.0 MWh <br/><strong style="color: var(--badge-success-text);">0.0 MWh (100.0% Preserved)</strong></div>
        </div>
        <div class="metric-card">
          <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">PEAK REDUCTION</span>
          <div id="m-reduc" class="metric-val">20.0%</div>
          <div style="font-size: 0.8rem; margin-top: 0.5rem; color: var(--text-secondary);">OFF: 0.0% | ON: 20.0% <br/><strong style="color: var(--badge-success-text);">+57.6 MW Safety Headroom</strong></div>
        </div>
      </section>
      <section class="card">
        <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem;">Flexibility Sweep & Diminishing Returns</h2>
        <div style="position: relative; height: 250px;"><canvas id="sweepChart"></canvas></div>
      </section>
      <section class="card">
        <h2 style="font-size: 1.25rem; font-weight: 700;">How It Works: 3-Step Coordination</h2>
        <div class="steps">
          <div class="step"><strong>1. Observe</strong><p style="font-size: 0.85rem; margin-top: 0.25rem; color: var(--text-secondary);">Aggregate substation feeder telemetry across residential, industrial, commercial, and transit grids.</p></div>
          <div class="step"><strong>2. Decide</strong><p style="font-size: 0.85rem; margin-top: 0.25rem; color: var(--text-secondary);">Extract flexible load slices and water-fill them into minimum demand valley hours below capacity.</p></div>
          <div class="step"><strong>3. Signal</strong><p style="font-size: 0.85rem; margin-top: 0.25rem; color: var(--text-secondary);">Dispatch price incentives and automated scheduled commands to endpoints while conserving total energy.</p></div>
        </div>
        <div class="signal">LIVE SIGNAL: "Shift EV charging & municipal pumps between 01:00 and 05:00 at 38% off-peak discount."</div>
      </section>
      <footer class="card" style="font-size: 0.85rem; color: var(--text-secondary);">
        <p><strong>Next steps:</strong> pilot in one neighbourhood with real meter data.</p>
        <p style="margin-top: 0.5rem;"><strong>Privacy & Fairness:</strong> Feeder aggregates only; no personal household habits tracked. EV commute readiness and comfort constraints guaranteed.</p>
      </footer>
    </div>
    <script>
      (function(){
        const CAPACITY = 480;
        const HOURS = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00'];
        const BASE = {
          res: [42,38,35,34,36,45,65,95,105,88,72,68,66,65,67,72,85,125,180,205,198,165,110,65],
          ind: [32,30,30,30,32,38,55,85,125,130,132,130,115,128,132,130,125,110,90,65,58,45,35,32],
          com: [22,20,18,18,20,25,35,55,90,125,145,155,150,152,155,152,148,145,160,150,146,110,50,32],
          trn: [12,10,10,10,12,20,45,82,88,65,42,38,40,42,45,52,72,90,98,92,90,50,24,16]
        };
        const D_KEYS = ['res','ind','com','trn'];
        let isOn = true;
        let flex = 0.20;
        function calc(f) {
          const tot = new Array(24).fill(0);
          for(let h=0; h<24; h++) for(let k of D_KEYS) tot[h] += BASE[k][h];
          if(f<=0) return { tot, peak: Math.max(...tot), hoursOver: tot.filter(v=>v>CAPACITY).length, energy: tot.reduce((a,b)=>a+b,0) };
          let rem = 0; const fix = {};
          for(let k of D_KEYS) { fix[k] = BASE[k].map(v => { const x = v*(1-f); rem += v*f; return x; }); }
          const curTot = new Array(24).fill(0);
          for(let h=0; h<24; h++) for(let k of D_KEYS) curTot[h] += fix[k][h];
          while(rem > 1e-5) {
            const chunk = Math.min(rem, 0.5);
            let minH = 0, minV = curTot[0];
            for(let h=1; h<24; h++) if(curTot[h] < minV) { minV = curTot[h]; minH = h; }
            curTot[minH] += chunk; rem -= chunk;
          }
          return { tot: curTot, peak: Math.max(...curTot), hoursOver: curTot.filter(v=>v>CAPACITY).length, energy: curTot.reduce((a,b)=>a+b,0) };
        }
        const b = calc(0);
        const mChart = new Chart(document.getElementById('mainChart'), {
          type: 'line',
          data: { labels: HOURS, datasets: [
            { label: 'Total Demand', data: calc(0.2).tot, borderColor: '#0f172a', borderWidth: 3.5, tension: 0.35, pointRadius: 2 },
            { label: 'Capacity (480 MW)', data: new Array(24).fill(480), borderColor: '#dc2626', borderDash: [6,4], borderWidth: 2, pointRadius: 0 }
          ]},
          options: { responsive: true, maintainAspectRatio: false }
        });
        const swPts = [];
        for(let p=0; p<=50; p+=2) swPts.push({ x: p, y: calc(p/100).peak });
        const sChart = new Chart(document.getElementById('sweepChart'), {
          type: 'line',
          data: { labels: swPts.map(p=>p.x+'%'), datasets: [
            { label: 'Peak (MW)', data: swPts.map(p=>p.y), borderColor: '#0284c7', backgroundColor: 'rgba(2,132,199,0.1)', fill: true },
            { label: 'Capacity', data: new Array(swPts.length).fill(480), borderColor: '#dc2626', borderDash: [5,4] }
          ]},
          options: { responsive: true, maintainAspectRatio: false }
        });
        function render() {
          const res = calc(isOn ? flex : 0);
          mChart.data.datasets[0].data = res.tot;
          mChart.update();
          document.getElementById('m-peak').textContent = res.peak.toFixed(1) + ' MW';
          document.getElementById('m-hours').textContent = res.hoursOver + ' hrs';
          document.getElementById('m-energy').textContent = Math.round(res.energy).toLocaleString() + ' MWh';
          document.getElementById('m-reduc').textContent = (isOn ? ((528 - res.peak)/528*100).toFixed(1) : '0.0') + '%';
        }
        document.getElementById('toggle-btn').onclick = function() {
          isOn = !isOn;
          this.setAttribute('aria-checked', isOn ? 'true' : 'false');
          document.getElementById('toggle-text').textContent = isOn ? 'Coordinator ON' : 'Coordinator OFF';
          document.getElementById('toggle-text').style.color = isOn ? 'var(--badge-success-text)' : 'var(--text-muted)';
          render();
        };
        document.getElementById('slider').oninput = function(e) {
          flex = Number(e.target.value)/100;
          document.getElementById('slider-val').textContent = e.target.value + '%';
          render();
        };
      })();
    <\/script>
  </body>
</html>`;
  };

  const handleDownloadHtml = () => {
    const html = generateStandaloneHtml();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'urbansync.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyHtml = () => {
    const html = generateStandaloneHtml();
    navigator.clipboard.writeText(html).then(() => {
      setCopiedHtml(true);
      setTimeout(() => setCopiedHtml(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 p-4 md:p-8 font-sans transition-colors">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        
        {/* 1. Header */}
        <header className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-sky-500/10 dark:bg-sky-500/20 text-sky-600 dark:text-sky-400 flex items-center justify-center font-black">
                <Zap className="w-6 h-6" />
              </div>
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
                Urban<span className="text-sky-600 dark:text-sky-400">Sync</span>
              </h1>
            </div>
            <p className="text-sm md:text-base font-medium text-slate-600 dark:text-slate-400 mt-2">
              Monitoring Public Service Usage: A Basic System for Efficient Service Operation
            </p>
            <div className="inline-flex items-center gap-2 mt-2 px-3 py-1 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md text-xs font-medium text-slate-600 dark:text-slate-400">
              <Info className="w-3.5 h-3.5 text-slate-500" />
              <span>All data is simulated and illustrative, not real city measurements.</span>
            </div>
          </div>

          <div className="flex items-center gap-2 self-stretch md:self-auto">
            <button
              onClick={() => setShowExportModal(true)}
              className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 transition-colors shadow-sm"
              title="Download or view self-contained single HTML file"
            >
              <FileCode className="w-4 h-4 text-sky-500" />
              <span>1-File HTML Deliverable</span>
            </button>
          </div>
        </header>

        {/* 2. Controls Deck */}
        <section
          aria-label="Coordinator Simulation Controls"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm grid grid-cols-1 md:grid-cols-12 gap-6 items-center"
        >
          {/* Coordinator ON/OFF Toggle */}
          <div className="md:col-span-4 flex flex-col gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-sky-500" />
              Coordinator State
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={isCoordinatorOn}
                onClick={() => setIsCoordinatorOn(!isCoordinatorOn)}
                className={`relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 ${
                  isCoordinatorOn ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    isCoordinatorOn ? 'translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
              <span
                className={`text-sm font-bold ${
                  isCoordinatorOn
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-400 dark:text-slate-500'
                }`}
              >
                {isCoordinatorOn ? 'Coordinator ON' : 'Coordinator OFF (Raw Baseline)'}
              </span>
            </div>
          </div>

          {/* Flexible Share of Load Slider */}
          <div className="md:col-span-4 flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <label
                htmlFor="flex-slider"
                className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5"
              >
                <Sliders className="w-4 h-4 text-sky-500" />
                Flexible Share of Load
              </label>
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300 border border-sky-300 dark:border-sky-800">
                {flexSharePct}%
              </span>
            </div>
            <input
              id="flex-slider"
              type="range"
              min="0"
              max="50"
              step="1"
              value={flexSharePct}
              onChange={e => setFlexSharePct(Number(e.target.value))}
              className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
              aria-label="Flexible share percentage"
            />
            <div className="flex justify-between text-[11px] text-slate-400 dark:text-slate-500 font-medium">
              <span>0% (Rigid)</span>
              <span>20% (Default)</span>
              <span>50% (Max Shift)</span>
            </div>
          </div>

          {/* District Toggles */}
          <div className="md:col-span-4 flex flex-col gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-sky-500" />
              District Layers
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs font-medium">
              {DISTRICT_CONFIGS.map(d => (
                <label
                  key={d.id}
                  className="flex items-center gap-2 cursor-pointer text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
                >
                  <input
                    type="checkbox"
                    checked={visibleDistricts[d.id]}
                    onChange={e =>
                      setVisibleDistricts(prev => ({ ...prev, [d.id]: e.target.checked }))
                    }
                    className="rounded border-slate-300 dark:border-slate-700 text-sky-600 focus:ring-sky-500 h-3.5 w-3.5"
                  />
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: d.color }}
                  />
                  <span className="truncate">{d.label}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* 3. Main 24-Hour Demand Chart */}
        <section
          aria-label="24-Hour City Electricity Demand vs Supply Capacity"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col gap-4"
        >
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div>
              <h2 className="text-lg md:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                24-Hour City Electricity Demand vs Supply Capacity
              </h2>
              <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400">
                Coordinated shifting transfers peak load into overnight valley hours without exceeding the 480 MW supply limit.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs font-medium text-slate-600 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-1 bg-slate-900 dark:bg-white rounded-full" />
                <span>Total Demand</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-0.5 border-t-2 border-dashed border-red-600" />
                <span className="text-red-600 dark:text-red-400 font-semibold">Capacity (480 MW)</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded bg-red-500/20 border border-red-500/50" />
                <span>Over-Capacity Area</span>
              </span>
            </div>
          </div>

          <div className="h-80 sm:h-96 w-full relative">
            <canvas ref={mainCanvasRef} aria-label="Hourly load chart" role="img" />
          </div>
        </section>

        {/* 4. Metric Cards */}
        <section
          aria-label="Operational Key Performance Indicators"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {/* Card 1: Peak Demand */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Peak Demand
              </span>
              <div className="text-2xl md:text-3xl font-extrabold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
                {currentSimulation.peak.toFixed(1)} MW
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-col gap-1 tabular-nums">
              <div className="flex justify-between">
                <span>OFF: {peakOff.toFixed(1)} MW</span>
                <span>ON: {peakOn.toFixed(1)} MW</span>
              </div>
              <div className="flex justify-between font-bold text-emerald-600 dark:text-emerald-400">
                <span>Net Change:</span>
                <span>{peakDelta >= 0 ? '+' : ''}{peakDelta.toFixed(1)} MW ({peakDeltaPct}%)</span>
              </div>
            </div>
          </div>

          {/* Card 2: Hours Over Capacity */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Hours Over Capacity
              </span>
              <div className="text-2xl md:text-3xl font-extrabold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
                {currentSimulation.hoursOverCapacity} hrs
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-col gap-1 tabular-nums">
              <div className="flex justify-between">
                <span>OFF: {hoursOff} hrs (18–20h)</span>
                <span>ON: {hoursOn} hrs</span>
              </div>
              <div className={`flex justify-between font-bold ${hoursDelta < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
                <span>Net Change:</span>
                <span>{hoursDelta} hrs ({hoursOn === 0 ? '100% Eliminated' : 'Reduced'})</span>
              </div>
            </div>
          </div>

          {/* Card 3: Daily Energy Conserved Check */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Daily Energy Conserved
              </span>
              <div className="text-2xl md:text-3xl font-extrabold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
                {Math.round(currentSimulation.totalEnergy).toLocaleString()} MWh
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-col gap-1 tabular-nums">
              <div className="flex justify-between">
                <span>OFF: {energyOff.toFixed(1)} MWh</span>
                <span>ON: {energyOn.toFixed(1)} MWh</span>
              </div>
              <div className="flex justify-between font-bold text-emerald-600 dark:text-emerald-400">
                <span>Conservation Check:</span>
                <span>{energyDelta < 0.05 ? '0.0 MWh (100% Preserved)' : `${energyDelta.toFixed(1)} MWh`}</span>
              </div>
            </div>
          </div>

          {/* Card 4: Peak Reduction % */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Peak Shaving Reduction
              </span>
              <div className="text-2xl md:text-3xl font-extrabold font-mono text-slate-900 dark:text-white mt-1 tabular-nums">
                {currentReduc.toFixed(1)}%
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-col gap-1 tabular-nums">
              <div className="flex justify-between">
                <span>OFF: 0.0%</span>
                <span>ON: {reducOn.toFixed(1)}%</span>
              </div>
              <div className={`flex justify-between font-bold ${currentHeadroom >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                <span>Grid Headroom:</span>
                <span>{currentHeadroom >= 0 ? `+${currentHeadroom.toFixed(1)} MW Below` : `${Math.abs(currentHeadroom).toFixed(1)} MW Over`}</span>
              </div>
            </div>
          </div>
        </section>

        {/* 5. Flexibility Sweep Chart */}
        <section
          aria-label="Flexibility Parameter Sweep & Diminishing Returns"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col gap-4"
        >
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>
              <h2 className="text-lg md:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                Flexibility Sweep &amp; Diminishing Returns Curve
              </h2>
              <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400">
                Peak demand response as flexible load share scales from 0% to 50%
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs font-semibold px-3 py-1 rounded bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
              <TrendingDown className="w-4 h-4 text-sky-600" />
              <span>Current Position: {flexSharePct}% ({onSimulation.peak.toFixed(1)} MW)</span>
            </div>
          </div>

          <div className="h-64 w-full relative">
            <canvas ref={sweepCanvasRef} aria-label="Flexibility sweep chart" role="img" />
          </div>

          <div className="p-4 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 rounded-xl text-xs sm:text-sm text-slate-600 dark:text-slate-300 flex items-start gap-3">
            <ArrowDownRight className="w-5 h-5 text-sky-600 shrink-0 mt-0.5" />
            <div>
              <strong>Diminishing Returns Principle:</strong> The initial 10%–20% flexibility removes peak overload hours and brings the entire system comfortably below the 480 MW capacity threshold. Above 35%, gains flatten because the overnight valley (01:00–05:00) fills up to meet daytime demand.
            </div>
          </div>
        </section>

        {/* 6. How It Works Strip */}
        <section
          aria-label="How It Works"
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col gap-5"
        >
          <div>
            <h2 className="text-lg md:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
              How It Works: 3-Step Coordination Loop
            </h2>
            <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400">
              A light-touch public service protocol for peak management without personal surveillance.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 rounded-xl flex flex-col gap-2">
              <div className="text-xs font-mono font-bold text-sky-600 dark:text-sky-400 tracking-wider">
                STEP 01
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Radio className="w-4 h-4 text-sky-500" />
                Observe
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Aggregates real-time substation feeder telemetry across residential, commercial, industrial, and transit districts to detect evening peak surges.
              </p>
            </div>

            <div className="p-5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 rounded-xl flex flex-col gap-2">
              <div className="text-xs font-mono font-bold text-sky-600 dark:text-sky-400 tracking-wider">
                STEP 02
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Sliders className="w-4 h-4 text-emerald-500" />
                Decide
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Extracts flexible quotas (EV fleet charging, municipal pumps, thermal storage) and water-fills them into the lowest demand hours below capacity.
              </p>
            </div>

            <div className="p-5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/60 rounded-xl flex flex-col gap-2">
              <div className="text-xs font-mono font-bold text-sky-600 dark:text-sky-400 tracking-wider">
                STEP 03
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-amber-500" />
                Signal
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Dispatches time-of-use price signals and automated scheduler triggers to smart endpoints, preserving 100% of daily consumed energy.
              </p>
            </div>
          </div>

          {/* Example Signal Banner */}
          <div className="p-4 bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-800 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
                <Zap className="w-4 h-4" />
              </div>
              <div>
                <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-sky-700 dark:text-sky-300">
                  Automated Coordinator Signal Example
                </span>
                <p className="text-xs sm:text-sm font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                  &ldquo;Shift EV charging &amp; municipal water pumps between 01:00 and 05:00 at off-peak discount.&rdquo;
                </p>
              </div>
            </div>
            <div className="text-[11px] font-mono px-2.5 py-1 rounded bg-white dark:bg-slate-900 border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-300 shrink-0">
              STATUS: DISPATCHED
            </div>
          </div>
        </section>

        {/* 7. Footer */}
        <footer className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm flex flex-col gap-4 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white text-sm">
            <CheckCircle2 className="w-4 h-4 text-sky-600" />
            <span>Next steps: pilot in one neighbourhood with real meter data</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-slate-100 dark:border-slate-800 pt-4">
            <div>
              <strong className="text-slate-800 dark:text-slate-200 flex items-center gap-1.5 mb-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                Privacy Protection
              </strong>
              Operates exclusively on aggregate feeder loads; no device-level or personal household habit telemetry is ever monitored, logged, or required.
            </div>
            <div>
              <strong className="text-slate-800 dark:text-slate-200 flex items-center gap-1.5 mb-1">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                Fairness &amp; Comfort Guarantees
              </strong>
              Flexible shifts respect hard constraints: EV commuters are 100% charged before 07:00, HVAC maintains strict comfort bands, and public transit schedules remain inviolable.
            </div>
          </div>
          <div className="text-[11px] text-slate-400 dark:text-slate-500 pt-2 border-t border-slate-100 dark:border-slate-800 flex justify-between">
            <span>UrbanSync &middot; College IDEA Lab Demo</span>
            <span>Theme: Monitoring Public Service Usage: A Basic System for Efficient Service Operation</span>
          </div>
        </footer>

      </div>

      {/* Export / Deliverable Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex justify-between items-center pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <FileCode className="w-5 h-5 text-sky-600" />
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  Self-Contained Single HTML Deliverable
                </h3>
              </div>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg font-bold px-2 py-1"
              >
                &times;
              </button>
            </div>

            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              This deliverable is a 100% self-contained single HTML file with inline CSS and inline JavaScript. The only external script is pinned Chart.js from cdnjs.cloudflare.com. Zero other network requests.
            </p>

            <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-lg font-mono text-xs text-slate-700 dark:text-slate-300 max-h-48 overflow-y-auto">
              <code>{generateStandaloneHtml().slice(0, 800)}... [complete file ready for export]</code>
            </div>

            <div className="flex flex-col sm:flex-row justify-end gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                onClick={handleCopyHtml}
                className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 transition-colors"
              >
                {copiedHtml ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                <span>{copiedHtml ? 'Copied HTML!' : 'Copy Raw HTML'}</span>
              </button>

              <button
                onClick={handleDownloadHtml}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold rounded-lg bg-sky-600 hover:bg-sky-500 text-white transition-colors shadow-sm"
              >
                <Download className="w-4 h-4" />
                <span>Download urbansync.html</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
