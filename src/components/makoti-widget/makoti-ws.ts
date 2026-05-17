import { getAppId, getSocketURL } from '@/components/shared';

// ─── Symbols & pip sizes ──────────────────────────────────────────────────────

export const ALL_SYMBOLS = [
    'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
    '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V',
];

export const SYMBOL_LABELS: Record<string, string> = {
    R_10: 'V 10', R_25: 'V 25', R_50: 'V 50', R_75: 'V 75', R_100: 'V 100',
    '1HZ10V': 'V 10 (1s)', '1HZ25V': 'V 25 (1s)', '1HZ50V': 'V 50 (1s)',
    '1HZ75V': 'V 75 (1s)', '1HZ100V': 'V 100 (1s)',
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
        const ca = localStorage.getItem('client.accounts');
        if (ca) { const t = JSON.parse(ca)[active_loginid]?.token; if (t) return t; }
        const al = localStorage.getItem('accountsList');
        if (al) { const t = JSON.parse(al)[active_loginid]; if (t) return t; }
    } catch (_) {}
    return null;
}

// ─── WebSocket type ───────────────────────────────────────────────────────────

export type MakotiWS = {
    send:   (msg: object) => void;
    close:  () => void;
    isOpen: () => boolean;
};

// ─── OTP-based WebSocket factory (new API v2) ─────────────────────────────────

/**
 * Open a WebSocket using the new Deriv API v2 OTP flow.
 * Fetches a one-time-use authenticated URL from the backend, connects,
 * and returns a MakotiWS handle.  No `authorize` message is needed — the
 * OTP URL is already authenticated.
 *
 * Falls back to `openMakotiWS` (legacy) if OTP is unavailable.
 */
export async function openMakotiWSWithOTP(
    onMessage: (data: any) => void,
    onReady:   () => void,
    onClose:   () => void,
    accountId?: string,
): Promise<MakotiWS> {
    try {
        const body = accountId ? JSON.stringify({ accountId }) : JSON.stringify({});
        const res  = await fetch('/api/trading/otp', {
            method:      'POST',
            headers:     { 'Content-Type': 'application/json' },
            credentials: 'include',
            body,
        });

        if (res.ok) {
            const data = await res.json() as { success?: boolean; url?: string };
            if (data.url) {
                console.log('🔗 [MakotiWS] Connecting via OTP URL (new API v2)');
                const ws = new WebSocket(data.url);

                ws.onopen    = () => onReady();
                ws.onmessage = (evt) => {
                    try { onMessage(JSON.parse(evt.data)); } catch (_) {}
                };
                ws.onerror   = () => {};
                ws.onclose   = () => onClose();

                return {
                    send:   (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
                    close:  ()    => { try { ws.close(); } catch (_) {} },
                    isOpen: ()    => ws.readyState === WebSocket.OPEN,
                };
            }
        }
    } catch (err) {
        console.warn('⚠️ [MakotiWS] OTP fetch failed, falling back to legacy WS:', err);
    }

    // Fallback: legacy WebSocket (authorize via token)
    return openMakotiWS(onMessage, onReady, onClose);
}

// ─── Legacy WebSocket factory (old API, authorize via token) ──────────────────

export function openMakotiWS(
    onMessage: (data: any) => void,
    onReady:   () => void,
    onClose:   () => void,
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

function calcRSI(prices: number[], period = 7): number {
    if (prices.length < period + 1) return 50;
    const slice   = prices.slice(-(period * 4 + 1));
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

function calcBBPosition(prices: number[], period = 14): number {
    if (prices.length < period) return 0.5;
    const slice    = prices.slice(-period);
    const mean     = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std      = Math.sqrt(variance);
    if (std === 0) return 0.5;
    const upper = mean + 2 * std;
    const lower = mean - 2 * std;
    return (prices[prices.length - 1] - lower) / (upper - lower);
}

function calcMACDHistogram(prices: number[]): { hist: number; prevHist: number } {
    if (prices.length < 28) return { hist: 0, prevHist: 0 };
    const ema12    = calcEMA(prices, 12);
    const ema26    = calcEMA(prices, 26);
    const offset   = ema12.length - ema26.length;
    const macdLine = ema26.map((v, i) => ema12[i + offset] - v);
    if (macdLine.length < 9) return { hist: macdLine.at(-1) ?? 0, prevHist: 0 };
    const signal   = calcEMA(macdLine, 9);
    const hist     = macdLine.at(-1)! - signal.at(-1)!;
    const prevHist = macdLine.at(-2)! - signal.at(-2)!;
    return { hist, prevHist };
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
    const arr   = ticks.slice(-window);
    const total = arr.length || 1;
    const c     = Array(10).fill(0);
    arr.forEach(d => { if (d >= 0 && d <= 9) c[d]++; });
    return c.map(v => (v / total) * 100);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SIGNAL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradeSignal {
    contract_type: string;
    barrier:       string;
    confidence:    number;
    reason:        string;
    indicators:    string;
}

export function analyzeSignal(ticks: number[], prices: number[]): TradeSignal | null {
    if (ticks.length < 30 || prices.length < 15) return null;

    const p20  = digitPcts(ticks, 20);
    const p50  = digitPcts(ticks, 50);
    const p100 = ticks.length >= 100 ? digitPcts(ticks, 100) : p50;

    const rsi    = calcRSI(prices, 7);
    const bbPos  = calcBBPosition(prices, 14);
    const streak = priceStreak(prices.slice(-20));
    const { hist: macdH, prevHist: macdPrev } = calcMACDHistogram(prices);
    const macdBull = macdH > 0 && macdPrev <= 0;
    const macdBear = macdH < 0 && macdPrev >= 0;

    let ema9Cross = '';
    if (prices.length >= 22) {
        const e9  = calcEMA(prices, 9);
        const e21 = calcEMA(prices, 21);
        if (e9.length >= 2 && e21.length >= 2) {
            const l = e9.length - 1;
            if (e9[l] > e21[l] && e9[l - 1] <= e21[l - 1]) ema9Cross = 'bull';
            if (e9[l] < e21[l] && e9[l - 1] >= e21[l - 1]) ema9Cross = 'bear';
        }
    }

    let bullVotes = 0, bearVotes = 0;
    const bullReasons: string[] = [], bearReasons: string[] = [];

    if (rsi < 20)  { bullVotes += 3; bullReasons.push(`RSI ${rsi.toFixed(1)}`); }
    else if (rsi < 30) { bullVotes += 2; bullReasons.push(`RSI ${rsi.toFixed(1)}`); }
    else if (rsi < 40) { bullVotes += 1; bullReasons.push(`RSI ${rsi.toFixed(1)}`); }
    if (rsi > 80)  { bearVotes += 3; bearReasons.push(`RSI ${rsi.toFixed(1)}`); }
    else if (rsi > 70) { bearVotes += 2; bearReasons.push(`RSI ${rsi.toFixed(1)}`); }
    else if (rsi > 60) { bearVotes += 1; bearReasons.push(`RSI ${rsi.toFixed(1)}`); }

    if (bbPos < 0.10) { bullVotes += 3; bullReasons.push('at lower BB'); }
    else if (bbPos < 0.20) { bullVotes += 2; bullReasons.push('near lower BB'); }
    else if (bbPos < 0.30) { bullVotes += 1; bullReasons.push('approaching lower BB'); }
    if (bbPos > 0.90) { bearVotes += 3; bearReasons.push('at upper BB'); }
    else if (bbPos > 0.80) { bearVotes += 2; bearReasons.push('near upper BB'); }
    else if (bbPos > 0.70) { bearVotes += 1; bearReasons.push('approaching upper BB'); }

    if (macdBull) { bullVotes += 2; bullReasons.push('MACD bull cross'); }
    if (macdBear) { bearVotes += 2; bearReasons.push('MACD bear cross'); }
    if (macdH > 0 && macdH > macdPrev) { bullVotes += 1; bullReasons.push('MACD rising'); }
    if (macdH < 0 && macdH < macdPrev) { bearVotes += 1; bearReasons.push('MACD falling'); }

    if (ema9Cross === 'bull') { bullVotes += 2; bullReasons.push('EMA9×EMA21 bull'); }
    if (ema9Cross === 'bear') { bearVotes += 2; bearReasons.push('EMA9×EMA21 bear'); }

    if (streak >= 5) { bullVotes += 2; bullReasons.push(`${streak} up streak`); }
    else if (streak >= 3) { bullVotes += 1; bullReasons.push(`${streak} up streak`); }
    if (streak <= -5) { bearVotes += 2; bearReasons.push(`${Math.abs(streak)} dn streak`); }
    else if (streak <= -3) { bearVotes += 1; bearReasons.push(`${Math.abs(streak)} dn streak`); }

    const voteMargin = Math.abs(bullVotes - bearVotes);
    const totalVotes = bullVotes + bearVotes;

    if (bullVotes > bearVotes && totalVotes >= 3 && voteMargin >= 2) {
        const conf = Math.min(92, 65 + bullVotes * 3 + voteMargin * 2);
        return { contract_type: 'CALL', barrier: '', confidence: conf, reason: `RISE — ${bullReasons.join(', ')}`, indicators: bullReasons.join(' | ') };
    }

    if (bearVotes > bullVotes && totalVotes >= 3 && voteMargin >= 2) {
        const conf = Math.min(92, 65 + bearVotes * 3 + voteMargin * 2);
        return { contract_type: 'PUT', barrier: '', confidence: conf, reason: `FALL — ${bearReasons.join(', ')}`, indicators: bearReasons.join(' | ') };
    }

    const hi69_20  = p20[6] + p20[7] + p20[8] + p20[9];
    const hi69_50  = p50[6] + p50[7] + p50[8] + p50[9];
    const hi69_100 = p100[6] + p100[7] + p100[8] + p100[9];
    const hi59_20  = p20[5]  + hi69_20;
    const hi59_50  = p50[5]  + hi69_50;
    const lo03_20  = p20[0]  + p20[1]  + p20[2]  + p20[3];
    const lo03_50  = p50[0]  + p50[1]  + p50[2]  + p50[3];
    const lo03_100 = p100[0] + p100[1] + p100[2] + p100[3];
    const lo04_20  = lo03_20 + p20[4];
    const lo04_50  = lo03_50 + p50[4];

    if (hi69_20 > 52 && hi69_50 > 46 && hi69_100 > 40) {
        const conf = Math.min(90, 70 + (hi69_50 - 40) * 1.0 + (hi69_20 - 46) * 0.5);
        return { contract_type: 'DIGITOVER', barrier: '5', confidence: conf, reason: `Digits 6-9: ${hi69_20.toFixed(0)}%/20t · ${hi69_50.toFixed(0)}%/50t · ${hi69_100.toFixed(0)}%/100t — OVER 5`, indicators: '3-TF digit convergence HIGH' };
    }

    if (lo03_20 > 52 && lo03_50 > 46 && lo03_100 > 40) {
        const conf = Math.min(90, 70 + (lo03_50 - 40) * 1.0 + (lo03_20 - 46) * 0.5);
        return { contract_type: 'DIGITUNDER', barrier: '4', confidence: conf, reason: `Digits 0-3: ${lo03_20.toFixed(0)}%/20t · ${lo03_50.toFixed(0)}%/50t · ${lo03_100.toFixed(0)}%/100t — UNDER 4`, indicators: '3-TF digit convergence LOW' };
    }

    if (hi59_20 > 60 && hi59_50 > 56) {
        const barrier = hi69_50 > 48 ? '5' : '4';
        const conf = Math.min(85, 68 + (hi59_50 - 50) * 1.2);
        return { contract_type: 'DIGITOVER', barrier, confidence: conf, reason: `Digits 5-9: ${hi59_20.toFixed(0)}%/20t · ${hi59_50.toFixed(0)}%/50t — OVER ${barrier}`, indicators: '2-TF digit convergence HIGH' };
    }

    if (lo04_20 > 60 && lo04_50 > 56) {
        const barrier = lo03_50 > 48 ? '4' : '5';
        const conf = Math.min(85, 68 + (lo04_50 - 50) * 1.2);
        return { contract_type: 'DIGITUNDER', barrier, confidence: conf, reason: `Digits 0-4: ${lo04_20.toFixed(0)}%/20t · ${lo04_50.toFixed(0)}%/50t — UNDER ${barrier}`, indicators: '2-TF digit convergence LOW' };
    }

    if (hi69_50 > 50 && hi69_20 > 50 && rsi >= 35 && rsi <= 65) {
        return { contract_type: 'DIGITOVER', barrier: '5', confidence: Math.min(80, 66 + (hi69_50 - 44) * 1.0), reason: `Digits 6-9 at ${hi69_50.toFixed(0)}%/50t, RSI neutral — OVER 5`, indicators: 'Digit bias HIGH + RSI neutral' };
    }

    if (lo03_50 > 50 && lo03_20 > 50 && rsi >= 35 && rsi <= 65) {
        return { contract_type: 'DIGITUNDER', barrier: '4', confidence: Math.min(80, 66 + (lo03_50 - 44) * 1.0), reason: `Digits 0-3 at ${lo03_50.toFixed(0)}%/50t, RSI neutral — UNDER 4`, indicators: 'Digit bias LOW + RSI neutral' };
    }

    return null;
}

export function getDigitPcts(ticks: number[], count = 100): number[] {
    return digitPcts(ticks, count);
}
