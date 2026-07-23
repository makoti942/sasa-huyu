import { getAppId, getSocketURL } from '@/components/shared';
import { onNewSystemMessage, isNewLoggedIn } from '@/auth/NewDerivAuth';

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
    options?: { skipAuth?: boolean },
): MakotiWS {
    // Prefer the OTP WebSocket (new auth system) — the legacy app ID 101585 has
    // been retired by Deriv, so legacy WS connections no longer work.
    if (typeof window !== 'undefined' && (window._newSystemWS || isNewLoggedIn())) {
        const unsub = onNewSystemMessage((event) => {
            try {
                const data = JSON.parse(event.data);
                onMessage(data);
            } catch (_) {}
        });

        // If OTP WS is already open, signal ready immediately.
        // Otherwise poll until it becomes open (it may still be CONNECTING
        // or createNewWebSocket might not have been called yet).
        let stopped = false;
        let readyFired = false;
        const checkReady = () => {
            if (stopped || readyFired) return;
            if (window._newSystemWS?.readyState === WebSocket.OPEN) {
                readyFired = true;
                onReady();
                return;
            }
            setTimeout(checkReady, 200);
        };
        checkReady();

        return {
            send:   (msg) => {
                if (window._newSystemWS?.readyState === WebSocket.OPEN) {
                    window._newSystemWS.send(JSON.stringify(msg));
                }
            },
            close:  ()    => {
                stopped = true;
                unsub();
            },
            isOpen: ()    => window._newSystemWS?.readyState === WebSocket.OPEN,
        };
    }

    // Fallback to legacy WS (only used when OTP WS is not available)
    const appId     = getAppId();
    const serverUrl = getSocketURL();
    const ws        = new WebSocket(`wss://${serverUrl}/websockets/v3?app_id=${appId}`);

    ws.onopen = () => {
        if (options?.skipAuth) { onReady(); return; }
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
 * Micro-timing signal engine optimized for 1-tick Rise/Fall prediction.
 * Focuses on immediate tick momentum, streak exhaustion, and ultra-short RSI(3).
 * Requires only 5+ prices (no slow medium-term indicators).
 */
export function analyzeSignal(ticks: number[], prices: number[]): TradeSignal | null {
    if (prices.length < 5) return null;

    // ── Micro price action ────────────────────────────────────────────
    const d1 = prices[prices.length - 1] - prices[prices.length - 2];
    const d2 = prices[prices.length - 2] - prices[prices.length - 3];
    const d3 = prices[prices.length - 3] - prices[prices.length - 4];

    if (d1 === 0) return null; // flat tick → skip

    // ── Full streak from current tick ─────────────────────────────────
    const streakDir = d1 > 0 ? 1 : -1;
    let streakLen = 0;
    for (let i = prices.length - 1; i > 0; i--) {
        const d = prices[i] - prices[i - 1];
        if (d === 0) continue;
        if ((d > 0 ? 1 : -1) === streakDir) streakLen++;
        else break;
    }
    const streak = streakLen * streakDir;

    // ── RSI(3) ultra-short ────────────────────────────────────────────
    const rsi3 = calcRSI(prices, 3);

    // ── Direction-change chop detection ───────────────────────────────
    const last5Dirs: number[] = [];
    for (let i = Math.max(0, prices.length - 5); i < prices.length - 1; i++) {
        const d = prices[i + 1] - prices[i];
        if (d > 0) last5Dirs.push(1);
        else if (d < 0) last5Dirs.push(-1);
    }
    let dirChanges = 0;
    for (let i = 1; i < last5Dirs.length; i++) {
        if (last5Dirs[i] !== last5Dirs[i - 1]) dirChanges++;
    }

    // ── Volatility (5-tick normalized range) ───────────────────────────
    const last5 = prices.slice(-5);
    const range5 = Math.max(...last5) - Math.min(...last5);
    const avg5 = last5.reduce((a, b) => a + b, 0) / last5.length;
    const volPct = avg5 > 0 ? (range5 / avg5) * 100 : 0;

    // ── Micro-timing score ────────────────────────────────────────────
    let score = 0;
    const signals: string[] = [];

    // 1. Last tick momentum (+1 for direction)
    if (d1 > 0) { score += 1; signals.push('↑'); }
    else if (d1 < 0) { score -= 1; signals.push('↓'); }

    // 2. Continuation bonus (two same-direction ticks)
    if (d1 > 0 && d2 > 0) { score += (d2 > 0 ? 1 : 0); signals.push('↑↑'); }
    else if (d1 < 0 && d2 < 0) { score -= 1; signals.push('↓↓'); }

    // 3. Three-peat bonus (strong momentum conviction)
    if (d1 > 0 && d2 > 0 && d3 > 0) { score += 1; signals.push('↑↑↑'); }
    else if (d1 < 0 && d2 < 0 && d3 < 0) { score -= 1; signals.push('↓↓↓'); }

    // 4. Streak exhaustion — longer runs increase reversal probability
    if (streak >= 6) { score -= 2; signals.push(`strk${streak}`); }
    else if (streak >= 4) { score -= 1; }
    else if (streak >= 2) { score -= 0; } // mild continuation
    if (streak <= -6) { score += 2; signals.push(`strk${streak}`); }
    else if (streak <= -4) { score += 1; }
    else if (streak <= -2) { score += 0; }

    // 5. RSI(3) micro-reversal — catches immediate oversold/overbought
    if (rsi3 < 10) { score += 2; signals.push('RSI3↓'); }
    else if (rsi3 < 20) { score += 1; signals.push('RSI3↓'); }
    if (rsi3 > 90) { score -= 2; signals.push('RSI3↑'); }
    else if (rsi3 > 80) { score -= 1; signals.push('RSI3↑'); }

    // 6. Chop filter — reduce conviction in whipsaw markets
    if (dirChanges >= 3) {
        if (score > 0) score = Math.max(0, score - 2);
        else if (score < 0) score = Math.min(0, score + 2);
        signals.push('chop');
    }

    // 7. Extreme chop — always skip
    if (dirChanges >= 4) return null;

    // ── Entry ─────────────────────────────────────────────────────────
    if (Math.abs(score) < 3) return null;

    const absScore = Math.abs(score);
    const volBonus = volPct > 0.05 ? 3 : 0;
    const conf = Math.min(92, 70 + absScore * 5 + volBonus);

    if (score > 0) {
        return {
            contract_type: 'CALL', barrier: '',
            confidence: conf,
            reason: `RISE ${signals.join(' ')}`,
            indicators: `s${score} r3:${rsi3.toFixed(0)} stk:${streak}`,
        };
    }
    return {
        contract_type: 'PUT', barrier: '',
        confidence: conf,
        reason: `FALL ${signals.join(' ')}`,
        indicators: `s${score} r3:${rsi3.toFixed(0)} stk:${streak}`,
    };
}

// ─── Digit pct helper (used by scanner) ──────────────────────────────────────

export function getDigitPcts(ticks: number[], count = 100): number[] {
    return digitPcts(ticks, count);
}
