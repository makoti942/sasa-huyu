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
function calcChoppiness(candles: any[]): SymbolDirectionResult {
    const lookback = Math.min(50, candles.length);
    const recent = candles.slice(-lookback);
    const bodyRatios = recent.map(c => {
        const range = Number(c.high) - Number(c.low);
        if (range <= 0) return 1;
        return Math.abs(Number(c.close) - Number(c.open)) / range;
    });
    const avgBodyRatio = bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length;

    let directionChanges = 0;
    for (let i = 1; i < recent.length; i++) {
        const pd = Number(recent[i - 1].close) - Number(recent[i - 1].open);
        const cd = Number(recent[i].close) - Number(recent[i].open);
        if ((pd > 0 && cd < 0) || (pd < 0 && cd > 0)) directionChanges++;
    }
    const dirChangeRatio = directionChanges / (recent.length - 1);

    const closes = recent.map(c => Number(c.close));
    const indices = closes.map((_, i) => i);
    const n = indices.length;
    const sumI = indices.reduce((a, b) => a + b, 0);
    const sumC = closes.reduce((a, b) => a + b, 0);
    const sumIC = indices.reduce((a, b, i) => a + b * closes[i], 0);
    const sumI2 = indices.reduce((a, b) => a + b * b, 0);
    const sumC2 = closes.reduce((a, b) => a + b * b, 0);
    const denom = Math.sqrt((n * sumI2 - sumI * sumI) * (n * sumC2 - sumC * sumC));
    const corr = denom === 0 ? 0 : (n * sumIC - sumI * sumC) / denom;
    const trendStrength = Math.abs(corr);

    const last3 = candles.slice(-3);
    const l3br = last3.map(c => {
        const r = Number(c.high) - Number(c.low);
        return r <= 0 ? 1 : Math.abs(Number(c.close) - Number(c.open)) / r;
    });
    const avgRecentBodyRatio = l3br.reduce((a, b) => a + b, 0) / l3br.length;

    const ranges = recent.map(c => Number(c.high) - Number(c.low));
    const half = Math.floor(ranges.length / 2);
    const fha = ranges.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const sha = ranges.slice(-half).reduce((a, b) => a + b, 0) / half;
    const rn = fha > 0 ? Math.min(1, sha / fha) : 1;

    const score = Math.min(100,
        (1 - avgBodyRatio) * 30 + dirChangeRatio * 25 +
        (1 - trendStrength) * 20 + (1 - avgRecentBodyRatio) * 15 + (1 - rn) * 10);

    return {
        symbol: '', label: '', choppinessScore: Math.round(score),
        bodyRatio: Math.round(avgBodyRatio * 100), directionChanges,
        trendStrength: Math.round(trendStrength * 100),
        recentBodyRatio: Math.round(avgRecentBodyRatio * 100),
        qualifies: true,
        detail: `Choppy: ${Math.round(score)}% | Body ${Math.round(avgBodyRatio * 100)}% | Δ ${directionChanges}/${lookback - 1} | Trend ${Math.round(trendStrength * 100)}%`,
    };
}

// ─── Global POC listener (survives WS reconnect via onNewSystemMessage) ──
(window as any).__makoti_lastTradeWon = true;

let _pocUnsub: (() => void) | null = null;

function startPocListener() {
    if (_pocUnsub) return;
    _pocUnsub = onNewSystemMessage((event: MessageEvent) => {
        try {
            const d = JSON.parse(event.data);
            if (d.msg_type === 'proposal_open_contract' && d.proposal_open_contract?.is_sold) {
                (window as any).__makoti_lastTradeWon = Number(d.proposal_open_contract.profit) >= 0;
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
        (window as any).__makoti_lastTradeWon = false;
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
                if ((window as any).__makoti_lastTradeWon) {
                    applySwitch(bestSym);
                } else {
                    setPending(bestSym);
                    showNotify(`Waiting for win before switching to ${bestLabel}…`, 'warn');
                }
            }

            // Apply pending when win arrives
            const ps = pendingSymbolRef.current;
            if (ps && (window as any).__makoti_lastTradeWon && autoSwitchRef.current) {
                if (best.indexOf(ps) >= 0) applySwitch(ps);
                else clearPending();
            }

            if (autoSwitchRef.current) {
                const p = pendingSymbolRef.current;
                setProgress(p ? `Auto: Pending ${SYMBOL_LABELS[p]} (wait win)` : `Auto: Best ${bestLabel} (${bestScore}%)`);
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
