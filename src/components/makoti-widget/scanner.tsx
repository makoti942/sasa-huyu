import React, { useCallback, useRef, useState, useEffect } from 'react';
import { ALL_SYMBOLS, SYMBOL_LABELS, PIP_SIZES, openMakotiWS, MakotiWS } from './makoti-ws';
import { onNewSystemMessage } from '@/auth/NewDerivAuth';

type BotId = 'pvty_kill' | 'rf_v4';

interface SymbolDigitResult {
    symbol: string;
    label: string;
    pcts: number[];
    totalTicks: number;
    qualifies: boolean;
    detail: string;
}

interface SymbolDirectionResult {
    symbol: string;
    label: string;
    choppinessScore: number;
    bodyRatio: number;
    directionChanges: number;
    trendStrength: number;
    recentBodyRatio: number;
    qualifies: boolean;
    detail: string;
}

type ScanResult = SymbolDigitResult | SymbolDirectionResult;

function isDigitResult(r: ScanResult): r is SymbolDigitResult {
    return (r as SymbolDigitResult).pcts !== undefined;
}

function calcDigitPcts(digits: number[]): number[] {
    const counts = Array(10).fill(0);
    digits.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; });
    const total = digits.length || 1;
    return counts.map(c => (c / total) * 100);
}

/* ── Deep choppiness analysis ────────────────────────────────────────────── */
// Analyzes both the line chart (close prices) and candlestick patterns to
// detect markets that are struggling to find direction — choppy, indecisive,
// no sustained momentum. Returns a 0–100 choppiness score (higher = more
// directionless / random).
function calcChoppiness(candles: any[]): SymbolDirectionResult {
    const lookback = Math.min(50, candles.length);
    const recent = candles.slice(-lookback);

    const closes = recent.map(c => Number(c.close));
    const opens  = recent.map(c => Number(c.open));
    const highs  = recent.map(c => Number(c.high));
    const lows   = recent.map(c => Number(c.low));

    // ──────────── LINE-CHART (close-price) analysis ─────────────────

    // 1. Direction change frequency — how often does close-to-close flip?
    let dirChanges = 0;
    for (let i = 2; i < closes.length; i++) {
        const d1 = closes[i - 1] - closes[i - 2];
        const d2 = closes[i]     - closes[i - 1];
        if (d1 > 0 && d2 < 0) dirChanges++;
        else if (d1 < 0 && d2 > 0) dirChanges++;
    }
    const dirChangeRate = dirChanges / Math.max(1, closes.length - 2);

    // 2. Average consecutive same-direction run length
    let runSum = 0, runCount = 0, curRun = 0, curDir = 0;
    for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const d = diff > 0 ? 1 : diff < 0 ? -1 : curDir;
        if (d === curDir && d !== 0) { curRun++; }
        else if (d !== 0) {
            if (curRun > 0) { runSum += curRun; runCount++; }
            curRun = 1; curDir = d;
        }
    }
    if (curRun > 0) { runSum += curRun; runCount++; }
    const avgRun = runCount > 0 ? runSum / runCount : 1;
    const runScore = Math.max(0, 1 - avgRun / 4); // runs of 1–2 = very choppy

    // 3. Mean-reversion crossovers — how often price crosses its 5-period SMA
    const sma5: number[] = [];
    for (let i = 0; i < closes.length; i++) {
        if (i < 4) { sma5.push(closes[i]); continue; }
        let s = 0; for (let j = i - 4; j <= i; j++) s += closes[j];
        sma5.push(s / 5);
    }
    let crossovers = 0;
    for (let i = 1; i < closes.length; i++) {
        if ((closes[i - 1] > sma5[i - 1]) !== (closes[i] > sma5[i])) crossovers++;
    }
    const crossoverRate = Math.min(1, crossovers / Math.max(1, closes.length - 1));

    // 4. Lag-1 autocorrelation of returns (low = random walk = choppy)
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(closes[i] - closes[i - 1]);
    let autoCorr = 0;
    if (rets.length > 2) {
        const r1 = rets.slice(0, -1), r2 = rets.slice(1);
        const m1 = r1.reduce((a, b) => a + b, 0) / r1.length;
        const m2 = r2.reduce((a, b) => a + b, 0) / r2.length;
        let num = 0, d1 = 0, d2 = 0;
        for (let i = 0; i < r1.length; i++) {
            num += (r1[i] - m1) * (r2[i] - m2);
            d1  += (r1[i] - m1) ** 2;
            d2  += (r2[i] - m2) ** 2;
        }
        autoCorr = d1 * d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;
    }
    const acScore = Math.max(0, 1 - Math.abs(autoCorr));

    // 5. Sideways ratio — % of closes inside the middle 30 % of the range
    const maxC = Math.max(...closes), minC = Math.min(...closes);
    const rangeC = maxC - minC || 1;
    const mid = (maxC + minC) / 2;
    const band = rangeC * 0.15;
    const sidewaysPct = closes.filter(c => Math.abs(c - mid) <= band).length / closes.length;

    // ──────────── CANDLESTICK analysis ────────────────────────────

    // 6. Body-to-range ratio (small = indecision)
    let bodySum = 0, rangeSum = 0, dojiCount = 0;
    for (let i = 0; i < recent.length; i++) {
        const body = Math.abs(closes[i] - opens[i]);
        const r = highs[i] - lows[i] || 1;
        bodySum += body / r;
        rangeSum += r;
        if (body / r < 0.08) dojiCount++;
    }
    const avgBodyRatio = bodySum / recent.length;
    const dojiRatio = dojiCount / recent.length;

    // 7. Wick symmetry — balanced upper/lower = indecision
    let wickScoreSum = 0;
    for (let i = 0; i < recent.length; i++) {
        const upper = highs[i] - Math.max(opens[i], closes[i]);
        const lower = Math.min(opens[i], closes[i]) - lows[i];
        const total = upper + lower;
        if (total > 0) wickScoreSum += 1 - Math.abs(upper - lower) / total;
        else wickScoreSum += 0.5;
    }
    const avgWickSym = wickScoreSum / recent.length; // 1 = perfectly balanced

    // ──────────── Composite score ────────────────────────────────
    const score = Math.min(100, Math.round(
        dirChangeRate          * 22 +      // frequent direction flips
        runScore               * 18 +      // short runs (1–2 candles)
        crossoverRate          * 15 +      // many SMA crossovers
        acScore                * 12 +      // low autocorrelation (random)
        sidewaysPct            * 10 +      // price stuck in middle band
        (1 - avgBodyRatio)     * 10 +      // small bodies = indecision
        dojiRatio              *  8 +      // many dojis
        avgWickSym             *  5        // balanced wicks = stalemate
    ));

    // enrich the result object
    const directionChanges = dirChanges;
    const bodyRatio = Math.round(avgBodyRatio * 100);
    const trendStrength = Math.round(Math.abs(autoCorr) * 100);

    return {
        symbol: '', label: '', choppinessScore: score,
        bodyRatio,
        directionChanges,
        trendStrength,
        recentBodyRatio: Math.round(dojiRatio * 100),
        qualifies: score >= 55,
        detail: `Choppy: ${score}% | Runs: ${avgRun.toFixed(1)} | Xovers: ${crossovers} | Dojis: ${dojiCount}/${lookback} | DirΔ: ${dirChanges}`,
    };
}

// ─── Global POC listener (survives WS reconnect via onNewSystemMessage) ──
// Flags when any contract settles (win or loss), so auto-switcher can update
// volatility on the next scan cycle.
(window as any).__makoti_lastContractSettled = true;

let _pocUnsub: (() => void) | null = null;

function startPocListener() {
    if (_pocUnsub) return;
    _pocUnsub = onNewSystemMessage((event: MessageEvent) => {
        try {
            const d = JSON.parse(event.data);
            if (d.msg_type === 'proposal_open_contract' && d.proposal_open_contract?.is_sold) {
                (window as any).__makoti_lastContractSettled = true;
            }
        } catch (_) {}
    });
}

function stopPocListener() {
    if (_pocUnsub) {
        _pocUnsub();
        _pocUnsub = null;
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Scanner Component
═══════════════════════════════════════════════════════════════════════════ */
export const Scanner: React.FC = () => {
    const [bot, setBot] = useState<BotId>('pvty_kill');
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState('');
    const [results, setResults] = useState<ScanResult[]>([]);
    const [bestSymbols, setBestSymbols] = useState<string[]>([]);
    const [autoSwitch, setAutoSwitch] = useState(false);
    const [autoSwitcherActive, setAutoSwitcherActive] = useState(false);
    const [pendingSymbol, setPendingSymbol] = useState('');
    const [notification, setNotification] = useState<{ msg: string; type: 'info' | 'success' | 'warn' } | null>(null);

    // Refs for logic (avoid stale closures)
    const wsRef = useRef<MakotiWS | null>(null);
    const pendingRef = useRef<Set<string>>(new Set());
    const collectedRef = useRef<Map<string, any>>(new Map());
    const botRef = useRef<BotId>('pvty_kill');
    const autoSwitchRef = useRef(false);
    const scanningRef = useRef(false);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const currentBestRef = useRef<string>('');
    const pendingSymbolRef = useRef<string>('');

    const showNotify = useCallback((msg: string, type: 'info' | 'success' | 'warn' = 'info') => {
        setNotification({ msg, type });
        setTimeout(() => setNotification(null), 3500);
    }, []);

    const setPending = useCallback((sym: string) => {
        setPendingSymbol(sym);
        pendingSymbolRef.current = sym;
    }, []);

    const clearPending = useCallback(() => {
        setPendingSymbol('');
        pendingSymbolRef.current = '';
    }, []);

    const applySwitch = useCallback((sym: string) => {
        currentBestRef.current = sym;
        clearPending();
        // 1. Runtime override
        try { window.DBot = window.DBot || {}; (window.DBot as any).__force_symbol = sym; } catch (_) {}
        // 2. QuickStrategy store
        try { const rs = (window as any).__store_instance; if (rs?.quick_strategy) rs.quick_strategy.setValue('symbol', sym); } catch (_) {}
        // 3. Blockly workspace
        try {
            const ws = (window as any).Blockly?.derivWorkspace;
            if (ws) {
                const b = ws.getAllBlocks().find((bl: any) => bl.type === 'trade_definition_market');
                if (b) b.setFieldValue('SYMBOL_LIST', sym);
            }
        } catch (_) {}
        // 4. Dashboard store (chart)
        try { const rs = (window as any).__store_instance; if (rs?.dashboard?.setBotBuilderSymbol) rs.dashboard.setBotBuilderSymbol(sym); } catch (_) {}
        (window as any).__makoti_lastContractSettled = false;
        showNotify(`Volatility Updated: ${SYMBOL_LABELS[sym]}`, 'success');
    }, [showNotify, clearPending]);

    const cleanup = useCallback(() => {
        try { wsRef.current?.close(); } catch (_) {}
        wsRef.current = null;
    }, []);

    /* ── Perform a single scan ──────────────────────────────────────────── */
    const performScan = useCallback((initial = false) => {
        if (scanningRef.current) return;
        const currentBot = botRef.current;
        if (currentBot === 'pvty_kill') return;

        scanningRef.current = true;
        setScanning(true);
        setProgress('Connecting to Deriv API…');
        if (initial) { setResults([]); setBestSymbols([]); }

        pendingRef.current = new Set(ALL_SYMBOLS);
        collectedRef.current = new Map();
        cleanup(); // close previous WS

        const handleMessage = (data: any) => {
            if (data.error) return;

            if (data.msg_type === 'candles' && data.candles) {
                const sym: string = data.echo_req?.ticks_history;
                if (!sym || !pendingRef.current.has(sym)) return;
                pendingRef.current.delete(sym);
                collectedRef.current.set(sym, data.candles);
                setProgress(`Fetched ${ALL_SYMBOLS.length - pendingRef.current.size} / ${ALL_SYMBOLS.length}…`);
                if (pendingRef.current.size === 0) finalize();
            }
        };

        const finalize = () => {
            const scanResults: SymbolDirectionResult[] = [];
            collectedRef.current.forEach((candles: any[], sym) => {
                if (!candles || candles.length < 5) return;
                const a = calcChoppiness(candles);
                a.symbol = sym; a.label = SYMBOL_LABELS[sym];
                scanResults.push(a);
            });
            scanResults.sort((a, b) => b.choppinessScore - a.choppinessScore);
            const best = scanResults.map(r => r.symbol);
            setResults(scanResults);
            setBestSymbols(best.slice(0, 3));
            setScanning(false);
            scanningRef.current = false;

            const bestSym = best[0] || '';
            const bestLabel = bestSym ? SYMBOL_LABELS[bestSym] : '';
            const bestScore = scanResults[0]?.choppinessScore ?? 0;

            // Auto-switch logic
            if (bestSym && bestSym !== currentBestRef.current && autoSwitchRef.current) {
                if ((window as any).__makoti_lastContractSettled) {
                    applySwitch(bestSym);
                } else {
                    setPending(bestSym);
                    showNotify(`Waiting for contract settlement to switch to ${bestLabel}…`, 'warn');
                }
            }

            // Apply pending when contract settles
            const ps = pendingSymbolRef.current;
            if (ps && (window as any).__makoti_lastContractSettled && autoSwitchRef.current) {
                if (best.indexOf(ps) >= 0) applySwitch(ps);
                else clearPending();
            }

            if (autoSwitchRef.current) {
                const p = pendingSymbolRef.current;
                setProgress(p ? `Auto: Pending ${SYMBOL_LABELS[p]} (wait settle)` : `Auto: Best ${bestLabel} (${bestScore}%)`);
            } else {
                setProgress(`Top: ${bestLabel} (${bestScore}%)`);
            }
            cleanup();
        };

        const mws = openMakotiWS(
            handleMessage,
            () => {
                setProgress('Fetching 50 candles from all 10 volatilities…');
                ALL_SYMBOLS.forEach(sym => mws.send({ ticks_history: sym, count: 50, end: 'latest', style: 'candles', granularity: 60 }));
            },
            () => {
                if (pendingRef.current.size > 0 && !autoSwitchRef.current) {
                    setScanning(false); scanningRef.current = false;
                    setProgress('Connection closed early.');
                }
            }
        );
        wsRef.current = mws;
    }, [cleanup, showNotify, applySwitch, setPending, clearPending]);

    /* ── Manual analyze button ──────────────────────────────────────────── */
    const analyze = useCallback(() => {
        if (scanningRef.current) return;
        botRef.current = bot;

        if (autoSwitch && bot === 'rf_v4') {
            currentBestRef.current = '';
            clearPending();
            autoSwitchRef.current = true;
            setAutoSwitcherActive(true);
            startPocListener();
            if (intervalRef.current) clearInterval(intervalRef.current);
            intervalRef.current = setInterval(() => performScan(false), 3000);
            performScan(true); // initial scan with results cleared
        } else {
            autoSwitchRef.current = false;
            setAutoSwitcherActive(false);
            stopPocListener();
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            performScan(true);
        }
    }, [bot, autoSwitch, performScan, clearPending]);

    /* ── Toggle auto-switcher ───────────────────────────────────────────── */
    const toggleAutoSwitch = useCallback(() => {
        setAutoSwitch(prev => {
            if (prev) {
                autoSwitchRef.current = false;
                setAutoSwitcherActive(false);
                clearPending();
                currentBestRef.current = '';
                stopPocListener();
                if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            }
            return !prev;
        });
    }, [clearPending]);

    useEffect(() => {
        return () => {
            autoSwitchRef.current = false;
            stopPocListener();
            if (intervalRef.current) clearInterval(intervalRef.current);
            try { wsRef.current?.close(); } catch (_) {}
        };
    }, []);

    return (
        <div className='mw-scanner'>
            {notification && (
                <div className={`mw-scanner__notif mw-scanner__notif--${notification.type}`}>{notification.msg}</div>
            )}
            <div className='mw-scanner__controls'>
                <div className='mw-field'>
                    <label className='mw-label'>Bot Selection</label>
                    <select className='mw-select' value={bot} onChange={e => setBot(e.target.value as BotId)} disabled={scanning}>
                        <option value='pvty_kill'>Poverty Killer</option>
                        <option value='rf_v4'>Rise/Fall V4</option>
                    </select>
                </div>
                <div className='mw-scanner__desc'>
                    {bot === 'pvty_kill'
                        ? 'Scans 1 000 ticks per volatility. Finds markets where digits 7, 8 and 9 each exceed 10%.'
                        : 'Deep candle analysis (50 candles per volatility). Finds choppy/undirectional markets — auto-switches every 3s.'}
                </div>
                {bot === 'rf_v4' && (
                    <label className='mw-switch-row'>
                        <span className='mw-switch-label'>Auto Switcher</span>
                        <div className='mw-toggle' onClick={toggleAutoSwitch}>
                            <div className={`mw-toggle__track${autoSwitch ? ' mw-toggle__track--on' : ''}`}>
                                <div className={`mw-toggle__thumb${autoSwitch ? ' mw-toggle__thumb--on' : ''}`} />
                            </div>
                        </div>
                        {autoSwitcherActive && <span className='mw-switch-active'>ACTIVE</span>}
                        {pendingSymbol && <span className='mw-switch-pending'>⏳ WIN REQUIRED</span>}
                    </label>
                )}
                <button className={`mw-btn mw-btn--scan${scanning ? ' mw-btn--busy' : ''}`} onClick={analyze} disabled={scanning}>
                    {scanning ? <><span className='mw-spin' /> Analyzing…</> : 'Analyze'}
                </button>
                {progress && <div className='mw-scanner__progress'>{progress}</div>}
            </div>
            {results.length > 0 && (
                <div className='mw-scanner__results'>
                    <div className='mw-scanner__results-head'>
                        {bot === 'pvty_kill'
                            ? 'Digit 7 / 8 / 9 Distribution (1 000 ticks)'
                            : `Choppiness Analysis (50 candles) ${autoSwitcherActive ? '— Auto-switching ON' : ''}`}
                    </div>
                    {bestSymbols.length > 0 && (
                        <div className='mw-scanner__best'>
                            <span className='mw-scanner__best-lbl'>Best:</span>
                            {bestSymbols.map(s => <span key={s} className='mw-scanner__badge'>{SYMBOL_LABELS[s]}</span>)}
                        </div>
                    )}
                    <div className='mw-scanner__list'>
                        {results.map((r, idx) => (
                            <div key={r.symbol} className={`mw-scanner__row${idx === 0 ? ' mw-scanner__row--match' : ''}`}>
                                <div className='mw-scanner__row-head'>
                                    <span className='mw-scanner__sym'>{r.label}</span>
                                    <span className='mw-scanner__row-detail'>{r.detail}</span>
                                    {idx === 0 && <span className='mw-scanner__tag'>BEST</span>}
                                </div>
                                {isDigitResult(r) && (
                                    <div className='mw-scanner__bars'>
                                        {r.pcts.map((p, i) => (
                                            <div key={i} className={`mw-scanner__bar-wrap${[7, 8, 9].includes(i) ? ' mw-scanner__bar-wrap--hi' : ''}`} title={`Digit ${i}: ${p.toFixed(2)}%`}>
                                                <div className='mw-scanner__bar-fill' style={{ height: `${Math.min(100, p * 4)}%` }} />
                                                <span className='mw-scanner__bar-pct'>{p.toFixed(0)}%</span>
                                                <span className='mw-scanner__bar-lbl'>{i}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {!isDigitResult(r) && (() => {
                                    const dr = r as SymbolDirectionResult;
                                    return (
                                        <div className='mw-scanner__dir-bar'>
                                            <div className='mw-scanner__dir-fill' style={{
                                                width: `${dr.choppinessScore}%`,
                                                background: dr.choppinessScore >= 70 ? 'linear-gradient(90deg, #22c55e, #16a34a)' : dr.choppinessScore >= 55 ? 'linear-gradient(90deg, #eab308, #ca8a04)' : 'linear-gradient(90deg, #ef4444, #dc2626)',
                                            }} />
                                        </div>
                                    );
                                })()}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
