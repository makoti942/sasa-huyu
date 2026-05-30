import { getAppId, getSocketURL } from '@/components/shared';

// ─── Symbols & pip sizes ──────────────────────────────────────────────────────

export const ALL_SYMBOLS = [
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
];

export const SYMBOL_LABELS: Record<string, string> = {
    R_10: 'Volatility 10', R_25: 'Volatility 25', R_50: 'Volatility 50', R_75: 'Volatility 75', R_100: 'Volatility 100',
    '1HZ10V': 'Volatility 10 (1s)', '1HZ25V': 'Volatility 25 (1s)', '1HZ50V': 'Volatility 50 (1s)',
    '1HZ75V': 'Volatility 75 (1s)', '1HZ100V': 'Volatility 100 (1s)',
};

export const PIP_SIZES: Record<string, number> = {
    R_100: 2, R_75: 4, R_50: 4, R_25: 3, R_10: 3,
    '1HZ100V': 2, '1HZ75V': 2, '1HZ50V': 2, '1HZ25V': 2, '1HZ10V': 2,
};

// ─── Token helper ─────────────────────────────────────────────────────────────

export function getToken(): string | null {
    try {
        const active_loginid = localStorage.getItem('active_loginid');
        if (!active_loginid) return null;

        // Account IDs look like CR1234567 or VR1234567; real tokens are long JWTs/hex strings
        const isRealToken = (v: string) => v && !/^[A-Z]{2,3}\d+$/.test(v);

        const ca = localStorage.getItem('client.accounts');
        if (ca) { const t = JSON.parse(ca)[active_loginid]?.token; if (t && isRealToken(t)) return t; }

        const al = localStorage.getItem('accountsList');
        if (al) { const t = JSON.parse(al)[active_loginid]; if (t && isRealToken(t)) return t; }

        // Try direct authToken key (legacy auth sets a real token here)
        const authToken = localStorage.getItem('authToken');
        if (authToken && isRealToken(authToken)) return authToken;

        // Try token_<loginid> pattern used by some Deriv apps
        const tokenKey = `token_${active_loginid}`;
        const tokenVal = localStorage.getItem(tokenKey);
        if (tokenVal && isRealToken(tokenVal)) return tokenVal;
    } catch (_) {}
    return null;
}

// ─── WebSocket factory ────────────────────────────────────────────────────────

export type MakotiWS = {
    send: (msg: object) => void;
    close: () => void;
    isOpen: () => boolean;
};

export function openMakotiWS(
    onMessage: (data: any) => void,
    onReady: () => void,
    onClose: () => void,
): MakotiWS {
    const appId     = getAppId();
    const serverUrl = getSocketURL();
    const ws        = new WebSocket(`wss://${serverUrl}/websockets/v3?app_id=${appId}`);

    ws.onopen = () => {
        const token = getToken();
        if (token) ws.send(JSON.stringify({ authorize: token }));
        else       onReady();
    };

    ws.onmessage = (evt) => {
        try {
            const data = JSON.parse(evt.data);
            if (data.msg_type === 'authorize') onReady();
            onMessage(data);
        } catch (_) {}
    };

    ws.onerror = () => {};
    ws.onclose = () => onClose();

    return {
        send:   (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
        close:  ()    => { try { ws.close(); } catch (_) {} },
        isOpen: ()    => ws.readyState === WebSocket.OPEN,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

/** Exponential Moving Average */
export function calcEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result = [ema];
    for (let i = period; i < prices.length; i++) {
        ema = prices[i] * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

/**
 * RSI — Wilder smoothing, fast 7-period by default.
 * Returns value 0-100. < 30 oversold, > 70 overbought.
 */
function calcRSI(prices: number[], period = 7): number {
    if (prices.length < period + 1) return 50;
    const slice   = prices.slice(-(period * 4 + 1));   // last 4× period for warm-up
    const changes = slice.slice(1).map((p, i) => p - slice[i]);
    const gains   = changes.map(c => Math.max(0, c));
    const losses  = changes.map(c => Math.max(0, -c));

    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < gains.length; i++) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

/**
 * Bollinger Bands — returns the price's position within the bands (0 = lower, 1 = upper).
 * < 0.15 = near lower band (oversold), > 0.85 = near upper band (overbought).
 */
function calcBBPosition(prices: number[], period = 14): number {
    if (prices.length < period) return 0.5;
    const slice   = prices.slice(-period);
    const mean    = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std     = Math.sqrt(variance);
    if (std === 0) return 0.5;
    const upper = mean + 2 * std;
    const lower = mean - 2 * std;
    return (prices[prices.length - 1] - lower) / (upper - lower);
}

/**
 * MACD — (EMA12 - EMA26). Returns current histogram value.
 * Positive and rising = bullish, negative and falling = bearish.
 */
function calcMACDHistogram(prices: number[]): { hist: number; prevHist: number } {
    if (prices.length < 28) return { hist: 0, prevHist: 0 };
    const ema12 = calcEMA(prices, 12);
    const ema26 = calcEMA(prices, 26);
    // align lengths
    const offset = ema12.length - ema26.length;
    const macdLine: number[] = ema26.map((v, i) => ema12[i + offset] - v);
    // Signal line = EMA(9) of MACD
    if (macdLine.length < 9) return { hist: macdLine.at(-1) ?? 0, prevHist: 0 };
    const signal   = calcEMA(macdLine, 9);
    const hist     = macdLine.at(-1)! - signal.at(-1)!;
    const prevHist = macdLine.at(-2)! - signal.at(-2)!;
    return { hist, prevHist };
}

/**
 * Consecutive price direction streak.
 * Positive = N consecutive up ticks, negative = N consecutive down ticks.
 */
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

/** Digit-percentage distribution over a window */
function digitPcts(ticks: number[], window: number): number[] {
    const arr   = ticks.slice(-window);
    const total = arr.length || 1;
    const c     = Array(10).fill(0);
    arr.forEach(d => { if (d >= 0 && d <= 9) c[d]++; });
    return c.map(v => (v / total) * 100);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SIGNAL ENGINE  — Only OVER/UNDER and RISE/FALL. No DIGITDIFF.
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradeSignal {
    contract_type: string;
    barrier: string;
    confidence: number;
    reason: string;
    indicators: string;
}

/**
 * Core analysis function. Returns the best trade signal or null if nothing
 * is strong enough. Strategies fire in priority order; the first one that
 * clears its confidence threshold is returned immediately.
 *
 * Minimum history: 30 ticks / 15 prices before any signal fires.
 *
 * v2 improvements:
 *  - Tighter RSI thresholds (25/75 instead of 40/60)
 *  - Higher entry bar: totalVotes >= 5, voteMargin >= 3
 *  - Trend direction filter (EMA50) boosts aligned trades
 *  - EMA21×50 crossover for medium-term momentum
 *  - Simpler digit strategy: only fires with RSI neutral AND strong convergence
 *  - Volatility filter skips very quiet markets
 *  - Reduced streak sensitivity (only >= 5, weight 1 instead of 2)
 */
export function analyzeSignal(ticks: number[], prices: number[]): TradeSignal | null {
    if (ticks.length < 30 || prices.length < 15) return null;

    // ── Volatility / range filter — skip if too quiet ─────────────────────
    const recentPrices = prices.slice(-20);
    const pxRange = Math.max(...recentPrices) - Math.min(...recentPrices);
    const avgPx = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    if (avgPx > 0 && (pxRange / avgPx) * 100 < 0.008) return null;

    // ── Digit distributions ────────────────────────────────────────────────
    const p20  = digitPcts(ticks, 20);
    const p50  = digitPcts(ticks, 50);

    // ── Price indicators ───────────────────────────────────────────────────
    const rsi    = calcRSI(prices, 7);
    const bbPos  = calcBBPosition(prices, 14);
    const streak = priceStreak(prices.slice(-20));
    const { hist: macdH, prevHist: macdPrev } = calcMACDHistogram(prices);
    const macdBull = macdH > 0 && macdPrev <= 0;
    const macdBear = macdH < 0 && macdPrev >= 0;

    // EMA crossovers
    let ema9Cross = '', ema50Cross = '';
    if (prices.length >= 22) {
        const e9 = calcEMA(prices, 9);
        const e21 = calcEMA(prices, 21);
        if (e9.length >= 2 && e21.length >= 2) {
            const l = e9.length - 1;
            if (e9[l] > e21[l] && e9[l - 1] <= e21[l - 1]) ema9Cross = 'bull';
            if (e9[l] < e21[l] && e9[l - 1] >= e21[l - 1]) ema9Cross = 'bear';
        }
    }
    if (prices.length >= 55) {
        const e21 = calcEMA(prices, 21);
        const e50 = calcEMA(prices, 50);
        if (e21.length >= 2 && e50.length >= 2) {
            const l = e21.length - 1;
            if (e21[l] > e50[l] && e21[l - 1] <= e50[l - 1]) ema50Cross = 'bull';
            if (e21[l] < e50[l] && e21[l - 1] >= e50[l - 1]) ema50Cross = 'bear';
        }
    }

    // ── Trend direction (EMA50, at least 55 prices) ────────────────────────
    let trendDir = 0; // 1 = bullish, -1 = bearish
    if (prices.length >= 55) {
        const e50 = calcEMA(prices, 50);
        const lastPrice = prices[prices.length - 1];
        const e50v = e50[e50.length - 1];
        if (e50v != null) trendDir = lastPrice > e50v ? 1 : (lastPrice < e50v ? -1 : 0);
    }

    // ── Composite confluence scoring ───────────────────────────────────────
    let bullVotes = 0, bearVotes = 0;
    const bullReasons: string[] = [], bearReasons: string[] = [];

    // RSI — tighter thresholds, only strong signals
    if (rsi < 20)  { bullVotes += 3; bullReasons.push(`RSI ${rsi.toFixed(1)}`); }
    else if (rsi < 25) { bullVotes += 2; bullReasons.push(`RSI ${rsi.toFixed(1)}`); }
    if (rsi > 80)  { bearVotes += 3; bearReasons.push(`RSI ${rsi.toFixed(1)}`); }
    else if (rsi > 75) { bearVotes += 2; bearReasons.push(`RSI ${rsi.toFixed(1)}`); }

    // Bollinger Bands — extreme positions only
    if (bbPos < 0.08) { bullVotes += 3; bullReasons.push('lower BB'); }
    else if (bbPos < 0.15) { bullVotes += 2; bullReasons.push('near lower BB'); }
    if (bbPos > 0.92) { bearVotes += 3; bearReasons.push('upper BB'); }
    else if (bbPos > 0.85) { bearVotes += 2; bearReasons.push('near upper BB'); }

    // MACD
    if (macdBull) { bullVotes += 2; bullReasons.push('MACD bull cross'); }
    if (macdBear) { bearVotes += 2; bullReasons.push('MACD bear cross'); }
    if (macdH > 0 && macdH > macdPrev) { bullVotes += 1; bullReasons.push('MACD rising'); }
    if (macdH < 0 && macdH < macdPrev) { bearVotes += 1; bullReasons.push('MACD falling'); }

    // EMA crossovers
    if (ema9Cross === 'bull') { bullVotes += 2; bullReasons.push('EMA9×21 bull'); }
    if (ema9Cross === 'bear') { bearVotes += 2; bullReasons.push('EMA9×21 bear'); }
    if (ema50Cross === 'bull') { bullVotes += 2; bullReasons.push('EMA21×50 bull'); }
    if (ema50Cross === 'bear') { bearVotes += 2; bullReasons.push('EMA21×50 bear'); }

    // Momentum streak — only long streaks, reduced weight
    if (streak >= 5) { bullVotes += 1; bullReasons.push(`${streak}-up streak`); }
    if (streak <= -5) { bearVotes += 1; bullReasons.push(`${Math.abs(streak)}-dn streak`); }

    // Trend alignment bonus
    if (trendDir === 1 && bullVotes > 0) { bullVotes += 1; bullReasons.push('uptrend'); }
    if (trendDir === -1 && bearVotes > 0) { bearVotes += 1; bearReasons.push('downtrend'); }

    // ── RISE / FALL — higher bar ───────────────────────────────────────────
    const voteMargin = Math.abs(bullVotes - bearVotes);
    const totalVotes = bullVotes + bearVotes;

    if (bullVotes > bearVotes && totalVotes >= 5 && voteMargin >= 3) {
        const conf = Math.min(88, 72 + bullVotes * 2 + voteMargin);
        return {
            contract_type: 'CALL', barrier: '',
            confidence: conf,
            reason: `RISE — ${bullReasons.join(', ')}`,
            indicators: bullReasons.join(' | '),
        };
    }

    if (bearVotes > bullVotes && totalVotes >= 5 && voteMargin >= 3) {
        const conf = Math.min(88, 72 + bearVotes * 2 + voteMargin);
        return {
            contract_type: 'PUT', barrier: '',
            confidence: conf,
            reason: `FALL — ${bearReasons.join(', ')}`,
            indicators: bearReasons.join(' | '),
        };
    }

    // ── OVER / UNDER — digit-based, only when RSI neutral ─────────────────
    if (rsi >= 40 && rsi <= 60) {
        const hi69_20 = p20[6] + p20[7] + p20[8] + p20[9];
        const hi69_50 = p50[6] + p50[7] + p50[8] + p50[9];
        const lo03_20 = p20[0] + p20[1] + p20[2] + p20[3];
        const lo03_50 = p50[0] + p50[1] + p50[2] + p50[3];

        if (hi69_50 > 56 && hi69_20 > 52) {
            const conf = Math.min(84, 70 + (hi69_50 - 50));
            return {
                contract_type: 'DIGITOVER', barrier: '5',
                confidence: conf,
                reason: `Digits 6-9: ${hi69_20.toFixed(0)}%/20t · ${hi69_50.toFixed(0)}%/50t — OVER 5`,
                indicators: 'Digit HIGH + RSI neutral',
            };
        }

        if (lo03_50 > 56 && lo03_20 > 52) {
            const conf = Math.min(84, 70 + (lo03_50 - 50));
            return {
                contract_type: 'DIGITUNDER', barrier: '4',
                confidence: conf,
                reason: `Digits 0-3: ${lo03_20.toFixed(0)}%/20t · ${lo03_50.toFixed(0)}%/50t — UNDER 4`,
                indicators: 'Digit LOW + RSI neutral',
            };
        }
    }

    return null;
}

// ─── Digit pct helper (used by scanner) ──────────────────────────────────────

export function getDigitPcts(ticks: number[], count = 100): number[] {
    return digitPcts(ticks, count);
}
