// ═══════════════════════════════════════════════════════════════════════════════
//  MAKOTI PREDICTION ENGINE v2
//  Multi-strategy ensemble with market state detection, dynamic weighting,
//  and contract-type-aware signal generation for Rise/Fall, Over/Under,
//  Even/Odd, and Digits.
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
const CONFIDENCE_FLOOR = 60;
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
    return Math.max(0.3, Math.min(1.5, rate * 2));
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

const riseFallStrategies: StrategyModule[] = [
    microTiming, rsiDivergence, macdStrategy, bbStrategy,
    stochasticStrategy, atrBreakout, priceAction, maCross,
    meanReversion, cciStrategy, zlemaStrategy, keltnerStrategy,
    rocStrategy, fractalEfficiency, digitPsychology, candleReversal,
    doubleTopBottom, exhaustionRev, pivotReversal, tickVelocity,
    fibonacciRetrace, statisticalExtreme,
];

/* ═══════════════════════════════════════════════════════════════════════════════
   OVER/UNDER STRATEGIES
═══════════════════════════════════════════════════════════════════════════════ */

// ── 15. Digit distribution barrier ──────────────────────────────────────────
const digitDistBarrier: StrategyModule = {
    name: 'DigitDist',
    run(_prices, ticks) {
        if (ticks.length < 20) return null;
        const pcts = digitPcts(ticks, 50);
        const pctsLong = digitPcts(ticks, 100);

        // Find digits that appear least frequently → best barrier for OVER
        // Find digits that appear most frequently → best barrier for UNDER
        let bestOverDigit = -1;
        let bestOverScore = 0;

        for (let barrier = 0; barrier <= 8; barrier++) {
            const overProb = pcts.slice(barrier + 1).reduce((a, b) => a + b, 0);
            if (overProb > bestOverScore) {
                bestOverScore = overProb;
                bestOverDigit = barrier;
            }
        }

        let bestUnderDigit = -1;
        let bestUnderScore = 0;
        for (let barrier = 1; barrier <= 9; barrier++) {
            const underProb = pcts.slice(0, barrier).reduce((a, b) => a + b, 0);
            if (underProb > bestUnderScore) {
                bestUnderScore = underProb;
                bestUnderDigit = barrier;
            }
        }

        // Long-term confirmation
        const overProbLong = bestOverDigit >= 0 ? pctsLong.slice(bestOverDigit + 1).reduce((a, b) => a + b, 0) : 0;
        const underProbLong = bestUnderDigit >= 0 ? pctsLong.slice(0, bestUnderDigit).reduce((a, b) => a + b, 0) : 0;

        // Only trade if distribution is skewed enough
        if (bestOverScore > 55 && overProbLong > 52) {
            const conf = Math.min(82, 55 + bestOverScore * 0.4);
            return { type: 'DIGITOVER', barrier: String(bestOverDigit), score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (bestUnderScore > 55 && underProbLong > 52) {
            const conf = Math.min(82, 55 + bestUnderScore * 0.4);
            return { type: 'DIGITUNDER', barrier: String(bestUnderDigit), score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 16. Standard deviation barrier ──────────────────────────────────────────
const stdDevBarrier: StrategyModule = {
    name: 'StdDev',
    run(prices, ticks) {
        if (prices.length < 20 || ticks.length < 20) return null;
        const recent = prices.slice(-20);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
        const std = Math.sqrt(variance);
        const pip = 0.01; // base
        const stdDigits = Math.round(std / pip);

        const lastDigit = ticks[ticks.length - 1];
        const digitMean = ticks.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const digitStd = Math.sqrt(ticks.slice(-20).reduce((a, b) => a + (b - digitMean) ** 2, 0) / 20);

        // If high volatility, use wider barrier
        const barrierOffset = Math.max(1, Math.round(digitStd));

        if (lastDigit > 5) {
            const barrier = Math.max(1, lastDigit - barrierOffset);
            const conf = Math.min(76, 55 + digitStd * 5);
            return { type: 'DIGITUNDER', barrier: String(barrier), score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        } else {
            const barrier = Math.min(8, lastDigit + barrierOffset);
            const conf = Math.min(76, 55 + digitStd * 5);
            return { type: 'DIGITOVER', barrier: String(barrier), score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }
    },
};

// ── 17. Price level density (support/resistance on digit level) ─────────────
const priceLevelDensity: StrategyModule = {
    name: 'PriceDensity',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        const recent = ticks.slice(-30);

        // Cluster detection — find which digits have the most ticks
        const clusters = Array(10).fill(0);
        recent.forEach(d => { if (d >= 0 && d <= 9) clusters[d]++; });
        const maxCluster = Math.max(...clusters);
        const maxDigit = clusters.indexOf(maxCluster);
        const clusterRatio = maxCluster / recent.length;

        if (clusterRatio > 0.25) {
            // Strong cluster at this digit → price tends to stay near it
            const conf = Math.min(72, 55 + clusterRatio * 50);
            return { type: 'DIGITOVER', barrier: String(maxDigit), score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
        }

        // S/R levels: find digits with unusually high or low frequency
        const expected = recent.length / 10;
        for (let d = 0; d <= 9; d++) {
            if (clusters[d] > expected * 2.5) {
                // Strong resistance — price rarely goes above
                return {
                    type: 'DIGITUNDER', barrier: String(d),
                    score: 2, confidence: 68,
                    weight: getStrategyWeight(this.name), name: this.name,
                };
            }
            if (d > 0 && clusters[d] < expected * 0.3) {
                // Weak digit — price rarely lands here, good barrier for DIGITOVER
                const lastDigit = ticks[ticks.length - 1];
                if (lastDigit > d) {
                    return {
                        type: 'DIGITOVER', barrier: String(d),
                        score: 2, confidence: 66,
                        weight: getStrategyWeight(this.name), name: this.name,
                    };
                }
            }
        }

        return null;
    },
};

// ── 18. Sequential digit momentum ───────────────────────────────────────────
const digitMomentum: StrategyModule = {
    name: 'DigitMomentum',
    run(_prices, ticks) {
        if (ticks.length < 10) return null;
        const last5 = ticks.slice(-5);
        const values = last5.map(d => d);
        const slope = values.length > 1
            ? (values[values.length - 1] - values[0]) / values.length
            : 0;

        if (slope > 0.5) {
            // Digits rising → value likely to go higher
            const barrier = Math.min(8, Math.round(values[values.length - 1] + Math.abs(slope)));
            return {
                type: 'DIGITOVER', barrier: String(barrier),
                score: 2, confidence: 65,
                weight: getStrategyWeight(this.name), name: this.name,
            };
        }
        if (slope < -0.5) {
            // Digits falling
            const barrier = Math.max(1, Math.round(values[values.length - 1] - Math.abs(slope)));
            return {
                type: 'DIGITUNDER', barrier: String(barrier),
                score: 2, confidence: 65,
                weight: getStrategyWeight(this.name), name: this.name,
            };
        }

        return null;
    },
};

const overUnderStrategies: StrategyModule[] = [
    digitDistBarrier, stdDevBarrier, priceLevelDensity, digitMomentum,
];

/* ═══════════════════════════════════════════════════════════════════════════════
   EVEN/ODD STRATEGIES (DIGITEVEN / DIGITODD)
═══════════════════════════════════════════════════════════════════════════════ */

// ── 19. Parity streak exhaustion ────────────────────────────────────────────
const parityStreak: StrategyModule = {
    name: 'ParityStreak',
    run(_prices, ticks) {
        if (ticks.length < 10) return null;
        const recent = ticks.slice(-20);

        // Streak of same parity
        const lastParity = recent[recent.length - 1] % 2; // 0=even, 1=odd
        let streakLen = 0;
        for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i] % 2 === lastParity) streakLen++;
            else break;
        }

        // Long streaks increase reversal probability
        if (streakLen >= 6) {
            const conf = Math.min(80, 55 + streakLen * 4);
            if (lastParity === 0) { // even streak
                return { type: 'DIGITODD', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'DIGITEVEN', score: 3, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
            }
        }
        if (streakLen >= 4) {
            const conf = Math.min(72, 55 + streakLen * 3);
            if (lastParity === 0) {
                return { type: 'DIGITODD', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'DIGITEVEN', score: 2, confidence: conf, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        return null;
    },
};

// ── 20. Parity distribution bias ────────────────────────────────────────────
const parityDistribution: StrategyModule = {
    name: 'ParityDist',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        const short = ticks.slice(-20);
        const long = ticks.slice(-50);

        const shortEven = short.filter(d => d % 2 === 0).length;
        const longEven = long.filter(d => d % 2 === 0).length;
        const shortPct = (shortEven / short.length) * 100;
        const longPct = (longEven / long.length) * 100;

        // Strong bias divergence between short and long
        if (shortPct > 62 && longPct < 55) {
            return { type: 'DIGITODD', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (shortPct < 38 && longPct > 45) {
            return { type: 'DIGITEVEN', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Sustained bias
        if (shortPct > 60 && longPct > 58) {
            return { type: 'DIGITEVEN', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (shortPct < 40 && longPct < 42) {
            return { type: 'DIGITODD', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 21. Markov chain transition probabilities ──────────────────────────────
const markovParity: StrategyModule = {
    name: 'Markov',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        const recent = ticks.slice(-40);
        const trans: Record<string, number> = {
            '00': 0, '01': 0, '10': 0, '11': 0,
        };

        for (let i = 1; i < recent.length; i++) {
            const from = recent[i - 1] % 2;
            const to = recent[i] % 2;
            trans[`${from}${to}`]++;
        }

        const totalFrom0 = trans['00'] + trans['01'];
        const totalFrom1 = trans['10'] + trans['11'];
        const prob0to1 = totalFrom0 > 0 ? trans['01'] / totalFrom0 : 0.5;
        const prob1to0 = totalFrom1 > 0 ? trans['10'] / totalFrom1 : 0.5;

        const lastParity = recent[recent.length - 1] % 2;

        // Strong transition probability
        if (lastParity === 0 && prob0to1 > 0.65) {
            return { type: 'DIGITODD', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (lastParity === 1 && prob1to0 > 0.65) {
            return { type: 'DIGITEVEN', score: 2, confidence: 67, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Mean reversion in transitions
        if (lastParity === 0 && prob0to1 < 0.35) {
            return { type: 'DIGITEVEN', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (lastParity === 1 && prob1to0 < 0.35) {
            return { type: 'DIGITODD', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 22. RSI on digit values ─────────────────────────────────────────────────
const rsiDigit: StrategyModule = {
    name: 'RSI_Digit',
    run(_prices, ticks) {
        if (ticks.length < 14) return null;
        const digitValues = ticks.map(d => d);
        const rsiVal = rsi(digitValues, 7);

        if (rsiVal < 25) {
            // Digit value very low (mostly 0-3) → next likely higher → more odd (1,3,5,7,9)
            return { type: 'DIGITODD', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (rsiVal > 75) {
            // Digit value very high (mostly 6-9) → next likely lower → more even (0,2,4,6,8)
            return { type: 'DIGITEVEN', score: 2, confidence: 64, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

// ── 23. Cyclical parity pattern ─────────────────────────────────────────────
const cyclicalParity: StrategyModule = {
    name: 'Cyclical',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        const recent = ticks.slice(-30);
        const parities = recent.map(d => d % 2);

        // Check for periodicity: autocorrelation at lag 1,2,3
        const lag1 = autocorr(parities, 1);
        const lag2 = autocorr(parities, 2);
        const lag3 = autocorr(parities, 3);

        if (lag1 !== null && lag1 > 0.3) {
            // Strong positive serial correlation → parity likely to follow previous
            const lastP = parities[parities.length - 1];
            if (lastP === 0) {
                return { type: 'DIGITEVEN', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'DIGITODD', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        if (lag1 !== null && lag1 < -0.2) {
            // Negative serial correlation → parity alternates → opposite of last
            const lastP = parities[parities.length - 1];
            if (lastP === 0) {
                return { type: 'DIGITODD', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            } else {
                return { type: 'DIGITEVEN', score: 2, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
            }
        }

        // Check 2-period cycle
        if (lag2 !== null && lag2 > 0.4) {
            return { type: parities[parities.length - 2] % 2 === 0 ? 'DIGITEVEN' : 'DIGITODD', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

function autocorr(values: number[], lag: number): number | null {
    if (values.length <= lag * 2) return null;
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n - lag; i++) {
        num += (values[i] - mean) * (values[i + lag] - mean);
    }
    for (let i = 0; i < n; i++) {
        den += (values[i] - mean) ** 2;
    }
    if (den === 0) return null;
    return num / den;
}

// ── 24. Bayesian parity probability ─────────────────────────────────────────
const bayesianParity: StrategyModule = {
    name: 'Bayesian',
    run(_prices, ticks) {
        if (ticks.length < 20) return null;
        const recent = ticks.slice(-20);
        const evens = recent.filter(d => d % 2 === 0).length;
        const total = recent.length;
        const pEven = evens / total;

        // Laplace smoothing: P(even) = (evens + 1) / (total + 2)
        const laplaceEven = (evens + 1) / (total + 2);
        const laplaceOdd = 1 - laplaceEven;

        // Strong conviction
        if (laplaceEven > 0.72) {
            return { type: 'DIGITEVEN', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (laplaceOdd > 0.72) {
            return { type: 'DIGITODD', score: 2, confidence: 68, weight: getStrategyWeight(this.name), name: this.name };
        }

        // Moderate conviction
        if (laplaceEven > 0.62) {
            return { type: 'DIGITEVEN', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (laplaceOdd > 0.62) {
            return { type: 'DIGITODD', score: 1, confidence: 62, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

const evenOddStrategies: StrategyModule[] = [
    parityStreak, parityDistribution, markovParity,
    rsiDigit, cyclicalParity, bayesianParity,
];

/* ═══════════════════════════════════════════════════════════════════════════════
   ENSEMBLE — Main entry point
═══════════════════════════════════════════════════════════════════════════════ */

const ALL_STRATEGIES: StrategyModule[] = [
    ...riseFallStrategies, ...overUnderStrategies, ...evenOddStrategies,
];

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
    const groups = new Map<string, { totalWeight: number; weightedConf: number; reasons: string[]; scores: number[]; barriers: string[] }>();

    for (const v of votes) {
        const key = v.type;
        if (!groups.has(key)) {
            groups.set(key, { totalWeight: 0, weightedConf: 0, reasons: [], scores: [], barriers: [] });
        }
        const g = groups.get(key)!;
        g.totalWeight += v.weight;
        g.weightedConf += v.confidence * v.weight;
        g.scores.push(v.score);
        if (v.barrier) g.barriers.push(v.barrier);
    }

    // Pick the best group
    let bestGroup: { key: string; data: typeof groups extends Map<string, infer V> ? V : never } | null = null;
    let bestScore = 0;

    for (const [key, data] of groups) {
        const avgConf = data.totalWeight > 0 ? data.weightedConf / data.totalWeight : 0;
        const avgScore = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
        const groupScore = data.totalWeight * avgConf * avgScore;

        if (groupScore > bestScore) {
            bestScore = groupScore;
            bestGroup = { key, data };
        }
    }

    if (!bestGroup) return null;

    const { key, data } = bestGroup;
    const avgConf = data.totalWeight > 0 ? data.weightedConf / data.totalWeight : 0;
    const barrier = data.barriers.length > 0
        ? data.barriers.sort((a, b) => {
            const freqA = data.barriers.filter(x => x === a).length;
            const freqB = data.barriers.filter(x => x === b).length;
            return freqB - freqA;
        })[0]
        : undefined;

    // Adjust confidence based on regime
    let regimeBonus = 0;
    if (regime === 'STRONG_BULL' && (key === 'CALL' || key === 'DIGITOVER')) regimeBonus = 5;
    if (regime === 'STRONG_BEAR' && (key === 'PUT' || key === 'DIGITUNDER')) regimeBonus = 5;
    if (regime === 'CHOPPY' && (key === 'CALL' || key === 'PUT')) regimeBonus = -8;
    if (regime === 'CHOPPY' && (key === 'DIGITEVEN' || key === 'DIGITODD')) regimeBonus = -5;

    const finalConfidence = Math.max(CONFIDENCE_FLOOR, Math.min(CONFIDENCE_CEILING, Math.round(avgConf + regimeBonus)));

    const contractType = key as ContractType;

    const details = `Regime: ${regime} | Strategies: ${votes.filter(v => v.type === key).map(v => `${v.name}(${v.confidence.toFixed(0)})`).join(', ')}`;

    return {
        contract_type: contractType,
        barrier,
        confidence: finalConfidence,
        reason: `${contractType} ${barrier ? '@ ' + barrier : ''} — ensemble of ${votes.length} strategies`,
        details,
    };
}
