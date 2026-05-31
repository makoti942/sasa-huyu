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

const riseFallStrategies: StrategyModule[] = [
    microTiming, rsiDivergence, macdStrategy, bbStrategy,
    stochasticStrategy, atrBreakout, priceAction, maCross,
    meanReversion, cciStrategy, zlemaStrategy, keltnerStrategy,
    rocStrategy, fractalEfficiency, digitPsychology, candleReversal,
    doubleTopBottom, exhaustionRev, pivotReversal, tickVelocity,
    fibonacciRetrace, statisticalExtreme,
    nPatternMatch, hlSequence, volContraction, mtfAlignment, barPatternSeq,
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

    if (!bestType || bestScore < 68) return null;
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

const overUnderStrategies: StrategyModule[] = [
    longTermDistribution, windowAlignment, timedEntry, digitGapAnalysis, streakWithDist,
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

// ── 7. Run-Length Encoded Parity Analysis ────────────────────────────────────
const runLengthParity: StrategyModule = {
    name: 'RunLength',
    run(_prices, ticks) {
        if (ticks.length < 20) return null;
        const recentParity = ticks.slice(-30).map(d => d % 2);

        // Run-length encode the parity sequence
        const runs: { parity: number; len: number }[] = [];
        for (const p of recentParity) {
            if (runs.length > 0 && runs[runs.length - 1].parity === p) {
                runs[runs.length - 1].len++;
            } else {
                runs.push({ parity: p, len: 1 });
            }
        }

        if (runs.length < 2) return null;
        const lastRun = runs[runs.length - 1];
        const prevRun = runs[runs.length - 2];

        // Long run of same parity → reversal likely
        if (lastRun.len >= 5) {
            const confidence = Math.min(84, 68 + lastRun.len * 3);
            return {
                type: lastRun.parity === 0 ? 'DIGITODD' : 'DIGITEVEN',
                score: 2,
                confidence: Math.round(confidence),
                weight: getStrategyWeight(this.name),
                name: this.name,
            };
        }

        // Alternating pattern (1,1,1,2,2,2 alternating) 
        if (runs.length >= 4) {
            const last4 = runs.slice(-4);
            const altPattern = last4.every(r => r.len >= 1 && r.len <= 3);
            if (altPattern && lastRun.len >= 2) {
                // continuation of alternation
                const nextParity = lastRun.parity === 0 ? 1 : 0;
                return {
                    type: nextParity === 0 ? 'DIGITEVEN' : 'DIGITODD',
                    score: 1,
                    confidence: 66,
                    weight: getStrategyWeight(this.name),
                    name: this.name,
                };
            }
        }

        // Run length ratio: if current run is much longer than average → reversal
        const avgRunLen = runs.slice(0, -1).reduce((a, r) => a + r.len, 0) / (runs.length - 1 || 1);
        if (avgRunLen > 1 && lastRun.len > avgRunLen * 2.5) {
            const conf = Math.min(82, 65 + Math.round((lastRun.len / avgRunLen) * 8));
            return {
                type: lastRun.parity === 0 ? 'DIGITODD' : 'DIGITEVEN',
                score: 2,
                confidence: Math.round(conf),
                weight: getStrategyWeight(this.name),
                name: this.name,
            };
        }

        return null;
    },
};

// ── 8. Consecutive Digit Pair Parity ─────────────────────────────────────────
const pairParity: StrategyModule = {
    name: 'PairParity',
    run(_prices, ticks) {
        if (ticks.length < 30) return null;
        // Build transition matrix: digit value → parity of next digit
        const trans: Record<number, { even: number; odd: number; total: number }> = {};
        for (let d = 0; d <= 9; d++) trans[d] = { even: 0, odd: 0, total: 0 };

        for (let i = 1; i < ticks.length; i++) {
            const from = ticks[i - 1];
            const toParity = ticks[i] % 2;
            if (from >= 0 && from <= 9 && trans[from]) {
                if (toParity === 0) trans[from].even++;
                else trans[from].odd++;
                trans[from].total++;
            }
        }

        const lastDigit = ticks[ticks.length - 1];
        if (lastDigit < 0 || lastDigit > 9 || trans[lastDigit].total < 3) return null;

        const t = trans[lastDigit];
        const evenProb = t.even / t.total;
        const oddProb = t.odd / t.total;

        // Calculate confidence based on skew and sample size
        const skew = Math.abs(evenProb - oddProb);
        const sizeBonus = Math.min(8, t.total * 0.3);

        // Also check if this aligns with digit psychology
        const isEvenDigit = lastDigit % 2 === 0;
        const ecoCluster = lastDigit >= 4 && lastDigit <= 6;

        if (evenProb > 0.65) {
            const conf = Math.min(84, 66 + Math.round(skew * 30 + sizeBonus) + (ecoCluster ? 4 : 0));
            return { type: 'DIGITEVEN', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }
        if (oddProb > 0.65) {
            const conf = Math.min(84, 66 + Math.round(skew * 30 + sizeBonus) + (ecoCluster ? 4 : 0));
            return { type: 'DIGITODD', score: 2, confidence: Math.round(conf), weight: getStrategyWeight(this.name), name: this.name };
        }

        // Moderate signal if current digit parity aligns with strong transition
        if (evenProb > 0.58 && isEvenDigit) {
            return { type: 'DIGITEVEN', score: 1, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }
        if (oddProb > 0.58 && !isEvenDigit) {
            return { type: 'DIGITODD', score: 1, confidence: 66, weight: getStrategyWeight(this.name), name: this.name };
        }

        return null;
    },
};

const evenOddStrategies: StrategyModule[] = [
    parityStreak, parityDistribution, markovParity,
    rsiDigit, cyclicalParity, bayesianParity,
    runLengthParity, pairParity,
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

    // Pick the best group — use weighted average confidence as primary metric
    let bestGroup: { key: string; data: typeof groups extends Map<string, infer V> ? V : never } | null = null;
    let bestScore = 0;

    for (const [key, data] of groups) {
        const avgConf = data.totalWeight > 0 ? data.weightedConf / data.totalWeight : 0;
        const voterCount = data.scores.length;
        // Use avgConf as primary score, small bonus for multi-strategy consensus
        const groupScore = avgConf + Math.min(3, voterCount * 0.5);

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
