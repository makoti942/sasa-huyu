import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SYMBOL_LABELS, PIP_SIZES, openMakotiWS, MakotiWS } from './makoti-ws';
import { sendViaNewSystemWithPromise, onNewSystemMessage } from '@/auth/NewDerivAuth';

/* ── Types ─────────────────────────────────────────────────────────────────── */
type RecoverySide = 'DIGITOVER' | 'DIGITUNDER';

interface SymbolState {
    ticks: number[];
    prices: number[];
    ready: boolean;
}

interface LogEntry {
    time: string;
    msg: string;
    type: 'win' | 'loss' | 'info' | 'trade';
}

/* ── Constants ─────────────────────────────────────────────────────────────── */
const ONE_SEC_SYMBOLS = ['1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];
const MAX_TICKS = 1000;
const MIN_TICKS = 100;
const SCAN_HISTORY = 1000;
const SCAN_INTERVAL_TRADES = 2;
const RECOVERY_SIDES: { label: string; value: RecoverySide }[] = [
    { label: 'Over', value: 'DIGITOVER' },
    { label: 'Under', value: 'DIGITUNDER' },
];

const LS_CONFIG_KEY = 'mw_under7_config';
const LS_LOGS_KEY = 'mw_under7_logs';

const DEFAULT_CONFIG = {
    stake: '0.35', martingale: '2',
    recoveryMode: false, recoverySide: 'DIGITOVER' as const, recoveryBarrier: '5',
};

function loadConfig(): typeof DEFAULT_CONFIG {
    try { const raw = localStorage.getItem(LS_CONFIG_KEY); return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG; }
    catch { return DEFAULT_CONFIG; }
}
function saveConfig(cfg: typeof DEFAULT_CONFIG) {
    try { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}

/* ── Digit % helpers ────────────────────────────────────────────────────────── */
function calcDigitPcts(ticks: number[]): number[] {
    const counts = new Array(10).fill(0);
    ticks.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; });
    const total = counts.reduce((a, v) => a + v, 0);
    return total > 0 ? counts.map(c => (c / total) * 100) : counts;
}

/* ── Check if a volatility qualifies ────────────────────────────────────────── */
interface VolScanResult {
    symbol: string;
    pcts: number[];
    qualifies: boolean;
    decreasing: boolean;
    score: number;
}

function scanVolatility(ticks: number[]): VolScanResult {
    const pcts = calcDigitPcts(ticks);
    const pctsFirst = calcDigitPcts(ticks.slice(0, 500));
    const pctsLast = calcDigitPcts(ticks.slice(-500));

    const p7 = pcts[7], p8 = pcts[8], p9 = pcts[9];
    const allBelow10 = p7 < 10 && p8 < 10 && p9 < 10;
    const twoBelow10 = [p7, p8, p9].filter(p => p < 10).length >= 2;

    // Check decreasing trend for 7,8,9
    const decreasing7 = pctsLast[7] < pctsFirst[7];
    const decreasing8 = pctsLast[8] < pctsFirst[8];
    const decreasing9 = pctsLast[9] < pctsFirst[9];
    const decreasingCount = [decreasing7, decreasing8, decreasing9].filter(Boolean).length;

    // Score: higher = better volatility for this strategy
    let score = 0;
    if (allBelow10) score += 30;
    else if (twoBelow10) score += 15;
    score += (10 - Math.min(p7, 10)) + (10 - Math.min(p8, 10)) + (10 - Math.min(p9, 10));
    score += decreasingCount * 5;

    return {
        symbol: '', pcts,
        qualifies: allBelow10 || twoBelow10,
        decreasing: decreasingCount >= 2,
        score,
    };
}

/* ── Check entry pattern: 2 digits below 4, 1 digit above 4 ───────────────── */
function checkEntryPattern(ticks: number[]): { found: boolean; entryDigit: number } {
    if (ticks.length < 3) return { found: false, entryDigit: -1 };
    const last3 = ticks.slice(-3);
    const below4 = last3.filter(d => d < 4);
    const above4 = last3.filter(d => d > 4);
    if (below4.length >= 2 && above4.length === 1) {
        const entryDigit = above4[0];
        return { found: true, entryDigit };
    }
    // Also check: if last 2 are below 4 and not recently above 4
    if (below4.length === 2 && above4.length === 0) {
        // Check if the last digit was > 4 but now we have 2 below 4
        if (ticks.length >= 4) {
            const fourthBack = ticks[ticks.length - 4];
            if (fourthBack > 4) {
                return { found: true, entryDigit: fourthBack };
            }
        }
    }
    return { found: false, entryDigit: -1 };
}

/* ═══════════════════════════════════════════════════════════════════════════════
   Under7 Component
═══════════════════════════════════════════════════════════════════════════════ */
export const Under7: React.FC = () => {
    const initCfg = loadConfig();
    const [stake, setStake] = useState(initCfg.stake);
    const [martingale, setMartingale] = useState(initCfg.martingale);
    const [recoveryMode, setRecoveryMode] = useState(initCfg.recoveryMode);
    const [recoverySide, setRecoverySide] = useState<RecoverySide>(initCfg.recoverySide);
    const [recoveryBarrier, setRecoveryBarrier] = useState(initCfg.recoveryBarrier);
    const [running, setRunning] = useState(false);
    const [pnl, setPnl] = useState(0);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [inRecovery, setInRecovery] = useState(false);
    const [activeVol, setActiveVol] = useState('');
    const [statusMsg, setStatusMsg] = useState('');

    /* ── Refs ─────────────────────────────────────────────────────────────── */
    const wsRef = useRef<MakotiWS | null>(null);
    const symbolDataRef = useRef<Record<string, SymbolState>>({});
    const pnlRef = useRef(0);
    const runningRef = useRef(false);
    const stakeParsed = useRef(0.35);
    const martingaleParsed = useRef(2);
    const recoveryModeRef = useRef(false);
    const recoverySideRef = useRef<RecoverySide>('DIGITOVER');
    const recoveryBarrierRef = useRef(5);
    const inRecoveryRef = useRef(false);
    const currentVolRef = useRef('');
    const currentEntryDigitRef = useRef(-1);
    const tradesSinceScanRef = useRef(0);
    const lastTradeWonRef = useRef<boolean | null>(null);
    const globalLock = useRef(false);
    const activeContractsRef = useRef(0);
    const contractMapRef = useRef<Map<string, { symbol: string; stake: number }>>(new Map());
    const consecutiveLossesRef = useRef(0);
    const globalStakeRef = useRef(0.35);

    /* ── Persist config ───────────────────────────────────────────────────── */
    useEffect(() => {
        saveConfig({ stake, martingale, recoveryMode, recoverySide, recoveryBarrier });
    }, [stake, martingale, recoveryMode, recoverySide, recoveryBarrier]);

    /* ── Log helper ────────────────────────────────────────────────────────── */
    const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [{ time, msg, type }, ...prev].slice(0, 120));
    }, []);

    const clearLogs = useCallback(() => {
        setLogs([]);
    }, []);

    /* ── Stop ────────────────────────────────────────────────────────────── */
    const stopScanner = useCallback(() => {
        runningRef.current = false;
        globalLock.current = false;
        inRecoveryRef.current = false;
        setRunning(false);
        setInRecovery(false);
        setActiveVol('');
        setStatusMsg('');
        try { wsRef.current?.close(); } catch (_) {}
        wsRef.current = null;
        activeContractsRef.current = 0;
        addLog('Under 7 scanner stopped.', 'info');
    }, [addLog]);

    /* ── POC listener ─────────────────────────────────────────────────────── */
    const pocUnsubRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!running) return;
        if (pocUnsubRef.current) pocUnsubRef.current();

        const unsub = onNewSystemMessage((event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                if (data.msg_type !== 'proposal_open_contract') return;
                const c = data.proposal_open_contract;
                if (!c?.is_sold) return;
                const cid = String(c.contract_id);
                const entry = contractMapRef.current.get(cid);
                if (!entry) return;
                contractMapRef.current.delete(cid);

                const { symbol: sym, stake: tradeStake } = entry;
                const profit = Number(c.profit);
                const won = profit >= 0;

                pnlRef.current += profit;
                setPnl(pnlRef.current);

                if (won) {
                    consecutiveLossesRef.current = 0;
                    globalStakeRef.current = stakeParsed.current;
                    lastTradeWonRef.current = true;
                    tradesSinceScanRef.current++;

                    if (inRecoveryRef.current) {
                        inRecoveryRef.current = false;
                        setInRecovery(false);
                        addLog(`✅ RECOVERY WON — back to Under 7 mode`, 'win');
                    }

                    addLog(`✅ WON +$${profit.toFixed(2)} on ${SYMBOL_LABELS[sym]} | P&L $${pnlRef.current.toFixed(2)}`, 'win');

                    // Re-scan after 2 trades, only on win
                    if (tradesSinceScanRef.current >= SCAN_INTERVAL_TRADES) {
                        tradesSinceScanRef.current = 0;
                        addLog(`🔍 Re-scanning volatilities...`, 'info');
                        setTimeout(() => runScan(), 500);
                    }
                } else {
                    consecutiveLossesRef.current++;
                    globalStakeRef.current = Number((tradeStake * martingaleParsed.current).toFixed(2));
                    lastTradeWonRef.current = false;
                    tradesSinceScanRef.current++;

                    addLog(`❌ LOST -$${Math.abs(profit).toFixed(2)} on ${SYMBOL_LABELS[sym]} | Next stake $${globalStakeRef.current.toFixed(2)} | P&L $${pnlRef.current.toFixed(2)}`, 'loss');

                    // Recovery mode: execute recovery config immediately
                    if (recoveryModeRef.current && currentVolRef.current && !inRecoveryRef.current) {
                        inRecoveryRef.current = true;
                        setInRecovery(true);
                        addLog(`🔄 RECOVERY — ${recoverySideRef.current === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${recoveryBarrierRef.current} on ${SYMBOL_LABELS[currentVolRef.current]}`, 'info');
                        setTimeout(() => executeRecovery(currentVolRef.current), 300);
                    }
                }

                globalLock.current = false;
                activeContractsRef.current = 0;
            } catch (_) {}
        });

        pocUnsubRef.current = unsub;
        return () => { unsub(); pocUnsubRef.current = null; };
    }, [running, addLog]);

    /* ── Execute Under 7 contract ──────────────────────────────────────────── */
    const executeUnder7 = useCallback(async (sym: string, entryDigit: number) => {
        if (!runningRef.current || globalLock.current) return;

        globalLock.current = true;

        const tradeStake = Number(globalStakeRef.current.toFixed(2));

        const params = {
            amount: tradeStake, basis: 'stake', currency: 'USD',
            duration: 1, duration_unit: 't',
            symbol: sym, contract_type: 'DIGITUNDER',
            barrier: '7',
        };

        addLog(`🎯 UNDER 7 — Entry D${entryDigit} on ${SYMBOL_LABELS[sym]} @ $${tradeStake}`, 'trade');

        try {
            const response = await sendViaNewSystemWithPromise({ buy: 1, price: tradeStake, parameters: params });
            const contractId = response?.buy?.contract_id ?? response?.contract_id;
            if (contractId) {
                contractMapRef.current.set(String(contractId), { symbol: sym, stake: tradeStake });
                addLog(`📡 Contract ${contractId} — UNDER 7 on ${SYMBOL_LABELS[sym]}`, 'trade');
                activeContractsRef.current = 1;
                setStatusMsg(`⏳ UNDER 7 on ${SYMBOL_LABELS[sym]} — entry D${entryDigit}`);
            } else {
                addLog(`⚠️ Buy ok but no contract_id`, 'info');
                globalLock.current = false;
            }
        } catch (err: any) {
            addLog(`⚠️ Buy error: ${err?.message || 'Unknown'}`, 'info');
            globalLock.current = false;
        }
    }, [addLog]);

    /* ── Execute Recovery contract ─────────────────────────────────────────── */
    const executeRecovery = useCallback(async (sym: string) => {
        if (!runningRef.current || !inRecoveryRef.current) return;

        const tradeStake = Number(globalStakeRef.current.toFixed(2));
        const ct = recoverySideRef.current;
        const barrier = String(recoveryBarrierRef.current);

        const params = {
            amount: tradeStake, basis: 'stake', currency: 'USD',
            duration: 1, duration_unit: 't',
            symbol: sym, contract_type: ct,
            barrier,
        };

        addLog(`🔄 RECOVERY ${ct === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${barrier} on ${SYMBOL_LABELS[sym]} @ $${tradeStake}`, 'trade');

        try {
            const response = await sendViaNewSystemWithPromise({ buy: 1, price: tradeStake, parameters: params });
            const contractId = response?.buy?.contract_id ?? response?.contract_id;
            if (contractId) {
                contractMapRef.current.set(String(contractId), { symbol: sym, stake: tradeStake });
                setStatusMsg(`🔄 RECOVERY — ${ct === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${barrier} on ${SYMBOL_LABELS[sym]}`);
                activeContractsRef.current = 1;
            }
        } catch (err: any) {
            addLog(`⚠️ Recovery error: ${err?.message || 'Unknown'}`, 'info');
        }
    }, [addLog]);

    /* ── Run scan on all 1s symbols ────────────────────────────────────────── */
    const runScan = useCallback(() => {
        if (!runningRef.current) return;

        let best: VolScanResult | null = null;

        ONE_SEC_SYMBOLS.forEach(sym => {
            const sd = symbolDataRef.current[sym];
            if (!sd || sd.ticks.length < MIN_TICKS) return;

            const result = scanVolatility(sd.ticks);
            result.symbol = sym;

            if (!result.qualifies) return;

            if (!best || result.score > best.score) {
                best = result;
            }
        });

        if (best) {
            currentVolRef.current = best.symbol;
            setActiveVol(best.symbol);
            const p789 = [best.pcts[7], best.pcts[8], best.pcts[9]].map(p => p.toFixed(1)).join('% / ');
            addLog(`🎯 Selected ${SYMBOL_LABELS[best.symbol]} — 7/8/9: ${p789}% | Score: ${best.score}`, 'info');
            setStatusMsg(`Monitoring ${SYMBOL_LABELS[best.symbol]} for entry pattern...`);

            // Start monitoring ticks on this symbol
            startMonitoring(best.symbol);
        } else {
            addLog(`⚠️ No qualifying volatility found — re-scanning in 5s`, 'info');
            setStatusMsg(`No qualifying volatility — re-scanning...`);
            setTimeout(() => runScan(), 5000);
        }
    }, [addLog]);

    /* ── Monitor for entry pattern ─────────────────────────────────────────── */
    const monitoringRef = useRef(false);
    const monitoredSymbolRef = useRef('');

    const startMonitoring = useCallback((sym: string) => {
        monitoringRef.current = true;
        monitoredSymbolRef.current = sym;
    }, []);

    const stopMonitoring = useCallback(() => {
        monitoringRef.current = false;
        monitoredSymbolRef.current = '';
    }, []);

    /* ── WebSocket tick handler ───────────────────────────────────────────── */
    const handleTickMsg = useCallback((data: any) => {
        if (!runningRef.current) return;

        if (data.msg_type === 'history') {
            const sym: string = data.echo_req?.ticks_history;
            if (!ONE_SEC_SYMBOLS.includes(sym) || !symbolDataRef.current[sym]) return;
            const sd = symbolDataRef.current[sym];
            const pip = PIP_SIZES[sym] || 2;
            const prices = (data.history.prices as (string | number)[]).map(p => Number(p));
            const digits = prices.map(p => Number(p.toFixed(pip).slice(-1)));
            sd.ticks = digits.slice(-MAX_TICKS);
            sd.prices = prices.slice(-MAX_TICKS);
            sd.ready = sd.ticks.length >= MIN_TICKS;
        }

        if (data.msg_type === 'tick') {
            const tick = data.tick;
            const sym: string = tick.symbol;
            if (!ONE_SEC_SYMBOLS.includes(sym) || !symbolDataRef.current[sym]) return;
            const sd = symbolDataRef.current[sym];
            const pip = PIP_SIZES[sym] || tick.pip_size || 2;
            const price = Number(tick.quote);
            const digit = Number(price.toFixed(pip).slice(-1));
            sd.ticks = [...sd.ticks.slice(-(MAX_TICKS - 1)), digit];
            sd.prices = [...sd.prices.slice(-(MAX_TICKS - 1)), price];
            sd.ready = sd.ticks.length >= MIN_TICKS;

            // Check if in recovery mode — skip Under 7 logic
            if (inRecoveryRef.current) return;

            // Check if we're monitoring for entry pattern
            if (monitoringRef.current && sym === monitoredSymbolRef.current) {
                const pattern = checkEntryPattern(sd.ticks);
                if (pattern.found && !globalLock.current) {
                    currentEntryDigitRef.current = pattern.entryDigit;
                    addLog(`🎯 Entry pattern found — 2 below 4 + D${pattern.entryDigit} above 4 → firing UNDER 7`, 'trade');
                    executeUnder7(sym, pattern.entryDigit);
                    stopMonitoring();
                    setStatusMsg(`Entry pattern fired — waiting for result`);
                } else {
                    setStatusMsg(`Monitoring ${SYMBOL_LABELS[sym]} for pattern...`);
                }
            }
        }
    }, [executeUnder7, stopMonitoring, addLog]);

    const handleTickRef = useRef(handleTickMsg);
    handleTickRef.current = handleTickMsg;

    /* ── Start ────────────────────────────────────────────────────────────── */
    const startScanner = useCallback(() => {
        const stakeVal = Math.max(0.35, parseFloat(stake) || 0.35);
        const mgVal = Math.max(1, parseFloat(martingale) || 2);
        const recBarrierVal = Math.min(9, Math.max(0, parseInt(recoveryBarrier) || 5));

        stakeParsed.current = stakeVal;
        martingaleParsed.current = mgVal;
        recoveryModeRef.current = recoveryMode;
        recoverySideRef.current = recoverySide;
        recoveryBarrierRef.current = recBarrierVal;
        globalStakeRef.current = stakeVal;
        consecutiveLossesRef.current = 0;
        tradesSinceScanRef.current = 0;
        lastTradeWonRef.current = null;
        globalLock.current = false;
        inRecoveryRef.current = false;
        monitoringRef.current = false;
        currentVolRef.current = '';
        currentEntryDigitRef.current = -1;
        contractMapRef.current = new Map();

        symbolDataRef.current = {};
        ONE_SEC_SYMBOLS.forEach(sym => {
            symbolDataRef.current[sym] = { ticks: [], prices: [], ready: false };
        });

        runningRef.current = true;
        setRunning(true);
        setInRecovery(false);
        setActiveVol('');
        setStatusMsg('Connecting...');
        setPnl(0);
        pnlRef.current = 0;

        addLog(`🔍 Under 7 — Scanning 1s volatilities for low 7/8/9% | stake $${stakeVal} MG ×${mgVal}`, 'info');
        if (recoveryMode) {
            addLog(`🔄 Recovery: on loss → ${recoverySide === 'DIGITOVER' ? 'OVER' : 'UNDER'} ${recBarrierVal}`, 'info');
        }

        if (wsRef.current) { try { wsRef.current.close(); } catch (_) {} wsRef.current = null; }

        const mws = openMakotiWS(
            (data) => { handleTickRef.current(data); },
            () => {
                addLog('Connected ✓ Subscribing to 1s volatilities...', 'info');
                ONE_SEC_SYMBOLS.forEach(sym => {
                    mws.send({ ticks_history: sym, count: SCAN_HISTORY, end: 'latest', style: 'ticks', subscribe: 1 });
                });
                // Initial scan after a delay to let ticks load
                setTimeout(() => runScan(), 2000);
            },
            () => {
                if (runningRef.current) {
                    addLog('Connection lost. Stopping.', 'info');
                    stopScanner();
                }
            },
        );
        wsRef.current = mws;
    }, [stake, martingale, recoveryMode, recoverySide, recoveryBarrier, addLog, stopScanner, runScan]);

    /* ── Cleanup on unmount ───────────────────────────────────────────────── */
    useEffect(() => {
        return () => {
            runningRef.current = false;
            monitoringRef.current = false;
            try { wsRef.current?.close(); } catch (_) {}
            if (pocUnsubRef.current) { pocUnsubRef.current(); pocUnsubRef.current = null; }
        };
    }, []);

    /* ── Derived stats ────────────────────────────────────────────────────── */
    const totalWins = 0; // not tracking per-symbol
    const totalLosses = 0;
    const totalTrades = activeContractsRef.current;

    /* ── Render ────────────────────────────────────────────────────────────── */
    return (
        <div className='mw-killer'>
            <div className='mw-killer__fields'>
                <div className='mw-field'>
                    <label className='mw-label'>Stake ($)</label>
                    <input className='mw-input' type='number' min='0.35' step='0.01'
                        value={stake} onChange={e => setStake(e.target.value)} disabled={running} />
                </div>
                <div className='mw-field'>
                    <label className='mw-label'>Martingale ×</label>
                    <input className='mw-input' type='number' min='1' step='0.1'
                        value={martingale} onChange={e => setMartingale(e.target.value)} disabled={running} />
                </div>
            </div>

            <div className='mw-killer__vh'>
                <label className='mw-killer__vh-toggle'>
                    <input type='checkbox' checked={recoveryMode}
                        onChange={e => setRecoveryMode(e.target.checked)} disabled={running} />
                    <span>Recovery <small style={{opacity:0.6,fontWeight:400}}>(on loss → immediate recovery trade)</small></span>
                </label>
            </div>

            {recoveryMode && !running && (
                <div className='mw-killer__fields'>
                    <div className='mw-field'>
                        <label className='mw-label'>Recovery Side</label>
                        <select className='mw-select' value={recoverySide}
                            onChange={e => setRecoverySide(e.target.value as RecoverySide)}>
                            {RECOVERY_SIDES.map(s => (
                                <option key={s.value} value={s.value}>{s.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className='mw-field'>
                        <label className='mw-label'>Recovery Barrier</label>
                        <input className='mw-input' type='number' min='0' max='9' step='1'
                            value={recoveryBarrier} onChange={e => setRecoveryBarrier(e.target.value)} />
                    </div>
                </div>
            )}

            <button
                className={`mw-btn${running ? ' mw-btn--stop' : ''}`}
                onClick={running ? stopScanner : startScanner}
            >
                {running ? <><span className='mw-pulse' /> STOP</> : '▶ RUN'}
            </button>

            {running && activeVol && (
                <div className='mw-killer__mode-note'>
                    <span style={{color:'#22c55e'}}>📊 Vol: {SYMBOL_LABELS[activeVol]}</span>
                    {inRecovery && <span style={{color:'#f97316',marginLeft:8}}>🔴 RECOVERY ACTIVE</span>}
                    {activeContractsRef.current > 0 && <span className='mw-killer__active-dot'> ● TRADE LIVE</span>}
                </div>
            )}

            {running && statusMsg && (
                <div className='mw-killer__signal'>
                    <div className='mw-killer__signal-detail'>{statusMsg}</div>
                </div>
            )}

            {(running || pnl !== 0) && (
                <div className='mw-killer__stats'>
                    <div className={`mw-killer__pnl${pnl >= 0 ? ' mw-killer__pnl--pos' : ' mw-killer__pnl--neg'}`}>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </div>
                    <div className='mw-killer__meta'>
                        <span>MG: ×{martingaleParsed.current}</span>
                        <span>Recovery: {recoveryModeRef.current ? (inRecoveryRef.current ? 'ON' : 'Standby') : 'OFF'}</span>
                    </div>
                </div>
            )}

            {logs.length > 0 && (
                <div className='mw-killer__log-wrap'>
                    <div className='mw-killer__log-header'>
                        <span className='mw-killer__log-title'>Activity Log</span>
                        <button className='mw-btn-clear' onClick={clearLogs} title='Clear log'>Clear</button>
                    </div>
                    <div className='mw-killer__log'>
                        {logs.map((l, i) => (
                            <div key={i} className={`mw-log-line mw-log-line--${l.type}`}>
                                <span className='mw-log-time'>{l.time}</span>
                                <span className='mw-log-msg'>{l.msg}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default Under7;
