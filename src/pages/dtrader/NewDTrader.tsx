import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getSocketURL, getAppId } from '@/components/shared';
import { sendViaNewSystemWithPromise, onNewSystemMessage, sendViaNewSystem } from '@/auth/NewDerivAuth';
import { AVAILABLE_INDICATORS, calcSMA, calcEMA, calcRSI, calcMACD, calcBB, calcStoch, calcATR, calcCCI, type IndicatorConfig } from './indicators';

const pip_sizes: Record<string, number> = {
  R_100: 2, R_75: 4, R_50: 4, R_25: 3, R_10: 3,
  '1HZ100V': 2, '1HZ75V': 2, '1HZ50V': 2, '1HZ25V': 2, '1HZ10V': 2,
};
const SYMBOLS = Object.keys(pip_sizes);
const DTRADER_CONFIG_KEY = 'mw_dtrader_config';

function loadDtraderConfig() {
  try {
    const raw = localStorage.getItem(DTRADER_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDtraderConfig(cfg: Record<string, any>) {
  try { localStorage.setItem(DTRADER_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}

const MAX_TICKS = 1000;

const VOLATILITY_NAMES: Record<string, string> = {
  R_100: 'Volatility 100 Index', R_75: 'Volatility 75 Index', R_50: 'Volatility 50 Index',
  R_25: 'Volatility 25 Index', R_10: 'Volatility 10 Index',
  '1HZ100V': 'Volatility 100 (1s) Index', '1HZ75V': 'Volatility 75 (1s) Index',
  '1HZ50V': 'Volatility 50 (1s) Index', '1HZ25V': 'Volatility 25 (1s) Index',
  '1HZ10V': 'Volatility 10 (1s) Index',
};
const DIGIT_WINDOW = 200; // match OU killer digit window

const TRADE_TYPES = [
  { value: 'rise_fall', label: 'Rise/Fall' },
  { value: 'over_under', label: 'Over/Under' },
    { value: 'digits', label: 'Matches/Differs' },
  { value: 'even_odd', label: 'Even/Odd' },
  { value: 'accumulator', label: 'Accumulator' },
];

function getPipSize(symbol: string): number { return pip_sizes[symbol] || 2; }
function extractDigit(quote: number, pip_size: number): number {
  const q = Number(quote);
  if (isNaN(q)) return 0;
  return parseInt(q.toFixed(pip_size).slice(-1), 10);
}

interface ContractInfo {
  id: string; contract_type: string; stake: number; symbol: string;
  entry_tick: number; entry_digit: number; entry_epoch?: number;
  entry_index?: number; exit_tick?: number; exit_epoch?: number;
  exit_digit?: number; profit?: number; is_sold: boolean; is_win?: boolean;
  duration?: number; duration_unit?: 't' | 'm';
}

const contractLabels: Record<string, string> = {
  CALL: 'Rise', PUT: 'Fall', DIGITOVER: 'Over', DIGITUNDER: 'Under',
  DIGITMATCH: 'Match', DIGITDIFF: 'Diff', DIGITEVEN: 'Even', DIGITODD: 'Odd',
  ACCU: 'Accu',
};

interface Candle { open: number; high: number; low: number; close: number; epoch: number }

type DrawToolType = 'trendline' | 'hline' | 'vline' | 'ray' | 'rectangle' | 'circle' | 'fibonacci' | 'pitchfork' | 'triangle' | 'arrow' | 'parallel' | 'text';

interface DrawPoint { x: number; y: number }

interface Drawing {
  id: string;
  type: DrawToolType;
  points: DrawPoint[];
  color: string;
  thickness: number;
  style: 'solid' | 'dashed' | 'dotted';
  text?: string;
  filled?: boolean;
}

const DRAW_TOOLS: { type: DrawToolType; label: string; icon: string; points: number }[] = [
  { type: 'trendline', label: 'Trend Line', icon: '📐', points: 2 },
  { type: 'hline', label: 'Horizontal Line', icon: '━', points: 1 },
  { type: 'vline', label: 'Vertical Line', icon: '┃', points: 1 },
  { type: 'ray', label: 'Ray', icon: '➡', points: 2 },
  { type: 'rectangle', label: 'Rectangle', icon: '▭', points: 2 },
  { type: 'circle', label: 'Circle', icon: '○', points: 2 },
  { type: 'fibonacci', label: 'Fibonacci', icon: 'φ', points: 2 },
  { type: 'pitchfork', label: 'Pitchfork', icon: 'Ψ', points: 3 },
  { type: 'triangle', label: 'Triangle', icon: '△', points: 3 },
  { type: 'arrow', label: 'Arrow', icon: '→', points: 2 },
  { type: 'parallel', label: 'Parallel Channel', icon: '⫽', points: 2 },
  { type: 'text', label: 'Text', icon: 'T', points: 1 },
];

const DRAW_COLORS = ['#ff4444', '#4caf50', '#2196f3', '#ff9800', '#9c27b0', '#ffeb3b', '#ffffff', '#00ffff'];
const DRAW_THICKNESS = [1, 2, 3, 4];

const GRANULARITIES = [
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
  { label: '15m', value: 900 },
  { label: '30m', value: 1800 },
  { label: '1h', value: 3600 },
];

const NewDTrader: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const tickPrices = useRef<number[]>([]);
  const tickEpochs = useRef<number[]>([]);
  const candleData = useRef<Candle[]>([]);
  const animRef = useRef<number>(0);
  const priceRef = useRef<number | null>(null);
  const digitRef = useRef<number | null>(null);
  const activeContractsRef = useRef<ContractInfo[]>([]);
  const stakeRef = useRef(5);
  const symbolRef = useRef('R_100');
  const barrierRef = useRef('5');
  const durationRef = useRef(1);
  const durationUnitRef = useRef<'t' | 'm'>('t');
  const tradeTypeRef = useRef('rise_fall');
  const pipSizeRef = useRef(2);
  const growthRateRef = useRef(0.01);
  const chartStyleRef = useRef<'line' | 'candle'>('line');
  const timeframeRef = useRef(60);

  const savedCfg = loadDtraderConfig();

  const [symbol, setSymbol] = useState(savedCfg.symbol || 'R_100');
  const [tradeType, setTradeType] = useState(savedCfg.tradeType || 'rise_fall');
  const [stake, setStake] = useState(savedCfg.stake || '0.35');
  const [barrier, setBarrier] = useState(savedCfg.barrier || '5');
  const [duration, setDuration] = useState(savedCfg.duration ?? 1);
  const [durationUnit, setDurationUnit] = useState<'t' | 'm'>(savedCfg.durationUnit || 't');
  const [allowEquals, setAllowEquals] = useState(savedCfg.allowEquals ?? false);
  const [contractType, setContractType] = useState(savedCfg.contractType || 'CALL');
  const [growthRate, setGrowthRate] = useState(savedCfg.growthRate ?? 0.01);
  const [takeProfit, setTakeProfit] = useState(savedCfg.takeProfit || '');
  const [chartStyle, setChartStyle] = useState<'line' | 'candle'>(savedCfg.chartStyle || 'candle');
  const [timeframe, setTimeframe] = useState(savedCfg.timeframe ?? 60);
  const [payout, setPayout] = useState<string | null>(null);
  const [tradeResult, setTradeResult] = useState<{ isWin: boolean; profit: number; contract_type: string; entry_digit: number; exit_digit: number } | null>(null);
  const contractTypeRef = useRef('CALL');
  const [showIndicators, setShowIndicators] = useState(false);
  const [tickCounter, setTickCounter] = useState(0);
  const [activeIndicators, setActiveIndicators] = useState<IndicatorConfig[]>([]);
  const [activeContracts, setActiveContracts] = useState<ContractInfo[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<string>('Disconnected');
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentDigit, setCurrentDigit] = useState<number | null>(null);
  const [exitHighlight, setExitHighlight] = useState<{ digit: number; win: boolean } | null>(null);
  const [sessionStats, setSessionStats] = useState<{ wins: number; losses: number; profit: number }>({ wins: 0, losses: 0, profit: 0 });
  const [isTrading, setIsTrading] = useState(false);
  const [tickHistory, setTickHistory] = useState<number[]>([]);
  const [digitCounts, setDigitCounts] = useState<number[]>(Array(10).fill(0));
  const [contractHistory, setContractHistory] = useState<ContractInfo[]>([]);
  const [balance, setBalance] = useState<number | null>(null);

  // Drawing toolbox state
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [activeDrawTool, setActiveDrawTool] = useState<DrawToolType | null>(null);
  const [drawPoints, setDrawPoints] = useState<DrawPoint[]>([]);
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [showToolbox, setShowToolbox] = useState(false);
  const [showDrawConfig, setShowDrawConfig] = useState(false);
  const [drawColor, setDrawColor] = useState('#ff4444');
  const [drawThickness, setDrawThickness] = useState(2);
  const [drawStyle, setDrawStyle] = useState<'solid' | 'dashed' | 'dotted'>('solid');
  const drawingsRef = useRef<Drawing[]>([]);
  const activeDrawToolRef = useRef<DrawToolType | null>(null);
  const drawPointsRef = useRef<DrawPoint[]>([]);

  /* ── Persist config ──────────────────────────────────────────── */
  useEffect(() => {
    saveDtraderConfig({
      symbol, tradeType, stake, barrier, duration, durationUnit, allowEquals,
      contractType, growthRate, takeProfit, chartStyle, timeframe,
    });
  }, [symbol, tradeType, stake, barrier, duration, durationUnit, allowEquals, contractType, growthRate, takeProfit, chartStyle, timeframe]);

  const indicatorRef = useRef<IndicatorConfig[]>([]);
  const indicatorValues = useRef<Map<string, (number | null)[]>>(new Map());
  const contractHistoryRef = useRef<ContractInfo[]>([]);
  const panPx = useRef(0);
  const isPanning = useRef(false);
  const panStartX = useRef(0);
  const panStartPx = useRef(0);
  const zoomRef = useRef(1);
  const chartHeightPct = useRef(1);
  const isResizing = useRef(false);
  const resizeStartY = useRef(0);
  const resizeStartPct = useRef(1);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const settledContractIds = useRef<Set<string>>(new Set());

  const activeAccuContract = activeContracts.find(c => c.contract_type === 'ACCU');
  const isPhone = typeof window !== 'undefined' && window.innerWidth < 768;
  const contractTypes = TRADE_TYPES.find(t => t.value === tradeType)?.label || 'Rise/Fall';

  stakeRef.current = stake; symbolRef.current = symbol; barrierRef.current = barrier;
  durationRef.current = duration; durationUnitRef.current = durationUnit;
  tradeTypeRef.current = tradeType; pipSizeRef.current = getPipSize(symbol);
  growthRateRef.current = growthRate; contractTypeRef.current = contractType;
  chartStyleRef.current = chartStyle; timeframeRef.current = timeframe;
  indicatorRef.current = activeIndicators;
  drawingsRef.current = drawings;
  activeDrawToolRef.current = activeDrawTool;
  drawPointsRef.current = drawPoints;

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const hasBelow = indicatorRef.current.some(i => i.pane === 'below');
    const paneH = hasBelow ? Math.max(60, H * 0.25) : 0;
    const pad = { top: 10, right: 60, bottom: 20, left: 50 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom - paneH;
    ctx.clearRect(0, 0, W, H);

    // Clip to chart area to prevent overflow
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (chartStyleRef.current === 'candle') {
      const candles = candleData.current;
      if (candles.length < 1) {
        ctx.fillStyle = '#555';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for candles...', W / 2, H / 2);
        return;
      }
      const candleCount = Math.max(3, Math.floor(200 / zoomRef.current));
      const vis = candles.slice(-candleCount);
      let cMin = Infinity, cMax = -Infinity;
      vis.forEach(c => { cMin = Math.min(cMin, c.low); cMax = Math.max(cMax, c.high); });
      const cRange = cMax - cMin || 1;
      const cPadding = cRange * 0.05;
      const cYMin = cMin - cPadding;
      const cYMax = cMax + cPadding;
      const cYRange = cYMax - cYMin;
      const cToY = (v: number) => pad.top + chartH - ((v - cYMin) / cYRange) * chartH;

      // Grid
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 5; i++) {
        const y = pad.top + (i / 5) * chartH;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
        const val = cYMax - (i / 5) * cYRange;
        ctx.fillStyle = '#666';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(val.toFixed(2), W - pad.right + 55, y + 3);
      }

      const candleW = Math.max(2, (chartW / vis.length) - 1);
      vis.forEach((c, idx) => {
        const x = pad.left + idx * (candleW + 1) + candleW / 2;
        const oY = cToY(c.open);
        const clY = cToY(c.close);
        const hY = cToY(c.high);
        const lY = cToY(c.low);
        const isUp = c.close >= c.open;
        ctx.strokeStyle = isUp ? '#4caf50' : '#f44336';
        ctx.fillStyle = isUp ? '#4caf50' : '#f44336';
        ctx.lineWidth = 1;
        // Wick
        ctx.beginPath(); ctx.moveTo(x, hY); ctx.lineTo(x, lY); ctx.stroke();
        // Body
        const bT = Math.min(oY, clY);
        const bB = Math.max(oY, clY);
        ctx.fillRect(x - candleW / 2, bT, candleW, Math.max(1, bB - bT));
      });
      // Price label
      const lastC = vis[vis.length - 1];
      const lastY = cToY(lastC.close);
      ctx.fillStyle = '#333';
      ctx.strokeStyle = '#85acb0';
      ctx.lineWidth = 1;
      const label = lastC.close.toFixed(2);
      const tw = ctx.measureText(label).width + 16;
      const lx = W - pad.right - tw;
      const ly = lastY > pad.top + chartH / 2 ? lastY - 20 : lastY + 10;
      ctx.fillStyle = '#85acb0';
      ctx.beginPath();
      ctx.roundRect(lx, ly, tw, 18, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, lx + tw / 2, ly + 13);

      // Candle overlay indicators
      const cCandleToX = (i: number) => pad.left + i * ((chartW / vis.length)) + (Math.max(2, (chartW / vis.length) - 1)) / 2;
      const cCandleToY = cToY;
      drawOverlayIndicators(ctx, W, pad, chartW, chartH, chartH, cCandleToX, cCandleToY);

      if (hasBelow) drawBelowIndicators(ctx, W, H, paneH, pad, chartW, chartH);
      drawContractOverlays(ctx, W, H, pad, chartW, chartH, cToY);
      drawExitOverlay(ctx, W, pad, chartW, cToY);
      drawUserDrawings(ctx, W, pad, chartW, chartH);
      ctx.restore();
      return;
    }

    const prices = tickPrices.current;
    if (prices.length < 2) {
      ctx.fillStyle = '#555';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for ticks...', W / 2, H / 2);
      return;
    }

    const pOff = panPx.current;
    const visibleCount = Math.max(5, Math.floor(300 / zoomRef.current));
    const sliceStart = Math.max(0, prices.length - visibleCount - Math.round(pOff));
    const visible = prices.slice(sliceStart, sliceStart + visibleCount);
    let minP = Math.min(...visible);
    let maxP = Math.max(...visible);
    const range = maxP - minP || 1;
    const padding = range * 0.08;
    const yMin = minP - padding;
    const yMax = maxP + padding;
    const yRange = yMax - yMin;
    const toX = (i: number) => pad.left + (i / (visible.length - 1)) * chartW;
    const toY = (v: number) => pad.top + chartH - ((v - yMin) / yRange) * chartH;

    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (i / 5) * chartH;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      const val = yMax - (i / 5) * yRange;
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val.toFixed(2), W - pad.right + 55, y + 3);
    }

    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    gradient.addColorStop(0, 'rgba(200,200,200,0.2)');
    gradient.addColorStop(1, 'rgba(200,200,200,0.02)');
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(visible[0]));
    for (let i = 1; i < visible.length; i++) ctx.lineTo(toX(i), toY(visible[i]));
    ctx.lineTo(toX(visible.length - 1), pad.top + chartH);
    ctx.lineTo(toX(0), pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(visible[0]));
    for (let i = 1; i < visible.length; i++) ctx.lineTo(toX(i), toY(visible[i]));
    ctx.strokeStyle = '#85acb0';
    ctx.lineWidth = 2;
    ctx.stroke();

    const lastX = toX(visible.length - 1);
    const lastY = toY(visible[visible.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#85acb0';
    ctx.fill();

    ctx.strokeStyle = 'rgba(133,172,176,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(lastX, pad.top);
    ctx.lineTo(lastX, pad.top + chartH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#333';
    ctx.strokeStyle = '#85acb0';
    ctx.lineWidth = 1;
    const label = visible[visible.length - 1].toFixed(2);
    const tw = ctx.measureText(label).width + 16;
    const lx = lastX - tw / 2;
    const ly = lastY > pad.top + chartH / 2 ? lastY - 20 : lastY + 10;
    ctx.fillStyle = '#85acb0';
    ctx.beginPath();
    ctx.roundRect(lx, ly, tw, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, lx + tw / 2, ly + 13);

    // Overlay indicators
    drawOverlayIndicators(ctx, W, pad, chartW, chartH, chartH, toX, toY);

    // Below-pane indicators
    if (hasBelow) drawBelowIndicators(ctx, W, H, paneH, pad, chartW, chartH);
    drawContractOverlays(ctx, W, H, pad, chartW, chartH, toY);
    drawExitOverlay(ctx, W, pad, chartW, toY);
    drawUserDrawings(ctx, W, pad, chartW, chartH);
    ctx.restore();
    return;
  }, []);

  function drawOverlayIndicators(ctx: CanvasRenderingContext2D, W: number, pad: any, chartW: number, chartH: number, totalH: number, toX: (i: number) => number, toY: (v: number) => number) {
    const inds = indicatorRef.current;
    if (inds.length === 0) return;
    const vals = indicatorValues.current;
    const prices = tickPrices.current;
    const pOff = panPx.current;
    const vc = Math.max(5, Math.floor(300 / zoomRef.current));
    const sliceStart = Math.max(0, prices.length - vc - Math.round(pOff));
    const visible = prices.slice(sliceStart, sliceStart + vc);
    if (visible.length < 2) return;
    const minP = Math.min(...visible), maxP = Math.max(...visible);
    const range = maxP - minP || 1;
    const padding = range * 0.05;
    const yMin = minP - padding, yMax = maxP + padding;
    const yRange = yMax - yMin;
    const lToY = (v: number) => pad.top + chartH - ((v - yMin) / yRange) * chartH;

    const lToX = (absIdx: number) => {
      const relIdx = absIdx - sliceStart;
      if (relIdx < 0 || relIdx >= visible.length) return -1;
      return pad.left + (relIdx / (visible.length - 1)) * chartW;
    };

    for (const ind of inds) {
      if (ind.pane !== 'overlay') continue;
      if (ind.id === 'sma') {
        const v = vals.get('sma'); if (!v) continue;
        ctx.strokeStyle = ind.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); let started = false;
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= v.length) break;
          const val = v[i]; if (val === null) { started = false; continue; }
          const x = lToX(i); if (x < 0) { started = false; continue; }
          const y = lToY(val);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (ind.id === 'ema') {
        const v = vals.get('ema'); if (!v) continue;
        ctx.strokeStyle = ind.color; ctx.lineWidth = 1.5;
        ctx.beginPath(); let started = false;
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= v.length) break;
          const val = v[i]; if (val === null) { started = false; continue; }
          const x = lToX(i); if (x < 0) { started = false; continue; }
          const y = lToY(val);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (ind.id === 'bb') {
        const up = vals.get('bb_up'), mid = vals.get('bb_mid'), low = vals.get('bb_low');
        if (!up || !mid || !low) continue;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = ind.color;
        ctx.beginPath(); let s = false;
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= up.length) break;
          const val = up[i]; if (val === null) { s = false; continue; }
          const x = lToX(i); if (x < 0) { s = false; continue; }
          const y = lToY(val);
          if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.beginPath(); s = false;
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= low.length) break;
          const val = low[i]; if (val === null) { s = false; continue; }
          const x = lToX(i); if (x < 0) { s = false; continue; }
          const y = lToY(val);
          if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = ind.color; ctx.lineWidth = 0.5;
        ctx.beginPath(); s = false;
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= mid.length) break;
          const val = mid[i]; if (val === null) { s = false; continue; }
          const x = lToX(i); if (x < 0) { s = false; continue; }
          const y = lToY(val);
          if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  function drawBelowIndicators(ctx: CanvasRenderingContext2D, W: number, H: number, paneH: number, pad: any, chartW: number, chartH: number) {
    const inds = indicatorRef.current.filter(i => i.pane === 'below');
    if (inds.length === 0) return;
    const prices = tickPrices.current;
    const pOff = panPx.current;
    const vc = Math.max(5, Math.floor(300 / zoomRef.current));
    const sliceStart = Math.max(0, prices.length - vc - Math.round(pOff));
    const visible = prices.slice(sliceStart, sliceStart + vc);
    if (visible.length < 2) return;

    const paneTop = pad.top + chartH + 5;
    const panePad = { top: 6, bottom: 4, left: pad.left, right: pad.right };
    const count = inds.length;
    const totalPaneH = paneH - panePad.top - panePad.bottom;
    const perPaneH = Math.max(30, Math.floor(totalPaneH / count));

    const lToPaneX = (absIdx: number) => {
      const relIdx = absIdx - sliceStart;
      if (relIdx < 0 || relIdx >= visible.length) return -1;
      return pad.left + (relIdx / (visible.length - 1)) * chartW;
    };

    inds.forEach((ind, idx) => {
      const pTop = paneTop + idx * perPaneH;
      const pHeight = perPaneH;

      let values: (number | null)[] | undefined;
      let extraValues: (number | null)[] | undefined;
      let extraValues2: (number | null)[] | undefined;
      let minVal = Infinity, maxVal = -Infinity;

      if (ind.id === 'rsi') {
        values = indicatorValues.current.get('rsi');
        minVal = 0; maxVal = 100;
      } else if (ind.id === 'macd') {
        values = indicatorValues.current.get('macd_hist');
        extraValues = indicatorValues.current.get('macd_line');
        extraValues2 = indicatorValues.current.get('macd_signal');
        const all = [values, extraValues, extraValues2];
        all.forEach(arr => arr?.forEach(v => { if (v !== null) { minVal = Math.min(minVal, v); maxVal = Math.max(maxVal, v); } }));
        if (minVal === Infinity) { minVal = -1; maxVal = 1; }
        const m = Math.max(Math.abs(minVal), Math.abs(maxVal));
        minVal = -m; maxVal = m;
      } else if (ind.id === 'stoch') {
        values = indicatorValues.current.get('stoch_k');
        extraValues = indicatorValues.current.get('stoch_d');
        minVal = 0; maxVal = 100;
      } else if (ind.id === 'atr') {
        values = indicatorValues.current.get('atr');
        values?.forEach(v => { if (v !== null) { minVal = Math.min(minVal, v); maxVal = Math.max(maxVal, v); } });
        if (minVal === Infinity) { minVal = 0; maxVal = 1; }
      } else if (ind.id === 'cci') {
        values = indicatorValues.current.get('cci');
        values?.forEach(v => { if (v !== null) { minVal = Math.min(minVal, v); maxVal = Math.max(maxVal, v); } });
        if (minVal === Infinity) { minVal = -100; maxVal = 100; }
      }

      const tMin = minVal, tMax = maxVal, tRange = tMax - tMin || 1;
      const toPaneY = (v: number) => pTop + pHeight - panePad.bottom - ((v - tMin) / tRange) * (pHeight - panePad.bottom - panePad.top);

      // Background
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(pad.left, pTop, chartW, pHeight);

      // Label
      ctx.fillStyle = '#666';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(ind.label + (values ? '' : ' (waiting for data...)'), pad.left + 2, pTop + 10);

      if (!values) return;

      // Reference lines (RSI 30/70, etc)
      if (ind.id === 'rsi') {
        ctx.strokeStyle = '#333'; ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
        [30, 50, 70].forEach(lv => { const y = toPaneY(lv); ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke(); });
        ctx.setLineDash([]);
      }

      // Draw MACD histogram
      if (ind.id === 'macd') {
        const zeroY = toPaneY(0);
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= values.length) break;
          const v = values[i]; if (v === null) continue;
          const x = lToPaneX(i); if (x < 0) continue;
          ctx.fillStyle = v >= 0 ? '#26a69a' : '#ef5350';
          const barH = Math.abs(v) / tRange * (pHeight - panePad.bottom - panePad.top);
          ctx.fillRect(x - 1, v >= 0 ? zeroY - barH : zeroY, 3, Math.max(1, barH));
        }
        if (extraValues) {
          ctx.strokeStyle = '#00bcd4'; ctx.lineWidth = 1;
          ctx.beginPath(); let s = false;
          for (let i = sliceStart; i < sliceStart + visible.length; i++) {
            if (i >= extraValues.length) break;
            const v = extraValues[i]; if (v === null) { s = false; continue; }
            const x = lToPaneX(i); if (x < 0) { s = false; continue; }
            const y = toPaneY(v);
            if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        if (extraValues2) {
          ctx.strokeStyle = '#ff7043'; ctx.lineWidth = 1;
          ctx.beginPath(); let s = false;
          for (let i = sliceStart; i < sliceStart + visible.length; i++) {
            if (i >= extraValues2.length) break;
            const v = extraValues2[i]; if (v === null) { s = false; continue; }
            const x = lToPaneX(i); if (x < 0) { s = false; continue; }
            const y = toPaneY(v);
            if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        return;
      }

      // Draw line
      ctx.strokeStyle = ind.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); let started = false;
      for (let i = sliceStart; i < sliceStart + visible.length; i++) {
        if (i >= values.length) break;
        const v = values[i]; if (v === null) { started = false; continue; }
        const x = lToPaneX(i); if (x < 0) { started = false; continue; }
        const y = toPaneY(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Second line (for stoch)
      if (ind.id === 'stoch' && extraValues) {
        ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.beginPath(); started = false;
        for (let i = sliceStart; i < sliceStart + visible.length; i++) {
          if (i >= extraValues.length) break;
          const v = extraValues[i]; if (v === null) { started = false; continue; }
          const x = lToPaneX(i); if (x < 0) { started = false; continue; }
          const y = toPaneY(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  }

  function drawSingleAccuBarrier(ctx: CanvasRenderingContext2D, W: number, pad: any, chartW: number, chartH: number, toY: (v: number) => number, entryTick: number, entryIndex: number | undefined, isWin: boolean | undefined) {
    const barrier = entryTick * 2;
    const by = toY(barrier);
    const barrierY = Math.max(pad.top, Math.min(pad.top + chartH, by));
    const isWon = isWin === true;
    const barrierColor = isWon ? '#4caf50' : (isWin === false ? '#f44336' : '#ff9800');
    const isClippedAbove = barrierY !== by && by < pad.top;

    let barrierStartX = pad.left;
    if (entryIndex != null) {
      const pOff = panPx.current;
      const vc = Math.max(10, Math.floor(300 / zoomRef.current));
      const prices = tickPrices.current;
      const lastIdx = prices.length - 1;
      const sliceStart = Math.max(0, Math.min(lastIdx, lastIdx - vc + 1 - pOff));
      const actualVc = Math.max(2, Math.min(vc, prices.length - sliceStart));
      const relPos = (entryIndex - sliceStart) / actualVc;
      if (relPos >= 0 && relPos <= 1) {
        barrierStartX = pad.left + relPos * chartW;
      }
    }

    ctx.strokeStyle = barrierColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(barrierStartX, barrierY);
    ctx.lineTo(W - pad.right, barrierY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = barrierColor;
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Barrier ${barrier.toFixed(2)}`, barrierStartX + 4, barrierY - 4);
    if (isClippedAbove) {
      ctx.fillText(`▲ ${barrier.toFixed(2)}`, barrierStartX + 4, pad.top + 10);
    }
  }

  function drawContractOverlays(ctx: CanvasRenderingContext2D, W: number, H: number, pad: any, chartW: number, chartH: number, toY: (v: number) => number) {
    const contracts = activeContractsRef.current;
    const pOff = panPx.current;
    const vc = Math.max(10, Math.floor(300 / zoomRef.current));
    const prices = tickPrices.current;
    const lastIdx = prices.length - 1;
    const sliceStart = Math.max(0, Math.min(lastIdx, lastIdx - vc + 1 - pOff));
    const actualVc = Math.max(2, Math.min(vc, prices.length - sliceStart));

    // ── Historical accumulator barriers (always visible) ──
    contractHistoryRef.current.forEach(c => {
      if (c.contract_type !== 'ACCU' || !c.entry_tick || c.entry_tick <= 0) return;
      drawSingleAccuBarrier(ctx, W, pad, chartW, chartH, toY, c.entry_tick, c.entry_index, c.is_win);
    });

    if (contracts.length === 0) return;

    contracts.forEach(c => {
      if (c.is_sold) return;
      const entryPrice = c.entry_tick;
      if (entryPrice <= 0 && c.contract_type !== 'ACCU' && tradeTypeRef.current !== 'accumulator') return;

      // Entry horizontal line
      const ey = toY(entryPrice);
      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, ey);
      ctx.lineTo(W - pad.right, ey);
      ctx.stroke();
      ctx.setLineDash([]);

      // Entry label
      ctx.fillStyle = '#4fc3f7';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'right';
      const entryLabel = `ENTRY ${entryPrice.toFixed(2)}`;
      ctx.fillText(entryLabel, W - pad.right - 4, ey - 4);

      // Small circle at entry price on current visible edge
      if (c.entry_index != null) {
        const relPos = (c.entry_index - sliceStart) / actualVc;
        if (relPos >= 0 && relPos <= 1) {
          const ex = pad.left + relPos * chartW;
          ctx.beginPath();
          ctx.arc(ex, ey, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#4fc3f7';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Countdown
      let remaining = '';
      const dur = c.duration || 0;
      if (dur > 0 && c.duration_unit === 't' && c.entry_index != null) {
        const elapsed = tickPrices.current.length - c.entry_index;
        const rem = Math.max(0, dur - elapsed);
        remaining = `${rem}t`;
      } else if (dur > 0 && c.duration_unit === 'm' && c.entry_epoch) {
        const now = tickEpochs.current[tickEpochs.current.length - 1] || 0;
        if (now > 0) {
          const elapsed = Math.floor((now - c.entry_epoch) / 60);
          const rem = Math.max(0, dur - elapsed);
          remaining = `${rem}m`;
        }
      }

      if (remaining) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.font = 'bold 11px sans-serif';
        const tw = ctx.measureText(remaining).width + 12;
        const rx = W - pad.right - tw - 4;
        const ry = pad.top + 4;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(rx, ry, tw, 20, 4);
        ctx.fill();
        ctx.fillStyle = '#ffeb3b';
        ctx.textAlign = 'center';
        ctx.fillText(remaining, rx + tw / 2, ry + 14);
        ctx.textAlign = 'right';
      }

      // Accumulator: barrier + growth curve + profit
      if ((c.contract_type === 'ACCU' || tradeTypeRef.current === 'accumulator') && entryPrice > 0) {
        const rate = growthRateRef.current;
        drawSingleAccuBarrier(ctx, W, pad, chartW, chartH, toY, entryPrice, c.entry_index, undefined);

        // Growth curve (green, from entry to latest tick)
        if (c.entry_index != null) {
          ctx.strokeStyle = '#4caf50';
          ctx.lineWidth = 2;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          let started = false;
          for (let i = Math.max(c.entry_index, sliceStart); i <= Math.min(lastIdx, sliceStart + actualVc - 1); i++) {
            const ticksSinceEntry = i - c.entry_index;
            const growthVal = entryPrice * Math.pow(1 + rate, ticksSinceEntry);
            const gx = pad.left + ((i - sliceStart) / (actualVc - 1)) * chartW;
            const gy = toY(growthVal);
            const clampedGy = Math.max(pad.top, Math.min(pad.top + chartH, gy));
            if (!started) { ctx.moveTo(gx, clampedGy); started = true; } else ctx.lineTo(gx, clampedGy);
          }
          ctx.stroke();
          ctx.setLineDash([]);

          // Current profit label (top-right of chart)
          const latestGrowth = entryPrice * Math.pow(1 + rate, lastIdx - c.entry_index);
          const currentProfit = latestGrowth - entryPrice;
          const profitColor = currentProfit >= 0 ? '#4caf50' : '#f44336';
          const profitSign = currentProfit >= 0 ? '+' : '';
          ctx.fillStyle = profitColor;
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(`${profitSign}$${currentProfit.toFixed(2)}`, W - pad.right - 4, pad.top + 28);
        }
      }
    });
  }

  function drawExitOverlay(ctx: CanvasRenderingContext2D, W: number, pad: any, chartW: number, toY: (v: number) => number) {
    const hist = contractHistoryRef.current;
    const lastResult = hist.length > 0 ? hist[hist.length - 1] : null;
    if (!lastResult || !lastResult.exit_tick) return;

    const exitPrice = lastResult.exit_tick;
    const ey = toY(exitPrice);
    const isWin = lastResult.is_win;

    ctx.strokeStyle = isWin ? '#4caf50' : '#f44336';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, ey);
    ctx.lineTo(W - pad.right, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = isWin ? '#4caf50' : '#f44336';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left';
    const exitLabel = `EXIT ${exitPrice.toFixed(2)}`;
    ctx.fillText(exitLabel, pad.left + 4, ey - 4);
  }

  /* ── Drawing toolbox rendering ──────────────────────────────────── */
  function drawUserDrawings(ctx: CanvasRenderingContext2D, W: number, pad: any, chartW: number, chartH: number) {
    const ds = drawingsRef.current;
    if (ds.length === 0 && drawPointsRef.current.length === 0) return;

    const applyStyle = (d: Drawing, isSelected: boolean) => {
      ctx.strokeStyle = isSelected ? '#ffffff' : d.color;
      ctx.lineWidth = d.thickness;
      ctx.fillStyle = d.color + '30';
      ctx.setLineDash(d.style === 'dashed' ? [8, 4] : d.style === 'dotted' ? [2, 2] : []);
    };

    for (const d of ds) {
      const isSel = selectedDrawing === d.id;
      ctx.save();
      applyStyle(d, isSel);

      switch (d.type) {
        case 'trendline':
        case 'ray':
        case 'arrow': {
          if (d.points.length < 2) break;
          const [p1, p2] = d.points;
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y);
          if (d.type === 'ray') {
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            ctx.lineTo(p1.x + (dx / len) * 3000, p1.y + (dy / len) * 3000);
          } else {
            ctx.lineTo(p2.x, p2.y);
          }
          ctx.stroke();
          if (d.type === 'arrow') {
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const ux = dx / len, uy = dy / len;
            const hl = 14;
            ctx.beginPath();
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(p2.x - ux * hl - uy * hl * 0.5, p2.y - uy * hl + ux * hl * 0.5);
            ctx.moveTo(p2.x, p2.y);
            ctx.lineTo(p2.x - ux * hl + uy * hl * 0.5, p2.y - uy * hl - ux * hl * 0.5);
            ctx.stroke();
          }
          break;
        }
        case 'hline': {
          if (d.points.length < 1) break;
          const y = d.points[0].y;
          ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
          ctx.fillStyle = d.color; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
          const priceAtY = d.text || '';
          if (priceAtY) ctx.fillText(priceAtY, W - pad.right + 4, y + 3);
          break;
        }
        case 'vline': {
          if (d.points.length < 1) break;
          const x = d.points[0].x;
          ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + chartH); ctx.stroke();
          break;
        }
        case 'rectangle': {
          if (d.points.length < 2) break;
          const [pa, pb] = d.points;
          const rx = Math.min(pa.x, pb.x), ry = Math.min(pa.y, pb.y);
          const rw = Math.abs(pb.x - pa.x), rh = Math.abs(pb.y - pa.y);
          if (d.filled) ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeRect(rx, ry, rw, rh);
          break;
        }
        case 'circle': {
          if (d.points.length < 2) break;
          const [pc, pe] = d.points;
          const rx = Math.abs(pe.x - pc.x), ry = Math.abs(pe.y - pc.y);
          ctx.beginPath(); ctx.ellipse(pc.x, pc.y, rx || 1, ry || 1, 0, 0, Math.PI * 2);
          if (d.filled) ctx.fill();
          ctx.stroke();
          break;
        }
        case 'fibonacci': {
          if (d.points.length < 2) break;
          const [pf1, pf2] = d.points;
          const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const range = pf2.y - pf1.y;
          for (const lv of levels) {
            const ly = pf1.y + range * lv;
            ctx.beginPath(); ctx.moveTo(pad.left, ly); ctx.lineTo(W - pad.right, ly); ctx.stroke();
            ctx.fillStyle = d.color; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
            ctx.fillText(`${(lv * 100).toFixed(1)}%`, pad.left + 4, ly - 3);
          }
          break;
        }
        case 'pitchfork': {
          if (d.points.length < 3) break;
          const [pp1, pp2, pp3] = d.points;
          const mx = (pp1.x + pp3.x) / 2, my = (pp1.y + pp3.y) / 2;
          ctx.beginPath(); ctx.moveTo(pp1.x, pp1.y); ctx.lineTo(mx, my); ctx.lineTo(pp3.x, pp3.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(mx, my);
          ctx.lineTo(mx + (mx - pp2.x), my + (my - pp2.y)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(pp2.x, pp2.y);
          ctx.lineTo(pp2.x - (mx - pp1.x), pp2.y - (my - pp1.y)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(pp2.x, pp2.y);
          ctx.lineTo(pp2.x - (mx - pp3.x), pp2.y - (my - pp3.y)); ctx.stroke();
          break;
        }
        case 'triangle': {
          if (d.points.length < 3) break;
          const [pt1, pt2, pt3] = d.points;
          ctx.beginPath(); ctx.moveTo(pt1.x, pt1.y); ctx.lineTo(pt2.x, pt2.y); ctx.lineTo(pt3.x, pt3.y); ctx.closePath(); ctx.stroke();
          break;
        }
        case 'parallel': {
          if (d.points.length < 2) break;
          const [pl1, pl2] = d.points;
          const dy = pl2.y - pl1.y;
          ctx.beginPath(); ctx.moveTo(pl1.x, pl1.y); ctx.lineTo(pl2.x, pl2.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(pl1.x, pl1.y - dy); ctx.lineTo(pl2.x, pl2.y - dy); ctx.stroke();
          ctx.setLineDash([3, 3]); ctx.beginPath();
          ctx.moveTo(pl1.x, pl1.y); ctx.lineTo(pl1.x, pl1.y - dy); ctx.stroke();
          ctx.moveTo(pl2.x, pl2.y); ctx.lineTo(pl2.x, pl2.y - dy); ctx.stroke();
          ctx.setLineDash([]);
          break;
        }
        case 'text': {
          if (d.points.length < 1 || !d.text) break;
          ctx.fillStyle = d.color; ctx.font = `${d.thickness * 5 + 8}px sans-serif`; ctx.textAlign = 'left';
          ctx.fillText(d.text, d.points[0].x, d.points[0].y);
          break;
        }
      }

      if (isSel) {
        for (const pt of d.points) {
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // In-progress points
    if (drawPointsRef.current.length > 0 && activeDrawToolRef.current) {
      ctx.save();
      for (const pt of drawPointsRef.current) {
        ctx.fillStyle = '#ffeb3b'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function checkAutoSettle() {
    const contracts = activeContractsRef.current;
    if (contracts.length === 0) return;
    const prices = tickPrices.current;
    const toSettle: ContractInfo[] = [];

    for (const c of contracts) {
      if (c.is_sold || settledContractIds.current.has(c.id)) continue;
      if (c.duration_unit === 't' && c.entry_index != null) {
        const elapsed = prices.length - c.entry_index;
        if (elapsed >= (c.duration || 1)) {
          toSettle.push(c);
        }
      }
    }

    if (toSettle.length === 0) return;

    for (const c of toSettle) {
      settledContractIds.current.add(c.id);
      const exitPrice = prices[prices.length - 1];
      const exitD = extractDigit(exitPrice, pipSizeRef.current);
      const entryD = c.entry_digit;
      const barrierD = (c as any).barrier != null ? parseInt(String((c as any).barrier)) : -1;

      let isWin = false;
      switch (c.contract_type) {
        case 'DIGITMATCH': isWin = entryD === exitD; break;
        case 'DIGITDIFF':  isWin = entryD !== exitD; break;
        case 'DIGITOVER':  isWin = exitD > barrierD; break;
        case 'DIGITUNDER': isWin = exitD < barrierD; break;
        case 'DIGITEVEN':  isWin = exitD % 2 === 0; break;
        case 'DIGITODD':   isWin = exitD % 2 !== 0; break;
        case 'CALL':       isWin = exitPrice >= (c.entry_tick || 0); break;
        case 'PUT':        isWin = exitPrice <= (c.entry_tick || 0); break;
        default:           isWin = false;
      }

      setExitHighlight({ digit: exitD, win: isWin });
      setTimeout(() => setExitHighlight(null), 3000);
      setTradeResult({
        isWin, profit: 0,
        contract_type: c.contract_type, entry_digit: entryD, exit_digit: exitD,
      });

      setActiveContracts(prev => {
        activeContractsRef.current = prev.filter(p => p.id !== c.id);
        return activeContractsRef.current;
      });

      setContractHistory(prev => {
        if (prev.find(p => p.id === c.id)) return prev;
        const next = [...prev, {
          ...c,
          exit_tick: exitPrice, exit_digit: exitD,
          exit_epoch: tickEpochs.current[tickEpochs.current.length - 1],
          profit: 0, is_sold: true, is_win: isWin,
        }];
        contractHistoryRef.current = next;
        return next;
      });
    }
  }

  useEffect(() => {
    if (!canvasRef.current) return;
    const ro = new ResizeObserver(() => drawChart());
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [drawChart]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(function loop() {
      drawChart();
      animRef.current = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(animRef.current);
  }, [drawChart]);

  // Chart panning, zooming (mouse + touch pinch) on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (e: MouseEvent) => {
      isPanning.current = true;
      panStartX.current = e.clientX;
      panStartPx.current = panPx.current;
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: MouseEvent) => {
      if (!isPanning.current) return;
      panPx.current = panStartPx.current + (e.clientX - panStartX.current);
    };
    const onUp = () => {
      isPanning.current = false;
      const c = canvasRef.current;
      if (c) c.style.cursor = 'crosshair';
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const oldZoom = zoomRef.current;
      const delta = e.deltaY > 0 ? 0.88 : 1/0.88;
      const newZoom = Math.max(0.3, Math.min(50, zoomRef.current * delta));
      zoomRef.current = newZoom;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - 50;
      if (mx > 0) {
        const ratio = newZoom / oldZoom;
        panPx.current = (panPx.current + mx) * ratio - mx;
      }
    };

    // Touch: single finger pan, two finger pinch zoom
    let touchStartDist = 0;
    let touchStartZoom = 1;
    let touchStartMidX = 0;
    let touchPanStartPx = 0;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        isPanning.current = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchStartDist = Math.sqrt(dx * dx + dy * dy);
        touchStartZoom = zoomRef.current;
        touchStartMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        touchPanStartPx = panPx.current;
      } else if (e.touches.length === 1) {
        isPanning.current = true;
        panStartX.current = e.touches[0].clientX;
        panStartPx.current = panPx.current;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && touchStartDist > 0) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / touchStartDist;
        const newZoom = Math.max(0.3, Math.min(50, touchStartZoom * scale));
        const rect = canvas.getBoundingClientRect();
        const mx = touchStartMidX - rect.left - 50;
        const ratio = newZoom / touchStartZoom;
        panPx.current = (touchPanStartPx + mx) * ratio - mx;
        zoomRef.current = newZoom;
      } else if (e.touches.length === 1 && isPanning.current) {
        panPx.current = panStartPx.current + (e.touches[0].clientX - panStartX.current);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) { touchStartDist = 0; }
      if (e.touches.length === 0) { isPanning.current = false; }
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.style.cursor = 'crosshair';
    return () => {
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // Drawing click handler — places points when a tool is active (mouse + touch)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const getCoords = (e: MouseEvent | Touch) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const placePoint = (cx: number, cy: number) => {
      const tool = activeDrawToolRef.current;
      if (!tool) return;
      const toolDef = DRAW_TOOLS.find(t => t.type === tool);
      if (!toolDef) return;
      const newPoints = [...drawPointsRef.current, { x: cx, y: cy }];
      drawPointsRef.current = newPoints;
      setDrawPoints(newPoints);
      if (newPoints.length >= toolDef.points) {
        const newDrawing: Drawing = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          type: tool, points: newPoints,
          color: drawColor, thickness: drawThickness, style: drawStyle,
          text: tool === 'text' ? prompt('Enter text:') || '' : undefined,
        };
        const updated = [...drawingsRef.current, newDrawing];
        drawingsRef.current = updated; setDrawings(updated);
        drawPointsRef.current = []; setDrawPoints([]);
      }
    };
    const handleMouseClick = (e: MouseEvent) => {
      if (!activeDrawToolRef.current) return;
      const { x, y } = getCoords(e);
      placePoint(x, y);
    };
    const handleTouchDraw = (e: TouchEvent) => {
      if (!activeDrawToolRef.current) return;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      const { x, y } = getCoords(touch);
      placePoint(x, y);
    };
    const handleSelectClick = (e: MouseEvent) => {
      if (activeDrawToolRef.current) return;
      const { x, y } = getCoords(e);
      let found: string | null = null;
      for (const d of drawingsRef.current) {
        for (const pt of d.points) {
          if (Math.sqrt((pt.x - x) ** 2 + (pt.y - y) ** 2) < 10) { found = d.id; break; }
        }
        if (found) break;
      }
      setSelectedDrawing(found);
    };
    const handleTouchSelect = (e: TouchEvent) => {
      if (activeDrawToolRef.current) return;
      const touch = e.changedTouches?.[0];
      if (!touch) return;
      const { x, y } = getCoords(touch);
      let found: string | null = null;
      for (const d of drawingsRef.current) {
        for (const pt of d.points) {
          if (Math.sqrt((pt.x - x) ** 2 + (pt.y - y) ** 2) < 15) { found = d.id; break; }
        }
        if (found) break;
      }
      setSelectedDrawing(found);
    };
    canvas.addEventListener('click', handleMouseClick);
    canvas.addEventListener('touchend', handleTouchDraw);
    canvas.addEventListener('click', handleSelectClick);
    canvas.addEventListener('touchend', handleTouchSelect);
    return () => {
      canvas.removeEventListener('click', handleMouseClick);
      canvas.removeEventListener('touchend', handleTouchDraw);
      canvas.removeEventListener('click', handleSelectClick);
      canvas.removeEventListener('touchend', handleTouchSelect);
    };
  }, []);

  // Resize handle
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      chartHeightPct.current = Math.max(0.3, Math.min(1, resizeStartPct.current + (e.clientY - resizeStartY.current) / window.innerHeight));
    };
    const onUp = () => { isResizing.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const connectTicks = useCallback((sym: string) => {
    if (wsRef.current) { try { wsRef.current.onclose = null; wsRef.current.close(); } catch {} }
    tickPrices.current = [];
    tickEpochs.current = [];
    priceRef.current = null; digitRef.current = null;
    setCurrentPrice(null); setCurrentDigit(null);
    setTickHistory([]); setDigitCounts(Array(10).fill(0));

    const server_url = getSocketURL()?.replace(/[^a-zA-Z0-9.]/g, '');
    const app_id = getAppId();
    if (!server_url || !app_id) return;
    const ws = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);
    wsRef.current = ws;
    setConnectionStatus('Connecting...');
    ws.onopen = () => {
      if (ws !== wsRef.current) return;
      ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
      ws.send(JSON.stringify({ ticks_history: sym, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
      if (chartStyleRef.current === 'candle') {
        ws.send(JSON.stringify({ ticks_history: sym, style: 'candles', granularity: timeframeRef.current, count: 500, end: 'latest' }));
      }
      setConnectionStatus('Live');
    };
    ws.onmessage = (event) => {
      if (ws !== wsRef.current) return;
      try {
        const data = JSON.parse(event.data);
        if (data.msg_type === 'tick' && data.tick?.quote) {
          const tick = data.tick;
          const ps = tick.pip_size || getPipSize(tick.symbol || sym);
          const digit = extractDigit(tick.quote, ps);
          tickPrices.current = [...tickPrices.current.slice(-MAX_TICKS + 1), tick.quote];
          tickEpochs.current = [...tickEpochs.current.slice(-MAX_TICKS + 1), tick.epoch || 0];
          priceRef.current = tick.quote; digitRef.current = digit;
          setCurrentPrice(tick.quote); setCurrentDigit(digit);
          setTickCounter(n => n + 1);
          setTickHistory(prev => {
            const next = [...prev.slice(-MAX_TICKS + 1), digit];
            const counts = Array(10).fill(0) as number[];
            next.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; });
            setDigitCounts(counts); return next;
          });
          // Update forming candle for real-time
          if (chartStyleRef.current === 'candle' && tick.epoch) {
            const gran = timeframeRef.current;
            const ce = Math.floor(tick.epoch / gran) * gran;
            const cd = candleData.current;
            if (cd.length > 0 && cd[cd.length - 1].epoch === ce) {
              const last = cd[cd.length - 1];
              last.high = Math.max(last.high, tick.quote);
              last.low = Math.min(last.low, tick.quote);
              last.close = tick.quote;
            } else {
              cd.push({ open: tick.quote, high: tick.quote, low: tick.quote, close: tick.quote, epoch: ce });
            }
          }
          // Auto-settle tick-based contracts when countdown reaches 0
          checkAutoSettle();
        } else if (data.msg_type === 'history' && data.history?.prices) {
          const prices: number[] = data.history.prices;
          const ps = getPipSize(sym);
          tickPrices.current = prices.slice(-MAX_TICKS);
          tickEpochs.current = data.history.times ? data.history.times.slice(-MAX_TICKS) : [];
          if (prices.length > 0) {
            const lastP = prices[prices.length - 1];
            const digits = prices.map((p: number) => extractDigit(p, ps));
            priceRef.current = lastP; digitRef.current = digits[digits.length - 1];
            setCurrentPrice(lastP); setCurrentDigit(digits[digits.length - 1]);
            setTickHistory(digits.slice(-MAX_TICKS));
            const counts = Array(10).fill(0) as number[];
            digits.slice(-MAX_TICKS).forEach((d: number) => { if (d >= 0 && d <= 9) counts[d]++; });
            setDigitCounts(counts);
          }
        } else if (data.msg_type === 'candles' && data.candles) {
          const gran = timeframeRef.current;
          candleData.current = data.candles.map((c: any) => ({
            open: c.open, high: c.high, low: c.low, close: c.close,
            epoch: Math.floor(c.epoch / gran) * gran,
          }));
        }
      } catch {}
    };
    ws.onclose = () => {
      if (ws !== wsRef.current) return;
      setConnectionStatus('Disconnected');
      setTimeout(() => connectTicks(sym), 3000);
    };
    ws.onerror = () => { if (ws === wsRef.current) ws.close(); };
  }, []);

  useEffect(() => {
    connectTicks(symbol);
    return () => { if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }};
  }, [symbol, connectTicks]);

  useEffect(() => {
    if (chartStyle !== 'candle' || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    candleData.current = [];
    wsRef.current.send(JSON.stringify({ ticks_history: symbolRef.current, style: 'candles', granularity: timeframe, count: 500, end: 'latest' }));
  }, [chartStyle, timeframe]);

  // Recalculate indicators when data or active indicators change
  useEffect(() => {
    const inds = activeIndicators;
    if (inds.length === 0) { indicatorValues.current.clear(); return; }
    const prices = tickPrices.current;
    const candles = candleData.current;
    if (prices.length < 2 && candles.length < 2) return;
    const vals = new Map<string, (number | null)[]>();
    for (const ind of inds) {
      if (ind.id === 'sma') vals.set('sma', calcSMA(prices, ind.params.period));
      else if (ind.id === 'ema') vals.set('ema', calcEMA(prices, ind.params.period));
      else if (ind.id === 'bb') {
        const bb = calcBB(prices, ind.params.period, ind.params.stddev);
        vals.set('bb_mid', bb.middle); vals.set('bb_up', bb.upper); vals.set('bb_low', bb.lower);
      } else if (ind.id === 'rsi') vals.set('rsi', calcRSI(prices, ind.params.period));
      else if (ind.id === 'macd') {
        const m = calcMACD(prices, ind.params.fast, ind.params.slow, ind.params.signal);
        vals.set('macd_line', m.macdLine); vals.set('macd_signal', m.signalLine); vals.set('macd_hist', m.histogram);
      } else if (ind.id === 'stoch' && candles.length > 0) {
        const ch = candles.map(c => c.high), cl = candles.map(c => c.low), cc = candles.map(c => c.close);
        const s = calcStoch(ch, cl, cc, ind.params.k, ind.params.d);
        vals.set('stoch_k', s.k); vals.set('stoch_d', s.d);
      } else if (ind.id === 'atr' && candles.length > 0) {
        vals.set('atr', calcATR(candles, ind.params.period));
      } else if (ind.id === 'cci' && candles.length > 0) {
        const ch = candles.map(c => c.high), cl = candles.map(c => c.low), cc = candles.map(c => c.close);
        vals.set('cci', calcCCI(ch, cl, cc, ind.params.period));
      }
    }
    indicatorValues.current = vals;
  }, [activeIndicators, tickCounter, candleData.current.length]);

  useEffect(() => {
    const unsub = onNewSystemMessage((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.msg_type === 'balance' && !data.error) {
          const bal = data.balance?.balance ?? data.balance?.accounts?.total;
          if (bal != null) setBalance(Number(bal));
          return;
        }
        if (data.msg_type === 'buy') {
          setIsTrading(false);
          if (data.error) {
            console.error('Buy error:', data.error);
            return;
          }
          if (data.buy?.contract_id) {
            const cid = String(data.buy.contract_id);
            const entryPrice = data.buy.entry_tick || priceRef.current || 0;
            const entryEpoch = data.buy.entry_tick_time || tickEpochs.current[tickEpochs.current.length - 1] || 0;
            const ct = data.buy.contract_type || (tradeTypeRef.current === 'accumulator' ? 'ACCU' : contractTypeRef.current);
            const nc: ContractInfo = {
              id: cid, contract_type: ct, stake: stakeRef.current,
              symbol: symbolRef.current, entry_tick: entryPrice,
              entry_digit: digitRef.current || extractDigit(entryPrice, pipSizeRef.current),
              entry_epoch: entryEpoch,
              entry_index: tickPrices.current.length,
              is_sold: false,
              duration: durationRef.current, duration_unit: durationUnitRef.current,
            };
            setActiveContracts(prev => { activeContractsRef.current = [...prev, nc]; return activeContractsRef.current; });
            sendViaNewSystem({ proposal_open_contract: 1, contract_id: data.buy.contract_id, subscribe: 1 });
            sendViaNewSystem({ balance: 1 });
          }
          return;
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
          const poc = data.proposal_open_contract;
          const cid = String(poc.contract_id);
          const ac = activeContractsRef.current.find(c => c.id === cid);

          // Fallback chain for entry/exit tick values (matches transactions-store.ts)
          const entryTick = poc.entry_tick_display_value || poc.entry_tick || poc.entry_spot_display_value || poc.entry_spot || ac?.entry_tick || 0;
          const exitTick = poc.exit_tick_display_value || poc.exit_tick || poc.exit_spot_display_value || poc.exit_spot || 0;
          const entryD = entryTick ? extractDigit(Number(entryTick), pipSizeRef.current) : 0;
          const exitD = exitTick ? extractDigit(Number(exitTick), pipSizeRef.current) : 0;

          if (poc.is_sold) {
            const profit = Number(poc.profit ?? 0);
            const isWin = profit >= 0;
            setExitHighlight({ digit: exitD, win: isWin });
            setTimeout(() => setExitHighlight(null), 3000);
            setTradeResult({ isWin, profit, contract_type: poc.contract_type || ac?.contract_type || '', entry_digit: entryD, exit_digit: exitD });
            setActiveContracts(prev => { activeContractsRef.current = prev.filter(c => c.id !== cid); return activeContractsRef.current; });
            setContractHistory(prev => {
              if (prev.find(c => c.id === cid)) return prev;
              const next = [...prev, {
                id: cid, contract_type: poc.contract_type || ac?.contract_type || '',
                stake: Number(poc.buy_price ?? ac?.stake ?? 0),
                symbol: poc.symbol || ac?.symbol || '',
                entry_tick: Number(entryTick), entry_digit: entryD,
                entry_epoch: poc.entry_tick_time || ac?.entry_epoch,
                entry_index: ac?.entry_index,
                exit_tick: Number(exitTick), exit_epoch: poc.exit_tick_time,
                exit_digit: exitD, profit, is_sold: true, is_win: isWin,
                duration: ac?.duration, duration_unit: ac?.duration_unit,
              }];
              contractHistoryRef.current = next;
              return next;
            });
            setSessionStats(prev => ({ wins: prev.wins + (isWin ? 1 : 0), losses: prev.losses + (isWin ? 0 : 1), profit: prev.profit + profit }));
            sendViaNewSystem({ balance: 1 });
          } else {
            setActiveContracts(prev => {
              const u = prev.map(c => c.id === cid ? {
                ...c, entry_tick: Number(entryTick) || c.entry_tick,
                entry_digit: entryD || c.entry_digit,
                entry_epoch: poc.entry_tick_time || c.entry_epoch,
              } : c);
              activeContractsRef.current = u; return u;
            });
          }
          return;
        }
        if (data.msg_type === 'sell') {
          setIsTrading(false);
          sendViaNewSystem({ balance: 1 });
          return;
        }
      } catch {}
    });
    return unsub;
  }, []);

  const handleBuyContract = (ct: string) => {
    if (isTrading) return;
    setIsTrading(true);
    const isAccu = tradeType === 'accumulator';
    const params: Record<string, any> = {
      amount: parseFloat(stake) || 0.35, basis: 'stake', currency: 'USD',
      symbol, contract_type: ct,
    };
    if (isAccu) {
      params.growth_rate = growthRate;
      if (takeProfit) {
        params.limit_order = { take_profit: Number(takeProfit) };
      }
    } else {
      params.duration = duration;
      params.duration_unit = durationUnit;
    }
    if (ct === 'DIGITOVER' || ct === 'DIGITUNDER' || ct === 'DIGITMATCH' || ct === 'DIGITDIFF') {
      params.barrier = barrier;
    }
    sendViaNewSystem({ buy: 1, price: parseFloat(stake) || 0.35, parameters: params });
  };

  const handleSellContract = async (contractId: string) => {
    if (isTrading) return;
    setIsTrading(true);
    try {
      const res = await sendViaNewSystemWithPromise({ sell: 1, contract_id: contractId });
      if (res?.error) {
        console.error('Sell error:', res.error);
        setTradeResult({ isWin: false, profit: 0, contract_type: 'SELL_ERR', entry_digit: 0, exit_digit: 0 });
        setTimeout(() => setTradeResult(null), 3000);
      }
    } catch (e: any) {
      console.error('Sell failed:', e);
      setTradeResult({ isWin: false, profit: 0, contract_type: 'SELL_ERR', entry_digit: 0, exit_digit: 0 });
      setTimeout(() => setTradeResult(null), 3000);
    }
    setIsTrading(false);
  };

  const requestProposal = async (ct: string) => {
    try {
      const isAccu = tradeType === 'accumulator';
      const params: Record<string, any> = {
        proposal: 1, amount: parseFloat(stake) || 0.35, basis: 'stake', currency: 'USD',
        symbol, contract_type: ct,
      };
      if (isAccu) {
        params.growth_rate = growthRate;
      } else {
        params.duration = duration;
        params.duration_unit = durationUnit;
      }
      if (ct === 'DIGITOVER' || ct === 'DIGITUNDER' || ct === 'DIGITMATCH' || ct === 'DIGITDIFF') {
        params.barrier = barrier;
      }
      const res = await sendViaNewSystemWithPromise(params);
      if (res?.proposal?.payout) {
        setPayout(Number(res.proposal.payout).toFixed(2));
      } else if (isAccu && res?.proposal?.longcode) {
        setPayout('ACCU');
      }
    } catch { setPayout(null); }
  };

  useEffect(() => {
    setPayout(null);
    const t = setTimeout(() => requestProposal(contractType), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractType, stake, duration, durationUnit, symbol, barrier, growthRate, tradeType]);

  const currentContracts: string[] = (() => {
    switch (tradeType) {
      case 'rise_fall': return ['CALL', 'PUT'];
      case 'over_under': return ['DIGITOVER', 'DIGITUNDER'];
      case 'digits': return ['DIGITMATCH', 'DIGITDIFF'];
      case 'even_odd': return ['DIGITEVEN', 'DIGITODD'];
      case 'accumulator': return ['ACCU'];
      default: return ['CALL', 'PUT'];
    }
  })();

  useEffect(() => {
    setContractType(currentContracts[0]);
    if (tradeType === 'accumulator') setChartStyle('line');
  }, [tradeType, currentContracts[0]]);

  useEffect(() => {
    if (!tradeResult) return;
    const t = setTimeout(() => setTradeResult(null), 2000);
    return () => clearTimeout(t);
  }, [tradeResult]);

  const navTradeTypes = [
    { value: 'rise_fall', label: 'Rise/Fall' },
    { value: 'over_under', label: 'Over/Under' },
  { value: 'digits', label: 'Matches/Differs' },
    { value: 'even_odd', label: 'Even/Odd' },
    { value: 'accumulator', label: 'Accumulator' },
  ];

  const fieldRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 0', borderBottom: '1px solid #2a2a2a',
  };
  const fieldLabel: React.CSSProperties = { color: '#999', fontSize: '12px' };
  const fieldVal: React.CSSProperties = {
    background: '#2a2a2a', color: '#ddd', border: '1px solid #444',
    borderRadius: '4px', padding: '4px 8px', fontSize: '13px', textAlign: 'right', width: '80px',
  };

  if (!isPhone) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', color: '#ddd', fontSize: '13px', background: '#111' }}>
        {/* TOP NAV BAR */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', background: '#1a1a1a', borderBottom: '1px solid #333', gap: '4px', overflowX: 'auto' }}>
          {navTradeTypes.map(t => (
            <button key={t.value} onClick={() => setTradeType(t.value)}
              style={{
                padding: '6px 14px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap',
                background: tradeType === t.value ? '#2a2a2a' : 'transparent',
                color: tradeType === t.value ? '#fff' : '#888',
                fontWeight: tradeType === t.value ? 'bold' : 'normal',
              }}>
              {t.value === 'rise_fall' ? '\uD83D\uDD25 ' : ''}{t.label}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px' }}>
            <span style={{ color: connectionStatus === 'Live' ? '#4caf50' : '#ff9800' }}>\u25CF</span>
            <span>{connectionStatus}</span>
            {currentDigit !== null && <span style={{ color: '#ffeb3b', fontWeight: 'bold', fontSize: '15px' }}>{currentDigit}</span>}
          </div>
        </div>

        {/* Volatility selector row */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', background: '#fff', borderBottom: '1px solid #e0e0e0', gap: '12px' }}>
          <span style={{ color: '#555', fontSize: '12px', fontWeight: 600 }}>Volatility</span>
          <select value={symbol} onChange={e => setSymbol(e.target.value)}
            style={{ background: '#fff', color: '#222', border: '1px solid #bbb', borderRadius: '4px', padding: '4px 8px', fontSize: '12px', minWidth: '180px' }}>
            {SYMBOLS.map(s => <option key={s} value={s}>{VOLATILITY_NAMES[s] || s}</option>)}
          </select>
        </div>

        {/* MAIN AREA */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* CHART */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: '#151515', borderBottom: '1px solid #222' }}>
              {currentPrice !== null && (
                <span style={{ color: '#fff', fontSize: '14px', fontWeight: 'bold' }}>
                  {currentPrice.toFixed(2)}
                </span>
              )}
              {currentPrice !== null && (
                <span style={{ color: '#888', fontSize: '11px' }}>
                  {currentPrice.toFixed(2)} ({((currentPrice - (tickPrices.current[tickPrices.current.length - 2] || currentPrice)) / currentPrice * 100).toFixed(2)}%)
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>
                <button onClick={() => setChartStyle('line')}
                  style={{
                    padding: '2px 10px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                    fontSize: '10px', fontWeight: chartStyle === 'line' ? 'bold' : 'normal',
                    background: chartStyle === 'line' ? '#333' : 'transparent',
                    color: chartStyle === 'line' ? '#fff' : '#666',
                  }}>Line</button>
                <button onClick={() => setChartStyle('candle')}
                  style={{
                    padding: '2px 10px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                    fontSize: '10px', fontWeight: chartStyle === 'candle' ? 'bold' : 'normal',
                    background: chartStyle === 'candle' ? '#333' : 'transparent',
                    color: chartStyle === 'candle' ? '#fff' : '#666',
                  }}>Candle</button>
                {chartStyle === 'candle' && GRANULARITIES.map(g => (
                  <button key={g.value} onClick={() => setTimeframe(g.value)}
                    style={{
                      padding: '2px 6px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                      fontSize: '9px', fontWeight: timeframe === g.value ? 'bold' : 'normal',
                      background: timeframe === g.value ? '#333' : 'transparent',
                      color: timeframe === g.value ? '#fff' : '#666',
                    }}>{g.label}</button>
                ))}
                <button onClick={() => setShowIndicators(!showIndicators)}
                  style={{
                    padding: '2px 8px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                    fontSize: '10px', fontWeight: showIndicators ? 'bold' : 'normal',
                    background: showIndicators ? '#333' : 'transparent',
                    color: showIndicators ? '#fff' : '#666',
                  }}>Indicators</button>
              </div>
            </div>
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />
              {/* Digit circles overlay — top of chart */}
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '10px 0 8px', background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 70%, transparent 100%)', zIndex: 5, pointerEvents: 'none' }}>
                <div style={{ display: 'flex', gap: '14px', pointerEvents: 'auto' }}>
                  {Array.from({ length: 10 }, (_, i) => {
                    const isCurrent = currentDigit === i;
                    const isHighlight = exitHighlight?.digit === i;
                    const hlColor = exitHighlight ? (exitHighlight.win ? '#4caf50' : '#f44336') : '#ffeb3b';
                    const isBarrier = String(i) === barrier;
                    const win = tickHistory.slice(-DIGIT_WINDOW); const counts = new Array(10).fill(0); win.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; }); const winTotal = counts.reduce((a, v) => a + v, 0); const pct = winTotal > 0 ? (counts[i] / winTotal) * 100 : 0;
                    return (
                      <div key={i} style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => setBarrier(String(i))}>
                        <div style={{
                          width: '52px', height: '52px', borderRadius: '50%', display: 'flex', alignItems: 'center',
                          justifyContent: 'center',
                          background: isHighlight ? hlColor : (isCurrent ? '#ffeb3b' : (isBarrier ? '#4fc3f7' : 'rgba(224,224,224,0.85)')),
                          color: (isCurrent || isBarrier) && !isHighlight ? '#000' : '#333',
                          fontWeight: 'bold', fontSize: '20px',
                          boxShadow: isCurrent ? '0 0 8px rgba(255,235,59,0.6)' : (isBarrier ? '0 0 8px rgba(79,195,247,0.6)' : 'none'),
                          border: (isCurrent || isBarrier) ? 'none' : '2px solid rgba(0,0,0,0.15)',
                        }}>{i}</div>
                        <div style={{ marginTop: '3px', height: '4px', background: 'rgba(255,255,255,0.2)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: isHighlight ? hlColor : (pct > 12 ? '#4caf50' : pct > 9 ? '#ff9800' : '#f44336') }} />
                        </div>
                        <div style={{ fontSize: '10px', color: '#ccc', marginTop: '1px' }}>{pct.toFixed(1)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Drawing toolbox button */}
              <div style={{ position: 'absolute', top: '8px', left: '8px', zIndex: 6, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <button onClick={() => { setShowToolbox(!showToolbox); setShowDrawConfig(false); }}
                  style={{ width: '32px', height: '32px', borderRadius: '6px', border: showToolbox ? '2px solid #4fc3f7' : '1px solid #555', background: showToolbox ? '#1a3a5a' : 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  title="Drawing Tools">✎</button>
                {activeDrawTool && (
                  <button onClick={() => { setActiveDrawTool(null); setDrawPoints([]); drawPointsRef.current = []; }}
                    style={{ width: '32px', height: '32px', borderRadius: '6px', border: '1px solid #f44336', background: 'rgba(244,67,54,0.3)', color: '#f44336', cursor: 'pointer', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title="Cancel Drawing">✕</button>
                )}
              </div>
              {/* Toolbox panel */}
              {showToolbox && (
                <div style={{ position: 'absolute', top: '48px', left: '8px', zIndex: 7, background: '#1a1a1a', border: '1px solid #444', borderRadius: '8px', padding: '8px', width: '200px', boxShadow: '0 4px 16px rgba(0,0,0,0.6)' }}>
                  <div style={{ color: '#aaa', fontSize: '10px', fontWeight: 'bold', marginBottom: '6px', textTransform: 'uppercase' }}>Drawing Tools</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px', marginBottom: '8px' }}>
                    {DRAW_TOOLS.map(tool => (
                      <button key={tool.type} onClick={() => { setActiveDrawTool(tool.type); setDrawPoints([]); drawPointsRef.current = []; setShowDrawConfig(false); }}
                        style={{ padding: '6px 2px', borderRadius: '4px', border: activeDrawTool === tool.type ? '2px solid #4fc3f7' : '1px solid #333', background: activeDrawTool === tool.type ? '#1a3a5a' : '#222', color: activeDrawTool === tool.type ? '#4fc3f7' : '#ccc', cursor: 'pointer', fontSize: '10px', textAlign: 'center' }}>
                        <div style={{ fontSize: '16px' }}>{tool.icon}</div>
                        <div style={{ marginTop: '2px' }}>{tool.label}</div>
                      </button>
                    ))}
                  </div>
                  {/* Config section */}
                  <div style={{ borderTop: '1px solid #333', paddingTop: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ color: '#aaa', fontSize: '10px' }}>Color</span>
                      <div style={{ display: 'flex', gap: '3px' }}>
                        {DRAW_COLORS.map(c => (
                          <div key={c} onClick={() => setDrawColor(c)}
                            style={{ width: '16px', height: '16px', borderRadius: '3px', background: c, cursor: 'pointer', border: drawColor === c ? '2px solid #fff' : '1px solid #555' }} />
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ color: '#aaa', fontSize: '10px' }}>Width</span>
                      <div style={{ display: 'flex', gap: '3px' }}>
                        {DRAW_THICKNESS.map(t => (
                          <button key={t} onClick={() => setDrawThickness(t)}
                            style={{ width: '24px', height: '20px', borderRadius: '3px', border: drawThickness === t ? '2px solid #4fc3f7' : '1px solid #333', background: drawThickness === t ? '#1a3a5a' : '#222', color: '#ccc', cursor: 'pointer', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ color: '#aaa', fontSize: '10px' }}>Style</span>
                      <div style={{ display: 'flex', gap: '3px' }}>
                        {(['solid', 'dashed', 'dotted'] as const).map(s => (
                          <button key={s} onClick={() => setDrawStyle(s)}
                            style={{ padding: '2px 6px', borderRadius: '3px', border: drawStyle === s ? '2px solid #4fc3f7' : '1px solid #333', background: drawStyle === s ? '#1a3a5a' : '#222', color: '#ccc', cursor: 'pointer', fontSize: '9px' }}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {/* Selected drawing actions */}
                  {selectedDrawing && (
                    <div style={{ borderTop: '1px solid #333', paddingTop: '6px', display: 'flex', gap: '4px' }}>
                      <button onClick={() => {
                        const d = drawingsRef.current.find(x => x.id === selectedDrawing);
                        if (d) {
                          const dup = { ...d, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), points: [...d.points.map(p => ({ ...p }))] };
                          const updated = [...drawingsRef.current, dup];
                          drawingsRef.current = updated; setDrawings(updated);
                        }
                      }} style={{ flex: 1, padding: '4px', borderRadius: '4px', border: '1px solid #333', background: '#222', color: '#4fc3f7', cursor: 'pointer', fontSize: '10px' }}>Duplicate</button>
                      <button onClick={() => {
                        const updated = drawingsRef.current.filter(x => x.id !== selectedDrawing);
                        drawingsRef.current = updated; setDrawings(updated); setSelectedDrawing(null);
                      }} style={{ flex: 1, padding: '4px', borderRadius: '4px', border: '1px solid #333', background: '#222', color: '#f44336', cursor: 'pointer', fontSize: '10px' }}>Delete</button>
                    </div>
                  )}
                  {drawings.length > 0 && (
                    <button onClick={() => { drawingsRef.current = []; setDrawings([]); setSelectedDrawing(null); }}
                      style={{ width: '100%', padding: '4px', marginTop: '4px', borderRadius: '4px', border: '1px solid #333', background: '#222', color: '#f44336', cursor: 'pointer', fontSize: '10px' }}>Clear All</button>
                  )}
                </div>
              )}
            </div>
            {/* Resize handle */}
            <div onMouseDown={(e) => { isResizing.current = true; resizeStartY.current = e.clientY; resizeStartPct.current = chartHeightPct.current; e.preventDefault(); }}
              style={{ height: '4px', background: '#333', cursor: 'ns-resize', flexShrink: 0 }} />
            {showIndicators && (
               <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 100, background: '#1a1a1a', border: '1px solid #333', borderRadius: '6px', padding: '8px', minWidth: '220px', maxWidth: '300px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: '#aaa', fontSize: '10px', fontWeight: 'bold' }}>Add Indicator</span>
                  <button onClick={() => setShowIndicators(false)} style={{ padding: '0 4px', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '12px', background: 'transparent', color: '#888' }}>\u2715</button>
                </div>
                {AVAILABLE_INDICATORS.map(ind => {
                  const isActive = activeIndicators.some(a => a.id === ind.id);
                  return (
                    <div key={ind.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0' }}>
                      <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: ind.color }} />
                      <span style={{ color: '#ccc', fontSize: '11px', flex: 1 }}>{ind.label}</span>
                      <button onClick={() => {
                        if (isActive) setActiveIndicators(prev => prev.filter(a => a.id !== ind.id));
                        else setActiveIndicators(prev => [...prev, { ...ind }]);
                      }} style={{
                        padding: '1px 8px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                        fontSize: '9px', background: isActive ? '#f44336' : '#333', color: '#fff',
                      }}>{isActive ? '×' : '+'}</button>
                    </div>
                  );
                })}
                {activeIndicators.length > 0 && (
                  <>
                    <div style={{ borderTop: '1px solid #333', margin: '6px 0', paddingTop: '6px' }}>
                      <div style={{ color: '#aaa', fontSize: '10px', marginBottom: '4px', fontWeight: 'bold' }}>Active</div>
                      {activeIndicators.map(ind => (
                        <div key={ind.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' }}>
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: ind.color }} />
                          <span style={{ color: '#ccc', fontSize: '11px', flex: 1 }}>{ind.label}</span>
                          <button onClick={() => setActiveIndicators(prev => prev.filter(a => a.id !== ind.id))}
                            style={{ padding: '1px 6px', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '9px', background: '#f44336', color: '#fff' }}>×</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* RIGHT SIDEBAR - TRADING PANEL */}
          <div style={{ width: '280px', minWidth: '280px', background: '#1a1a1a', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px', flex: 1, overflow: 'auto' }}>
              <div style={{ textAlign: 'right', marginBottom: '8px' }}>
                <a style={{ color: '#4fc3f7', fontSize: '11px', cursor: 'pointer', textDecoration: 'none' }}>
                  How to trade {contractTypes}?
                </a>
              </div>

              {/* Direction/Contract Type Toggle */}
              {tradeType === 'accumulator' ? (
                <div style={{ textAlign: 'center', padding: '10px', marginBottom: '8px', background: '#1a3a1a', borderRadius: '6px', border: '1px solid #2a5a2a' }}>
                  <span style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '14px' }}>Accumulator</span>
                  <div style={{ color: '#888', fontSize: '11px', marginTop: '2px' }}>Compounding per tick</div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  {currentContracts.map(ct => (
                    <button key={ct} onClick={() => setContractType(ct)}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '6px', border: contractType === ct ? '2px solid #ff4444' : '2px solid #333',
                        background: contractType === ct ? '#2a1a1a' : '#1a1a1a',
                        color: contractType === ct ? '#ff4444' : '#666', cursor: 'pointer',
                        fontWeight: contractType === ct ? 'bold' : 'normal', fontSize: '13px',
                      }}>
                      {contractLabels[ct] || ct}
                    </button>
                  ))}
                </div>
              )}

              {/* Barrier (for digits/over_under) */}
              {(tradeType === 'over_under' || tradeType === 'digits') && (
                <div style={fieldRow}>
                  <span style={fieldLabel}>Barrier</span>
                  <input type="number" min={0} max={9} value={barrier}
                    onChange={e => setBarrier(e.target.value.replace(/[^0-9]/g, '').slice(0, 1) || '0')}
                    style={{ ...fieldVal, width: '60px', textAlign: 'center' }} />
                </div>
              )}

              {/* Growth Rate (only for Accumulator) */}
              {tradeType === 'accumulator' ? (
                <>
                  <div style={fieldRow}>
                    <span style={fieldLabel}>Growth Rate</span>
                    <select value={growthRate} onChange={e => setGrowthRate(Number(e.target.value))}
                      style={{ background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: '4px', padding: '4px 8px', fontSize: '12px' }}>
                      <option value={0.01}>1%</option>
                      <option value={0.02}>2%</option>
                      <option value={0.03}>3%</option>
                      <option value={0.04}>4%</option>
                      <option value={0.05}>5%</option>
                    </select>
                  </div>
                  <div style={fieldRow}>
                    <span style={fieldLabel}>Take Profit</span>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <span style={{ color: '#888', fontSize: '12px' }}>$</span>
                      <input type="number" min={0} value={takeProfit}
                        onChange={e => setTakeProfit(e.target.value)}
                        placeholder="Optional"
                        style={{ ...fieldVal, width: '80px' }} />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Duration */}
                  <div style={fieldRow}>
                    <span style={fieldLabel}>Duration</span>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input type="number" min={1} value={duration}
                        onChange={e => setDuration(Math.max(1, Number(e.target.value) || 1))}
                        style={{ ...fieldVal, width: '50px', textAlign: 'center' }} />
                      <select value={durationUnit} onChange={e => setDurationUnit(e.target.value as 't' | 'm')}
                        style={{ background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: '4px', padding: '4px 6px', fontSize: '12px' }}>
                        <option value="m">min</option>
                        <option value="t">ticks</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {/* Stake */}
              <div style={fieldRow}>
                <span style={fieldLabel}>Stake</span>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <span style={{ color: '#888', fontSize: '12px' }}>$</span>
                  <input type="number" min={0.35} step={0.35} value={stake}
                    onChange={e => setStake(e.target.value)}
                    onBlur={() => setStake(s => { const n = parseFloat(s); return (isNaN(n) || n < 0.35) ? '0.35' : s; })}
                    style={{ ...fieldVal, width: '80px' }} />
                </div>
              </div>

              {/* Allow Equals (only for Rise/Fall) */}
              {tradeType === 'rise_fall' && (
                <div style={fieldRow}>
                  <span style={fieldLabel}>Allow Equals</span>
                  <div onClick={() => setAllowEquals(!allowEquals)}
                    style={{
                      width: '36px', height: '20px', borderRadius: '10px',
                      background: allowEquals ? '#4caf50' : '#444', cursor: 'pointer',
                      position: 'relative', transition: 'background 0.2s',
                    }}>
                    <div style={{
                      width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: '2px',
                      left: allowEquals ? '18px' : '2px', transition: 'left 0.2s',
                    }} />
                  </div>
                </div>
              )}

              {/* Buy / Sell Button */}
              <div style={{ marginTop: '16px' }}>
                {activeAccuContract ? (
                  <button onClick={() => handleSellContract(activeAccuContract.id)}
                    disabled={isTrading}
                    style={{
                      width: '100%', padding: '14px', borderRadius: '6px', border: 'none',
                      background: '#ff9800', color: '#fff',
                      cursor: isTrading ? 'not-allowed' : 'pointer',
                      fontWeight: 'bold', fontSize: '15px',
                    }}>
                    {isTrading ? 'Selling...' : 'Sell'}
                  </button>
                ) : (
                  <button onClick={() => handleBuyContract(contractType)}
                    disabled={isTrading || currentPrice === null}
                    style={{
                      width: '100%', padding: '14px', borderRadius: '6px', border: 'none',
                      background: isTrading ? '#555' : (tradeType === 'accumulator' ? '#2e7d32' : '#d32f2f'), color: '#fff',
                      cursor: isTrading ? 'not-allowed' : 'pointer',
                      fontWeight: 'bold', fontSize: '15px',
                    }}>
                    {isTrading ? 'Buying...' : (tradeType === 'accumulator' ? 'Buy Accumulator' : `Buy ${contractLabels[contractType] || contractType}`)}
                  </button>
                )}
                {tradeType === 'accumulator' ? (
                  <div style={{ textAlign: 'center', marginTop: '8px', color: '#888', fontSize: '11px' }}>
                    {activeAccuContract ? 'Active · ' : ''}Growth: {growthRate * 100}% · Stake: ${parseFloat(stake) || 0.35}
                  </div>
                ) : payout && (
                  <div style={{ textAlign: 'center', marginTop: '8px', color: '#888', fontSize: '12px' }}>
                    Payout: ${payout}
                  </div>
                )}
              </div>
            </div>

            {/* Active + History mini section */}
            <div style={{ borderTop: '1px solid #222', padding: '8px 12px', maxHeight: '110px', overflow: 'auto', fontSize: '11px' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>
                Active: {activeContracts.length} | W:{sessionStats.wins} L:{sessionStats.losses} P&L:{sessionStats.profit.toFixed(2)}
              </div>
              {contractHistory.slice(-5).reverse().map(c => (
                <div key={c.id} style={{
                  padding: '2px 4px', marginBottom: '2px', borderLeft: `2px solid ${c.is_win ? '#4caf50' : '#f44336'}`,
                  color: '#888', fontSize: '10px',
                }}>
              {c.contract_type === 'ACCU'
                ? `ACCU ${c.is_win ? `+$${c.profit?.toFixed(2) || '0'}` : `-$${Math.abs(c.profit || 0).toFixed(2)}`}`
                : `${c.contract_type} ${c.entry_tick.toFixed(2)}→${c.exit_tick?.toFixed(2) ?? '?'} ${c.is_win ? `+$${c.profit?.toFixed(2) || '0'}` : `-$${Math.abs(c.profit || 0).toFixed(2)}`}`
              }
                </div>
              ))}
            </div>
          </div>
        </div>
        {tradeResult && (
          <div style={{
            position: 'fixed', top: '16px', right: '16px', zIndex: 9999,
            background: tradeResult.isWin ? '#1b5e20' : '#b71c1c',
            color: '#fff', padding: '12px 20px', borderRadius: '8px',
            fontSize: '14px', fontWeight: 'bold', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}>
            {tradeResult.isWin ? 'WIN' : 'LOSS'} · {tradeResult.contract_type} · {tradeResult.entry_digit}→{tradeResult.exit_digit} · {tradeResult.isWin ? '+' : ''}${tradeResult.profit.toFixed(2)}
          </div>
        )}
      </div>
    );
  }

  /* ─── PHONE LAYOUT ─── all in one screen, no scroll */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: '#333', fontSize: '13px', background: '#fff', overflow: 'hidden' }}>
      {/* TOP NAV — compact */}
      <div style={{ display: 'flex', gap: '4px', padding: '6px 8px', background: '#f0f0f0', overflowX: 'auto', whiteSpace: 'nowrap', borderBottom: '1px solid #ddd', alignItems: 'center', minHeight: '36px' }}>
        {navTradeTypes.map(t => (
          <button key={t.value} onClick={() => setTradeType(t.value)}
            style={{
              padding: '4px 10px', borderRadius: '14px', border: 'none', cursor: 'pointer',
              fontSize: '10px', whiteSpace: 'nowrap', fontWeight: tradeType === t.value ? 'bold' : 'normal',
              background: tradeType === t.value ? '#222' : 'transparent',
              color: tradeType === t.value ? '#fff' : '#555',
            }}>
            {t.value === 'rise_fall' ? '\uD83D\uDD25 ' : ''}{t.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: connectionStatus === 'Live' ? '#4caf50' : '#ff9800', fontSize: '8px' }}>\u25CF</span>
      </div>

      {/* Volatility selector row */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 12px', background: '#fff', borderBottom: '1px solid #ddd', gap: '8px' }}>
        <span style={{ color: '#555', fontSize: '11px', fontWeight: 600 }}>Volatility</span>
        <select value={symbol} onChange={e => setSymbol(e.target.value)}
          style={{ background: '#fff', color: '#222', border: '1px solid #bbb', borderRadius: '4px', padding: '4px 6px', fontSize: '11px', flex: 1 }}>
          {SYMBOLS.map(s => <option key={s} value={s}>{VOLATILITY_NAMES[s] || s}</option>)}
        </select>
      </div>

      {/* CHART (rise_fall / accumulator) OR DIGIT CIRCLES */}
      {tradeType === 'rise_fall' || tradeType === 'accumulator' ? (
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 6px', background: '#1a1a1a', borderBottom: '1px solid #333' }}>
            <button onClick={() => setChartStyle('line')}
              style={{
                padding: '2px 8px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                fontSize: '9px', fontWeight: chartStyle === 'line' ? 'bold' : 'normal',
                background: chartStyle === 'line' ? '#333' : 'transparent',
                color: chartStyle === 'line' ? '#fff' : '#888',
              }}>Line</button>
            <button onClick={() => setChartStyle('candle')}
              style={{
                padding: '2px 8px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                fontSize: '9px', fontWeight: chartStyle === 'candle' ? 'bold' : 'normal',
                background: chartStyle === 'candle' ? '#333' : 'transparent',
                color: chartStyle === 'candle' ? '#fff' : '#888',
              }}>Candle</button>
            {chartStyle === 'candle' && GRANULARITIES.map(g => (
              <button key={g.value} onClick={() => setTimeframe(g.value)}
                style={{
                  padding: '2px 6px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                  fontSize: '9px', fontWeight: timeframe === g.value ? 'bold' : 'normal',
                  background: timeframe === g.value ? '#333' : 'transparent',
                  color: timeframe === g.value ? '#fff' : '#888',
                }}>{g.label}</button>
            ))}
            <button onClick={() => setShowIndicators(!showIndicators)}
              style={{
                padding: '2px 6px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                fontSize: '9px', fontWeight: showIndicators ? 'bold' : 'normal',
                background: showIndicators ? '#333' : 'transparent',
                color: showIndicators ? '#fff' : '#888',
              }}>Indicators</button>
            <span style={{ color: '#666', fontSize: '8px' }}>{chartStyle === 'candle' ? GRANULARITIES.find(g => g.value === timeframe)?.label : ''}</span>
          </div>
          <div style={{ flex: '1 1 auto', position: 'relative', minHeight: 0, background: '#111' }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }} />
            {/* Drawing toolbox button — mobile */}
            <div style={{ position: 'absolute', top: '6px', left: '6px', zIndex: 6, display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <button onClick={() => { setShowToolbox(!showToolbox); setShowDrawConfig(false); }}
                style={{ width: '28px', height: '28px', borderRadius: '5px', border: showToolbox ? '2px solid #4fc3f7' : '1px solid #555', background: showToolbox ? '#1a3a5a' : 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                title="Drawing Tools">✎</button>
              {activeDrawTool && (
                <button onClick={() => { setActiveDrawTool(null); setDrawPoints([]); drawPointsRef.current = []; }}
                  style={{ width: '28px', height: '28px', borderRadius: '5px', border: '1px solid #f44336', background: 'rgba(244,67,54,0.3)', color: '#f44336', cursor: 'pointer', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  title="Cancel">✕</button>
              )}
            </div>
            {/* Toolbox panel — mobile */}
            {showToolbox && (
              <div style={{ position: 'absolute', top: '40px', left: '6px', zIndex: 7, background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '6px', width: '170px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)' }}>
                <div style={{ color: '#333', fontSize: '9px', fontWeight: 'bold', marginBottom: '4px', textTransform: 'uppercase' }}>Drawing Tools</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px', marginBottom: '6px' }}>
                  {DRAW_TOOLS.map(tool => (
                    <button key={tool.type} onClick={() => { setActiveDrawTool(tool.type); setDrawPoints([]); drawPointsRef.current = []; }}
                      style={{ padding: '4px 1px', borderRadius: '3px', border: activeDrawTool === tool.type ? '2px solid #2196f3' : '1px solid #ddd', background: activeDrawTool === tool.type ? '#e3f2fd' : '#fff', color: activeDrawTool === tool.type ? '#2196f3' : '#333', cursor: 'pointer', fontSize: '9px', textAlign: 'center' }}>
                      <div style={{ fontSize: '13px' }}>{tool.icon}</div>
                      <div style={{ marginTop: '1px', fontSize: '8px' }}>{tool.label}</div>
                    </button>
                  ))}
                </div>
                <div style={{ borderTop: '1px solid #eee', paddingTop: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ color: '#666', fontSize: '9px' }}>Color</span>
                    <div style={{ display: 'flex', gap: '2px' }}>
                      {DRAW_COLORS.slice(0, 6).map(c => (
                        <div key={c} onClick={() => setDrawColor(c)}
                          style={{ width: '14px', height: '14px', borderRadius: '2px', background: c, cursor: 'pointer', border: drawColor === c ? '2px solid #333' : '1px solid #ddd' }} />
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <span style={{ color: '#666', fontSize: '9px' }}>Width</span>
                    <div style={{ display: 'flex', gap: '2px' }}>
                      {DRAW_THICKNESS.map(t => (
                        <button key={t} onClick={() => setDrawThickness(t)}
                          style={{ width: '20px', height: '18px', borderRadius: '2px', border: drawThickness === t ? '2px solid #2196f3' : '1px solid #ddd', background: drawThickness === t ? '#e3f2fd' : '#fff', color: '#333', cursor: 'pointer', fontSize: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {selectedDrawing && (
                  <div style={{ borderTop: '1px solid #eee', paddingTop: '4px', display: 'flex', gap: '3px' }}>
                    <button onClick={() => {
                      const d = drawingsRef.current.find(x => x.id === selectedDrawing);
                      if (d) {
                        const dup = { ...d, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), points: [...d.points.map(p => ({ ...p }))] };
                        const updated = [...drawingsRef.current, dup];
                        drawingsRef.current = updated; setDrawings(updated);
                      }
                    }} style={{ flex: 1, padding: '3px', borderRadius: '3px', border: '1px solid #ddd', background: '#fff', color: '#2196f3', cursor: 'pointer', fontSize: '9px' }}>Duplicate</button>
                    <button onClick={() => {
                      const updated = drawingsRef.current.filter(x => x.id !== selectedDrawing);
                      drawingsRef.current = updated; setDrawings(updated); setSelectedDrawing(null);
                    }} style={{ flex: 1, padding: '3px', borderRadius: '3px', border: '1px solid #ddd', background: '#fff', color: '#f44336', cursor: 'pointer', fontSize: '9px' }}>Delete</button>
                  </div>
                )}
                {drawings.length > 0 && (
                  <button onClick={() => { drawingsRef.current = []; setDrawings([]); setSelectedDrawing(null); }}
                    style={{ width: '100%', padding: '3px', marginTop: '3px', borderRadius: '3px', border: '1px solid #ddd', background: '#fff', color: '#f44336', cursor: 'pointer', fontSize: '9px' }}>Clear All</button>
                )}
              </div>
            )}
          </div>
          {/* Resize handle */}
          <div onMouseDown={(e) => { isResizing.current = true; resizeStartY.current = e.clientY; resizeStartPct.current = chartHeightPct.current; e.preventDefault(); }}
            style={{ height: '4px', background: '#ccc', cursor: 'ns-resize', flexShrink: 0 }} />
          {showIndicators && (
               <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 100, background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '8px', minWidth: '200px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: '#333', fontSize: '11px', fontWeight: 'bold' }}>Indicators</span>
                <button onClick={() => setShowIndicators(false)} style={{ padding: '0 4px', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '12px', background: 'transparent', color: '#888' }}>\u2715</button>
              </div>
              {AVAILABLE_INDICATORS.map(ind => {
                const isActive = activeIndicators.some(a => a.id === ind.id);
                return (
                  <div key={ind.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: ind.color }} />
                    <span style={{ color: '#555', fontSize: '11px', flex: 1 }}>{ind.label}</span>
                    <button onClick={() => {
                      if (isActive) setActiveIndicators(prev => prev.filter(a => a.id !== ind.id));
                      else setActiveIndicators(prev => [...prev, { ...ind }]);
                    }} style={{
                      padding: '1px 8px', borderRadius: '4px', border: 'none', cursor: 'pointer',
                      fontSize: '9px', background: isActive ? '#f44336' : '#4caf50', color: '#fff',
                    }}>{isActive ? '×' : '+'}</button>
                  </div>
                );
              })}
              {activeIndicators.length > 0 && (
                <div style={{ borderTop: '1px solid #e0e0e0', margin: '6px 0', paddingTop: '6px' }}>
                  <div style={{ color: '#333', fontSize: '10px', marginBottom: '4px', fontWeight: 'bold' }}>Active</div>
                  {activeIndicators.map(ind => (
                    <div key={ind.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' }}>
                      <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: ind.color }} />
                      <span style={{ color: '#555', fontSize: '11px', flex: 1 }}>{ind.label}</span>
                      <button onClick={() => setActiveIndicators(prev => prev.filter(a => a.id !== ind.id))}
                        style={{ padding: '1px 6px', borderRadius: '4px', border: 'none', cursor: 'pointer', fontSize: '9px', background: '#f44336', color: '#fff' }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', background: '#fff', minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px 14px', width: '100%', maxWidth: '340px' }}>
            {Array.from({ length: 10 }, (_, i) => {
              const isCurrent = currentDigit === i;
              const isHighlight = exitHighlight?.digit === i;
              const hlColor = exitHighlight ? (exitHighlight.win ? '#4caf50' : '#f44336') : '#ffeb3b';
              const isBarrier = String(i) === barrier;
              const win = tickHistory.slice(-DIGIT_WINDOW); const winTotal = win.length || 1; const pct = (win.filter(d => d === i).length / winTotal) * 100;
              const halfAngle = (pct / 100) * 180;
              const barColor = isHighlight ? hlColor : (pct > 12 ? '#4caf50' : pct > 9 ? '#ff9800' : '#f44336');
              return (
                <div key={i} style={{ textAlign: 'center', cursor: 'pointer', position: 'relative' }} onClick={() => setBarrier(String(i))}>
                  {/* Pyramid cursor arrow for current digit */}
                  {isCurrent && (
                    <div style={{
                      position: 'absolute', top: '-10px', left: '50%', marginLeft: '-5px',
                      width: '0', height: '0',
                      borderLeft: '5px solid transparent',
                      borderRight: '5px solid transparent',
                      borderTop: '7px solid #ffeb3b',
                      zIndex: 2,
                    }} />
                  )}
                  {/* Outer ring container */}
                  <div style={{ position: 'relative', width: '60px', height: '60px', margin: '0 auto' }}>
                    {/* Ring track */}
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#ddd' }} />
                    {/* Ring fill — conic gradient growing upward on both sides */}
                    <div style={{
                      position: 'absolute', inset: 0, borderRadius: '50%',
                      background: `conic-gradient(from ${180 - halfAngle}deg, ${barColor} 0deg, ${barColor} ${2 * halfAngle}deg, transparent ${2 * halfAngle}deg)`,
                    }} />
                    {/* Inner circle with digit */}
                    <div style={{
                      position: 'absolute', top: '7px', left: '7px',
                      width: '46px', height: '46px', borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isHighlight ? hlColor : (isCurrent ? '#ffeb3b' : (isBarrier ? '#4fc3f7' : '#e0e0e0')),
                      color: (isCurrent || isBarrier) && !isHighlight ? '#000' : '#333',
                      fontWeight: 'bold', fontSize: '20px',
                      boxShadow: isCurrent ? '0 0 8px rgba(255,235,59,0.6)' : (isBarrier ? '0 0 8px rgba(79,195,247,0.6)' : 'none'),
                    }}>
                      {i}
                    </div>
                  </div>
                  <div style={{ fontSize: '9px', color: '#999', marginTop: '2px' }}>{pct.toFixed(1)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* BOTTOM TRADING PANEL — fixed, no scroll */}
      <div style={{ background: '#fff', borderTop: '1px solid #e0e0e0', padding: '6px 10px 10px' }}>
        {/* Direction Toggle */}
        {tradeType === 'accumulator' ? (
          <div style={{ textAlign: 'center', padding: '6px', marginBottom: '6px', background: '#e8f5e9', borderRadius: '6px', border: '1px solid #c8e6c9' }}>
            <span style={{ color: '#2e7d32', fontWeight: 'bold', fontSize: '13px' }}>Accumulator</span>
            <span style={{ color: '#666', fontSize: '10px', marginLeft: '6px' }}>{growthRate * 100}% / tick</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0', marginBottom: '6px', borderRadius: '6px', overflow: 'hidden', border: '1px solid #ddd' }}>
            {currentContracts.map(ct => (
              <button key={ct} onClick={() => setContractType(ct)}
                style={{
                  flex: 1, padding: '8px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold',
                  background: contractType === ct ? '#fff' : '#f5f5f5',
                  color: contractType === ct ? '#4caf50' : '#999',
                  borderBottom: contractType === ct ? '2px solid #4caf50' : '2px solid transparent',
                }}>
                {contractLabels[ct] || ct}
              </button>
            ))}
          </div>
        )}

        {/* Trade Parameters Row */}
        {tradeType === 'accumulator' ? (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Growth Rate</div>
              <select value={growthRate} onChange={e => setGrowthRate(Number(e.target.value))}
                style={{ background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', outline: 'none', padding: '0', width: '100%' }}>
                <option value={0.01}>1%</option>
                <option value={0.02}>2%</option>
                <option value={0.03}>3%</option>
                <option value={0.04}>4%</option>
                <option value={0.05}>5%</option>
              </select>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Stake</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <span style={{ color: '#333', fontSize: '12px', fontWeight: 'bold' }}>$</span>
                <input type="number" min={0.35} step={0.35} value={stake}
                  onChange={e => setStake(e.target.value)}
                  onBlur={() => setStake(s => { const n = parseFloat(s); return (isNaN(n) || n < 0.35) ? '0.35' : s; })}
                  style={{ width: '40px', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
              </div>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Take Profit</div>
              <input type="number" min={0} value={takeProfit}
                onChange={e => setTakeProfit(e.target.value)}
                placeholder="$"
                style={{ width: '100%', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Duration</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <input type="number" min={1} value={duration}
                  onChange={e => setDuration(Math.max(1, Number(e.target.value) || 1))}
                  style={{ width: '36px', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
                <select value={durationUnit} onChange={e => setDurationUnit(e.target.value as 't' | 'm')}
                  style={{ background: 'transparent', color: '#666', border: 'none', fontSize: '10px', outline: 'none', padding: '0' }}>
                  <option value="t">ticks</option>
                  <option value="m">min</option>
                </select>
              </div>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Stake</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <span style={{ color: '#333', fontSize: '12px', fontWeight: 'bold' }}>$</span>
                <input type="number" min={0.35} step={0.35} value={stake}
                  onChange={e => setStake(e.target.value)}
                  onBlur={() => setStake(s => { const n = parseFloat(s); return (isNaN(n) || n < 0.35) ? '0.35' : s; })}
                  style={{ width: '40px', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
              </div>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Allow equals</div>
              <div onClick={() => setAllowEquals(!allowEquals)} style={{ cursor: 'pointer' }}>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: allowEquals ? '#4caf50' : '#ccc' }}>
                  {allowEquals ? 'On' : '\u2014'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Barrier (if applicable) */}
        {(tradeType === 'over_under' || tradeType === 'digits') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <span style={{ fontSize: '10px', color: '#999' }}>Barrier:</span>
            <input type="number" min={0} max={9} value={barrier}
              onChange={e => setBarrier(e.target.value.replace(/[^0-9]/g, '').slice(0, 1) || '0')}
              style={{ width: '40px', background: '#f5f5f5', color: '#333', border: '1px solid #ddd', borderRadius: '4px', padding: '3px 6px', fontSize: '12px', textAlign: 'center' }} />
          </div>
        )}

        {/* Buy / Sell Button */}
        {activeAccuContract ? (
          <button onClick={() => handleSellContract(activeAccuContract.id)}
            disabled={isTrading}
            style={{
              width: '100%', padding: '12px', borderRadius: '6px', border: 'none',
              background: '#ff9800', color: '#fff',
              cursor: isTrading ? 'not-allowed' : 'pointer',
              fontWeight: 'bold', fontSize: '15px',
            }}>
            {isTrading ? 'Selling...' : 'Sell'}
          </button>
        ) : (
          <button onClick={() => handleBuyContract(contractType)}
            disabled={isTrading || currentPrice === null}
            style={{
              width: '100%', padding: '12px', borderRadius: '6px', border: 'none',
              background: isTrading ? '#aaa' : (tradeType === 'accumulator' ? '#2e7d32' : '#4caf50'), color: '#fff',
              cursor: isTrading ? 'not-allowed' : 'pointer',
              fontWeight: 'bold', fontSize: '15px',
            }}>
            {isTrading ? 'Buying...' : (tradeType === 'accumulator' ? 'Buy Accumulator' : 'Buy')}
          </button>
        )}
        {tradeType === 'accumulator' ? (
          <div style={{ textAlign: 'center', marginTop: '4px', color: '#999', fontSize: '10px' }}>
            {activeAccuContract ? 'Active · ' : ''}{growthRate * 100}% growth · ${parseFloat(stake) || 0.35} stake
          </div>
        ) : payout && (
          <div style={{ textAlign: 'center', marginTop: '4px', color: '#999', fontSize: '11px' }}>
            Payout: ${payout}
          </div>
        )}
      </div>
      {tradeResult && (
        <div style={{
          position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)', zIndex: 9999,
          background: tradeResult.isWin ? '#1b5e20' : '#b71c1c',
          color: '#fff', padding: '10px 18px', borderRadius: '8px',
          fontSize: '13px', fontWeight: 'bold', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          whiteSpace: 'nowrap',
        }}>
          {tradeResult.isWin ? 'WIN' : 'LOSS'} · {tradeResult.contract_type} · {tradeResult.entry_digit}→{tradeResult.exit_digit} · {tradeResult.isWin ? '+' : ''}${tradeResult.profit.toFixed(2)}
        </div>
      )}
    </div>
  );
};

export default NewDTrader;
