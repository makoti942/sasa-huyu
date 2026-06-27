// ═══════════════════════════════════════════════════════════════════════════════
//  MAKOTI PREDICTION ENGINE v3
//  Multi-strategy ensemble with market state detection, dynamic weighting,
//  and contract-type-aware signal generation for Rise/Fall, Over/Under,
//  Even/Odd, and Digits. 47 strategies total (36 RF, 5 OU, 6 EO).
// ═══════════════════════════════════════════════════════════════════════════════

/* ── Exports ───────────────────────────────────────────────────────────────── */
export type ContractType = 'CALL' | 'PUT' | 'DIGITOVER' | 'DIGITUNDER' | 'DIGITEVEN' | 'DIGITODD';

export interface TradeSignal {
    contract_type: ContractType;
    barrier?: string;
    confidence: number;
    reason: string;
    details: string;
}

interface StrategyVote {
    type: ContractType;
    barrier?: string;
    score: number;
    confidence: number;
    weight: number;
    name: string;
}

interface StrategyPerf {
    wins: number;
    losses: number;
    total: number;
}

type MarketRegime = 'STRONG_BULL' | 'WEAK_BULL' | 'RANGING' | 'WEAK_BEAR' | 'STRONG_BEAR' | 'CHOPPY' | 'VOLATILE_SPIKE';

/* ── Constants ─────────────────────────────────────────────────────────────── */
const MAX_STRATEGY_HISTORY = 50;
const REGIME_LOOKBACK = 20;
const CONFIDENCE_FLOOR = 75;
const CONFIDENCE_CEILING = 98;
const MIN_TICK_FOR_ANALYSIS = 5;

/* ── Per-strategy performance tracker ────────────────────────────────────── */
const strategyPerf: Record<string, StrategyPerf> = {};

export function recordOutcome(strategyName: string, won: boolean) {
    const p = strategyPerf[strategyName] || { wins: 0, losses: 0, total: 0 };
    if (won) p.wins++; else p.losses++;
    p.total++;
    if (p.total > MAX_STRATEGY_HISTORY) {
        if (won) p.wins--; else p.losses--;
        p.total--;
    }
    strategyPerf[strategyName] = p;
}

function getStrategyWeight(name: string): number {
    const p = strategyPerf[name];
    if (!p || p.total < 5) return 1.0;
    const rate = p.wins / p.total;
    return Math.max(0.3, Math.min(3.0, rate * 4));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UTILITY INDICATORS
═══════════════════════════════════════════════════════════════════════════════ */

function ema(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = [result];
    for (let i = period; i < values.length; i++) {
        result = values[i] * k + result * (1 - k);
        out.push(result);
    }
    return out;
}

function sma(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const out: number[] = [];
    for (let i = period - 1; i < values.length; i++) {
        out.push(values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    }
    return out;
}

function rsi(prices: number[], period = 7): number {
    if (prices.length < period + 1) return 50;
    const slice = prices.slice(-(period * 4 + 1));
    const changes = slice.slice(1).map((p, i) => p - slice[i]);
    const gains = changes.map(c => Math.max(0, c));
    const losses = changes.map(c => Math.max(0, -c));
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function bbPosition(prices: number[], period = 14, std = 2): number {
    if (prices.length < period) return 0.5;
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const s = Math.sqrt(variance);
    if (s === 0) return 0.5;
    return (prices[prices.length - 1] - (mean - std * s)) / (2 * std * s);
}

function macd(prices: number[]): { macd: number; signal: number; hist: number; prevHist: number } {
    if (prices.length < 28) return { macd: 0, signal: 0, hist: 0, prevHist: 0 };
    const e12 = ema(prices, 12);
    const e26 = ema(prices, 26);
    const offset = e12.length - e26.length;
    const macdLine: number[] = e26.map((v, i) => e12[i + offset] - v);
    if (macdLine.length < 9) return { macd: macdLine.at(-1) ?? 0, signal: 0, hist: 0, prevHist: 0 };
    const sig = ema(macdLine, 9);
    return {
        macd: macdLine.at(-1)!,
        signal: sig.at(-1)!,
        hist: macdLine.at(-1)! - sig.at(-1)!,
        prevHist: macdLine.at(-2)! - sig.at(-2)!,
    };
}

function stoch(prices: number[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
    if (prices.length < kPeriod) return { k: 50, d: 50 };
    const slice = prices.slice(-kPeriod);
    const low = Math.min(...slice);
    const high = Math.max(...slice);
    if (high === low) return { k: 50, d: 50 };
    const rawK = ((prices[prices.length - 1] - low) / (high - low)) * 100;
    const k = Math.max(0, Math.min(100, rawK));
    const d = k; // simplified: use k as d for single-point
    return { k, d };
}

function atr(prices: number[], period = 7): number {
    if (prices.length < period + 1) return 0;
    const slice = prices.slice(-(period + 1));
    const ranges: number[] = [];
    for (let i = 1; i < slice.length; i++) {
        ranges.push(Math.abs(slice[i] - slice[i - 1]));
    }
    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

function hullMA(prices: number[], period = 9): number | null {
    if (prices.length < period) return null;
    const half = Math.floor(period / 2);
    const sqrtPeriod = Math.floor(Math.sqrt(period));
    if (prices.length < half + sqrtPeriod) return null;
    const wmaHalf = wma(prices.slice(-half - sqrtPeriod), half);
    const wmaFull = wma(prices.slice(-period - sqrtPeriod), period);
    if (wmaHalf === null || wmaFull === null) return null;
    const rawHull = wmaHalf * 2 - wmaFull;
    return rawHull;
}

function wma(values: number[], period: number): number | null {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    const weight = period * (period + 1) / 2;
    return slice.reduce((sum, v, i) => sum + v * (i + 1), 0) / weight;
}

function zlema(values: number[], period = 9): number | null {
    if (values.length < period * 2) return null;
    const lag = Math.floor((period - 1) / 2);
    const zl = values.map((v, i) => {
        if (i < lag) return v;
        return v + (v - values[i - lag]);
    });
    const zlEma = ema(zl.slice(-period * 3), period);
    return zlEma.length > 0 ? zlEma.at(-1)! : null;
}

function roc(values: number[], period = 3): number {
    if (values.length <= period) return 0;
    const prev = values[values.length - 1 - period];
    if (prev === 0) return 0;
    return ((values[values.length - 1] - prev) / prev) * 100;
}

function cci(prices: number[], period = 14): number {
    if (prices.length < period) return 0;
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const mad = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    if (mad === 0) return 0;
    return (prices[prices.length - 1] - mean) / (0.015 * mad);
}

function keltner(prices: number[], period = 14, mult = 1.5): { upper: number; lower: number; mid: number } {
    if (prices.length < period) return { upper: 0, lower: 0, mid: 0 };
    const slice = prices.slice(-period);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    const tr = atr(prices, period);
    return { upper: mid + tr * mult, lower: mid - tr * mult, mid };
}

function priceStreak(prices: number[]): number {
    if (prices.length < 2) return 0;
    const dir = prices.at(-1)! > prices.at(-2)! ? 1 : -1;
    let n = 1;
    for (let i = prices.length - 2; i > 0; i--) {
        if ((prices[i] > prices[i - 1] ? 1 : -1) === dir) n++;
        else break;
    }
    return dir * n;
}

function digitPcts(ticks: number[], window: number): number[] {
    const arr = ticks.slice(-window);
    const total = arr.length || 1;
    const c = Array(10).fill(0);
    arr.forEach(d => { if (d >= 0 && d <= 9) c[d]++; });
    return c.map(v => (v / total) * 100);
}

// ── WMA returning array (for crossover) ──────────────────────────────────
function wmaArr(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const out: number[] = [];
    const weight = period * (period + 1) / 2;
    for (let i = period - 1; i < values.length; i++) {
        const slice = values.slice(i - period + 1, i + 1);
        out.push(slice.reduce((s, v, j) => s + v * (j + 1), 0) / weight);
    }
    return out;
}

// ── HMA returning array (for slope) ──────────────────────────────────────
function hmaArr(values: number[], period: number): number[] {
    const half = Math.floor(period / 2);
    const sqrtP = Math.floor(Math.sqrt(period));
    if (values.length < period + half + sqrtP) return [];
    const wmaH = wmaArr(values, half);
    const wmaF = wmaArr(values, period);
    if (wmaH.length < sqrtP || wmaF.length < sqrtP) return [];
    const raw: number[] = [];
    const offset = wmaF.length - wmaH.length;
    for (let i = 0; i < wmaF.length; i++) {
        raw.push(2 * wmaH[i + offset] - wmaF[i]);
    }
    return raw.length >= sqrtP ? wmaArr(raw, sqrtP) : [];
}

// ── Donchian Channel ─────────────────────────────────────────────────────
function donchian(prices: number[], period = 20): { upper: number; lower: number; mid: number } {
    if (prices.length < period) return { upper: 0, lower: 0, mid: 0 };
    const slice = prices.slice(-period);
    return { upper: Math.max(...slice), lower: Math.min(...slice), mid: (Math.max(...slice) + Math.min(...slice)) / 2 };
}

// ── Linear Regression Slope ──────────────────────────────────────────────
function linregSlope(values: number[], period = 14): number {
    if (values.length < period) return 0;
    const slice = values.slice(-period);
    const n = slice.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i; sumY += slice[i]; sumXY += i * slice[i]; sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
}

// ── ALMA ─────────────────────────────────────────────────────────────────
function alma(values: number[], period = 9, offset = 0.85, sigma = 6): number {
    if (values.length < period) return values[values.length - 1] || 0;
    const slice = values.slice(-period);
    const m = Math.floor(offset * (period - 1));
    const s = period / sigma;
    let sum = 0, weightSum = 0;
    for (let i = 0; i < period; i++) {
        const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
        sum += slice[i] * w;
        weightSum += w;
    }
    return weightSum > 0 ? sum / weightSum : slice[period - 1];
}

// ── Williams %R ──────────────────────────────────────────────────────────
function williamsR(prices: number[], period = 14): number {
    if (prices.length < period) return -50;
    const slice = prices.slice(-period);
    const high = Math.max(...slice), low = Math.min(...slice);
    if (high === low) return -50;
    return ((high - prices[prices.length - 1]) / (high - low)) * -100;
}

// ── Awesome Oscillator ───────────────────────────────────────────────────
function awesomeOsc(prices: number[]): { ao: number; prevAo: number } {
    if (prices.length < 35) return { ao: 0, prevAo: 0 };
    const mid5 = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const mid34 = prices.slice(-34).reduce((a, b) => a + b, 0) / 34;
    const prevMid5 = prices.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
    const prevMid34 = prices.slice(-35, -1).reduce((a, b) => a + b, 0) / 34;
    return { ao: mid5 - mid34, prevAo: prevMid5 - prevMid34 };
}

// ── Chande Momentum Oscillator ───────────────────────────────────────────
function cmo(values: number[], period = 9): number {
    if (values.length < period + 1) return 0;
    const slice = values.slice(-(period + 1));
    let sumUp = 0, sumDown = 0;
    for (let i = 1; i < slice.length; i++) {
        const diff = slice[i] - slice[i - 1];
        if (diff > 0) sumUp += diff; else sumDown += Math.abs(diff);
    }
    const total = sumUp + sumDown;
    return total === 0 ? 0 : ((sumUp - sumDown) / total) * 100;
}

// ── Ultimate Oscillator ──────────────────────────────────────────────────
function ultimateOsc(prices: number[]): number {
    if (prices.length < 29) return 50;
    const bp = (i: number) => prices[i] - Math.min(prices[i], prices[Math.max(0, i - 1)]);
    const tr = (i: number) => Math.max(prices[i], prices[Math.max(0, i - 1)]) - Math.min(prices[i], prices[Math.max(0, i - 1)]);
    const sum = (n: number, len: number) => { let s = 0, t = 0; for (let j = 0; j < len; j++) { s += bp(n - j); t += tr(n - j); } return t === 0 ? 0 : s / t; };
    const i = prices.length - 1;
    const a = sum(i, 7), b = sum(i, 14), c = sum(i, 28);
    return 100 * (4 * a + 2 * b + c) / 7;
}

// ── Detrended Price Oscillator ───────────────────────────────────────────
function dpo(prices: number[], period = 14): number {
    if (prices.length < period * 2) return 0;
    const shift = Math.floor(period / 2) + 1;
    const idx = prices.length - 1 - shift;
    const smaSlice = prices.slice(idx - period + 1, idx + 1);
    if (smaSlice.length < period) return 0;
    const sma = smaSlice.reduce((a, b) => a + b, 0) / period;
    return prices[idx] - sma;
}

// ── Fisher Transform ─────────────────────────────────────────────────────
function fisherTransform(prices: number[], period = 9): { fisher: number; signal: number } {
    if (prices.length < period * 2) return { fisher: 0, signal: 0 };
    const slice = prices.slice(-period);
    const high = Math.max(...slice), low = Math.min(...slice);
    if (high === low) return { fisher: 0, signal: 0 };
    const mid = (prices[prices.length - 1] - low) / (high - low);
    const clamped = Math.max(-0.999, Math.min(0.999, 2 * mid - 1));
    const fisher = 0.5 * Math.log((1 + clamped) / (1 - clamped));
    // Return both fisher and a smoothed signal using EMA(1)
    const prevMid = (prices[prices.length - 2] - low) / (high - low);
    const prevClamped = Math.max(-0.999, Math.min(0.999, 2 * prevMid - 1));
    const prevFisher = 0.5 * Math.log((1 + prevClamped) / (1 - prevClamped));
    const signal = prevFisher;
    return { fisher, signal };
}

// ── True Strength Index ──────────────────────────────────────────────────
function tsi(values: number[], long = 25, short = 13, signal = 7): { tsi: number; signal: number } {
    if (values.length < long + short + 5) return { tsi: 0, signal: 0 };
    const diffs: number[] = [];
    for (let i = 1; i < values.length; i++) diffs.push(values[i] - values[i - 1]);
    const absDiffs = diffs.map(Math.abs);
    const e1 = ema(diffs, long); if (e1.length === 0) return { tsi: 0, signal: 0 };
    const ae1 = ema(absDiffs, long); if (ae1.length === 0) return { tsi: 0, signal: 0 };
    const e2 = ema(e1, short); if (e2.length === 0) return { tsi: 0, signal: 0 };
    const ae2 = ema(ae1, short); if (ae2.length === 0) return { tsi: 0, signal: 0 };
    const tsiVal = ae2[ae2.length - 1] !== 0 ? (e2[e2.length - 1] / ae2[ae2.length - 1]) * 100 : 0;
    const tsiArr: number[] = [tsiVal];
    const sigEma = ema(tsiArr, signal);
    return { tsi: tsiVal, signal: sigEma.length > 0 ? sigEma[0] : 0 };
}

// ── Percentage Price Oscillator ──────────────────────────────────────────
function ppo(prices: number[], fast = 12, slow = 26, sig = 9): { ppo: number; signal: number; hist: number } {
    const eFast = ema(prices, fast), eSlow = ema(prices, slow);
    if (eFast.length === 0 || eSlow.length === 0) return { ppo: 0, signal: 0, hist: 0 };
    const offset = eFast.length - eSlow.length;
    const ppoLine: number[] = eSlow.map((v, i) => eSlow[i] !== 0 ? ((eFast[i + offset] - v) / v) * 100 : 0);
    if (ppoLine.length < sig) return { ppo: ppoLine[ppoLine.length - 1] || 0, signal: 0, hist: 0 };
    const sigLine = ema(ppoLine, sig);
    return { ppo: ppoLine[ppoLine.length - 1] || 0, signal: sigLine[sigLine.length - 1] || 0, hist: (ppoLine[ppoLine.length - 1] || 0) - (sigLine[sigLine.length - 1] || 0) };
}

// ── Heikin-Ashi ──────────────────────────────────────────────────────────
function heikinAshi(prices: number[]): { haOpen: number; haClose: number; haHigh: number; haLow: number; color: 'GREEN' | 'RED'; prevColor: 'GREEN' | 'RED' } {
    if (prices.length < 2) return { haOpen: 0, haClose: 0, haHigh: 0, haLow: 0, color: 'GREEN', prevColor: 'GREEN' };
    const haClose = (prices[prices.length - 1] + prices[prices.length - 2]) / 2;
    const haOpen = prices.length > 2 ? (prices[prices.length - 3] + prices[prices.length - 3]) / 2 : prices[prices.length - 2];
    const haHigh = Math.max(prices[prices.length - 1], haOpen, haClose);
    const haLow = Math.min(prices[prices.length - 1], haOpen, haClose);
    const prevClose = prices.length > 2 ? (prices[prices.length - 2] + prices[prices.length - 3]) / 2 : prices[prices.length - 2];
    const prevOpen = prices.length > 3 ? (prices[prices.length - 4] + prices[prices.length - 4]) / 2 : prices[prices.length - 3] || prices[prices.length - 2];
    return { haOpen, haClose, haHigh, haLow, color: haClose >= haOpen ? 'GREEN' : 'RED', prevColor: prevClose >= prevOpen ? 'GREEN' : 'RED' };
}

// ── Elder Ray Index ─────────────────────────────────────────────────────
function elderRay(prices: number[], period = 13): { ema: number; bullPower: number; bearPower: number; emaSlope: number } {
    const e = ema(prices, period);
    if (e.length < 2) return { ema: 0, bullPower: 0, bearPower: 0, emaSlope: 0 };
    const emaVal = e[e.length - 1];
    const price = prices[prices.length - 1];
    return { ema: emaVal, bullPower: price - emaVal, bearPower: prices[prices.length - 1] - emaVal, emaSlope: e[e.length - 1] - e[e.length - 2] };
}

// ── Choppiness Index ─────────────────────────────────────────────────────
function chopIndex(prices: number[], period = 14): number {
    if (prices.length < period + 1) return 50;
    const slice = prices.slice(-(period + 1));
    let sumRange = 0;
    const high = Math.max(...slice), low = Math.min(...slice);
    for (let i = 1; i < slice.length; i++) sumRange += Math.abs(slice[i] - slice[i - 1]);
    const range = high - low;
    if (sumRange === 0 || range === 0) return 50;
    return 100 * Math.log10(sumRange / range) / Math.log10(period);
}

// ── Coppock Curve ───────────────────────────────────────────────────────
function coppock(prices: number[]): number {
    if (prices.length < 30) return 0;
    const roc14 = roc(prices, 14);
    const roc11 = roc(prices, 11);
    const sum = roc14 + roc11;
    // WMA(10) of the sum — simplified using single value
    const recent10 = prices.slice(-20);
    if (recent10.length < 10) return sum;
    const wmas = wmaArr(recent10, 10);
    return wmas.length > 0 ? wmas[wmas.length - 1] : sum;
}

// ── Vortex Indicator ────────────────────────────────────────────────────
function vortex(prices: number[], period = 14): { plusVI: number; minusVI: number } {
    if (prices.length < period + 1) return { plusVI: 0, minusVI: 0 };
    let vmPlus = 0, vmMinus = 0, tr = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        const high = Math.max(prices[i], prices[i - 1]);
        const low = Math.min(prices[i], prices[i - 1]);
        vmPlus += Math.abs(high - prices[i - 1]);
        vmMinus += Math.abs(low - prices[i - 1]);
        tr += Math.abs(prices[i] - prices[i - 1]);
    }
    return { plusVI: tr !== 0 ? vmPlus / tr : 0, minusVI: tr !== 0 ? vmMinus / tr : 0 };
}

// ── Center of Gravity ────────────────────────────────────────────────────
function cog(prices: number[], period = 10): number {
    if (prices.length < period) return 0;
    const slice = prices.slice(-period);
    let num = 0, den = 0;
    for (let i = 0; i < period; i++) { num += (i + 1) * slice[i]; den += slice[i]; }
    const cogVal = den !== 0 ? -num / den + (period + 1) / 2 : 0;
    // Return negative for cross-detection convention
    return -cogVal;
}

function cogSignal(prices: number[], period = 10): number {
    return cog(prices, period);
}

// ── Schaff Trend Cycle ──────────────────────────────────────────────────
function stc(prices: number[], fast = 23, slow = 50, cycle = 10): number {
    const eFast = ema(prices, fast), eSlow = ema(prices, slow);
    if (eFast.length === 0 || eSlow.length === 0) return 50;
    const offset = eFast.length - eSlow.length;
    const macdArr: number[] = eSlow.map((v, i) => eFast[i + offset] - v);
    if (macdArr.length < 2) return 50;
    const mn = Math.min(...macdArr), mx = Math.max(...macdArr);
    if (mx === mn) return 50;
    let k = ((macdArr[macdArr.length - 1] - mn) / (mx - mn)) * 100;
    k = Math.max(0, Math.min(100, k));
    // Simplified: single stochastic of MACD
    return k;
}

// ── Connors RSI ─────────────────────────────────────────────────────────
function connorsRSI(prices: number[], period = 3): number {
    const rsiVal = rsi(prices, 3);
    const streak = priceStreak(prices);
    const streakRSI = 100 - (50 / (1 + Math.abs(streak)));
    const rocVal = roc(prices, 2);
    const rocNorm = Math.max(0, Math.min(100, (rocVal + 100) / 2));
    return (rsiVal + streakRSI + rocNorm) / 3;
}

// ── Klinger Oscillator (simplified — uses price magnitude as volume proxy) ─
function klingerOsc(prices: number[], fast = 34, slow = 55): { klinger: number; signal: number } {
    if (prices.length < slow + 2) return { klinger: 0, signal: 0 };
    let vf = 0;
    for (let i = prices.length - slow; i < prices.length; i++) {
        const trend = prices[i] > prices[i - 1] ? 1 : -1;
        const vol = Math.abs(prices[i] - prices[i - 1]) * 1000; // price magnitude as volume proxy
        vf += trend * vol;
    }
    const klinger = vf;
    // Simplified signal from Klinger
    return { klinger, signal: 0 };
}

// ── Supertrend ──────────────────────────────────────────────────────────
function supertrendCalc(prices: number[], period = 10, mult = 3): { trend: 'UP' | 'DOWN'; value: number; flipped: boolean; prevTrend: 'UP' | 'DOWN' } {
    if (prices.length < period + 1) return { trend: 'UP', value: 0, flipped: false, prevTrend: 'UP' };
    const atrVal = atr(prices, period);
    const hl2 = (prices[prices.length - 1] + prices[prices.length - 2]) / 2;
    const upper = hl2 + mult * atrVal;
    const lower = hl2 - mult * atrVal;
    const prevUpper = (prices[prices.length - 2] + prices[prices.length - 3]) / 2 + mult * atr(prices.slice(0, -1), period);
    const prevLower = (prices[prices.length - 2] + prices[prices.length - 3]) / 2 - mult * atr(prices.slice(0, -1), period);
    const prevTrend = prices[prices.length - 2] > prevUpper ? 'DOWN' : prices[prices.length - 2] < prevLower ? 'UP' : 'UP';
    const trend = prices[prices.length - 1] > upper ? 'DOWN' : prices[prices.length - 1] < lower ? 'UP' : prevTrend;
    return { trend, value: trend === 'UP' ? lower : upper, flipped: trend !== prevTrend, prevTrend };
}

// ── Parabolic SAR ───────────────────────────────────────────────────────
function parabolicSar(prices: number[], step = 0.02, maxStep = 0.2): { sar: number; above: boolean; flipped: boolean } {
    if (prices.length < 3) return { sar: 0, above: false, flipped: false };
    const trend = prices[prices.length - 1] > prices[prices.length - 2] ? 'UP' : 'DOWN';
    const prevTrend = prices[prices.length - 2] > prices[prices.length - 3] ? 'UP' : 'DOWN';
    let sar = trend === 'UP' ? Math.min(...prices.slice(-5)) : Math.max(...prices.slice(-5));
    const above = trend === 'DOWN';
    const flipped = trend !== prevTrend;
    return { sar, above, flipped };
}

// ── Ichimoku Kijun-sen ─────────────────────────────────────────────────
function kijunSen(prices: number[], period = 26): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const slice = prices.slice(-period);
    return (Math.max(...slice) + Math.min(...slice)) / 2;
}

// ── Standard Deviation Channel ──────────────────────────────────────────
function stdChannel(prices: number[], period = 20, mult = 2): { upper: number; lower: number; mean: number } {
    if (prices.length < period) return { upper: 0, lower: 0, mean: 0 };
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return { upper: mean + mult * std, lower: mean - mult * std, mean };
}

function trix(prices: number[], period = 4): { trix: number; signal: number; prevTrix: number } {
    const n = prices.length;
    if (n < period * 3 + 2) return { trix: 0, signal: 0, prevTrix: 0 };
    const ema1 = ema(prices, period);
    const ema2 = ema(ema1.slice(-(period * 3 + 2)), period);
    const ema3 = ema(ema2.slice(-(period * 2 + 2)), period);
    const vals = ema3.slice(-3);
    const t = vals.length >= 3 ? ((vals[2] - vals[1]) / vals[1]) * 100 : 0;
    const p = vals.length >= 3 ? ((vals[1] - vals[0]) / vals[0]) * 100 : 0;
    const signalEma = ema([p, t], period);
    return { trix: t, signal: signalEma.length > 0 ? signalEma[signalEma.length - 1] : 0, prevTrix: p };
}

function massIndex(prices: number[], period = 9): number {
    if (prices.length < period + 2) return 0;
    const ranges: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        ranges.push(prices[i] - prices[i - 1]);
    }
    const absRanges = ranges.map(Math.abs);
    const emaRange = ema(absRanges, 9);
    const ratio: number[] = [];
    for (let i = 0; i < ranges.length; i++) {
        const denom = emaRange[i] || 0.001;
        ratio.push(Math.abs(ranges[i]) / denom);
    }
    if (ratio.length < period + 9) return 0;
    const sum = ratio.slice(-period).reduce((a, b) => a + b, 0);
    return sum;
}

function chaikinOsc(prices: number[], fast = 3, slow = 10): number {
    if (prices.length < slow + 2) return 0;
    let adl = 0;
    const adls: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        const hl = Math.max(prices[i], prices[i - 1]) - Math.min(prices[i], prices[i - 1]) || 0.001;
        const clv = ((prices[i] - Math.min(prices[i], prices[i - 1])) - (Math.max(prices[i], prices[i - 1]) - prices[i])) / hl;
        adl += clv;
        adls.push(adl);
    }
    const fastEma = ema(adls, fast);
    const slowEma = ema(adls, slow);
    const v = fastEma.length > 0 && slowEma.length > 0 ? fastEma[fastEma.length - 1] - slowEma[slowEma.length - 1] : 0;
    const p = fastEma.length > 1 && slowEma.length > 1 ? fastEma[fastEma.length - 2] - slowEma[slowEma.length - 2] : 0;
    return v >= 0 && p < 0 ? 1 : v < 0 && p >= 0 ? -1 : (v > p ? 0.5 : v < p ? -0.5 : 0);
}

function envelope(prices: number[], period = 5, percent = 0.1): { upper: number; lower: number; mid: number } {
    if (prices.length < period) return { upper: 0, lower: 0, mid: 0 };
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    return { upper: mean * (1 + percent / 100), lower: mean * (1 - percent / 100), mid: mean };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MARKET STATE DETECTION
═══════════════════════════════════════════════════════════════════════════════ */

function detectRegime(prices: number[]): MarketRegime {
    if (prices.length < REGIME_LOOKBACK) return 'RANGING';

    const recent = prices.slice(-REGIME_LOOKBACK);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const pctChange = first !== 0 ? ((last - first) / first) * 100 : 0;

    const dirs: number[] = [];
    for (let i = 1; i < recent.length; i++) {
        const d = recent[i] - recent[i - 1];
        dirs.push(d > 0 ? 1 : d < 0 ? -1 : 0);
    }
    let dirChanges = 0;
    for (let i = 1; i < dirs.length; i++) {
        if (dirs[i] !== dirs[i - 1]) dirChanges++;
    }
    const chopRatio = dirChanges / dirs.length;

    const rsiVal = rsi(prices, 7);
    const atrVal = atr(prices, 7);
    const avgPrice = recent.reduce((a, b) => a + b, 0) / recent.length;
    const volRatio = avgPrice > 0 ? atrVal / avgPrice * 100 : 0;

    // Strong trend
    if (Math.abs(pctChange) > 0.3 && chopRatio < 0.35) {
        return pctChange > 0 ? 'STRONG_BULL' : 'STRONG_BEAR';
    }

    // Weak trend
    if (Math.abs(pctChange) > 0.1 && chopRatio < 0.45) {
        return pctChange > 0 ? 'WEAK_BULL' : 'WEAK_BEAR';
    }

    // Volatile spike
    if (volRatio > 0.3) return 'VOLATILE_SPIKE';

    // Choppy
    if (chopRatio > 0.55 || (rsiVal > 40 && rsiVal < 60 && chopRatio > 0.5)) return 'CHOPPY';

    return 'RANGING';
}

/* ═══════════════════════════════════════════════════════════════════════════════
   RISE/FALL STRATEGIES (CALL / PUT)
═══════════════════════════════════════════════════════════════════════════════ */

interface StrategyModule {
    name: string;
    run: (prices: number[], ticks: number[], regime: MarketRegime) => StrategyVote | null;
}

// ── 1. Micro-timing momentum ────────────────────────────────────────────────
const microTiming: StrategyModule = {
    name: 'MicroTiming',
    run(prices) {
        if (prices.length < 5) return null;
        const d1 = prices[prices.length - 1] - prices[prices.length - 2];
        if (d1 === 0) return null;

        // Streak
        const streakDir = d1 > 0 ? 1 : -1;
        let streakLen = 0;
        for (let i = prices.length - 1; i > 0; i--) {
            const d = prices[i] - prices[i - 1];
            if (d === 0) continue;
            if ((d > 0 ? 1 : -1) === streakDir) streakLen++;
            else break;
        }
        const streak = streakLen * streakDir;

        // RSI(3)
        const rsi3 = rsi(prices, 3);

        // Direction changes (last 5)
        const last5Dirs: number[] = [];
        for (let i = Math.max(0, prices.length - 5); i < prices.length - 1; i++) {
            const d = prices[i + 1] - prices[i];
            last5Dirs.push(d > 0 ? 1 : d < 0 ? -1 : 0);
        }
        let dirChanges = 0;
        for (let i = 1; i < last5Dirs.length; i++) {
            if (last5Dirs[i] !== last5Dirs[i - 1]) dirChanges++;
        }

        // Volatility
        const last5 = prices.slice(-5);
        const range5 = Math.max(...last5) - Math.min(...last5);
        const avg5 = last5.reduce((a, b) => a + b, 0) / last5.length;
        const volPct = avg5 > 0 ? (range5 / avg5) * 100 : 0;

        let score = 0;
        if (d1 > 0) score += 1; else score -= 1;

        const d2 = prices[prices.length - 2] - prices[prices.length - 3];
        const d3 = prices[prices.length - 3] - prices[prices.length - 4];

        if (d1 > 0 && d2 > 0) score += 1;
        if (d1 < 0 && d2 < 0) score -= 1;
        if (d1 > 0 && d2 > 0 && d3 > 0) score += 1;
        if (d1 < 0 && d2 < 0 && d3 < 0) score -= 1;

        if (streak >= 6) score -= 2;
        else if (streak >= 4) score -= 1;
        if (streak <= -6) score += 2;
        else if (streak <= -4) score += 1;

        if (rsi3 < 10) score += 2;
        else if (rsi3 < 20) score += 1;
        if (rsi3 > 90) score -= 2;
        else if (rsi3 > 80) score -= 1;

        if (dirChanges >= 3) {
            if (score > 0) score = Math.max(0, score - 2);
            else if (score < 0) score = Math.min(0, score + 2);
        }
        if (dirChanges >= 4) return null;

        const absScore = Math.abs(score);
        if (absScore < 2) return null;
        const volBonus = volPct > 0.05 ? 3 : 0;
        const conf = Math.min(CONFIDENCE_CEILING, 65 + absScore * 6 + volBonus);

        return {
            type: score > 0 ? 'CALL' : 'PUT',
            score: absScore,
            confidence: conf,
            weight: getStrategyWeight(this.name),
            name: this.name,
        };
    },
};

// ── 2. RSI + divergence detection ───────────────────────────────────────────
const rsiDivergence: StrategyModule = {
    name: 'RSIDivergence',
    run(prices) {
        if (prices.length < 30) return null;
        const rsi7 = rsi(prices, 7);
        const rsi14 = rsi(prices, 14);

        // Oversold bounce / Overbought reversal
        if (rsi7 < 25 && rsi14 < 30) {
            return { type: 'CALL', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (rsi7 > 75 && rsi14 > 70) {
            return { type: 'PUT', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Hidden divergence: price higher low, RSI lower low → bearish
        const p10 = prices.slice(-10);
        const pMin = Math.min(...p10);
        const pMinIdx = p10.indexOf(pMin);
        const r10 = p10.map((_, i) => {
            const s = prices.slice(-30 + i);
            return s.length >= 7 ? rsi(s, 7) : 50;
        });
        const rMin = Math.min(...r10);

        if (pMinIdx > 0 && pMinIdx < r10.length && r10[pMinIdx] !== rMin) {
            // Check if price made higher low but RSI made lower low (bearish)
            if (prices[prices.length - 1] > pMin && rsi7 < rMin) {
                return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
            }
            // Check if price made lower low but RSI made higher low (bullish)
            if (prices[prices.length - 1] < pMin && rsi7 > rMin) {
                return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 3. MACD signal cross + histogram divergence ─────────────────────────────
const macdStrategy: StrategyModule = {
    name: 'MACD',
    run(prices) {
        if (prices.length < 30) return null;
        const m = macd(prices);

        // Histogram momentum (turning)
        if (m.hist > 0 && m.prevHist < 0) {
            return { type: 'CALL', score: 3, confidence: 75, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (m.hist < 0 && m.prevHist > 0) {
            return { type: 'PUT', score: 3, confidence: 75, weight: getStrategyWeight(this.name), name: this.name };
        }

        // MACD line vs signal cross
        if (m.macd > m.signal && m.prevHist > m.hist) {
            return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (m.macd < m.signal && m.prevHist < m.hist) {
            return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Histogram strength
        if (m.hist > 0 && m.hist > Math.abs(m.prevHist) * 1.5) {
            return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (m.hist < 0 && Math.abs(m.hist) > Math.abs(m.prevHist) * 1.5) {
            return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 4. Bollinger Band squeeze + position ────────────────────────────────────
const bbStrategy: StrategyModule = {
    name: 'BBands',
    run(prices) {
        if (prices.length < 14) return null;
        const pos = bbPosition(prices, 14, 2);

        // Extreme touches
        if (pos < 0.05) {
            return { type: 'CALL', score: 3, confidence: 73, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (pos > 0.95) {
            return { type: 'PUT', score: 3, confidence: 73, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Near bands (reversal zone)
        if (pos < 0.15) {
            return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (pos > 0.85) {
            return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 5. Stochastic overbought/oversold ───────────────────────────────────────
const stochasticStrategy: StrategyModule = {
    name: 'Stochastic',
    run(prices) {
        if (prices.length < 14) return null;
        const { k } = stoch(prices, 14, 3);

        if (k < 15) {
            return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (k > 85) {
            return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (k < 25) {
            return { type: 'CALL', score: 1, confidence: 60, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (k > 75) {
            return { type: 'PUT', score: 1, confidence: 60, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 6. ATR channel breakout ─────────────────────────────────────────────────
const atrBreakout: StrategyModule = {
    name: 'ATR_Breakout',
    run(prices) {
        if (prices.length < 14) return null;
        const tr = atr(prices, 7);
        const recent = prices.slice(-7);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];

        // Breakout above ATR channel
        if (last > avg + tr * 1.5 && prev <= avg + tr * 1.5) {
            const conf = Math.min(78, 65 + (tr / avg) * 200);
            return { type: 'CALL', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Breakout below ATR channel
        if (last < avg - tr * 1.5 && prev >= avg - tr * 1.5) {
            const conf = Math.min(78, 65 + (tr / avg) * 200);
            return { type: 'PUT', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 7. Price action patterns ────────────────────────────────────────────────
const priceAction: StrategyModule = {
    name: 'PriceAction',
    run(prices) {
        if (prices.length < 10) return null;

        const last = prices[prices.length - 1];
        const p1 = prices[prices.length - 2];
        const p2 = prices[prices.length - 3];
        const p3 = prices[prices.length - 4];
        const p4 = prices[prices.length - 5];

        // Bullish engulfing (on tick data: current tick higher than prev, prev was lower than its prev)
        if (last > p1 && p1 < p2 && last > p2) {
            return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Bearish engulfing
        if (last < p1 && p1 > p2 && last < p2) {
            return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Three white soldiers (3 consecutive higher ticks)
        if (last > p1 && p1 > p2 && p2 > p3) {
            return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Three black crows
        if (last < p1 && p1 < p2 && p2 < p3) {
            return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Hammer pattern (long lower shadow proxy: tick bounced up from lower)
        const low3 = Math.min(last, p1, p2);
        const high3 = Math.max(last, p1, p2);
        if (last > p1 && p1 < p2 && (high3 - low3) > 0 && (p1 - low3) / (high3 - low3) > 0.6) {
            return { type: 'CALL', score: 2, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Shooting star
        if (last < p1 && p1 > p2 && (high3 - low3) > 0 && (high3 - p1) / (high3 - low3) > 0.6) {
            return { type: 'PUT', score: 2, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 8. Multi-MA (SMA/EMA/Hull) cross ────────────────────────────────────────
const maCross: StrategyModule = {
    name: 'MA_Cross',
    run(prices) {
        if (prices.length < 30) return null;
        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];

        const sma7 = sma(prices, 7);
        const sma21 = sma(prices, 21);
        if (sma7.length < 1 || sma21.length < 1) return null;
        const s7 = sma7.at(-1)!;
        const s21 = sma21.at(-1)!;
        const s7_1 = sma7.at(-2)!;
        const s21_1 = sma21.at(-2)!;

        // Bullish cross (7 above 21)
        if (s7 > s21 && s7_1 <= s21_1) {
            return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Bearish cross
        if (s7 < s21 && s7_1 >= s21_1) {
            return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Price vs MA
        if (last > s7 && prev <= s7) {
            return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last < s7 && prev >= s7) {
            return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Hull MA
        const hma = hullMA(prices, 9);
        if (hma !== null) {
            if (last > hma && prev <= hma) {
                return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
            }
            if (last < hma && prev >= hma) {
                return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 9. Mean reversion ───────────────────────────────────────────────────────
const meanReversion: StrategyModule = {
    name: 'MeanReversion',
    run(prices) {
        if (prices.length < 20) return null;
        const last = prices[prices.length - 1];
        const ema20 = ema(prices, 20);
        if (ema20.length < 1) return null;
        const e20 = ema20.at(-1)!;
        const deviation = e20 > 0 ? Math.abs(last - e20) / e20 * 100 : 0;

        if (deviation > 0.5) {
            if (last > e20) {
                return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        return null;
    },
};

// ── 10. CCI overbought/oversold ─────────────────────────────────────────────
const cciStrategy: StrategyModule = {
    name: 'CCI',
    run(prices) {
        if (prices.length < 14) return null;
        const cciVal = cci(prices, 14);

        if (cciVal < -150) {
            return { type: 'CALL', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (cciVal > 150) {
            return { type: 'PUT', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (cciVal < -100) {
            return { type: 'CALL', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (cciVal > 100) {
            return { type: 'PUT', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 11. Zero-lag EMA cross ──────────────────────────────────────────────────
const zlemaStrategy: StrategyModule = {
    name: 'ZLEMA',
    run(prices) {
        if (prices.length < 30) return null;
        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];
        const zl = zlema(prices, 9);
        if (zl === null) return null;

        if (last > zl && prev <= zl) {
            return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last < zl && prev >= zl) {
            return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 12. Keltner channel breakout ────────────────────────────────────────────
const keltnerStrategy: StrategyModule = {
    name: 'Keltner',
    run(prices) {
        if (prices.length < 14) return null;
        const kc = keltner(prices, 14, 1.5);
        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];

        if (last > kc.upper && prev <= kc.upper) {
            return { type: 'CALL', score: 2, confidence: 69, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last < kc.lower && prev >= kc.lower) {
            return { type: 'PUT', score: 2, confidence: 69, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 13. Rate of Change momentum ─────────────────────────────────────────────
const rocStrategy: StrategyModule = {
    name: 'ROC',
    run(prices) {
        if (prices.length < 10) return null;
        const roc3 = roc(prices, 3);
        const roc5 = roc(prices, 5);

        // Accelerating momentum
        if (roc3 > 0.1 && roc5 > 0.05) {
            const conf = Math.min(75, 60 + Math.abs(roc3) * 20);
            return { type: 'CALL', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (roc3 < -0.1 && roc5 < -0.05) {
            const conf = Math.min(75, 60 + Math.abs(roc3) * 20);
            return { type: 'PUT', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Momentum reversal
        if (roc3 > 0.05 && roc5 < -0.02) {
            return { type: 'CALL', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (roc3 < -0.05 && roc5 > 0.02) {
            return { type: 'PUT', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 14. Fractal Efficiency / Market efficiency ratio ────────────────────────
const fractalEfficiency: StrategyModule = {
    name: 'FractalEff',
    run(prices) {
        if (prices.length < 14) return null;
        const slice = prices.slice(-14);
        const netChange = Math.abs(slice.at(-1)! - slice[0]);
        let totalMovement = 0;
        for (let i = 1; i < slice.length; i++) {
            totalMovement += Math.abs(slice[i] - slice[i - 1]);
        }
        if (totalMovement === 0) return null;
        const efficiency = netChange / totalMovement;

        // High efficiency = trending → follow trend
        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];

        if (efficiency > 0.6 && last > prev) {
            return { type: 'CALL', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (efficiency > 0.6 && last < prev) {
            return { type: 'PUT', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Low efficiency = ranging, mean revert
        if (efficiency < 0.3) return null;

        return null;
    },
};

// ── 15. Digit Psychology — round numbers, digit clustering, psychological barriers ──
const digitPsychology: StrategyModule = {
    name: 'DigitPsych',
    run(_prices, ticks) {
        if (ticks.length < 20) return null;
        const recent = ticks.slice(-15);
        const lastDigit = recent[recent.length - 1];

        // Round-number magnetism: digits 0 and 5 act as psychological support/resistance
        const roundDigits = [0, 5];
        const roundHits = recent.filter(d => roundDigits.includes(d)).length;
        const roundPct = (roundHits / recent.length) * 100;

        // Check if price is at or near a psychological round digit
        if (lastDigit <= 1 && roundPct > 30) {
            // Near bottom of round cluster → likely to bounce up
            return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (lastDigit >= 8 && roundPct > 30) {
            // Near top of round cluster → likely to drop
            return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Double-touch at same digit (rejection pattern)
        if (recent.length >= 5) {
            const last5 = recent.slice(-5);
            const uniqueD = [...new Set(last5)];
            if (uniqueD.length <= 2 && uniqueD.includes(lastDigit)) {
                // Price keeps returning to same digit — strong support/resistance
                if (lastDigit <= 2) {
                    return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
                }
                if (lastDigit >= 7) {
                    return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
                }
            }
        }

        // Mirror pattern: digits that mirror each other around 4.5 (e.g., 0↔9, 1↔8, 2↔7)
        const mirroredDigits: Record<number, number[]> = { 0: [9], 1: [8], 2: [7], 3: [6], 4: [5], 5: [4], 6: [3], 7: [2], 8: [1], 9: [0] };
        const mirrorCount = recent.filter(d => mirroredDigits[lastDigit]?.includes(d)).length;
        const mirrorRatio = mirrorCount / recent.length;
        if (mirrorRatio > 0.35) {
            if (lastDigit >= 5) {
                return { type: 'CALL', score: 1, confidence: 63, weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'PUT', score: 1, confidence: 63, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 16. Red Bar / Green Bar Reversal — 1-tick candlestick patterns ────────────
interface TickCandle {
    open: number;
    close: number;
    high: number;
    low: number;
    body: number;
    upperWick: number;
    lowerWick: number;
    isGreen: boolean;
    isRed: boolean;
}

function makeCandle(prev: number, curr: number): TickCandle {
    const open = prev;
    const close = curr;
    const high = Math.max(open, close);
    const low = Math.min(open, close);
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    return {
        open, close, high, low, body, upperWick, lowerWick,
        isGreen: close > open,
        isRed: close < open,
    };
}

const candleReversal: StrategyModule = {
    name: 'CandleRev',
    run(prices) {
        if (prices.length < 4) return null;
        const last = prices[prices.length - 1];
        const p1 = prices[prices.length - 2];
        const p2 = prices[prices.length - 3];
        const p3 = prices[prices.length - 4];
        const p4 = prices.length > 4 ? prices[prices.length - 5] : p3;

        const c1 = makeCandle(p1, last);
        const c2 = makeCandle(p2, p1);
        const c3 = prices.length > 4 ? makeCandle(p3, p2) : null;

        // ── Single-bar reversals ──

        // Hammer: small body at top, long lower wick, after downtrend
        if (c2.isRed && c1.isGreen && c1.lowerWick > c1.body * 2 && c1.upperWick < c1.body * 0.3) {
            return { type: 'CALL', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Shooting Star: small body at bottom, long upper wick, after uptrend
        if (c2.isGreen && c1.isRed && c1.upperWick > c1.body * 2 && c1.lowerWick < c1.body * 0.3) {
            return { type: 'PUT', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Doji: very small body, indicates indecision, often precedes reversal
        if (c1.body > 0 && c1.body / (c1.high - c1.low) < 0.15 && (c1.high - c1.low) > 0) {
            if (c2.isGreen && c2.body > 0) {
                return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            }
            if (c2.isRed && c2.body > 0) {
                return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // ── Two-bar reversals ──

        // Bullish Engulfing: red bar followed by green bar that completely engulfs it
        if (c2.isRed && c1.isGreen && c1.open < c2.close && c1.close > c2.open) {
            return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Bearish Engulfing: green bar followed by red bar that completely engulfs it
        if (c2.isGreen && c1.isRed && c1.open > c2.close && c1.close < c2.open) {
            return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Piercing pattern: red bar then green bar that closes above midpoint of red bar
        if (c2.isRed && c1.isGreen && c1.close > c2.open + c2.body * 0.5 && c1.close < c2.open) {
            return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Dark cloud cover: green bar then red bar that closes below midpoint of green bar
        if (c2.isGreen && c1.isRed && c1.close < c2.close - c2.body * 0.5 && c1.close > c2.open) {
            return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }

        // ── Three-bar reversals ──
        if (c3) {
            const c3C = makeCandle(p3, p2);

            // Morning Star: long red, small body (doji), long green
            if (c3C.isRed && c3C.body > 0 && Math.abs(c2.body) < Math.abs(c3C.body) * 0.3
                && c1.isGreen && c1.close > c2.high + (p2 - p3) * 0.5) {
                return { type: 'CALL', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
            }
            // Evening Star: long green, small body (doji), long red
            if (c3C.isGreen && c3C.body > 0 && Math.abs(c2.body) < Math.abs(c3C.body) * 0.3
                && c1.isRed && c1.close < c2.low - (p3 - p2) * 0.5) {
                return { type: 'PUT', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
            }

            // Three White Soldiers: 3 consecutive strong green bars (from downtrend)
            if (p4 < p3 && c3C.isGreen && c2.isGreen && c1.isGreen
                && c3C.body > 0 && c2.body > 0 && c1.body > 0) {
                return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
            }
            // Three Black Crows: 3 consecutive strong red bars (from uptrend)
            if (p4 > p3 && c3C.isRed && c2.isRed && c1.isRed
                && c3C.body > 0 && c2.body > 0 && c1.body > 0) {
                return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 17. Double Top/Bottom Reversal ───────────────────────────────────────────
const doubleTopBottom: StrategyModule = {
    name: 'DoubleTB',
    run(prices) {
        if (prices.length < 20) return null;

        const recent = prices.slice(-20);
        const peaks: { index: number; price: number }[] = [];
        const troughs: { index: number; price: number }[] = [];

        // Find local peaks and troughs in the last 20 ticks
        for (let i = 2; i < recent.length - 2; i++) {
            if (recent[i] > recent[i - 1] && recent[i] > recent[i - 2]
                && recent[i] > recent[i + 1] && recent[i] > recent[i + 2]) {
                peaks.push({ index: i, price: recent[i] });
            }
            if (recent[i] < recent[i - 1] && recent[i] < recent[i - 2]
                && recent[i] < recent[i + 1] && recent[i] < recent[i + 2]) {
                troughs.push({ index: i, price: recent[i] });
            }
        }

        const last = recent[recent.length - 1];
        const prev = recent[recent.length - 2];

        // Double top: two peaks at similar level, then price dropping
        for (let i = 0; i < peaks.length - 1; i++) {
            const diff = Math.abs(peaks[i].price - peaks[i + 1].price);
            const avgP = (peaks[i].price + peaks[i + 1].price) / 2;
            if (diff / avgP < 0.002 && last < prev && last < peaks[i + 1].price) {
                return { type: 'PUT', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // Double bottom: two troughs at similar level, then price rising
        for (let i = 0; i < troughs.length - 1; i++) {
            const diff = Math.abs(troughs[i].price - troughs[i + 1].price);
            const avgP = (troughs[i].price + troughs[i + 1].price) / 2;
            if (diff / avgP < 0.002 && last > prev && last > troughs[i + 1].price) {
                return { type: 'CALL', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 18. Exhaustion Reversal — after strong multi-tick move, first counter-move ──
const exhaustionRev: StrategyModule = {
    name: 'ExhaustRev',
    run(prices) {
        if (prices.length < 12) return null;

        const last = prices[prices.length - 1];
        const prev = prices[prices.length - 2];
        const p3 = prices[prices.length - 3];

        // Calculate recent momentum strength
        const recent8 = prices.slice(-8);
        let upCount = 0, downCount = 0;
        for (let i = 1; i < recent8.length; i++) {
            if (recent8[i] > recent8[i - 1]) upCount++;
            else if (recent8[i] < recent8[i - 1]) downCount++;
        }

        // Strong uptrend (6+ up ticks out of 7) followed by a down tick
        if (upCount >= 6 && last < prev && prev >= p3) {
            return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Strong downtrend (6+ down ticks out of 7) followed by an up tick
        if (downCount >= 6 && last > prev && prev <= p3) {
            return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Moderate exhaustion (5 out of 7)
        if (upCount >= 5 && last < prev) {
            return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (downCount >= 5 && last > prev) {
            return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 19. Pivot Point Reversal ─────────────────────────────────────────────────
const pivotReversal: StrategyModule = {
    name: 'PivotRev',
    run(prices) {
        if (prices.length < 10) return null;

        const recent = prices.slice(-10);
        const last = recent[recent.length - 1];
        const prev = recent[recent.length - 2];
        const p3 = recent[recent.length - 3];
        const p4 = recent[recent.length - 4];

        // Bullish pivot: lower low followed by higher low and then breakout
        if (prev < p3 && prev < p4 && last > prev && last > p3) {
            return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Bearish pivot: higher high followed by lower high and then breakdown
        if (prev > p3 && prev > p4 && last < prev && last < p3) {
            return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Key level rejection: price tests recent range extreme and bounces
        const highest = Math.max(...recent);
        const lowest = Math.min(...recent);
        const range = highest - lowest;

        if (range > 0 && last >= highest - range * 0.05 && last < prev) {
            return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (range > 0 && last <= lowest + range * 0.05 && last > prev) {
            return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 20. TICK Volume / Tick Velocity — acceleration/deceleration detection ───
const tickVelocity: StrategyModule = {
    name: 'TickVel',
    run(prices) {
        if (prices.length < 10) return null;

        // Measure tick velocity: how fast price moves over consecutive ticks
        const velocities: number[] = [];
        for (let i = 1; i < prices.length; i++) {
            velocities.push(Math.abs(prices[i] - prices[i - 1]));
        }
        const last5v = velocities.slice(-5);
        const prev5v = velocities.slice(-10, -5);
        if (prev5v.length < 3 || last5v.length < 3) return null;

        const avgRecentV = last5v.reduce((a, b) => a + b, 0) / last5v.length;
        const avgPrevV = prev5v.reduce((a, b) => a + b, 0) / prev5v.length;

        // Deceleration: velocity decreasing → trend losing steam → reversal likely
        if (avgRecentV < avgPrevV * 0.6) {
            const last = prices[prices.length - 1];
            const prev = prices[prices.length - 2];

            // Was going up, now slowing
            const upTicks = velocities.slice(-8).filter(v => v > 0).length;
            if (upTicks >= 5 && last < prev) {
                return { type: 'PUT', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
            }
            if (upTicks <= 3 && last > prev) {
                return { type: 'CALL', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 21. Fibonacci Retracement Levels ─────────────────────────────────────────
const fibonacciRetrace: StrategyModule = {
    name: 'FibRetrace',
    run(prices) {
        if (prices.length < 20) return null;
        const recent = prices.slice(-20);
        const high = Math.max(...recent);
        const low = Math.min(...recent);
        const range = high - low;
        if (range === 0) return null;
        const last = recent[recent.length - 1];
        const prev = recent[recent.length - 2];

        const fibLevels = [0.236, 0.382, 0.5, 0.618, 0.786];
        const lastPos = (last - low) / range;
        const prevPos = (prev - low) / range;

        // Check if price is bouncing off a Fibonacci level
        for (const fib of fibLevels) {
            const fibPrice = low + range * fib;
            const fibBand = range * 0.02;

            if (Math.abs(last - fibPrice) < fibBand && last > prev) {
                // Bounce up from fib level
                return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
            }
            if (Math.abs(last - fibPrice) < fibBand && last < prev) {
                // Reject down from fib level
                return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // Key level: 0.618 bounce is strongest
        const fib618 = low + range * 0.618;
        if (Math.abs(last - fib618) < range * 0.015) {
            if (last > prev) return { type: 'CALL', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
            if (last < prev) return { type: 'PUT', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 22. Statistical Extreme — 2+ standard deviation from mean ────────────────
const statisticalExtreme: StrategyModule = {
    name: 'StatExtreme',
    run(prices) {
        if (prices.length < 14) return null;
        const slice = prices.slice(-14);
        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
        const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
        const std = Math.sqrt(variance);
        if (std === 0) return null;

        const last = slice[slice.length - 1];
        const zScore = (last - mean) / std;

        // Extreme deviation → strong mean reversion signal
        if (zScore > 2.0) {
            return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (zScore < -2.0) {
            return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (zScore > 1.5) {
            return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (zScore < -1.5) {
            return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 23. N-Period Pattern Matching — correlation-based historical pattern matching ──
const nPatternMatch: StrategyModule = {
    name: 'NPattern',
    run(prices) {
        if (prices.length < 30) return null;
        const patternLen = 10;
        const pattern = prices.slice(-patternLen);
        const patternDir = pattern[pattern.length - 1] - pattern[0];
        if (Math.abs(patternDir) < 0.001) return null;

        // Normalize pattern to 0-1 range for shape matching
        const pMin = Math.min(...pattern);
        const pMax = Math.max(...pattern);
        const pRange = pMax - pMin || 1;
        const norm = pattern.map(p => (p - pMin) / pRange);

        // Search historical segments for best match (correlation)
        let bestCorr = -1;
        let bestNextDir = 0;
        const searchEnd = prices.length - patternLen - 3;

        for (let i = 0; i < searchEnd; i++) {
            const seg = prices.slice(i, i + patternLen + 1);
            const sMin = Math.min(...seg.slice(0, -1));
            const sMax = Math.max(...seg.slice(0, -1));
            const sRange = sMax - sMin || 1;
            const sNorm = seg.slice(0, -1).map(p => (p - sMin) / sRange);

            // Pearson correlation
            let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0;
            for (let j = 0; j < patternLen; j++) {
                sumX += norm[j]; sumY += sNorm[j];
                sumX2 += norm[j] * norm[j];
                sumY2 += sNorm[j] * sNorm[j];
                sumXY += norm[j] * sNorm[j];
            }
            const n = patternLen;
            const corr = (n * sumXY - sumX * sumY) / Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY) || 1);

            if (corr > bestCorr) {
                bestCorr = corr;
                bestNextDir = seg[seg.length - 1] - seg[seg.length - 2];
            }
        }

        if (bestCorr > 0.75 && Math.abs(bestNextDir) > 0) {
            const conf = Math.min(84, 68 + Math.round(bestCorr * 20));
            return {
                type: bestNextDir > 0 ? 'CALL' : 'PUT',
                score: 3,
                confidence: conf,
                weight: getStrategyWeight(this.name),
                name: this.name,
            };
        }
        return null;
    },
};

// ── 24. Higher High / Lower Low Sequence (HH/HL/LH/LL) ─────────────────────
const hlSequence: StrategyModule = {
    name: 'HLSeq',
    run(prices) {
        if (prices.length < 20) return null;
        const lookback = prices.slice(-20);
        // Find swing highs and lows
        const peaks: number[] = [], troughs: number[] = [];
        for (let i = 2; i < lookback.length - 2; i++) {
            if (lookback[i] > lookback[i - 1] && lookback[i] > lookback[i - 2] && lookback[i] > lookback[i + 1] && lookback[i] > lookback[i + 2]) {
                peaks.push(i);
            }
            if (lookback[i] < lookback[i - 1] && lookback[i] < lookback[i - 2] && lookback[i] < lookback[i + 1] && lookback[i] < lookback[i + 2]) {
                troughs.push(i);
            }
        }

        if (peaks.length < 2 && troughs.length < 2) return null;

        const last = lookback[lookback.length - 1];
        const prev = lookback[lookback.length - 2];

        // Higher High followed by Lower High → bearish reversal
        if (peaks.length >= 2) {
            const lastPeak = lookback[peaks[peaks.length - 1]];
            const prevPeak = peaks.length >= 2 ? lookback[peaks[peaks.length - 2]] : lastPeak;
            if (prevPeak < lastPeak && last < lastPeak && prev < last) {
                const conf = Math.min(82, 68 + (lastPeak - prevPeak) * 500);
                return { type: 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // Lower Low followed by Higher Low → bullish reversal
        if (troughs.length >= 2) {
            const lastTrough = lookback[troughs[troughs.length - 1]];
            const prevTrough = troughs.length >= 2 ? lookback[troughs[troughs.length - 2]] : lastTrough;
            if (prevTrough > lastTrough && last > lastTrough && prev > last) {
                const conf = Math.min(82, 68 + (prevTrough - lastTrough) * 500);
                return { type: 'CALL', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // Sequence of HH → HL → LL (exhaustion)
        if (peaks.length >= 1 && troughs.length >= 2) {
            const lastP = lookback[peaks[peaks.length - 1]];
            const lastT = lookback[troughs[troughs.length - 1]];
            const prevT = lookback[troughs[troughs.length - 2]];
            const recentHigh = Math.max(...lookback.slice(-5));
            if (lastP >= recentHigh && lastT < prevT && prev < last) {
                const conf = Math.min(80, 66 + (prevT - lastT) * 400);
                return { type: 'PUT', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 25. Volatility Contraction / BB Squeeze Breakout ────────────────────────
const volContraction: StrategyModule = {
    name: 'VolContract',
    run(prices) {
        if (prices.length < 25) return null;
        const slice = prices.slice(-25);
        const per = 14;
        const means: number[] = [];
        const stds: number[] = [];

        for (let i = per; i <= slice.length; i++) {
            const s = slice.slice(i - per, i);
            const m = s.reduce((a, b) => a + b, 0) / per;
            means.push(m);
            const v = s.reduce((a, b) => a + (b - m) ** 2, 0) / per;
            stds.push(Math.sqrt(v));
        }

        if (stds.length < 3) return null;
        // BB width
        const widths = stds.map(s => s * 4);
        const recentWidths = widths.slice(-5);
        const priorWidths = widths.slice(-10, -5);

        const avgRecent = recentWidths.reduce((a, b) => a + b, 0) / recentWidths.length;
        const avgPrior = priorWidths.reduce((a, b) => a + b, 0) / priorWidths.length;

        if (avgPrior > 0 && avgRecent < avgPrior * 0.7) {
            // Squeeze detected → breakout likely
            const last = slice[slice.length - 1];
            const lastMean = means[means.length - 1];
            const lastStd = stds[stds.length - 1];

            // Direction determined by recent momentum
            const mom = last - slice[slice.length - 4];
            const conf = Math.min(80, 65 + Math.round((1 - avgRecent / avgPrior) * 30));
            if (mom > 0) {
                return { type: 'CALL', score: 2, confidence: Math.round(conf + 3), weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'PUT', score: 2, confidence: Math.round(conf + 3), weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // Expansion: BB width expanding → trend continuation
        if (avgPrior > 0 && avgRecent > avgPrior * 1.4) {
            const last3 = slice.slice(-3);
            const dir = last3[2] - last3[0];
            if (Math.abs(dir) > 0) {
                const conf = Math.min(78, 62 + Math.round((avgRecent / avgPrior - 1) * 20));
                return {
                    type: dir > 0 ? 'CALL' : 'PUT',
                    score: 2,
                    confidence: Math.round(conf),
                    weight: getStrategyWeight(this.name),
                    name: this.name,
                };
            }
        }

        return null;
    },
};

// ── 26. Multi-Timeframe Trend Alignment ─────────────────────────────────────
const mtfAlignment: StrategyModule = {
    name: 'MTFAlign',
    run(prices) {
        if (prices.length < 25) return null;

        // Compute slopes at different windows
        function slope(vals: number[]): number {
            if (vals.length < 2) return 0;
            return (vals[vals.length - 1] - vals[0]) / vals.length;
        }

        const s5 = slope(prices.slice(-5));
        const s10 = slope(prices.slice(-10));
        const s20 = slope(prices.slice(-20));

        // Count aligned timeframes
        let bullish = 0, bearish = 0;
        [s5, s10, s20].forEach(s => {
            if (s > 0.0005) bullish++;
            else if (s < -0.0005) bearish++;
        });

        // All bullish → strong continuation up
        if (bullish === 3) {
            const strength = (s5 + s10 + s20) / 3;
            const conf = Math.min(86, 70 + Math.round(Math.abs(strength) * 2000));
            return { type: 'CALL', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        // All bearish → strong continuation down
        if (bearish === 3) {
            const strength = (s5 + s10 + s20) / 3;
            const conf = Math.min(86, 70 + Math.round(Math.abs(strength) * 2000));
            return { type: 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }

        // 2/3 aligned → moderate signal
        if (bullish === 2 && bearish === 0) {
            return { type: 'CALL', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (bearish === 2 && bullish === 0) {
            return { type: 'PUT', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Conflict check (5-tick opposes 20-tick) → ranging, no signal
        if (Math.abs(s5) > 0.001 && s5 * s20 < 0) {
            return null;
        }

        return null;
    },
};

// ── 27. Sequential Bar Pattern — 3-bar and 4-bar patterns ───────────────────
const barPatternSeq: StrategyModule = {
    name: 'BarSeq',
    run(prices) {
        if (prices.length < 8) return null;
        const b = prices.slice(-8);

        // Build 1-tick candles
        const candles: { o: number; c: number; h: number; l: number; bullish: boolean }[] = [];
        for (let i = 1; i < b.length; i++) {
            candles.push({
                o: b[i - 1], c: b[i],
                h: Math.max(b[i - 1], b[i]),
                l: Math.min(b[i - 1], b[i]),
                bullish: b[i] > b[i - 1],
            });
        }
        if (candles.length < 4) return null;

        const last2 = candles.slice(-2);
        const last3 = candles.slice(-3);
        const last4 = candles.slice(-4);

        // Inside bar: range of current < range of previous
        const isInside = (c: typeof candles[0], p: typeof candles[0]) =>
            c.h <= p.h && c.l >= p.l && (c.h < p.h || c.l > p.l);

        // Outside bar: range of current > range of previous
        const isOutside = (c: typeof candles[0], p: typeof candles[0]) =>
            c.h > p.h && c.l < p.l;

        // Bullish Harami: bearish candle followed by smaller bullish inside bar
        if (last3.length >= 2 && !last3[0].bullish && last3[1].bullish && isInside(last3[1], last3[0])) {
            const conf = 76;
            return { type: 'CALL', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Bearish Harami: bullish candle followed by smaller bearish inside bar
        if (last3.length >= 2 && last3[0].bullish && !last3[1].bullish && isInside(last3[1], last3[0])) {
            const conf = 76;
            return { type: 'PUT', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Bullish outside bar (engulfing): bearish candle followed by larger bullish
        if (last3.length >= 2 && !last3[0].bullish && last3[1].bullish && isOutside(last3[1], last3[0])) {
            const conf = 80;
            return { type: 'CALL', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Bearish outside bar: bullish followed by larger bearish
        if (last3.length >= 2 && last3[0].bullish && !last3[1].bullish && isOutside(last3[1], last3[0])) {
            const conf = 80;
            return { type: 'PUT', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }

        // 3-bar pattern: morning star (bear, doji/small, bull)
        if (last3.length >= 3) {
            if (!last3[0].bullish && last3[2].bullish) {
                const body0 = Math.abs(last3[0].c - last3[0].o);
                const body1 = Math.abs(last3[1].c - last3[1].o);
                const body2 = Math.abs(last3[2].c - last3[2].o);
                if (body1 < body0 * 0.5 && body2 > body0 * 0.6) {
                    return { type: 'CALL', score: 3, confidence: 82, weight: getStrategyWeight(this.name), name: this.name };
                }
            }
            if (last3[0].bullish && !last3[2].bullish) {
                const body0 = Math.abs(last3[0].c - last3[0].o);
                const body1 = Math.abs(last3[1].c - last3[1].o);
                const body2 = Math.abs(last3[2].c - last3[2].o);
                if (body1 < body0 * 0.5 && body2 > body0 * 0.6) {
                    return { type: 'PUT', score: 3, confidence: 82, weight: getStrategyWeight(this.name), name: this.name };
                }
            }
        }

        // 4-bar: three soldiers (3 consecutive bullish) → trend continuation
        if (last4.length >= 3) {
            const b3 = last4.slice(-3);
            if (b3[0].bullish && b3[1].bullish && b3[2].bullish) {
                const conf = Math.min(80, 68 + (b3[2].c - b3[0].o) * 500);
                return { type: 'CALL', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
            if (!b3[0].bullish && !b3[1].bullish && !b3[2].bullish) {
                const conf = Math.min(80, 68 + (b3[0].o - b3[2].c) * 500);
                return { type: 'PUT', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 28. Multi-window Tick Pressure (3/5/8 tick up/down ratio) ────────────────
const tickPressure: StrategyModule = {
    name: 'TickPressure',
    run(prices) {
        if (prices.length < 10) return null;
        function bias(vals: number[], w: number): number {
            if (vals.length < w + 1) return 0;
            const s = vals.slice(-w - 1);
            let u = 0, d = 0;
            for (let i = 1; i < s.length; i++) {
                if (s[i] > s[i - 1]) u++;
                else if (s[i] < s[i - 1]) d++;
            }
            return u - d;
        }
        const b3 = bias(prices, 3);
        const b5 = bias(prices, 5);
        const b8 = bias(prices, 8);
        if (b3 >= 2 && b5 >= 2 && b8 >= 2) {
            const conf = Math.min(86, 72 + b3 * 3);
            return { type: 'CALL', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        if (b3 <= -2 && b5 <= -2 && b8 <= -2) {
            const conf = Math.min(86, 72 + Math.abs(b3) * 3);
            return { type: 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        if ((b3 > 0 && b5 > 0 && b3 + b5 >= 3) || (b3 > 0 && b8 > 0 && b3 + b8 >= 3) || (b5 > 0 && b8 > 0 && b5 + b8 >= 3)) {
            return { type: 'CALL', score: 2, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
        }
        if ((b3 < 0 && b5 < 0 && Math.abs(b3 + b5) >= 3) || (b3 < 0 && b8 < 0 && Math.abs(b3 + b8) >= 3) || (b5 < 0 && b8 < 0 && Math.abs(b5 + b8) >= 3)) {
            return { type: 'PUT', score: 2, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 29. Tick Acceleration/Deceleration ────────────────────────────────────────
const accelMomentum: StrategyModule = {
    name: 'Accel',
    run(prices) {
        if (prices.length < 6) return null;
        const v: number[] = [];
        for (let i = 1; i < 7 && i < prices.length; i++) {
            v.push(prices[prices.length - i] - prices[prices.length - i - 1]);
        }
        const vRecent = v.slice(0, 2);
        const vPrior = v.slice(2, 5);
        if (vPrior.length < 2 || vRecent.length < 2) return null;
        const sumRecent = vRecent.reduce((a, b) => a + b, 0);
        const sumPrior = vPrior.reduce((a, b) => a + b, 0);
        const absRecent = Math.abs(sumRecent);
        const absPrior = Math.abs(sumPrior);
        if (sumRecent > 0 && sumPrior > 0 && absRecent > absPrior * 1.3) {
            const conf = Math.min(84, 70 + Math.round((absRecent / (absPrior || 0.0001)) * 10));
            return { type: 'CALL', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (sumRecent < 0 && sumPrior < 0 && absRecent > absPrior * 1.3) {
            const conf = Math.min(84, 70 + Math.round((absRecent / (absPrior || 0.0001)) * 10));
            return { type: 'PUT', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (sumPrior > 0 && sumRecent < 0 && absPrior > 0.001) {
            const ratio = absRecent / absPrior;
            if (ratio > 0.5) return { type: 'PUT', score: 2, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (sumPrior < 0 && sumRecent > 0 && absPrior > 0.001) {
            const ratio = absRecent / absPrior;
            if (ratio > 0.5) return { type: 'CALL', score: 2, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 30. Micro-Trend Strength (% directional consistency, ADX-like for ticks) ──
const microTrendStrength: StrategyModule = {
    name: 'MicroTrend',
    run(prices) {
        if (prices.length < 10) return null;
        const recent = prices.slice(-10);
        let upMoves = 0, downMoves = 0, upSum = 0, downSum = 0;
        for (let i = 1; i < recent.length; i++) {
            const diff = recent[i] - recent[i - 1];
            if (diff > 0) { upMoves++; upSum += diff; }
            else if (diff < 0) { downMoves++; downSum += Math.abs(diff); }
        }
        const totalMov = upMoves + downMoves;
        if (totalMov < 6) return null;
        const upPct = upMoves / totalMov;
        const downPct = downMoves / totalMov;
        const directionalConsistency = Math.max(upPct, downPct) * 100;
        if (directionalConsistency >= 70) {
            if (upPct > downPct && upSum > downSum) {
                const bonus = upSum > downSum * 1.3 ? 4 : 0;
                const conf = Math.min(84, 66 + Math.round((directionalConsistency - 60) * 0.8) + bonus);
                return { type: 'CALL', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
            if (downPct > upPct && downSum > upSum) {
                const bonus = downSum > upSum * 1.3 ? 4 : 0;
                const conf = Math.min(84, 66 + Math.round((directionalConsistency - 60) * 0.8) + bonus);
                return { type: 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        if (directionalConsistency >= 62 && upPct !== downPct) {
            if (upPct > downPct) return { type: 'CALL', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
            else return { type: 'PUT', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 31. Micro Support/Resistance Bounce ───────────────────────────────────────
const supportBounce: StrategyModule = {
    name: 'SupportBounce',
    run(prices) {
        if (prices.length < 12) return null;
        const recent = prices.slice(-12);
        const last = recent[recent.length - 1];
        const prev = recent[recent.length - 2];
        const highs: number[] = [], lows: number[] = [];
        for (let i = 2; i < recent.length - 2; i++) {
            if (recent[i] > recent[i - 1] && recent[i] > recent[i + 1]) highs.push(recent[i]);
            if (recent[i] < recent[i - 1] && recent[i] < recent[i + 1]) lows.push(recent[i]);
        }
        const avgPrice = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (lows.length > 0) {
            const nearestSupport = lows.reduce((best, l) => Math.abs(last - l) < Math.abs(last - best) ? l : best, lows[0]);
            const pctDist = avgPrice > 0 ? Math.abs(last - nearestSupport) / avgPrice * 100 : 0;
            if (pctDist < 0.05 && last > prev && last >= nearestSupport) {
                const conf = Math.min(80, 68 + Math.round((0.05 - pctDist) * 200));
                return { type: 'CALL', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        if (highs.length > 0) {
            const nearestResist = highs.reduce((best, h) => Math.abs(last - h) < Math.abs(last - best) ? h : best, highs[0]);
            const pctDist = avgPrice > 0 ? Math.abs(last - nearestResist) / avgPrice * 100 : 0;
            if (pctDist < 0.05 && last < prev && last <= nearestResist) {
                const conf = Math.min(80, 68 + Math.round((0.05 - pctDist) * 200));
                return { type: 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        return null;
    },
};

// ── 32. Tick Pressure Divergence — price extreme but pressure weakening ──────
const tickDivergence: StrategyModule = {
    name: 'TickDiverge',
    run(prices) {
        if (prices.length < 14) return null;
        const recent = prices.slice(-14);
        const last = recent[recent.length - 1];
        const prev = recent[recent.length - 2];
        const highest = Math.max(...recent);
        const lowest = Math.min(...recent);
        function pressure(vals: number[]): number {
            let u = 0, d = 0;
            for (let i = 1; i < vals.length; i++) {
                if (vals[i] > vals[i - 1]) u++;
                else if (vals[i] < vals[i - 1]) d++;
            }
            return u - d;
        }
        const pRecent = pressure(recent.slice(-5));
        const pPrior = pressure(recent.slice(-10, -5));
        const range = highest - lowest || 1;
        if (last >= highest - range * 0.05 && pRecent < pPrior && pRecent < 0) {
            return { type: 'PUT', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last <= lowest + range * 0.05 && pRecent > pPrior && pRecent > 0) {
            return { type: 'CALL', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last > prev && pRecent <= 0 && pPrior > 0) {
            return { type: 'PUT', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last < prev && pRecent >= 0 && pPrior < 0) {
            return { type: 'CALL', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 33. Consecutive Gap Expansion — each successive tick gap grows ───────────
const consecGap: StrategyModule = {
    name: 'ConsecGap',
    run(prices) {
        if (prices.length < 5) return null;
        const last3Gaps: number[] = [];
        for (let i = 0; i < 3 && i + 1 < prices.length; i++) {
            last3Gaps.push(prices[prices.length - 1 - i] - prices[prices.length - 2 - i]);
        }
        if (last3Gaps.length < 3) return null;
        const dir = last3Gaps[0] > 0 ? 1 : last3Gaps[0] < 0 ? -1 : 0;
        if (dir === 0) return null;
        const allSameDir = last3Gaps.every(g => (g > 0 ? 1 : g < 0 ? -1 : 0) === dir);
        if (!allSameDir) return null;
        const absGaps = last3Gaps.map(g => Math.abs(g));
        const expanding = absGaps[0] > absGaps[1] && absGaps[1] > absGaps[2];
        if (!expanding) return null;
        const conf = Math.min(86, 72 + Math.round((absGaps[0] / (absGaps[2] || 0.0001)) * 5));
        return { type: dir > 0 ? 'CALL' : 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
    },
};

// ── 34. Triple MA Alignment (SMA3, SMA5, SMA8) ───────────────────────────────
const tripleMA: StrategyModule = {
    name: 'TripleMA',
    run(prices) {
        if (prices.length < 15) return null;
        const last = prices[prices.length - 1];
        const sma3 = sma(prices, 3);
        const sma5 = sma(prices, 5);
        const sma8 = sma(prices, 8);
        if (sma3.length < 1 || sma5.length < 1 || sma8.length < 1) return null;
        const s3 = sma3.at(-1)!, s5 = sma5.at(-1)!, s8 = sma8.at(-1)!;
        if (last > s3 && s3 > s5 && s5 > s8) {
            const conf = Math.min(84, 70 + Math.round((last - s8) / (s8 || 0.0001) * 500));
            return { type: 'CALL', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last < s3 && s3 < s5 && s5 < s8) {
            const conf = Math.min(84, 70 + Math.round((s8 - last) / (s8 || 0.0001) * 500));
            return { type: 'PUT', score: 3, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last > s3 && s3 > s5) {
            return { type: 'CALL', score: 2, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (last < s3 && s3 < s5) {
            return { type: 'PUT', score: 2, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 35. Micro 3-Tick Pattern Recognition ──────────────────────────────────────
const microPattern3: StrategyModule = {
    name: 'Micro3Pat',
    run(prices) {
        if (prices.length < 6) return null;
        const p4 = prices[prices.length - 4];
        const p3 = prices[prices.length - 3];
        const p2 = prices[prices.length - 2];
        const p1 = prices[prices.length - 1];
        const d1 = p1 > p2 ? 1 : p1 < p2 ? -1 : 0;
        const d2 = p2 > p3 ? 1 : p2 < p3 ? -1 : 0;
        const d3 = p3 > p4 ? 1 : p3 < p4 ? -1 : 0;
        if (d1 === 0) return null;
        // All same direction → continuation
        if (d1 === d2 && d2 === d3) {
            return { type: d1 > 0 ? 'CALL' : 'PUT', score: 3, confidence: 78, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Pullback pattern (d1 same as d3, d2 opposite) → continuation after pullback
        if (d1 === d3 && d2 === -d1 && d2 !== 0) {
            return { type: d1 > 0 ? 'CALL' : 'PUT', score: 2, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
        }
        // Reversal pattern (d2 same as d3, opposite to d1) → new trend
        if (d2 === d3 && d2 !== d1 && d2 !== 0) {
            return { type: d2 > 0 ? 'CALL' : 'PUT', score: 2, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── 36. Tick Entropy — low entropy = trending → follow trend ─────────────────
const tickEntropy: StrategyModule = {
    name: 'TickEntropy',
    run(prices) {
        if (prices.length < 12) return null;
        const recent = prices.slice(-12);
        let upCount = 0, downCount = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] > recent[i - 1]) upCount++;
            else if (recent[i] < recent[i - 1]) downCount++;
        }
        const total = upCount + downCount;
        if (total < 8) return null;
        const pUp = upCount / total;
        const pDown = downCount / total;
        if (pUp === 0 || pDown === 0) return null;
        // Shannon entropy H = -sum(p * log2(p))
        const entropy = -(pUp * Math.log2(pUp) + pDown * Math.log2(pDown));
        // Max entropy = 1.0 (for binary). Lower = more directional.
        // Entropy < 0.85 means at least 65% in one direction
        if (entropy < 0.85) {
            const last = recent[recent.length - 1];
            const prev = recent[recent.length - 2];
            if (pUp > pDown && last > prev) {
                const conf = Math.min(82, 70 + Math.round((0.85 - entropy) * 60));
                return { type: 'CALL', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
            if (pDown > pUp && last < prev) {
                const conf = Math.min(82, 70 + Math.round((0.85 - entropy) * 60));
                return { type: 'PUT', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        return null;
    },
};

// ── RSI Direction Filter (RSI 7) ──────────────────────────────────────────────
// PUT when RSI > 60 (overbought), CALL when RSI < 40 (oversold)
const rsiDirection: StrategyModule = {
    name: 'rsiDirection',
    run(prices) {
        if (prices.length < 30) return null;
        const rsiVal = rsi(prices, 7);
        if (rsiVal > 60) {
            const conf = Math.min(78, 64 + Math.round((rsiVal - 60) * 0.7));
            return { type: 'PUT', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (rsiVal < 40) {
            const conf = Math.min(78, 64 + Math.round((40 - rsiVal) * 0.7));
            return { type: 'CALL', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── Bollinger Band Touch Filter ────────────────────────────────────────────────
// PUT when price near/above upper band (pos > 0.8), CALL when near/below lower band (pos < 0.2)
const bbTouch: StrategyModule = {
    name: 'bbTouch',
    run(prices) {
        if (prices.length < 14) return null;
        const pos = bbPosition(prices, 14, 2);
        if (pos > 0.8) {
            const conf = Math.min(76, 64 + Math.round((pos - 0.8) * 40));
            return { type: 'PUT', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (pos < 0.2) {
            const conf = Math.min(76, 64 + Math.round((0.2 - pos) * 40));
            return { type: 'CALL', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── EMA 5/10 Crossover Filter ──────────────────────────────────────────────────
// CALL when EMA5 crosses above EMA10, PUT when EMA5 crosses below EMA10
const emaCross5_10: StrategyModule = {
    name: 'emaCross',
    run(prices) {
        if (prices.length < 20) return null;
        const e5 = ema(prices, 5);
        const e10 = ema(prices, 10);
        if (e5.length < 2 || e10.length < 2) return null;
        const le5 = e5[e5.length - 1], le10 = e10[e10.length - 1];
        const pe5 = e5[e5.length - 2], pe10 = e10[e10.length - 2];
        const above = le5 > le10;
        const prevAbove = pe5 > pe10;
        if (above && !prevAbove) {
            return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (!above && prevAbove) {
            return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPANDED STRATEGIES (60 new — MA-based, oscillators, candle patterns,
//  Deriv-specific, volume-proxy, and structural)
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. SMA 20 CROSS ──────────────────────────────────────────────────────────
const sma20Cross: StrategyModule = { name: 'sma20Cross', run(prices) {
    if (prices.length < 21) return null;
    const sma20 = sma(prices, 20); if (sma20.length < 2) return null;
    const cur = sma20[sma20.length - 1], prev = sma20[sma20.length - 2];
    const lastP = prices[prices.length - 1], prevP = prices[prices.length - 2];
    if (lastP > cur && prevP <= prev) return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (lastP < cur && prevP >= prev) return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 2. EMA 50 STRUCTURAL FILTER ─────────────────────────────────────────────
const ema50Filter: StrategyModule = { name: 'ema50Filter', run(prices) {
    if (prices.length < 51) return null;
    const e50 = ema(prices, 50); if (e50.length < 1) return null;
    const emaVal = e50[e50.length - 1], price = prices[prices.length - 1];
    const prevGreen = prices.length > 1 && prices[prices.length - 1] > prices[prices.length - 2];
    if (price > emaVal && prevGreen) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (price < emaVal && !prevGreen) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 3. HMA 9 SLOPE ──────────────────────────────────────────────────────────
const hma9Slope: StrategyModule = { name: 'hma9Slope', run(prices) {
    if (prices.length < 20) return null;
    const h = hmaArr(prices, 9); if (h.length < 2) return null;
    if (h[h.length - 1] > h[h.length - 2]) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (h[h.length - 1] < h[h.length - 2]) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 4. SUPERTREND (10, 3) ────────────────────────────────────────────────────
const supertrendStrat: StrategyModule = { name: 'supertrend', run(prices) {
    if (prices.length < 12) return null;
    const st = supertrendCalc(prices, 10, 3);
    if (st.flipped && st.trend === 'UP') return { type: 'CALL', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
    if (st.flipped && st.trend === 'DOWN') return { type: 'PUT', score: 3, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 5. PARABOLIC SAR ────────────────────────────────────────────────────────
const parabolicSarStrat: StrategyModule = { name: 'parabolicSar', run(prices) {
    if (prices.length < 5) return null;
    const ps = parabolicSar(prices, 0.02, 0.2);
    if (ps.flipped && !ps.above) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (ps.flipped && ps.above) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 6. ICHIMOKU KIJUN-SEN BREAK ─────────────────────────────────────────────
const ichimokuKijun: StrategyModule = { name: 'ichimokuKijun', run(prices) {
    if (prices.length < 27) return null;
    const kijun = kijunSen(prices, 26);
    const prevKijun = kijunSen(prices.slice(0, -1), 26);
    const price = prices[prices.length - 1], prevPrice = prices[prices.length - 2];
    if (price > kijun && prevPrice <= prevKijun) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (price < kijun && prevPrice >= prevKijun) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 7. VWAP BREAK (price-magnitude proxy) ──────────────────────────────────
const vwapBreak: StrategyModule = { name: 'vwapBreak', run(prices) {
    if (prices.length < 30) return null;
    const slice = prices.slice(-20);
    const vwap = slice.reduce((s, v, i) => s + v * (i + 1), 0) / slice.reduce((s, v, i) => s + (i + 1), 0);
    const price = prices[prices.length - 1], prev = prices[prices.length - 2];
    const volSurge = Math.abs(prices[prices.length - 1] - prices[prices.length - 2]) > atr(prices, 7) * 1.5;
    if (price > vwap && prev <= vwap && volSurge) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (price < vwap && prev >= vwap && volSurge) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 8. BB (20, 2) STRUCTURAL ESCAPE ─────────────────────────────────────────
const bbStructuralEscape: StrategyModule = { name: 'bbEscape', run(prices) {
    if (prices.length < 21) return null;
    const slice = prices.slice(-20);
    const mean = slice.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    const upper = mean + 2 * std, lower = mean - 2 * std;
    const price = prices[prices.length - 1], prev = prices[prices.length - 2];
    if (price < lower && prev >= lower) return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
    if (price > upper && prev <= upper) return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 9. KELTNER (20, 2, ATR 10) ──────────────────────────────────────────────
const keltner20: StrategyModule = { name: 'keltner20', run(prices) {
    if (prices.length < 21) return null;
    const kc = keltner(prices, 20, 2);
    if (kc.upper === 0) return null;
    const price = prices[prices.length - 1], prev = prices[prices.length - 2];
    if (price > kc.upper && prev <= kc.upper) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (price < kc.lower && prev >= kc.lower) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 10. DONCHIAN (20) ───────────────────────────────────────────────────────
const donchian20: StrategyModule = { name: 'donchian20', run(prices) {
    if (prices.length < 21) return null;
    const dc = donchian(prices, 20);
    if (dc.upper === 0) return null;
    const price = prices[prices.length - 1];
    if (price >= dc.upper) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (price <= dc.lower) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 11. ADX (14) + DI CROSS ────────────────────────────────────────────────
const adxDI: StrategyModule = { name: 'adxDI', run(prices) {
    if (prices.length < 16) return null;
    const period = 14;
    const slice = prices.slice(-(period + 2));
    if (slice.length < period + 1) return null;
    let plusDM = 0, minusDM = 0, tr = 0;
    for (let i = 1; i < slice.length; i++) {
        const up = slice[i] - slice[i - 1];
        const down = 0;
        if (up > 0 && up > Math.abs(down)) plusDM += up;
        if (down < 0 && Math.abs(down) > up) minusDM += Math.abs(down);
        tr += Math.abs(slice[i] - slice[i - 1]);
    }
    if (tr === 0) return null;
    const pDI = (plusDM / tr) * 100, mDI = (minusDM / tr) * 100;
    const dx = Math.abs(pDI - mDI) / (pDI + mDI) * 100;
    if (dx > 25 && pDI > mDI) return { type: 'CALL', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
    if (dx > 25 && mDI > pDI) return { type: 'PUT', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 12. LINEAR REGRESSION SLOPE (14) ────────────────────────────────────────
const linregSlope14: StrategyModule = { name: 'linregSlope', run(prices) {
    if (prices.length < 15) return null;
    const slope = linregSlope(prices, 14);
    const prevSlope = linregSlope(prices.slice(0, -1), 14);
    if (slope > 0 && prevSlope <= 0) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (slope < 0 && prevSlope >= 0) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 13. WMA 5/15 CROSSOVER ─────────────────────────────────────────────────
const wmaCross5_15: StrategyModule = { name: 'wmaCross5_15', run(prices) {
    if (prices.length < 16) return null;
    const w5 = wmaArr(prices, 5), w15 = wmaArr(prices, 15);
    if (w5.length < 2 || w15.length < 2) return null;
    const off = w15.length - w5.length;
    const w5c = w5[w5.length - 1], w5p = w5[w5.length - 2];
    const w15c = w15[w15.length - 1], w15p = w15[w15.length - 2];
    if (w5c > w15c && w5p <= w15p) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (w5c < w15c && w5p >= w15p) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 14. ALMA POSITION ────────────────────────────────────────────────────────
const almaStrat: StrategyModule = { name: 'alma', run(prices) {
    if (prices.length < 15) return null;
    const almaVal = alma(prices, 9, 0.85, 6);
    const prevAlma = alma(prices.slice(0, -1), 9, 0.85, 6);
    const price = prices[prices.length - 1];
    const angle = almaVal - prevAlma;
    if (price > almaVal && angle > 0) return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (price < almaVal && angle < 0) return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 15. STD DEV CHANNEL ─────────────────────────────────────────────────────
const stdDevChannel: StrategyModule = { name: 'stdDevChannel', run(prices) {
    if (prices.length < 21) return null;
    const sc = stdChannel(prices, 20, 2);
    const price = prices[prices.length - 1];
    if (price <= sc.lower * 1.001) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (price >= sc.upper * 0.999) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 16. RSI(14) BASELINE REVERSION ──────────────────────────────────────────
const rsi14Baseline: StrategyModule = { name: 'rsi14Baseline', run(prices) {
    if (prices.length < 20) return null;
    const r = rsi(prices, 14);
    const prevR = rsi(prices.slice(0, -1), 14);
    if (r > 30 && prevR <= 30) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (r < 70 && prevR >= 70) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 17. RSI(9) HYPER EXHAUSTION ─────────────────────────────────────────────
const rsi9Hyper: StrategyModule = { name: 'rsi9Hyper', run(prices) {
    if (prices.length < 15) return null;
    const r = rsi(prices, 9);
    if (r < 15) return { type: 'CALL', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
    if (r > 85) return { type: 'PUT', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 18. STOCHASTIC (14, 3, 3) CROSS ─────────────────────────────────────────
const stoch14: StrategyModule = { name: 'stoch14', run(prices) {
    if (prices.length < 18) return null;
    const s = stoch(prices, 14, 3);
    const prevS = stoch(prices.slice(0, -1), 14, 3);
    if (s.k > s.d && prevS.k <= prevS.d && s.k < 20) return { type: 'CALL', score: 2, confidence: 69, weight: getStrategyWeight(this.name), name: this.name };
    if (s.k < s.d && prevS.k >= prevS.d && s.k > 80) return { type: 'PUT', score: 2, confidence: 69, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 19. MACD CENTER-LINE CROSS ──────────────────────────────────────────────
const macdCenterLine: StrategyModule = { name: 'macdCenter', run(prices) {
    if (prices.length < 28) return null;
    const m = macd(prices);
    const prevHist = m.prevHist;
    if (m.hist > 0 && prevHist <= 0) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (m.hist < 0 && prevHist >= 0) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 20. WILLIAMS %R (14) ────────────────────────────────────────────────────
const williamsR14: StrategyModule = { name: 'williamsR', run(prices) {
    if (prices.length < 18) return null;
    const wr = williamsR(prices, 14);
    const prevWr = williamsR(prices.slice(0, -1), 14);
    if (wr > -80 && prevWr <= -80) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (wr < -20 && prevWr >= -20) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 21. CCI(14) CROSS ──────────────────────────────────────────────────────
const cci14Cross: StrategyModule = { name: 'cci14Cross', run(prices) {
    if (prices.length < 18) return null;
    const c = cci(prices, 14);
    const prevC = cci(prices.slice(0, -1), 14);
    if (c > -100 && prevC <= -100) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (c < 100 && prevC >= 100) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 22. ROC(9) ZERO CROSS ──────────────────────────────────────────────────
const roc9Zero: StrategyModule = { name: 'roc9Zero', run(prices) {
    if (prices.length < 12) return null;
    const r = roc(prices, 9);
    const prevR = roc(prices.slice(0, -1), 9);
    if (r > 0 && prevR <= 0) return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (r < 0 && prevR >= 0) return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 23. AWESOME OSCILLATOR ─────────────────────────────────────────────────
const awesomeOscillator: StrategyModule = { name: 'awesomeOsc', run(prices) {
    if (prices.length < 36) return null;
    const ao = awesomeOsc(prices);
    if (ao.ao > 0 && ao.prevAo <= 0) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (ao.ao < 0 && ao.prevAo >= 0) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 24. MFI (14) MOMENTUM (price-based proxy) ──────────────────────────────
const mfi14: StrategyModule = { name: 'mfi14', run(prices) {
    if (prices.length < 18) return null;
    const slice = prices.slice(-15);
    let posFlow = 0, negFlow = 0;
    for (let i = 1; i < slice.length; i++) {
        const vol = Math.abs(slice[i]) * 10;
        if (slice[i] > slice[i - 1]) posFlow += vol; else negFlow += vol;
    }
    const ratio = negFlow !== 0 ? posFlow / negFlow : 1;
    const mfiVal = 100 - (100 / (1 + ratio));
    const prevSlice = prices.slice(-16, -1);
    let prevPos = 0, prevNeg = 0;
    for (let i = 1; i < prevSlice.length; i++) {
        const vol = Math.abs(prevSlice[i]) * 10;
        if (prevSlice[i] > prevSlice[i - 1]) prevPos += vol; else prevNeg += vol;
    }
    const prevRatio = prevNeg !== 0 ? prevPos / prevNeg : 1;
    const prevMfi = 100 - (100 / (1 + prevRatio));
    if (mfiVal < 20 && mfiVal > prevMfi) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (mfiVal > 80 && mfiVal < prevMfi) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 25. CMO CROSS ──────────────────────────────────────────────────────────
const cmoCross: StrategyModule = { name: 'cmoCross', run(prices) {
    if (prices.length < 12) return null;
    const cmoVal = cmo(prices, 9);
    const prevCmo = cmo(prices.slice(0, -1), 9);
    if (cmoVal > -50 && prevCmo <= -50) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (cmoVal < 50 && prevCmo >= 50) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 26. ULTIMATE OSCILLATOR ────────────────────────────────────────────────
const ultimateOscStrat: StrategyModule = { name: 'ultimateOsc', run(prices) {
    if (prices.length < 30) return null;
    const uo = ultimateOsc(prices);
    const prevUo = ultimateOsc(prices.slice(0, -1));
    if (uo < 30 && uo > prevUo) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (uo > 70 && uo < prevUo) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 27. DPO ZERO CROSS ─────────────────────────────────────────────────────
const dpoCross: StrategyModule = { name: 'dpoCross', run(prices) {
    if (prices.length < 30) return null;
    const dpoVal = dpo(prices, 14);
    const prevDpo = dpo(prices.slice(0, -1), 14);
    if (dpoVal > 0 && prevDpo <= 0) return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (dpoVal < 0 && prevDpo >= 0) return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 28. FISHER TRANSFORM ────────────────────────────────────────────────────
const fisherTransformStrat: StrategyModule = { name: 'fisherTransform', run(prices) {
    if (prices.length < 20) return null;
    const ft = fisherTransform(prices, 9);
    if (ft.fisher > ft.signal && ft.fisher < -1.5) return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
    if (ft.fisher < ft.signal && ft.fisher > 1.5) return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 29. TSI CROSS ──────────────────────────────────────────────────────────
const tsiCross: StrategyModule = { name: 'tsiCross', run(prices) {
    if (prices.length < 50) return null;
    const t = tsi(prices, 25, 13, 7);
    if (t.tsi > t.signal) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (t.tsi < t.signal) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 30. PPO SIGNAL CROSS ───────────────────────────────────────────────────
const ppoCross: StrategyModule = { name: 'ppoCross', run(prices) {
    if (prices.length < 30) return null;
    const p = ppo(prices, 12, 26, 9);
    const hist = p.ppo - p.signal;
    const prevPpo = ppo(prices.slice(0, -1), 12, 26, 9);
    const prevHist = prevPpo.ppo - prevPpo.signal;
    if (hist > 0 && prevHist <= 0) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (hist < 0 && prevHist >= 0) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 31. ENGULFING CANDLE ────────────────────────────────────────────────────
const engulfingCandle: StrategyModule = { name: 'engulfing', run(prices) {
    if (prices.length < 3) return null;
    const cur = prices[prices.length - 1], prev = prices[prices.length - 2];
    const curGreen = cur > prices[prices.length - 2];
    const prevGreen = prev > prices[prices.length - 3];
    const body = Math.abs(cur - prices[prices.length - 2]), prevBody = Math.abs(prev - prices[prices.length - 3]);
    if (curGreen && !prevGreen && body > prevBody * 1.1) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (!curGreen && prevGreen && body > prevBody * 1.1) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 32. INSIDE BAR BREAKOUT ────────────────────────────────────────────────
const insideBarBreakout: StrategyModule = { name: 'insideBarBreakout', run(prices) {
    if (prices.length < 4) return null;
    const range = (i: number) => Math.abs(prices[i] - prices[i - 1]);
    const prevRange = range(prices.length - 2);
    const curRange = range(prices.length - 1);
    const insidePrev = range(prices.length - 3);
    if (curRange > prevRange && curRange > insidePrev) {
        if (prices[prices.length - 1] > prices[prices.length - 2]) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    }
    return null;
}};

// ── 33. PIN BAR REJECTION ──────────────────────────────────────────────────
const pinBarRejection: StrategyModule = { name: 'pinBar', run(prices) {
    if (prices.length < 3) return null;
    const cur = prices[prices.length - 1], prev = prices[prices.length - 2];
    const body = Math.abs(cur - prev);
    if (body === 0) return null;
    const range = Math.abs(cur - prices[Math.max(0, prices.length - 3)]);
    const wick = range - body;
    if (wick >= body * 2) {
        if (cur > prev && cur >= prices[prices.length - 1] - body * 0.75) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        if (cur < prev && cur <= prices[prices.length - 1] + body * 0.75) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    }
    return null;
}};

// ── 34. THREE WHITE SOLDIERS / BLACK CROWS ────────────────────────────────
const threeSoldiersCrows: StrategyModule = { name: 'threeSoldiersCrows', run(prices) {
    if (prices.length < 4) return null;
    const p = prices, n = p.length;
    const g1 = p[n-1] > p[n-2], g2 = p[n-2] > p[n-3], g3 = p[n-3] > p[n-4];
    if (g1 && g2 && g3) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (!g1 && !g2 && !g3) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 35. MARUBOZU ───────────────────────────────────────────────────────────
const marubozu: StrategyModule = { name: 'marubozu', run(prices) {
    if (prices.length < 3) return null;
    const cur = prices[prices.length - 1], prev = prices[prices.length - 2];
    const body = Math.abs(cur - prev);
    const totalRange = Math.abs(cur - prices[Math.max(0, prices.length - 3)]);
    if (body > 0 && totalRange > 0 && body / totalRange > 0.85) {
        if (cur > prev) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    }
    return null;
}};

// ── 36. LOCAL SWING BOUNDARY BREAKOUT ─────────────────────────────────────
const swingBoundaryBreakout: StrategyModule = { name: 'swingBoundary', run(prices) {
    if (prices.length < 52) return null;
    const slice50 = prices.slice(-50);
    const high50 = Math.max(...slice50), low50 = Math.min(...slice50);
    const price = prices[prices.length - 1];
    if (price > high50) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (price < low50) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 37. SUPPLY & DEMAND ZONES ─────────────────────────────────────────────
const supplyDemandZones: StrategyModule = { name: 'supplyDemand', run(prices) {
    if (prices.length < 25) return null;
    const recent = prices.slice(-10);
    const high = Math.max(...recent), low = Math.min(...recent);
    const price = prices[prices.length - 1], prev = prices[prices.length - 2];
    const greenTick = price > prev;
    const lookback = prices.slice(-25, -10);
    const demandZone = Math.min(...lookback);
    const supplyZone = Math.max(...lookback);
    if (price <= demandZone * 1.002 && greenTick) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (price >= supplyZone * 0.998 && !greenTick) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 38. TRENDLINE DEFLECTION ──────────────────────────────────────────────
const trendlineDeflection: StrategyModule = { name: 'trendlineDefl', run(prices) {
    if (prices.length < 15) return null;
    const left = prices.slice(-15, -8);
    const right = prices.slice(-8);
    const slopeL = (left[left.length - 1] - left[0]) / left.length;
    const slopeR = (right[right.length - 1] - right[0]) / right.length;
    const price = prices[prices.length - 1], prev = prices[prices.length - 2];
    const greenClose = price > prev;
    if (slopeL < 0 && slopeR > 0 && greenClose) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (slopeL > 0 && slopeR < 0 && !greenClose) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 39. FIB 61.8% GOLDEN POCKET ───────────────────────────────────────────
const fibGoldenPocket: StrategyModule = { name: 'fibGoldenPocket', run(prices) {
    if (prices.length < 30) return null;
    const lookback = prices.slice(-30);
    const high = Math.max(...lookback), low = Math.min(...lookback);
    const range = high - low;
    if (range === 0) return null;
    const fib618 = low + range * 0.618;
    const price = prices[prices.length - 1], prev = prices[prices.length - 2];
    const greenTick = price > prev;
    // Detect uptrend: recent 10 ticks higher than older 10
    const recent10 = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const older10 = prices.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
    const uptrend = recent10 > older10, downtrend = recent10 < older10;
    if (uptrend && Math.abs(price - fib618) / range < 0.02 && greenTick) return { type: 'CALL', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
    if (downtrend && Math.abs(price - fib618) / range < 0.02 && !greenTick) return { type: 'PUT', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 40. HIGH-VOLUME CLIMAX (price-magnitude proxy) ────────────────────────
const volumeClimax: StrategyModule = { name: 'volumeClimax', run(prices) {
    if (prices.length < 102) return null;
    const slice = prices.slice(-100);
    let maxAbs = 0;
    for (let i = 1; i < slice.length; i++) maxAbs = Math.max(maxAbs, Math.abs(slice[i] - slice[i - 1]));
    const curMove = Math.abs(prices[prices.length - 1] - prices[prices.length - 2]);
    const curGreen = prices[prices.length - 1] > prices[prices.length - 2];
    if (curMove >= maxAbs * 0.95) {
        if (!curGreen) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        if (curGreen) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    }
    return null;
}};

// ── 41. HEIKIN-ASHI COLOR FLOW ────────────────────────────────────────────
const heikinAshiStrat: StrategyModule = { name: 'heikinAshi', run(prices) {
    if (prices.length < 4) return null;
    const ha = heikinAshi(prices);
    const lowerShadow = Math.min(ha.haOpen, ha.haClose) - ha.haLow;
    const upperShadow = ha.haHigh - Math.max(ha.haOpen, ha.haClose);
    if (ha.color === 'GREEN' && ha.prevColor === 'RED' && lowerShadow === 0) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (ha.color === 'RED' && ha.prevColor === 'GREEN' && upperShadow === 0) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 42. ELDER RAY INDEX ───────────────────────────────────────────────────
const elderRayStrat: StrategyModule = { name: 'elderRay', run(prices) {
    if (prices.length < 20) return null;
    const er = elderRay(prices, 13);
    if (er.emaSlope > 0 && er.bullPower < 0 && er.bullPower > -er.bearPower * 1.2) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (er.emaSlope < 0 && er.bearPower > 0 && er.bearPower < -er.bullPower * 1.2) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 43. THREE-LINE STRIKE ─────────────────────────────────────────────────
const threeLineStrike: StrategyModule = { name: 'threeLineStrike', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const g = [p[n-1] > p[n-2], p[n-2] > p[n-3], p[n-3] > p[n-4], p[n-4] > p[n-5]];
    const body4 = Math.abs(p[n-1] - p[n-2]), body3 = Math.abs(p[n-2] - p[n-3]), body2 = Math.abs(p[n-3] - p[n-4]), body1 = Math.abs(p[n-4] - p[n-5]);
    // Three rising then large bear engulfing
    if (g[3] && g[2] && g[1] && !g[0] && body4 > body3 + body2 + body1) return { type: 'PUT', score: 2, confidence: 71, weight: getStrategyWeight(this.name), name: this.name };
    // Three falling then large bull engulfing
    if (!g[3] && !g[2] && !g[1] && g[0] && body4 > body3 + body2 + body1) return { type: 'CALL', score: 2, confidence: 71, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 44. MORNING / EVENING STAR ────────────────────────────────────────────
const morningEveningStar: StrategyModule = { name: 'morningEveningStar', run(prices) {
    if (prices.length < 4) return null;
    const p = prices, n = p.length;
    const body1 = Math.abs(p[n-3] - p[n-4]), body2 = Math.abs(p[n-2] - p[n-3]), body3 = Math.abs(p[n-1] - p[n-2]);
    // Morning: large red, small body, large green closing above midpoint of candle 1
    if (!(p[n-3] > p[n-4]) && body2 < body1 * 0.5 && p[n-1] > p[n-2] && body3 > body1 * 0.7 && p[n-1] > (p[n-3] + p[n-4]) / 2) return { type: 'CALL', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
    // Evening: large green, small body, large red closing below midpoint of candle 1
    if ((p[n-3] > p[n-4]) && body2 < body1 * 0.5 && p[n-1] < p[n-2] && body3 > body1 * 0.7 && p[n-1] < (p[n-3] + p[n-4]) / 2) return { type: 'PUT', score: 3, confidence: 74, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 45. CHOPPINESS INDEX FILTER ──────────────────────────────────────────
const choppinessFilter: StrategyModule = { name: 'choppinessFilter', run(prices) {
    if (prices.length < 25) return null;
    const chop = chopIndex(prices, 14);
    const e5 = ema(prices, 5), e20 = ema(prices, 20);
    if (e5.length < 2 || e20.length < 2) return null;
    const e5c = e5[e5.length - 1], e5p = e5[e5.length - 2];
    const e20c = e20[e20.length - 1], e20p = e20[e20.length - 2];
    if (chop < 38 && e5c > e20c && e5p <= e20p) return { type: 'CALL', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
    if (chop < 38 && e5c < e20c && e5p >= e20p) return { type: 'PUT', score: 2, confidence: 70, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 46. SEQUENTIAL TICK FATIGUE ───────────────────────────────────────────
const sequentialTickFatigue: StrategyModule = { name: 'tickFatigue', run(prices) {
    if (prices.length < 6) return null;
    const streak = priceStreak(prices);
    if (streak === -5) return { type: 'CALL', score: 3, confidence: 75, weight: getStrategyWeight(this.name), name: this.name };
    if (streak === 5) return { type: 'PUT', score: 3, confidence: 75, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 47. TICK VELOCITY STD DEV SHOCK ──────────────────────────────────────
const tickVelocityShock: StrategyModule = { name: 'tickVelocityShock', run(prices) {
    if (prices.length < 102) return null;
    const slice = prices.slice(-100);
    const diffs: number[] = [];
    for (let i = 1; i < slice.length; i++) diffs.push(Math.abs(slice[i] - slice[i - 1]));
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length;
    const std = Math.sqrt(variance);
    const curMove = prices[prices.length - 1] - prices[prices.length - 2];
    const curGreen = curMove > 0;
    if (!curGreen && Math.abs(curMove) > 3 * std) return { type: 'CALL', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
    if (curGreen && Math.abs(curMove) > 3 * std) return { type: 'PUT', score: 3, confidence: 76, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 48. MULTI-TIMEFRAME CONVERGENCE ──────────────────────────────────────
const multiTFConvergence: StrategyModule = { name: 'multiTFConv', run(prices) {
    if (prices.length < 20) return null;
    const hmaVal = hmaArr(prices, 5);
    if (hmaVal.length < 2) return null;
    const hmaUp = hmaVal[hmaVal.length - 1] > hmaVal[hmaVal.length - 2];
    const last2Green = prices[prices.length - 1] > prices[prices.length - 2];
    if (last2Green && hmaUp) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (!last2Green && !hmaUp) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 49. LAST-DIGIT STRUCTURAL DISEQUILIBRIUM ────────────────────────────
const lastDigitDisequilibrium: StrategyModule = { name: 'lastDigitDis', run(prices) {
    if (prices.length < 7) return null;
    const digits = prices.slice(-6).map(v => Math.round(Math.abs(v * 100000)) % 10);
    const even = digits.map(d => d % 2 === 0);
    const allEven = even.every(Boolean);
    const allOdd = even.every(v => !v);
    if (allEven) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (allOdd) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 50. 3-TICK MICRO CHANNEL INVERSION ───────────────────────────────────
const microChannelInversion: StrategyModule = { name: 'microChannelInv', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const descending = p[n-2] < p[n-3] && p[n-3] < p[n-4];
    const ascending = p[n-2] > p[n-3] && p[n-3] > p[n-4];
    if (descending && p[n-1] > p[n-2]) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (ascending && p[n-1] < p[n-2]) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 51. VIRTUAL-LOSS SEQUENCING ──────────────────────────────────────────
const virtualLossSequencing: StrategyModule = { name: 'virtualLossSeq', run(prices) {
    // Returns signal aligned with underlying core — but confidence is low
    // since the actual VH tracking is in market-killer.tsx
    if (prices.length < 5) return null;
    const streak = priceStreak(prices);
    const rsiVal = rsi(prices, 7);
    if (streak <= -2 && rsiVal < 40) return { type: 'CALL', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
    if (streak >= 2 && rsiVal > 60) return { type: 'PUT', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 52. DYNAMIC PIVOT S1/R1 DEFLECTION ───────────────────────────────────
const dynamicPivot: StrategyModule = { name: 'dynamicPivot', run(prices) {
    if (prices.length < 25) return null;
    const slice = prices.slice(-24);
    const high = Math.max(...slice), low = Math.min(...slice), close = prices[prices.length - 1];
    const pivot = (high + low + close) / 3;
    const r1 = 2 * pivot - low, s1 = 2 * pivot - high;
    const prev = prices[prices.length - 2];
    const greenTick = close > prev;
    if (close <= s1 * 1.002 && greenTick) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (close >= r1 * 0.998 && !greenTick) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 53. COPPOCK CURVE ────────────────────────────────────────────────────
const coppockCurveStrat: StrategyModule = { name: 'coppockCurve', run(prices) {
    if (prices.length < 35) return null;
    const cc = coppock(prices);
    const prevCc = coppock(prices.slice(0, -1));
    if (cc > 0 && prevCc <= 0) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (cc < 0 && prevCc >= 0) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 54. VORTEX INDICATOR ─────────────────────────────────────────────────
const vortexIndicator: StrategyModule = { name: 'vortex', run(prices) {
    if (prices.length < 18) return null;
    const vi = vortex(prices, 14);
    const prevVi = vortex(prices.slice(0, -1), 14);
    if (vi.plusVI > vi.minusVI && prevVi.plusVI <= prevVi.minusVI) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (vi.minusVI > vi.plusVI && prevVi.minusVI <= prevVi.plusVI) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 55. CENTER OF GRAVITY ────────────────────────────────────────────────
const centerOfGravity: StrategyModule = { name: 'centerOfGravity', run(prices) {
    if (prices.length < 15) return null;
    const cg = cog(prices, 10);
    const prevCg = cog(prices.slice(0, -1), 10);
    if (cg > prevCg && cg < -2) return { type: 'CALL', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (cg < prevCg && cg > 2) return { type: 'PUT', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 56. SCHAFF TREND CYCLE ───────────────────────────────────────────────
const schaffTrendCycle: StrategyModule = { name: 'schaffTC', run(prices) {
    if (prices.length < 55) return null;
    const stcVal = stc(prices, 23, 50, 10);
    const prevStc = stc(prices.slice(0, -1), 23, 50, 10);
    if (stcVal > 25 && prevStc <= 25) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (stcVal < 75 && prevStc >= 75) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 57. TTM SQUEEZE ──────────────────────────────────────────────────────
const ttmSqueeze: StrategyModule = { name: 'ttmSqueeze', run(prices) {
    if (prices.length < 22) return null;
    // BB width vs Keltner width
    const slice20 = prices.slice(-20);
    const mean = slice20.reduce((a, b) => a + b, 0) / 20;
    const std = Math.sqrt(slice20.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    const bbWidth = 4 * std;
    const kc = keltner(prices, 20, 1.5);
    const kcWidth = kc.upper - kc.lower;
    const squeezed = bbWidth < kcWidth;
    const curGreen = prices[prices.length - 1] > prices[prices.length - 2];
    if (squeezed && curGreen) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (squeezed && !curGreen) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 58. CONNORS RSI ──────────────────────────────────────────────────────
const connorsRSIStrat: StrategyModule = { name: 'connorsRSI', run(prices) {
    if (prices.length < 12) return null;
    const crsi = connorsRSI(prices, 3);
    if (crsi < 5) return { type: 'CALL', score: 3, confidence: 78, weight: getStrategyWeight(this.name), name: this.name };
    if (crsi > 95) return { type: 'PUT', score: 3, confidence: 78, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 59. KLINGER OSCILLATOR ───────────────────────────────────────────────
const klingerOscStrat: StrategyModule = { name: 'klingerOsc', run(prices) {
    if (prices.length < 60) return null;
    const ko = klingerOsc(prices, 34, 55);
    const prevKo = klingerOsc(prices.slice(0, -1), 34, 55);
    if (ko.klinger > ko.signal && prevKo.klinger <= prevKo.signal) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (ko.klinger < ko.signal && prevKo.klinger >= prevKo.signal) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 60. VOLUME PROFILE POC REJECTION ─────────────────────────────────────
const volumePOC: StrategyModule = { name: 'volumePOC', run(prices) {
    if (prices.length < 30) return null;
    const slice = prices.slice(-20);
    // Find the price level with highest "volume" (density of ticks)
    const priceLevels = new Map<number, number>();
    slice.forEach(v => { priceLevels.set(v, (priceLevels.get(v) || 0) + 1); });
    let poc = 0, maxFreq = 0;
    for (const [price, freq] of priceLevels) { if (freq > maxFreq) { maxFreq = freq; poc = price; } }
    const cur = prices[prices.length - 1], prev = prices[prices.length - 2];
    const greenTick = cur > prev;
    if (cur <= poc && greenTick && cur > poc * 0.998) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (cur >= poc && !greenTick && cur < poc * 1.002) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 61. 3-TICK MICRO-VELOCITY BOUNCE ─────────────────────────────────────
const microVelocityBounce: StrategyModule = { name: 'microVeloBounce', run(prices) {
    if (prices.length < 4) return null;
    const p = prices, n = p.length;
    const allRed = p[n-4] >= p[n-3] && p[n-3] >= p[n-2];
    const allGreen = p[n-4] <= p[n-3] && p[n-3] <= p[n-2];
    if (allRed && p[n-1] - p[n-2] >= 0.05) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (allGreen && p[n-2] - p[n-1] >= 0.05) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 62. 4-TICK TREND AVALANCHE ───────────────────────────────────────────
const trendAvalanche: StrategyModule = { name: 'trendAvalanche', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    if (p[n-1] > p[n-2] && p[n-2] > p[n-3] && p[n-3] > p[n-4] && p[n-4] > p[n-5]) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] < p[n-2] && p[n-2] < p[n-3] && p[n-3] < p[n-4] && p[n-4] < p[n-5]) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 63. ALTERNATING TICK FATIGUE ─────────────────────────────────────────
const alternatingFatigue: StrategyModule = { name: 'altFatigue', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const g = (i: number) => p[i] > p[i-1];
    if (g(n-1) && !g(n-2) && g(n-3) && !g(n-4)) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (!g(n-1) && g(n-2) && !g(n-3) && g(n-4)) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 64. TICK-TO-TICK VELOCITY ACCELERATION ───────────────────────────────
const velocityAcceleration: StrategyModule = { name: 'veloAccel', run(prices) {
    if (prices.length < 4) return null;
    const p = prices, n = p.length;
    const d1 = p[n-1] - p[n-2], d2 = p[n-2] - p[n-3];
    if (d1 > 0 && d2 > 0 && d1 > 2 * d2) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (d1 < 0 && d2 < 0 && -d1 > 2 * -d2) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 65. 2-PERIOD MICRO-SMA CROSS ─────────────────────────────────────────
const microSMACross: StrategyModule = { name: 'microSMACross', run(prices) {
    if (prices.length < 6) return null;
    const p = prices, n = p.length;
    const sma2Cur = (p[n-1] + p[n-2]) / 2, sma2Prev = (p[n-2] + p[n-3]) / 2;
    const sma4Cur = (p[n-1] + p[n-2] + p[n-3] + p[n-4]) / 4, sma4Prev = (p[n-2] + p[n-3] + p[n-4] + p[n-5]) / 4;
    if (sma2Prev <= sma4Prev && sma2Cur > sma4Cur) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (sma2Prev >= sma4Prev && sma2Cur < sma4Cur) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 66. MICRO-RANGE COMPRESSION ESCAPE ───────────────────────────────────
const rangeCompressionEscape: StrategyModule = { name: 'rangeCompress', run(prices) {
    if (prices.length < 6) return null;
    const p = prices, n = p.length;
    const slice = p.slice(-6);
    const mean = slice.reduce((a, b) => a + b, 0) / 6;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 6;
    const hi = Math.max(...slice), lo = Math.min(...slice);
    if (variance < 0.03 && p[n-1] > hi) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (variance < 0.03 && p[n-1] < lo) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 67. 5-TICK ABSORPTION SETUP ──────────────────────────────────────────
const absorptionSetup: StrategyModule = { name: 'absorptionSetup', run(prices) {
    if (prices.length < 6) return null;
    const p = prices, n = p.length;
    const drop4 = p[n-5] > p[n-4] && p[n-4] > p[n-3] && p[n-3] > p[n-2] && p[n-2] > p[n-1];
    const rise4 = p[n-5] < p[n-4] && p[n-4] < p[n-3] && p[n-3] < p[n-2] && p[n-2] < p[n-1];
    if (drop4 && p[n-1] === p[n-2]) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (rise4 && p[n-1] === p[n-2]) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 68. ZERO-MAGNET EDGE REJECTION ───────────────────────────────────────
const zeroMagnetEdge: StrategyModule = { name: 'zeroMagnetEdge', run(prices) {
    if (prices.length < 3) return null;
    const p = prices, n = p.length;
    const endsWith00 = (v: number) => Math.round(Math.abs(v * 100)) % 100 === 0;
    if (endsWith00(p[n-2]) && p[n-1] > p[n-2]) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (endsWith00(p[n-2]) && p[n-1] < p[n-2]) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 69. LAST-DIGIT CUMULATIVE IMBALANCE ──────────────────────────────────
const lastDigitCumulativeImbalance: StrategyModule = { name: 'lastDigitImbal', run(prices) {
    if (prices.length < 6) return null;
    const digits = prices.slice(-6).map(v => Math.round(Math.abs(v * 100000)) % 10);
    const low = digits.every(d => d <= 2);
    const high = digits.every(d => d >= 7);
    if (low) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (high) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 70. DIGIT PATTERN TWIN REVERSAL ──────────────────────────────────────
const digitPatternTwinReversal: StrategyModule = { name: 'digitTwinRev', run(prices) {
    if (prices.length < 3) return null;
    const p = prices, n = p.length;
    const lastDigit = (v: number) => Math.round(Math.abs(v * 100000)) % 10;
    const d1 = lastDigit(p[n-2]), d0 = lastDigit(p[n-1]);
    if (d1 === d0 && p[n-1] < p[n-2]) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (d1 === d0 && p[n-1] > p[n-2]) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 71. 3-PERIOD HYPER-RSI ───────────────────────────────────────────────
const hyperRSI: StrategyModule = { name: 'hyperRSI', run(prices) {
    if (prices.length < 5) return null;
    const rsi3 = rsi(prices, 3);
    if (rsi3 < 10) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (rsi3 > 90) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 72. 5-TICK STOCHASTIC MICRO-FRACTIONAL CROSS ─────────────────────────
const microStochasticCross: StrategyModule = { name: 'microStochCross', run(prices) {
    if (prices.length < 10) return null;
    const s = stoch(prices, 5, 3);
    if (s.k < 5 && s.d < 5 && s.k > s.d) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (s.k > 95 && s.d > 95 && s.k < s.d) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 73. TICK PRICE-TO-EMA EXTREME DIVERGENCE ─────────────────────────────
const priceToEMAExtreme: StrategyModule = { name: 'priceEMAExtreme', run(prices) {
    if (prices.length < 7) return null;
    const ema5 = ema(prices, 5);
    if (ema5.length === 0) return null;
    const cur = prices[prices.length - 1], emaVal = ema5[ema5.length - 1];
    const avg = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const pct = avg !== 0 ? Math.abs(cur - emaVal) / avg * 100 : 0;
    if (cur < emaVal && pct > 0.5) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (cur > emaVal && pct > 0.5) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 74. 3-TICK ROC ZERO INVERSION ────────────────────────────────────────
const microROCZeroInversion: StrategyModule = { name: 'microROCZero', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const roc3 = (p[n-1] - p[n-4]) / (p[n-4] || 1);
    const roc3Prev = (p[n-2] - p[n-5]) / (p[n-5] || 1);
    if (roc3Prev < 0 && roc3 > 0) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (roc3Prev > 0 && roc3 < 0) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 75. MICRO BOLLINGER BAND WICK-OUT (10,2) ─────────────────────────────
const microBBWickOut: StrategyModule = { name: 'microBBWick', run(prices) {
    if (prices.length < 12) return null;
    const p = prices, n = p.length;
    const slice = p.slice(-10);
    const mean = slice.reduce((a, b) => a + b, 0) / 10;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 10);
    const upper = mean + 2 * std, lower = mean - 2 * std;
    if (p[n-1] < lower) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] > upper) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 76. DOUBLE-TICK BOTTOM REVERSAL ──────────────────────────────────────
const doubleTickBottomReversal: StrategyModule = { name: 'doubleTickBottom', run(prices) {
    if (prices.length < 4) return null;
    const p = prices, n = p.length;
    if (p[n-3] === p[n-2] && p[n-1] > p[n-2]) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-3] === p[n-2] && p[n-1] < p[n-2]) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 77. MICRO DONCHIAN 4-TICK BREAKOUT ───────────────────────────────────
const microDonchianBreakout: StrategyModule = { name: 'microDonchian', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const hi = Math.max(p[n-5], p[n-4], p[n-3], p[n-2]);
    const lo = Math.min(p[n-5], p[n-4], p[n-3], p[n-2]);
    if (p[n-1] > hi) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] < lo) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 78. 3-TICK CHANDE MOMENTUM SHOCK ─────────────────────────────────────
const microCMOShock: StrategyModule = { name: 'microCMOShock', run(prices) {
    if (prices.length < 5) return null;
    const cmo3 = cmo(prices, 3);
    if (cmo3 <= -99) return { type: 'CALL', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    if (cmo3 >= 99) return { type: 'PUT', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 79. MICRO HULL DERIVATIVE SWAP (3/6) ─────────────────────────────────
const microHullSwap: StrategyModule = { name: 'microHullSwap', run(prices) {
    if (prices.length < 10) return null;
    const h3 = hmaArr(prices, 3);
    const h6 = hmaArr(prices, 6);
    if (h3.length < 3 || h6.length < 3) return null;
    const n = h3.length, m = h6.length;
    if (h3[n-2] <= h6[m-2] && h3[n-1] > h6[m-1]) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (h3[n-2] >= h6[m-2] && h3[n-1] < h6[m-1]) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 80. JUMP INDEX GAP REBALANCING ───────────────────────────────────────
const jumpIndexGap: StrategyModule = { name: 'jumpIndexGap', run(prices) {
    if (prices.length < 3) return null;
    const p = prices, n = p.length;
    const gap = p[n-1] - p[n-2];
    if (gap < -0.1) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (gap > 0.1) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 81. TICK DECELERATION EXHAUSTION ─────────────────────────────────────
const tickDecelerationExhaustion: StrategyModule = { name: 'tickDecelExh', run(prices) {
    if (prices.length < 4) return null;
    const p = prices, n = p.length;
    const d1 = p[n-3] - p[n-2], d2 = p[n-2] - p[n-1];
    if (d1 > 0 && d2 < 0 && Math.abs(d2) < Math.abs(d1) * 0.2) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (d1 < 0 && d2 > 0 && Math.abs(d2) < Math.abs(d1) * 0.2) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 82. 5-PERIOD WILLIAMS %R CORE THRESHOLD ──────────────────────────────
const microWilliamsR: StrategyModule = { name: 'microWilliamsR', run(prices) {
    if (prices.length < 7) return null;
    const wr = williamsR(prices, 5);
    if (wr < -95) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (wr > -5) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 83. 4-TICK SCALPER PIVOT ─────────────────────────────────────────────
const fourTickScalperPivot: StrategyModule = { name: 'scalperPivot', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const allRed = p[n-4] >= p[n-3] && p[n-3] >= p[n-2];
    const allGreen = p[n-4] <= p[n-3] && p[n-3] <= p[n-2];
    if (allRed && Math.abs(p[n-1] - p[n-4]) < 0.001) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (allGreen && Math.abs(p[n-1] - p[n-4]) < 0.001) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 84. MICRO COMMODITY CHANNEL PULSE (4) ────────────────────────────────
const microCCIPulse: StrategyModule = { name: 'microCCIPulse', run(prices) {
    if (prices.length < 6) return null;
    const cci4 = cci(prices, 4);
    if (cci4 < -150) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (cci4 > 150) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 85. EVEN/ODD CONSECUTIVE IMBALANCE ──────────────────────────────────
const evenOddConsecImbalance: StrategyModule = { name: 'evenOddConsec', run(prices) {
    if (prices.length < 6) return null;
    const digits = prices.slice(-6).map(v => Math.round(Math.abs(v * 100000)) % 10);
    const odd5 = digits.slice(0, 5).every(d => d % 2 === 1);
    const even5 = digits.slice(0, 5).every(d => d % 2 === 0);
    if (odd5) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (even5) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 86. LINEAR REGRESSION 3-TICK SLOPE CROSS ─────────────────────────────
const linregSlopeCross: StrategyModule = { name: 'linregSlopeCross', run(prices) {
    if (prices.length < 5) return null;
    const slope = linregSlope(prices, 3);
    if (slope > 0) return { type: 'CALL', score: 1, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (slope < 0) return { type: 'PUT', score: 1, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 87. FAST WMA (3) VS PRICE STEP ───────────────────────────────────────
const fastWMAvPrice: StrategyModule = { name: 'fastWMAvPrice', run(prices) {
    if (prices.length < 5) return null;
    const wma3 = wmaArr(prices, 3);
    if (wma3.length === 0) return null;
    const cur = prices[prices.length - 1], wmaVal = wma3[wma3.length - 1];
    if (cur - wmaVal >= 0.2) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (wmaVal - cur >= 0.2) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 88. MICRO-KELTNER OVER-EXTENSION (5,1,ATR5) ──────────────────────────
const microKeltnerOverExt: StrategyModule = { name: 'microKeltnerExt', run(prices) {
    if (prices.length < 8) return null;
    const p = prices, n = p.length;
    const tr5 = Math.max(p[n-1], p[n-2]) - Math.min(p[n-1], p[n-2]);
    const atr5Vals = prices.slice(-6).map((_, i, a) => i < 1 ? 0 : Math.max(a[i], a[i-1]) - Math.min(a[i], a[i-1]));
    const atr5 = atr5Vals.slice(-5).reduce((a, b) => a + b, 0) / 5 || 0.001;
    const avg = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const upper = avg + atr5, lower = avg - atr5;
    if (p[n-1] < lower) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] > upper) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 89. TICK VOLUME DELTA DIVERGENCE ─────────────────────────────────────
const tickVolumeDeltaDivergence: StrategyModule = { name: 'tickVolDelta', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const greenTicks = p.slice(-5).filter((_, i, a) => i > 0 && a[i] > a[i-1]).length;
    if (p[n-1] < p[n-2] && greenTicks >= 3) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] > p[n-2] && greenTicks <= 1) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 90. 4-TICK STEP INDEX SYMMETRY ──────────────────────────────────────
const stepIndexSymmetry: StrategyModule = { name: 'stepIndexSym', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const drop3 = p[n-4] - p[n-3] === 1 && p[n-3] - p[n-2] === 1 && p[n-2] - p[n-1] === 1;
    const rise3 = p[n-4] - p[n-3] === -1 && p[n-3] - p[n-2] === -1 && p[n-2] - p[n-1] === -1;
    if (drop3) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (rise3) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 91. AWESOME OSCILLATOR MICRO-BAR FLIP ────────────────────────────────
const awesomeOscMicroBarFlip: StrategyModule = { name: 'awesomeMicroBar', run(prices) {
    if (prices.length < 5) return null;
    const ao = awesomeOsc(prices);
    if (ao.ao < 0 && ao.ao > ao.prevAo) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (ao.ao > 0 && ao.ao < ao.prevAo) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 92. 2-TICK SEQUENTIAL SHOCK TRAP ─────────────────────────────────────
const sequentialShockTrap: StrategyModule = { name: 'seqShockTrap', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const slice = p.slice(-6);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length) || 0.001;
    const z1 = (p[n-2] - mean) / std, z2 = (p[n-1] - mean) / std;
    if (z1 <= -2 && z2 <= -2) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (z1 >= 2 && z2 >= 2) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 93. TRUE STRENGTH INDEX (TSI) HYPER-CROSS (3,3) ──────────────────────
const tsiHyperCross: StrategyModule = { name: 'tsiHyperCross', run(prices) {
    if (prices.length < 12) return null;
    const t = tsi(prices, 3, 3, 3);
    if (t.tsi > t.signal) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (t.tsi < t.signal) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 94. MICRO-FISHER TRANSFORM SIGNAL (4) ────────────────────────────────
const microFisherSignal: StrategyModule = { name: 'microFisherSig', run(prices) {
    if (prices.length < 8) return null;
    const f = fisherTransform(prices, 4);
    if (f.fisher < -2 && f.fisher > f.signal) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (f.fisher > 2 && f.fisher < f.signal) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 95. TICK CHANNEL MIDLINE REJECTION ──────────────────────────────────
const tickChannelMidlineRejection: StrategyModule = { name: 'channelMidline', run(prices) {
    if (prices.length < 12) return null;
    const p = prices, n = p.length;
    const slice = p.slice(-10);
    const mid = (Math.max(...slice) + Math.min(...slice)) / 2;
    const trendUp = p[n-4] < p[n-3] && p[n-3] < p[n-2];
    const trendDn = p[n-4] > p[n-3] && p[n-3] > p[n-2];
    if (trendUp && Math.abs(p[n-2] - mid) < 0.01 && p[n-1] > p[n-2]) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (trendDn && Math.abs(p[n-2] - mid) < 0.01 && p[n-1] < p[n-2]) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 96. DETRENDED PRICE OSCILLATOR (DPO) 4-PERIOD BURST ──────────────────
const dpoBurst: StrategyModule = { name: 'dpoBurst', run(prices) {
    if (prices.length < 10) return null;
    const d = dpo(prices, 4);
    if (d > 0) return { type: 'CALL', score: 1, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (d < 0) return { type: 'PUT', score: 1, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 97. 3-TICK CONNOR'S RSI EXTREME FADE ─────────────────────────────────
const connorsRSIExtremeFade: StrategyModule = { name: 'connorsExtreme', run(prices) {
    if (prices.length < 8) return null;
    const crsi = connorsRSI(prices, 3);
    if (crsi < 2) return { type: 'CALL', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    if (crsi > 98) return { type: 'PUT', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 98. LAST-DIGIT SEQUENTIAL MIRRORING ──────────────────────────────────
const lastDigitSequentialMirror: StrategyModule = { name: 'lastDigitMirror', run(prices) {
    if (prices.length < 4) return null;
    const ld = (v: number) => Math.round(Math.abs(v * 100000)) % 10;
    const p = prices, n = p.length;
    const d3 = ld(p[n-3]), d2 = ld(p[n-2]), d1 = ld(p[n-1]);
    if (d3 === 1 && d2 === 2 && d1 === 1 && p[n-1] < p[n-2]) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (d3 === 9 && d2 === 8 && d1 === 9 && p[n-1] > p[n-2]) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 99. 5-TICK PIVOT POINT SCALPER ──────────────────────────────────────
const pivotPointScalper: StrategyModule = { name: 'pivotScalper', run(prices) {
    if (prices.length < 7) return null;
    const p = prices, n = p.length;
    const hi = Math.max(p[n-6], p[n-5], p[n-4], p[n-3], p[n-2]);
    const lo = Math.min(p[n-6], p[n-5], p[n-4], p[n-3], p[n-2]);
    if (p[n-1] < lo && p[n-1] > p[n-2]) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] > hi && p[n-1] < p[n-2]) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 100. MICRO-EXPONENTIAL TRIX CROSS (4) ─────────────────────────────────
const microTrixCross: StrategyModule = { name: 'microTrixCross', run(prices) {
    if (prices.length < 16) return null;
    const t = trix(prices, 4);
    if (t.trix > t.signal && t.prevTrix <= t.signal) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (t.trix < t.signal && t.prevTrix >= t.signal) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 101. PERCENTAGE PRICE OSCILLATOR (PPO) TICK FLASH (2,5) ──────────────
const ppoTickFlash: StrategyModule = { name: 'ppoTickFlash', run(prices) {
    if (prices.length < 10) return null;
    const pp = ppo(prices, 2, 5, 3);
    if (pp.signal > 0 && pp.ppo > 0) return { type: 'CALL', score: 1, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    if (pp.signal < 0 && pp.ppo < 0) return { type: 'PUT', score: 1, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 102. 4-TICK MEAN-REVERSION BAND STRETCH ──────────────────────────────
const meanReversionBandStretch: StrategyModule = { name: 'mrBandStretch', run(prices) {
    if (prices.length < 55) return null;
    const p = prices, n = p.length;
    const sma4 = sma(prices, 4);
    if (sma4.length === 0) return null;
    const curSma = sma4[sma4.length - 1], curP = p[n-1];
    let maxDist = 0;
    for (let i = Math.max(0, n - 50); i < n; i++) {
        const idx = i - (n - sma4.length);
        if (idx >= 0 && idx < sma4.length) maxDist = Math.max(maxDist, Math.abs(p[i] - sma4[idx]));
    }
    const dist = Math.abs(curP - curSma);
    if (dist > maxDist * 0.95 && curP < curSma) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (dist > maxDist * 0.95 && curP > curSma) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 103. 3-TICK PARABOLIC FLIT (0.1, 0.5) ────────────────────────────────
const parabolicFlit: StrategyModule = { name: 'parabolicFlit', run(prices) {
    if (prices.length < 6) return null;
    const ps = parabolicSar(prices, 0.1, 0.5);
    if (ps.flipped && !ps.above) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (ps.flipped && ps.above) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 104. INSIDE-TICK CHANNEL BREAKOUT ────────────────────────────────────
const insideTickChannelBreakout: StrategyModule = { name: 'insideTickBreak', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const hi = Math.max(p[n-3], p[n-2]), lo = Math.min(p[n-3], p[n-2]);
    const prevHi = p[n-4], prevLo = p[n-4];
    if (p[n-1] > prevHi && p[n-3] <= prevHi && p[n-2] <= prevHi) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] < prevLo && p[n-3] >= prevLo && p[n-2] >= prevLo) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 105. 5-PERIOD CHAIKIN OSCILLATOR CROSS ───────────────────────────────
const chaikinOscCross: StrategyModule = { name: 'chaikinOscCross', run(prices) {
    if (prices.length < 14) return null;
    const co = chaikinOsc(prices, 3, 10);
    if (co === 1) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (co === -1) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 106. MICRO-ENVELOPE BAND INVERSION (5, 0.1%) ─────────────────────────
const microEnvelopeBandInv: StrategyModule = { name: 'microEnvelope', run(prices) {
    if (prices.length < 7) return null;
    const env = envelope(prices, 5, 0.1);
    const cur = prices[prices.length - 1];
    if (cur <= env.lower) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (cur >= env.upper) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 107. 3-TICK VOLUME-WEIGHTED MOMENTUM CROSS (2/5) ─────────────────────
const microVWAPCrossover: StrategyModule = { name: 'microVWAPCross', run(prices) {
    if (prices.length < 7) return null;
    const p = prices, n = p.length;
    const vwap2 = (p[n-1] + p[n-2]) / 2;
    const vwap5 = (p[n-1] + p[n-2] + p[n-3] + p[n-4] + p[n-5]) / 5;
    const vwap2p = (p[n-2] + p[n-3]) / 2;
    const vwap5p = (p[n-2] + p[n-3] + p[n-4] + p[n-5] + p[n-6]) / 5;
    if (vwap2p <= vwap5p && vwap2 > vwap5) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (vwap2p >= vwap5p && vwap2 < vwap5) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 108. ULTIMATE OSCILLATOR 3-PERIOD EXHAUSTION ─────────────────────────
const ultimateOscExhaustion: StrategyModule = { name: 'ultimateOscExh', run(prices) {
    if (prices.length < 8) return null;
    const uo = ultimateOsc(prices);
    if (uo < 15) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (uo > 85) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 109. HIGH-FREQUENCY MASS INDEX EXPANSION (9) ─────────────────────────
const massIndexExpansion: StrategyModule = { name: 'massIndexExp', run(prices) {
    if (prices.length < 14) return null;
    const mi = massIndex(prices, 9);
    const p = prices, n = p.length;
    if (mi > 27 && p[n-1] > p[n-2]) return { type: 'CALL', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    if (mi > 27 && p[n-1] < p[n-2]) return { type: 'PUT', score: 2, confidence: 65, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 110. MICRO HEIKIN-ASHI 2-TICK CONTINUATION ──────────────────────────
const microHeikinAshiContinuation: StrategyModule = { name: 'microHACont', run(prices) {
    if (prices.length < 5) return null;
    const p = prices, n = p.length;
    const ha = heikinAshi(prices.slice(-4));
    if (ha.color === 'GREEN' && ha.prevColor === 'GREEN' && ha.haLow === ha.haOpen) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (ha.color === 'RED' && ha.prevColor === 'RED' && ha.haHigh === ha.haOpen) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

// ── 111. 3-TICK MICRO CLOUD ESCAPE (5-period Kumo) ───────────────────────
const microCloudEscape: StrategyModule = { name: 'microCloudEscape', run(prices) {
    if (prices.length < 10) return null;
    const p = prices, n = p.length;
    const slice = p.slice(-7);
    const tenkan = (Math.max(...slice.slice(-3)) + Math.min(...slice.slice(-3))) / 2;
    const kijun = (Math.max(...slice) + Math.min(...slice)) / 2;
    const spanA = (tenkan + kijun) / 2;
    const spanB = (Math.max(...p.slice(-10)) + Math.min(...p.slice(-10))) / 2;
    const kumoHi = Math.max(spanA, spanB), kumoLo = Math.min(spanA, spanB);
    if (p[n-1] > kumoHi && p[n-2] <= kumoHi) return { type: 'CALL', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    if (p[n-1] < kumoLo && p[n-2] >= kumoLo) return { type: 'PUT', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
    return null;
}};

const riseFallStrategies: StrategyModule[] = [
    microTiming, rsiDivergence, macdStrategy, bbStrategy,
    stochasticStrategy, atrBreakout, priceAction, maCross,
    meanReversion, cciStrategy, zlemaStrategy, keltnerStrategy,
    rocStrategy, fractalEfficiency, digitPsychology, candleReversal,
    doubleTopBottom, exhaustionRev, pivotReversal, tickVelocity,
    fibonacciRetrace, statisticalExtreme,
    nPatternMatch, hlSequence, volContraction, mtfAlignment, barPatternSeq,
    tickPressure, accelMomentum, microTrendStrength, supportBounce,
    tickDivergence, consecGap, tripleMA, microPattern3, tickEntropy,
    rsiDirection, bbTouch, emaCross5_10,
    sma20Cross, ema50Filter, hma9Slope, supertrendStrat, parabolicSarStrat,
    ichimokuKijun, vwapBreak, bbStructuralEscape, keltner20, donchian20,
    adxDI, linregSlope14, wmaCross5_15, almaStrat, stdDevChannel,
    rsi14Baseline, rsi9Hyper, stoch14, macdCenterLine, williamsR14,
    cci14Cross, roc9Zero, awesomeOscillator, mfi14, cmoCross,
    ultimateOscStrat, dpoCross, fisherTransformStrat, tsiCross, ppoCross,
    engulfingCandle, insideBarBreakout, pinBarRejection, threeSoldiersCrows,
    marubozu, swingBoundaryBreakout, supplyDemandZones, trendlineDeflection,
    fibGoldenPocket, volumeClimax, heikinAshiStrat, elderRayStrat,
    threeLineStrike, morningEveningStar, choppinessFilter, sequentialTickFatigue,
    tickVelocityShock, multiTFConvergence, lastDigitDisequilibrium,
    microChannelInversion, virtualLossSequencing, dynamicPivot,
    coppockCurveStrat, vortexIndicator, centerOfGravity, schaffTrendCycle,
    ttmSqueeze, connorsRSIStrat, klingerOscStrat, volumePOC,
    microVelocityBounce, trendAvalanche, alternatingFatigue, velocityAcceleration,
    microSMACross, rangeCompressionEscape, absorptionSetup, zeroMagnetEdge,
    lastDigitCumulativeImbalance, digitPatternTwinReversal, hyperRSI,
    microStochasticCross, priceToEMAExtreme, microROCZeroInversion, microBBWickOut,
    doubleTickBottomReversal, microDonchianBreakout, microCMOShock, microHullSwap,
    jumpIndexGap, tickDecelerationExhaustion, microWilliamsR, fourTickScalperPivot,
    microCCIPulse, evenOddConsecImbalance, linregSlopeCross, fastWMAvPrice,
    microKeltnerOverExt, tickVolumeDeltaDivergence, stepIndexSymmetry,
    awesomeOscMicroBarFlip, sequentialShockTrap, tsiHyperCross, microFisherSignal,
    tickChannelMidlineRejection, dpoBurst, connorsRSIExtremeFade, lastDigitSequentialMirror,
    pivotPointScalper, microTrixCross, ppoTickFlash, meanReversionBandStretch,
    parabolicFlit, insideTickChannelBreakout, chaikinOscCross, microEnvelopeBandInv,
    microVWAPCrossover, ultimateOscExhaustion, massIndexExpansion, microHeikinAshiContinuation,
    microCloudEscape,
];

/* ═══════════════════════════════════════════════════════════════════════════════
   OVER/UNDER STRATEGIES
   Uses 100/200-tick digit percentages (like Deriv's Over/Under tab).
   Barriers 0-4 for Over, 1-6 for Under.
   Confidences reflect true expected value (prob × payout), not raw probability.
═══════════════════════════════════════════════════════════════════════════════ */

const OVER_BARRIERS = [2, 3, 4] as const;
const UNDER_BARRIERS = [1, 2, 3, 4, 5, 6] as const;

// Value-based barrier scoring: picks barrier with best prob × payout tradeoff
// Sweet spot: 55-68% probability (decent payout with good win rate)
function findBestValueBarrier(
    pctsShort: number[],   // typically 20-30 ticks
    pctsMedium: number[],  // typically 100 ticks
    pctsLong: number[],    // typically 200 ticks
): { type: 'DIGITOVER' | 'DIGITUNDER'; barrier: string; confidence: number; score: number } | null {
    type Candidate = { barrier: string; probShort: number; probMed: number; probLong: number };

    const overCands: Candidate[] = [];
    for (const b of OVER_BARRIERS) {
        const ps = pctsShort.slice(b + 1).reduce((a, v) => a + v, 0);
        const pm = pctsMedium.slice(b + 1).reduce((a, v) => a + v, 0);
        const pl = pctsLong.slice(b + 1).reduce((a, v) => a + v, 0);
        overCands.push({ barrier: String(b), probShort: ps, probMed: pm, probLong: pl });
    }

    const underCands: Candidate[] = [];
    for (const b of UNDER_BARRIERS) {
        const ps = pctsShort.slice(0, b).reduce((a, v) => a + v, 0);
        const pm = pctsMedium.slice(0, b).reduce((a, v) => a + v, 0);
        const pl = pctsLong.slice(0, b).reduce((a, v) => a + v, 0);
        underCands.push({ barrier: String(b), probShort: ps, probMed: pm, probLong: pl });
    }

    // Score each candidate: penalize high prob (low payout), reward stability across windows
    function scoreCandidate(c: Candidate): number {
        // Sweet spot: 55-68% probability gives best value
        const prob = c.probShort;
        let valueScore: number;
        if (prob >= 55 && prob <= 68) valueScore = 100;           // ideal
        else if (prob >= 50 && prob <= 72) valueScore = 80;       // good
        else if (prob >= 45 && prob <= 78) valueScore = 60;       // acceptable
        else if (prob >= 40 && prob <= 82) valueScore = 40;       // marginal
        else valueScore = 10;                                      // poor value (too risky or too low payout)

        // Stability bonus: all windows agree within 5%
        const stabilityPenalty = Math.abs(c.probShort - c.probMed) + Math.abs(c.probShort - c.probLong) + Math.abs(c.probMed - c.probLong);
        const stabilityBonus = Math.max(0, 20 - stabilityPenalty);

        return valueScore + stabilityBonus;
    }

    let bestType: 'DIGITOVER' | 'DIGITUNDER' | null = null;
    let bestBarrier = '';
    let bestScore = 0;
    let bestConf = 0;

    for (const c of overCands) {
        const s = scoreCandidate(c);
        if (s > bestScore) {
            bestScore = s;
            bestType = 'DIGITOVER';
            bestBarrier = c.barrier;
            // Confidence: base 68 + value score contribution
            bestConf = Math.min(84, 68 + Math.round((s - 50) * 0.3));
        }
    }
    for (const c of underCands) {
        const s = scoreCandidate(c);
        if (s > bestScore) {
            bestScore = s;
            bestType = 'DIGITUNDER';
            bestBarrier = c.barrier;
            bestConf = Math.min(84, 68 + Math.round((s - 50) * 0.3));
        }
    }

    if (!bestType || bestScore < 80) return null;
    return { type: bestType, barrier: bestBarrier, confidence: bestConf, score: 2 };
}

// ── 1. Long-term Digit Distribution (like Deriv's Over/Under tab) ──────────
const longTermDistribution: StrategyModule = {
    name: 'LongTermDist',
    run(_prices, ticks) {
        if (ticks.length < 120) return null;
        const pctsShort = digitPcts(ticks, 30);
        const pctsMed = digitPcts(ticks, 100);
        const pctsLong = digitPcts(ticks, 200);

        const result = findBestValueBarrier(pctsShort, pctsMed, pctsLong);
        if (!result) return null;

        // Entry timing: recent tick direction must not oppose the trade
        const last5 = ticks.slice(-5);
        const upCount = last5.filter((d, i, a) => i > 0 && d > a[i - 1]).length;
        const downCount = last5.filter((d, i, a) => i > 0 && d < a[i - 1]).length;

        if (result.type === 'DIGITOVER' && downCount >= upCount) return null;
        if (result.type === 'DIGITUNDER' && upCount >= downCount) return null;

        // Current digit should be near the barrier for best entry
        const curr = ticks[ticks.length - 1];
        const barNum = Number(result.barrier);
        if (result.type === 'DIGITOVER' && curr > barNum + 1) return null;
        if (result.type === 'DIGITUNDER' && curr < barNum - 1) return null;

        return {
            type: result.type,
            barrier: result.barrier,
            score: result.score,
            confidence: result.confidence,
            weight: getStrategyWeight(this.name),
            name: this.name,
        };
    },
};

// ── 2. Window comparison — short vs medium vs long term alignment ───────────
const windowAlignment: StrategyModule = {
    name: 'WinAlign',
    run(_prices, ticks) {
        if (ticks.length < 120) return null;
        const pcts50 = digitPcts(ticks, 50);
        const pcts100 = digitPcts(ticks, 100);
        const pcts200 = digitPcts(ticks, 200);

        // Check if all windows agree on Over/Under for a given barrier
        type Candidate = { barrier: string; probs: number[] };
        const overCands: Candidate[] = [];
        for (const b of OVER_BARRIERS) {
            const p50 = pcts50.slice(b + 1).reduce((a, v) => a + v, 0);
            const p100 = pcts100.slice(b + 1).reduce((a, v) => a + v, 0);
            const p200 = pcts200.slice(b + 1).reduce((a, v) => a + v, 0);
            overCands.push({ barrier: String(b), probs: [p50, p100, p200] });
        }
        const underCands: Candidate[] = [];
        for (const b of UNDER_BARRIERS) {
            const p50 = pcts50.slice(0, b).reduce((a, v) => a + v, 0);
            const p100 = pcts100.slice(0, b).reduce((a, v) => a + v, 0);
            const p200 = pcts200.slice(0, b).reduce((a, v) => a + v, 0);
            underCands.push({ barrier: String(b), probs: [p50, p100, p200] });
        }

        let bestType: 'DIGITOVER' | 'DIGITUNDER' | null = null;
        let bestBarrier = '';
        let bestConsensus = 0;

        for (const c of overCands) {
            const [p50, p100, p200] = c.probs;
            // All three must be in value range 45-78%
            if (p50 >= 45 && p50 <= 78 && p100 >= 45 && p100 <= 78 && p200 >= 45 && p200 <= 78) {
                const spread = Math.max(p50, p100, p200) - Math.min(p50, p100, p200);
                const consensus = 100 - spread * 2; // lower spread = higher consensus
                if (consensus > bestConsensus) {
                    bestConsensus = consensus;
                    bestType = 'DIGITOVER';
                    bestBarrier = c.barrier;
                }
            }
        }
        for (const c of underCands) {
            const [p50, p100, p200] = c.probs;
            if (p50 >= 45 && p50 <= 78 && p100 >= 45 && p100 <= 78 && p200 >= 45 && p200 <= 78) {
                const spread = Math.max(p50, p100, p200) - Math.min(p50, p100, p200);
                const consensus = 100 - spread * 2;
                if (consensus > bestConsensus) {
                    bestConsensus = consensus;
                    bestType = 'DIGITUNDER';
                    bestBarrier = c.barrier;
                }
            }
        }

        if (!bestType || bestConsensus < 70) return null;
        const conf = Math.min(82, 64 + Math.round(bestConsensus * 0.15));
        return {
            type: bestType,
            barrier: bestBarrier,
            score: 2,
            confidence: Math.round(conf),
            weight: getStrategyWeight(this.name),
            name: this.name,
        };
    },
};

// ── 3. Timed Entry — combines distribution with recent tick momentum ────────
const timedEntry: StrategyModule = {
    name: 'TimedEntry',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        const pcts100 = digitPcts(ticks, 100);

        // Find the best value barrier from long-term distribution
        const pctsShort = digitPcts(ticks, 15);
        const pcts200 = ticks.length >= 200 ? digitPcts(ticks, 200) : pcts100;
        const valueResult = findBestValueBarrier(pctsShort, pcts100, pcts200);
        if (!valueResult) return null;

        // Timing filter: check recent digit movement
        const last5 = ticks.slice(-5);
        const upCount = last5.filter((d, i, a) => i > 0 && d > a[i - 1]).length;
        const downCount = last5.filter((d, i, a) => i > 0 && d < a[i - 1]).length;
        const currentDigit = ticks[ticks.length - 1];
        const barrierNum = Number(valueResult.barrier);

        let timingOk = false;
        if (valueResult.type === 'DIGITOVER') {
            // Need more up ticks than down, and digit should be at or below barrier
            timingOk = upCount > downCount && currentDigit <= barrierNum + 1;
        } else {
            timingOk = downCount > upCount && currentDigit >= barrierNum - 1;
        }

        if (!timingOk) return null;

        // Bonus for strong alignment
        let timingBonus = 0;
        if (valueResult.type === 'DIGITOVER' && upCount >= 4) timingBonus = 4;
        if (valueResult.type === 'DIGITUNDER' && downCount >= 4) timingBonus = 4;

        const conf = Math.min(86, valueResult.confidence + timingBonus);
        return {
            type: valueResult.type,
            barrier: valueResult.barrier,
            score: 2,
            confidence: Math.round(conf),
            weight: getStrategyWeight(this.name),
            name: this.name,
        };
    },
};

// ── 4. Digit gap analysis — sudden digit gaps signal direction ─────────────
const digitGapAnalysis: StrategyModule = {
    name: 'DigitGap',
    run(_prices, ticks) {
        if (ticks.length < 15) return null;
        const last10 = ticks.slice(-10);

        // Detect large single-tick digit jumps (gap of 4+)
        let maxJump = 0;
        let jumpDir = 0;
        for (let i = 1; i < last10.length; i++) {
            const gap = last10[i] - last10[i - 1];
            if (Math.abs(gap) > Math.abs(maxJump)) {
                maxJump = gap;
                jumpDir = gap > 0 ? 1 : -1;
            }
        }

        if (Math.abs(maxJump) < 4) return null;

        // A large jump in one direction often means the digit will pull back
        // (mean reversion on digit level)
        const lastDigit = last10[last10.length - 1];

        if (jumpDir > 0 && lastDigit <= 5) {
            // Jumped up but still mid-range → likely to fall back
            const bar = UNDER_BARRIERS.reduce((best, b) => Math.abs(b - lastDigit) < Math.abs(best - lastDigit) ? b : best, UNDER_BARRIERS[0]);
            const conf = Math.min(76, 64 + Math.abs(maxJump) * 2);
            return { type: 'DIGITUNDER', barrier: String(bar), score: 1, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        if (jumpDir < 0 && lastDigit >= 4) {
            const bar = OVER_BARRIERS.reduce((best, b) => Math.abs(b - lastDigit) < Math.abs(best - lastDigit) ? b : best, OVER_BARRIERS[0]);
            const conf = Math.min(76, 64 + Math.abs(maxJump) * 2);
            return { type: 'DIGITOVER', barrier: String(bar), score: 1, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 5. Digit streak with distribution confirmation ─────────────────────────
const streakWithDist: StrategyModule = {
    name: 'StreakDist',
    run(_prices, ticks) {
        if (ticks.length < 40) return null;
        const pcts100 = digitPcts(ticks, 100);
        const pcts200 = ticks.length >= 200 ? digitPcts(ticks, 200) : pcts100;

        // Find recent streak direction
        const last10 = ticks.slice(-10);
        let streakUp = 0, streakDown = 0;
        for (let i = last10.length - 1; i > 0; i--) {
            if (last10[i] > last10[i - 1]) streakUp++;
            else if (last10[i] < last10[i - 1]) streakDown++;
            else break;
        }

        if (streakUp < 3 && streakDown < 3) return null;

        const isUpStreak = streakUp > streakDown;
        const currentDigit = last10[last10.length - 1];

        // Check if the long-term distribution supports a reversal from this streak
        if (isUpStreak && currentDigit >= 5) {
            // After rising streak at high digits, check Under probability
            // Find best Under barrier from distribution
            let bestBar = -1, bestScore = 0;
            for (const b of UNDER_BARRIERS) {
                const prob = pcts100.slice(0, b).reduce((a, v) => a + v, 0);
                if (prob > bestScore) { bestScore = prob; bestBar = b; }
            }
            if (bestBar >= 0 && bestScore >= 45 && bestScore <= 78) {
                const conf = Math.min(80, 66 + streakUp * 2);
                return { type: 'DIGITUNDER', barrier: String(bestBar), score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        if (!isUpStreak && currentDigit <= 5) {
            let bestBar = -1, bestScore = 0;
            for (const b of OVER_BARRIERS) {
                const prob = pcts100.slice(b + 1).reduce((a, v) => a + v, 0);
                if (prob > bestScore) { bestScore = prob; bestBar = b; }
            }
            if (bestBar >= 0 && bestScore >= 45 && bestScore <= 78) {
                const conf = Math.min(80, 66 + streakDown * 2);
                return { type: 'DIGITOVER', barrier: String(bestBar), score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

/* ═══════════════════════════════════════════════════════════════════════════════
   OU STRATEGIES (DIGITOVER / DIGITUNDER)
   For predicting whether the next digit will be higher (OVER) or lower (UNDER)
   than the prediction barrier. Confidence: up to 82.
══════════════════════════════════════════════════════════════════════════════════ */

/* ── OU6. Digit Momentum ────────────────────────────────────────────────── */
const digitMomentum: StrategyModule = {
    name: 'DigitMomentum',
    run(_prices, ticks) {
        if (ticks.length < 15) return null;
        const recent = ticks.slice(-12);
        let ups = 0, downs = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] > recent[i - 1]) ups++;
            else if (recent[i] < recent[i - 1]) downs++;
        }
        const total = ups + downs;
        if (total < 6) return null;
        const r = ups / total;
        if (r > 0.72) return { type: 'DIGITOVER', score: 2, confidence: Math.min(82, 68 + Math.round((r - 0.72) * 80)), weight: getStrategyWeight(this.name), name: this.name };
        if (1 - r > 0.72) return { type: 'DIGITUNDER', score: 2, confidence: Math.min(82, 68 + Math.round(((1 - r) - 0.72) * 80)), weight: getStrategyWeight(this.name), name: this.name };
        return null;
    },
};

/* ── OU7. Frequency Anomaly ─────────────────────────────────────────────── */
const frequencyAnomaly: StrategyModule = {
    name: 'FreqAnomaly',
    run(_prices, ticks) {
        if (ticks.length < 80) return null;
        const pcts = digitPcts(ticks, 80);
        let hiD = 0, hiP = 0;
        pcts.forEach((p, i) => { if (p > hiP) { hiP = p; hiD = i; } });
        if (hiP < 18) return null;
        const c = Math.min(80, 62 + Math.round((hiP - 10) * 1.5));
        if (hiD >= 6) return { type: 'DIGITUNDER', score: 2, confidence: c, weight: getStrategyWeight(this.name), name: this.name };
        if (hiD <= 3) return { type: 'DIGITOVER', score: 2, confidence: c, weight: getStrategyWeight(this.name), name: this.name };
        const cur = ticks[ticks.length - 1];
        if (hiD > cur) return { type: 'DIGITUNDER', score: 1, confidence: Math.round(c * 0.85), weight: getStrategyWeight(this.name), name: this.name };
        return { type: 'DIGITOVER', score: 1, confidence: Math.round(c * 0.85), weight: getStrategyWeight(this.name), name: this.name };
    },
};

/* ── OU8. Barrier Proximity ─────────────────────────────────────────────── */
const barrierProximity: StrategyModule = {
    name: 'BarrierProx',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        const cur = ticks[ticks.length - 1];
        const t: Record<number, { h: number; l: number }> = {};
        for (let i = 1; i < ticks.length; i++) {
            const f = ticks[i - 1];
            if (!t[f]) t[f] = { h: 0, l: 0 };
            if (ticks[i] > f) t[f].h++; else if (ticks[i] < f) t[f].l++;
        }
        const m = t[cur];
        if (!m || m.h + m.l < 8) return null;
        const r = m.h / (m.h + m.l);
        if (r > 0.68) return { type: 'DIGITOVER', score: 2, confidence: Math.min(80, 65 + Math.round((r - 0.68) * 70)), weight: getStrategyWeight(this.name), name: this.name };
        if (1 - r > 0.68) return { type: 'DIGITUNDER', score: 2, confidence: Math.min(80, 65 + Math.round(((1 - r) - 0.68) * 70)), weight: getStrategyWeight(this.name), name: this.name };
        return null;
    },
};

const overUnderStrategies: StrategyModule[] = [
    longTermDistribution, windowAlignment, timedEntry, digitGapAnalysis, streakWithDist,
    digitMomentum, frequencyAnomaly, barrierProximity,
];

/* ═══════════════════════════════════════════════════════════════════════════════
   EVEN/ODD STRATEGIES (DIGITEVEN / DIGITODD)
   All strategies have confidence capped at 72 (parity prediction is ~50/50).
   Only fire on extreme, statistically significant deviations.
══════════════════════════════════════════════════════════════════════════════════ */

// ── EO1. Extreme parity streak exhaustion — streaks 6+ ─────────────────────
const extremeParityStreak: StrategyModule = {
    name: 'ExtremeParityStreak',
    run(_prices, ticks) {
        if (ticks.length < 15) return null;
        const recent = ticks.slice(-25);
        const lastParity = recent[recent.length - 1] % 2;
        let streakLen = 0;
        for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i] % 2 === lastParity) streakLen++;
            else break;
        }
        if (streakLen < 6) return null;
        const conf = Math.min(72, 58 + streakLen * 3);
        return {
            type: lastParity === 0 ? 'DIGITODD' : 'DIGITEVEN',
            score: 2, confidence: Math.round(conf),
            weight: getStrategyWeight(this.name), name: this.name,
        };
    },
};

// ── EO2. Strong distribution bias (>68% in 68 and 100-tick windows) ────────
const strongParityBias: StrategyModule = {
    name: 'StrongParityBias',
    run(_prices, ticks) {
        if (ticks.length < 100) return null;
        const pcts68 = digitPcts(ticks, 68);
        const pcts100 = digitPcts(ticks, 100);
        const even68 = pcts68.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
        const odd68 = pcts68.filter((_, i) => i % 2 === 1).reduce((a, v) => a + v, 0);
        const even100 = pcts100.filter((_, i) => i % 2 === 0).reduce((a, v) => a + v, 0);
        const odd100 = pcts100.filter((_, i) => i % 2 === 1).reduce((a, v) => a + v, 0);
        if (even68 > 68 && even100 > 68) {
            return { type: 'DIGITEVEN', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (odd68 > 68 && odd100 > 68) {
            return { type: 'DIGITODD', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── EO3. Markov transition >70% with min 10 samples ────────────────────────
const highConvictionMarkov: StrategyModule = {
    name: 'HighConvictionMarkov',
    run(_prices, ticks) {
        if (ticks.length < 40) return null;
        const recent = ticks.slice(-50);
        let e2e = 0, e2o = 0, o2e = 0, o2o = 0;
        for (let i = 1; i < recent.length; i++) {
            const prev = recent[i - 1] % 2, curr = recent[i] % 2;
            if (prev === 0 && curr === 0) e2e++;
            else if (prev === 0 && curr === 1) e2o++;
            else if (prev === 1 && curr === 0) o2e++;
            else o2o++;
        }
        const last = recent[recent.length - 1] % 2;
        if (last === 0) {
            const total = e2e + e2o;
            if (total >= 10 && e2o / total > 0.70) {
                return { type: 'DIGITODD', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
            }
        } else {
            const total = o2e + o2o;
            if (total >= 10 && o2e / total > 0.70) {
                return { type: 'DIGITEVEN', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        return null;
    },
};

// ── EO4. Extreme RSI(7) <15 or >85 on digit values ─────────────────────────
const extremeRSI: StrategyModule = {
    name: 'ExtremeRSI',
    run(_prices, ticks) {
        if (ticks.length < 20) return null;
        const rsiVal = rsi(ticks, 7);
        if (rsiVal < 15) {
            return { type: 'DIGITODD', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (rsiVal > 85) {
            return { type: 'DIGITEVEN', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── EO5. Pair transitions >72% with 8+ samples ─────────────────────────────
const strongPairParity: StrategyModule = {
    name: 'StrongPairParity',
    run(_prices, ticks) {
        if (ticks.length < 40) return null;
        const lastDigit = ticks[ticks.length - 1];
        const trans: Record<number, { even: number; odd: number }> = {};
        for (let i = 1; i < ticks.length; i++) {
            const from = ticks[i - 1];
            if (!trans[from]) trans[from] = { even: 0, odd: 0 };
            if (ticks[i] % 2 === 0) trans[from].even++;
            else trans[from].odd++;
        }
        const t = trans[lastDigit];
        if (!t || t.even + t.odd < 8) return null;
        const total = t.even + t.odd;
        const evenPct = (t.even / total) * 100;
        if (evenPct > 72) {
            return { type: 'DIGITEVEN', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (100 - evenPct > 72) {
            return { type: 'DIGITODD', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

// ── EO6. Bayesian Laplace >72% (50-tick window) ────────────────────────────
const highBarBayesian: StrategyModule = {
    name: 'HighBarBayesian',
    run(_prices, ticks) {
        if (ticks.length < 50) return null;
        const recent = ticks.slice(-50);
        const evens = recent.filter(d => d % 2 === 0).length;
        const total = recent.length;
        const laplaceEven = (evens + 1) / (total + 2);
        if (laplaceEven > 0.72) {
            return { type: 'DIGITEVEN', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        if ((1 - laplaceEven) > 0.72) {
            return { type: 'DIGITODD', score: 2, confidence: 72, weight: getStrategyWeight(this.name), name: this.name };
        }
        return null;
    },
};

const evenOddStrategies: StrategyModule[] = [
    extremeParityStreak, strongParityBias, highConvictionMarkov,
    extremeRSI, strongPairParity, highBarBayesian,
];

/* ═══════════════════════════════════════════════════════════════════════════════
   ENSEMBLE — Main entry point
═══════════════════════════════════════════════════════════════════════════════ */

const ALL_STRATEGIES: StrategyModule[] = [
    ...riseFallStrategies, ...overUnderStrategies, ...evenOddStrategies,
];

// ── Auto-flip when a strategy family is consistently losing ──────────────
function shouldFlipFamily(types: ContractType[]): boolean {
    const isRF = types.some(t => t === 'CALL' || t === 'PUT');
    const isOU = types.some(t => t === 'DIGITOVER' || t === 'DIGITUNDER');
    const isEO = types.some(t => t === 'DIGITEVEN' || t === 'DIGITODD');
    let totalWins = 0, totalLosses = 0;
    for (const s of ALL_STRATEGIES) {
        const matches = (riseFallStrategies.includes(s) && isRF) ||
                        (overUnderStrategies.includes(s) && isOU) ||
                        (evenOddStrategies.includes(s) && isEO);
        if (!matches) continue;
        const p = strategyPerf[s.name];
        if (p) { totalWins += p.wins; totalLosses += p.losses; }
    }
    const total = totalWins + totalLosses;
    if (total < 10) return false; // not enough data
    const rate = totalWins / total;
    return rate < 0.38; // flip if win rate below 38%
}

function flipType(t: ContractType): ContractType {
    switch (t) {
        case 'CALL':       return 'PUT';
        case 'PUT':        return 'CALL';
        case 'DIGITOVER':  return 'DIGITUNDER';
        case 'DIGITUNDER': return 'DIGITOVER';
        case 'DIGITEVEN':  return 'DIGITODD';
        case 'DIGITODD':   return 'DIGITEVEN';
    }
}

/** 
 * Pick the best tick duration (1-5) based on historical directional consistency.
 * For each duration D, checks: over recent ticks, how often did the predicted
 * direction hold true over D-tick intervals?  Picks the D with the highest 
 * reliability so the contract duration matches the market's natural timeframe.
 */
export function findBestDuration(
    prices: number[],
    direction: 'CALL' | 'PUT',
    maxDuration = 5,
): number {
    if (prices.length < 10) return 1;

    // ── Indicator-based duration bonuses ───────────────────────────────
    // RSI(7): oversold/overbought suggests quick reversal → shorter durations
    let rsiDurationBonus: number[] = [0, 0, 0, 0, 0, 0];                  // index = duration
    const rsiVal = prices.length >= 30 ? rsi(prices, 7) : 50;
    if (direction === 'CALL' && rsiVal < 40) {
        const strength = (40 - rsiVal) / 40;                              // 0..1
        if (rsiVal < 25)      { rsiDurationBonus[1] = 7 * strength; rsiDurationBonus[2] = 5 * strength; }
        else if (rsiVal < 33) { rsiDurationBonus[2] = 5 * strength; rsiDurationBonus[3] = 3 * strength; }
        else                  { rsiDurationBonus[3] = 3 * strength; }
    }
    if (direction === 'PUT' && rsiVal > 60) {
        const strength = (rsiVal - 60) / 40;                              // 0..1
        if (rsiVal > 75)      { rsiDurationBonus[1] = 7 * strength; rsiDurationBonus[2] = 5 * strength; }
        else if (rsiVal > 67) { rsiDurationBonus[2] = 5 * strength; rsiDurationBonus[3] = 3 * strength; }
        else                  { rsiDurationBonus[3] = 3 * strength; }
    }

    // Bollinger Bands: price stretched near bands → reversal expected → shorter durations
    let bbDurationBonus: number[] = [0, 0, 0, 0, 0, 0];
    const bbPos = prices.length >= 14 ? bbPosition(prices, 14, 2) : 0.5;
    if (direction === 'CALL' && bbPos < 0.3) {
        const distFromMid = (0.5 - bbPos) / 0.5;
        if (bbPos < 0.1)      { bbDurationBonus[1] = 6 * distFromMid; bbDurationBonus[2] = 4 * distFromMid; }
        else if (bbPos < 0.2) { bbDurationBonus[2] = 4 * distFromMid; bbDurationBonus[3] = 2 * distFromMid; }
        else                  { bbDurationBonus[3] = 2 * distFromMid; }
    }
    if (direction === 'PUT' && bbPos > 0.7) {
        const distFromMid = (bbPos - 0.5) / 0.5;
        if (bbPos > 0.9)      { bbDurationBonus[1] = 6 * distFromMid; bbDurationBonus[2] = 4 * distFromMid; }
        else if (bbPos > 0.8) { bbDurationBonus[2] = 4 * distFromMid; bbDurationBonus[3] = 2 * distFromMid; }
        else                  { bbDurationBonus[3] = 2 * distFromMid; }
    }

    // EMA 5/10 crossover: trending alignment → longer durations; flat → shorter
    let emaDurationBonus: number[] = [0, 0, 0, 0, 0, 0];
    if (prices.length >= 20) {
        const e5 = ema(prices, 5);
        const e10 = ema(prices, 10);
        if (e5.length > 0 && e10.length > 0) {
            const le5 = e5[e5.length - 1], le10 = e10[e10.length - 1];
            const gap = ((le5 - le10) / le10) * 100;                     // % gap between EMAs
            const absGap = Math.abs(gap);
            if (direction === 'CALL' && gap > 0) {
                if (absGap > 0.2) { emaDurationBonus[4] = 5; emaDurationBonus[5] = 4; }
                else if (absGap > 0.1) { emaDurationBonus[3] = 4; emaDurationBonus[4] = 3; }
                else { emaDurationBonus[2] = 3; emaDurationBonus[3] = 2; }
            }
            if (direction === 'PUT' && gap < 0) {
                if (absGap > 0.2) { emaDurationBonus[4] = 5; emaDurationBonus[5] = 4; }
                else if (absGap > 0.1) { emaDurationBonus[3] = 4; emaDurationBonus[4] = 3; }
                else { emaDurationBonus[2] = 3; emaDurationBonus[3] = 2; }
            }
            // Narrow gap (crossing soon): shorter durations to catch early move
            if (absGap < 0.05) {
                emaDurationBonus[1] = Math.max(emaDurationBonus[1], 4);
                emaDurationBonus[2] = Math.max(emaDurationBonus[2], 3);
            }
        }
    }

    // ── Blend historical accuracy with indicator bonuses ───────────────
    let bestD = 1;
    let bestScore = -Infinity;

    for (let d = 1; d <= maxDuration; d++) {
        const step = Math.max(1, d);
        const maxSamples = Math.min(30, Math.floor((prices.length - 1) / step));
        if (maxSamples < 3) continue;

        let correct = 0, total = 0;
        for (let i = prices.length - 1; i >= step && total < maxSamples; i -= step) {
            const actualUp = prices[i] > prices[i - step];
            if ((direction === 'CALL' && actualUp) || (direction === 'PUT' && !actualUp)) {
                correct++;
            }
            total++;
        }

        if (total === 0) continue;
        const accuracy = correct / total;

        const indicatorBonus = rsiDurationBonus[d] + bbDurationBonus[d] + emaDurationBonus[d];
        const score = accuracy * 100 + (maxDuration - d) * 0.5 + indicatorBonus + (d === 1 ? 10 : 0);

        if (score > bestScore) {
            bestScore = score;
            bestD = d;
        }
    }

    return bestD;
}

export function analyzeSignals(
    ticks: number[],
    prices: number[],
    contractTypes: ContractType[],
): TradeSignal | null {
    if (prices.length < MIN_TICK_FOR_ANALYSIS) return null;

    const regime = detectRegime(prices);

    // Filter eligible strategies based on requested contract types
    const isRiseFall = contractTypes.some(t => t === 'CALL' || t === 'PUT');
    const isOverUnder = contractTypes.some(t => t === 'DIGITOVER' || t === 'DIGITUNDER');
    const isEvenOdd = contractTypes.some(t => t === 'DIGITEVEN' || t === 'DIGITODD');

    const votes: StrategyVote[] = [];
    const usedStrategyNames = new Set<string>();

    for (const strat of ALL_STRATEGIES) {
        // Skip strategies not relevant to requested types
        const name = strat.name;
        const isRiseFallStrat = riseFallStrategies.includes(strat);
        const isOverUnderStrat = overUnderStrategies.includes(strat);
        const isEvenOddStrat = evenOddStrategies.includes(strat);

        if (isRiseFallStrat && !isRiseFall) continue;
        if (isOverUnderStrat && !isOverUnder) continue;
        if (isEvenOddStrat && !isEvenOdd) continue;

        const result = strat.run(prices, ticks, regime);
        if (result && result.confidence > CONFIDENCE_FLOOR) {
            votes.push(result);
            usedStrategyNames.add(name);
        }
    }

    if (votes.length === 0) return null;

    // Group votes by contract type
    type GroupData = { votes: { conf: number; weight: number; score: number; barrier?: string }[]; barriers: string[] };
    const groups = new Map<string, GroupData>();

    for (const v of votes) {
        const key = v.type;
        if (!groups.has(key)) groups.set(key, { votes: [], barriers: [] });
        const g = groups.get(key)!;
        g.votes.push({ conf: v.confidence, weight: v.weight, score: v.score, barrier: v.barrier });
        if (v.barrier) g.barriers.push(v.barrier);
    }

    // Pick the best group using top-quartile weighted average confidence
    function topQuartileConf(vs: GroupData['votes']): number {
        const sorted = [...vs].sort((a, b) => b.conf - a.conf);
        const take = Math.max(1, Math.ceil(sorted.length / 4));
        const top = sorted.slice(0, take);
        const tw = top.reduce((s, v) => s + v.weight, 0);
        return tw > 0 ? top.reduce((s, v) => s + v.conf * v.weight, 0) / tw : 0;
    }

    let bestKey = '';
    let bestGroup: GroupData | null = null;
    let bestScore = 0;

    for (const [key, g] of groups) {
        const tqConf = topQuartileConf(g.votes);
        const groupScore = tqConf + Math.min(3, g.votes.length * 0.5);
        if (groupScore > bestScore) {
            bestScore = groupScore;
            bestKey = key;
            bestGroup = g;
        }
    }

    if (!bestGroup || bestGroup.votes.length < 2) return null;
    // Consensus: at least 2 of the top 3 strategies by confidence must agree
    const top3 = [...bestGroup.votes].sort((a, b) => b.conf - a.conf).slice(0, 3);
    if (top3.length >= 2 && top3[0].conf < CONFIDENCE_FLOOR + 5) return null;

    const key = bestKey;
    const data = bestGroup;
    const avgConf = topQuartileConf(data.votes);
    let barrier = data.barriers.length > 0
        ? data.barriers.sort((a, b) => {
            const freqA = data.barriers.filter(x => x === a).length;
            const freqB = data.barriers.filter(x => x === b).length;
            return freqB - freqA;
        })[0]
        : undefined;

    // Auto-flip if this family is consistently losing
    let contractType = key as ContractType;
    if (shouldFlipFamily(contractTypes)) {
        contractType = flipType(contractType);
        barrier = undefined;
    }

    // Adjust confidence based on regime
    let regimeBonus = 0;
    if (regime === 'STRONG_BULL' && (contractType === 'CALL' || contractType === 'DIGITOVER')) regimeBonus = 5;
    if (regime === 'STRONG_BEAR' && (contractType === 'PUT' || contractType === 'DIGITUNDER')) regimeBonus = 5;
    if (regime === 'CHOPPY' && (contractType === 'CALL' || contractType === 'PUT')) regimeBonus = -3;
    if (regime === 'CHOPPY' && (contractType === 'DIGITEVEN' || contractType === 'DIGITODD')) regimeBonus = 0;

    const finalConfidence = Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, Math.round(avgConf + regimeBonus)));

    const details = `Regime: ${regime} | Strategies: ${votes.filter(v => v.type === key).map(v => `${v.name}(${v.confidence.toFixed(0)})`).join(', ')}`;

    return {
        contract_type: contractType,
        barrier,
        confidence: finalConfidence,
        reason: `${contractType} ${barrier ? '@ ' + barrier : ''} — ensemble of ${votes.length} strategies`,
        details,
    };
}
