import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ALL_SYMBOLS, SYMBOL_LABELS, PIP_SIZES, openMakotiWS, MakotiWS } from './makoti-ws';
import { analyzeSignals, findBestDuration, recordOutcome, ContractType, TradeSignal } from './prediction-engine';
import { sendViaNewSystemWithPromise, onNewSystemMessage } from '@/auth/NewDerivAuth';
import { useStore } from '@/hooks/useStore';

/* ── Types ─────────────────────────────────────────────────────────────────── */
interface SymbolState {
    ticks: number[];
    prices: number[];
    lastSignal: string;
    wins: number;
    losses: number;
    ready: boolean;
}

interface LogEntry {
    time: string;
    msg: string;
    type: 'win' | 'loss' | 'info' | 'trade';
}

/* ── Constants ─────────────────────────────────────────────────────────────── */
const MAX_TICKS              = 1000;
const MIN_TICKS_BEFORE_TRADE = 30;
const CONFIDENCE_THRESHOLD   = 68;
const CONTRACT_FAMILIES: { label: string; types: ContractType[] }[] = [
    { label: 'Rise/Fall', types: ['CALL', 'PUT'] },
];

const LS_LOGS_KEY            = 'mw_mk_logs';
const MAX_SAVED_LOGS         = 80;

function loadSavedLogs(): LogEntry[] {
    try {
        const raw = localStorage.getItem(LS_LOGS_KEY);
        return raw ? (JSON.parse(raw) as LogEntry[]) : [];
    } catch {
        return [];
    }
}

function saveLogs(logs: LogEntry[]) {
    try {
        localStorage.setItem(LS_LOGS_KEY, JSON.stringify(logs.slice(0, MAX_SAVED_LOGS)));
    } catch {}
}

/* ═══════════════════════════════════════════════════════════════════════════
   MarketKiller
═══════════════════════════════════════════════════════════════════════════ */
export const MarketKiller: React.FC = () => {
    const { transactions, run_panel } = useStore();

    const [stake,       setStake]       = useState('0.35');
    const [martingale,  setMartingale]  = useState('2');
    const [takeProfit,  setTakeProfit]  = useState('10');
    const [stopLoss,    setStopLoss]    = useState('5');
    const [vhEnabled,   setVhEnabled]   = useState(false);
    const [vhThreshold, setVhThreshold] = useState('1');
    const [running,     setRunning]     = useState(false);
    const [pnl,         setPnl]         = useState(0);
    const [logs,        setLogs]        = useState<LogEntry[]>(loadSavedLogs);
    const [activeContracts, setActiveContracts] = useState(0);
    const [symbolDisplay, setSymbolDisplay] = useState<
        Record<string, { lastSignal: string; wins: number; losses: number; stake: number }>
    >({});

    /* ── Refs ─────────────────────────────────────────────────────────────── */
    const wsRef            = useRef<MakotiWS | null>(null);
    const symbolDataRef    = useRef<Record<string, SymbolState>>({});
    const pnlRef           = useRef(0);
    const runningRef       = useRef(false);
    const stakeParsed      = useRef(0.35);
    const martingaleParsed = useRef(2);
    const tpRef            = useRef(10);
    const slRef            = useRef(5);

    const globalLock         = useRef(false);
    const activeContractsRef = useRef(0);
    const globalStakeRef     = useRef(0.35);
    const contractMapRef     = useRef<Map<string, { symbol: string; stake: number; strategyNames: string[]; duration: number }>>(new Map());
    const consecutiveLossesRef = useRef(0);
    const cooldownTicksRef     = useRef(0);
    const signalHistoryRef     = useRef<{ sym: string; type: string; conf: number }[]>([]);

    const vhStateRef = useRef({ enabled: false, threshold: 1, is_virtual: false, loss_count: 0 });
    const vhEnabledRef = useRef(false);
    const vhThresholdRef = useRef(1);

    /* ── Persist ──────────────────────────────────────────────────────────── */
    useEffect(() => { saveLogs(logs); }, [logs]);

    /* ── POC listener on the OTP new system WS ────────────────────────────── */
    // Re-subscribe POC on every contract buy by keying on activeContractsRef
    const pocUnsubRef = useRef<(() => void) | null>(null);
    const subscribePOC = useCallback(() => {
        if (!window._newSystemWS) return;
        window._newSystemWS.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
    }, []);

    useEffect(() => {
        if (!running) return;
        subscribePOC();
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

                const { symbol: sym, stake: tradeStake, strategyNames, duration } = entry;
                const sd = symbolDataRef.current[sym];
                if (!sd) return;

                const profit = Number(c.profit);
                const won = profit >= 0;

                strategyNames.forEach(n => recordOutcome(n, won));

                pnlRef.current += profit;
                setPnl(pnlRef.current);

                if (won) {
                    sd.wins++;
                    consecutiveLossesRef.current = 0;
                    cooldownTicksRef.current = 0;
                    globalStakeRef.current = stakeParsed.current;
                    addLog(`✅ WON +$${profit.toFixed(2)} on ${SYMBOL_LABELS[sym]} | Next stake reset to $${stakeParsed.current.toFixed(2)} | P&L $${pnlRef.current.toFixed(2)}`, 'win');
                    if (vhStateRef.current.enabled && !vhStateRef.current.is_virtual) {
                        vhStateRef.current.is_virtual = true;
                        vhStateRef.current.loss_count = 0;
                        addLog(`🤖 [VIRTUAL HOOK] 🔄 Real WIN — switching back to VIRTUAL mode`, 'info');
                    }
                } else {
                    sd.losses++;
                    consecutiveLossesRef.current++;
                    globalStakeRef.current = Number((tradeStake * martingaleParsed.current).toFixed(2));
                    if (consecutiveLossesRef.current >= 3) {
                        cooldownTicksRef.current = 8;
                        addLog(`⚠ ${consecutiveLossesRef.current} consecutive losses — cooldown ${cooldownTicksRef.current} ticks`, 'loss');
                    }
                    addLog(`❌ LOST -$${Math.abs(profit).toFixed(2)} on ${SYMBOL_LABELS[sym]} | Next stake $${globalStakeRef.current.toFixed(2)} | P&L $${pnlRef.current.toFixed(2)}`, 'loss');
                }

                flushDisplay(sym);
                globalLock.current = false;
                activeContractsRef.current = 0;
                setActiveContracts(0);
                checkLimits();
            } catch (_) {}
        });

        pocUnsubRef.current = unsub;
        return () => { unsub(); pocUnsubRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [running]);

    /* ── Log helper ──────────────────────────────────────────────────────── */
    const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
        const time = new Date().toLocaleTimeString();
        setLogs(prev => [{ time, msg, type }, ...prev].slice(0, 120));
    }, []);

    const clearLogs = useCallback(() => {
        setLogs([]);
        localStorage.removeItem(LS_LOGS_KEY);
    }, []);

    const flushDisplay = useCallback((sym: string) => {
        const sd = symbolDataRef.current[sym];
        if (!sd) return;
        setSymbolDisplay(prev => ({
            ...prev,
            [sym]: {
                lastSignal: sd.lastSignal,
                wins: sd.wins,
                losses: sd.losses,
                stake: globalStakeRef.current,
            },
        }));
    }, []);

    const checkLimits = useCallback(() => {
        if (pnlRef.current >= tpRef.current) {
            addLog(`✅ Take Profit +$${tpRef.current} reached! P&L: $${pnlRef.current.toFixed(2)}`, 'win');
            stopKiller();
            return true;
        }
        if (pnlRef.current <= -slRef.current) {
            addLog(`🛑 Stop Loss -$${slRef.current} hit! P&L: $${pnlRef.current.toFixed(2)}`, 'loss');
            stopKiller();
            return true;
        }
        return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addLog]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const stopKiller = useCallback(() => {
        runningRef.current = false;
        globalLock.current = false;
        setRunning(false);
        try { wsRef.current?.close(); } catch (_) {}
        wsRef.current = null;
        activeContractsRef.current = 0;
        setActiveContracts(0);
        run_panel.setHasOpenContract(false);
        run_panel.setIsRunning(false);
        addLog('Market Killer stopped.', 'info');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addLog]);

    /* ── Auto-detect best tick duration (1-5) by analyzing price history ──── */
    const getBestDuration = useCallback((prices: number[], direction: 'CALL' | 'PUT'): number => {
        return findBestDuration(prices, direction);
    }, []);

    /* ── Execute ONE trade using the global stake ────────────────────────── */
    const executeTrade = useCallback(async (sym: string, signal: TradeSignal) => {
        if (!runningRef.current) return;
        if (!signal || signal.confidence < CONFIDENCE_THRESHOLD) return;

        const sd = symbolDataRef.current[sym];
        if (!sd) return;

        // ── Virtual Hook: if in virtual mode, simulate trade instead of buying ──
        if (vhStateRef.current.enabled && vhStateRef.current.is_virtual) {
            const vhConfWin = signal.confidence >= 75;
            if (vhConfWin) {
                vhStateRef.current.loss_count = 0;
                addLog(`🤖 [VIRTUAL HOOK] ✅ Simulated WIN on ${SYMBOL_LABELS[sym]} (${signal.contract_type} @ ${signal.confidence.toFixed(0)}%)`, 'win');
            } else {
                vhStateRef.current.loss_count++;
                addLog(`🤖 [VIRTUAL HOOK] ❌ Simulated LOSS #${vhStateRef.current.loss_count}/${vhStateRef.current.threshold} on ${SYMBOL_LABELS[sym]} (${signal.contract_type} @ ${signal.confidence.toFixed(0)}%)`, 'loss');
                if (vhStateRef.current.loss_count >= vhStateRef.current.threshold) {
                    vhStateRef.current.is_virtual = false;
                    addLog(`🤖 [VIRTUAL HOOK] 🔄 THRESHOLD REACHED — Switching to REAL trades`, 'info');
                }
            }
            signalHistoryRef.current = [];
            return;
        }

        // Micro-trend entry gate: don't trade against the trend
        if (signal.contract_type === 'CALL' || signal.contract_type === 'PUT') {
            const last3 = sd.prices.slice(-3);
            if (last3.length === 3) {
                const rising = last3[0] < last3[1] && last3[1] < last3[2];
                const falling = last3[0] > last3[1] && last3[1] > last3[2];
                if (signal.contract_type === 'CALL' && falling) return;
                if (signal.contract_type === 'PUT' && rising) return;
            }
        }

        globalLock.current = true;
        activeContractsRef.current = 1;
        setActiveContracts(1);

        const { contract_type, barrier, reason, confidence, details } = signal;
        const tradeStake = Number(globalStakeRef.current.toFixed(2));
        const duration   = getBestDuration(sd.prices, contract_type);
        addLog(`Trade stake: $${tradeStake.toFixed(2)} (base: $${stakeParsed.current.toFixed(2)}, mg: ${martingaleParsed.current}x)`, 'trade');

        // Extract strategy names from details for outcome tracking
        const strategyMatch = details.match(/Strategies: (.+)/);
        const strategyNames = strategyMatch
            ? strategyMatch[1].split(',').map(s => s.trim().split('(')[0])
            : ['ensemble'];

        const params: any = {
            amount: tradeStake, basis: 'stake', currency: 'USD',
            duration, duration_unit: 't',
            symbol: sym, contract_type,
        };
        if (barrier) params.barrier = barrier;

        const label = contract_type === 'CALL' ? 'RISE' : 'FALL';

        if (window._newSystemWS?.readyState === WebSocket.OPEN) {
            try {
                const response = await sendViaNewSystemWithPromise({ buy: 1, price: tradeStake, parameters: params });
                const contractId = response?.buy?.contract_id ?? response?.contract_id;
                if (contractId) {
                    contractMapRef.current.set(String(contractId), { symbol: sym, stake: tradeStake, strategyNames, duration });
                    sd.lastSignal = label;
                    addLog(`🎯 [${confidence.toFixed(0)}%] ${SYMBOL_LABELS[sym]}: ${label} D${duration} @ $${tradeStake} — ${reason}`, 'trade');
                    addLog(`Contract ${contractId} open on ${SYMBOL_LABELS[sym]}`, 'info');
                    flushDisplay(sym);
                    try {
                        transactions.onBotContractEvent({
                            contract_id: contractId,
                            transaction_ids: { buy: response?.buy?.transaction_id },
                            buy_price: tradeStake,
                            currency: 'USD',
                            contract_type,
                            underlying: sym,
                            display_name: SYMBOL_LABELS[sym],
                            date_start: Math.floor(Date.now() / 1000),
                            status: 'open',
                        } as any);
                        run_panel.setHasOpenContract(true);
                    } catch (_) {}
                } else {
                    addLog(`Buy ok but no contract_id: ${JSON.stringify(response).slice(0, 100)}`, 'info');
                    globalLock.current = false;
                    activeContractsRef.current = 0;
                    setActiveContracts(0);
                }
            } catch (err: any) {
                addLog(`Buy error: ${err?.error?.message || err?.message || 'Unknown'}`, 'info');
                globalLock.current = false;
                activeContractsRef.current = 0;
                setActiveContracts(0);
            }
        } else if (wsRef.current?.isOpen()) {
            wsRef.current.send({ buy: 1, price: tradeStake, parameters: params });
            sd.lastSignal = label;
            addLog(`🎯 [${confidence.toFixed(0)}%] ${SYMBOL_LABELS[sym]}: ${label} D${duration} @ $${tradeStake} — ${reason}`, 'trade');
            contractMapRef.current.set(sym + Date.now(), { symbol: sym, stake: tradeStake, strategyNames, duration });
            flushDisplay(sym);
            try {
                transactions.onBotContractEvent({
                    contract_id: sym + Date.now(),
                    buy_price: tradeStake,
                    currency: 'USD',
                    contract_type,
                    underlying: sym,
                    display_name: SYMBOL_LABELS[sym],
                    date_start: Math.floor(Date.now() / 1000),
                    status: 'open',
                } as any);
                run_panel.setHasOpenContract(true);
            } catch (_) {}
        } else {
            globalLock.current = false;
            activeContractsRef.current = 0;
            setActiveContracts(0);
        }
    }, [addLog, flushDisplay]);

    /* ── Handle every incoming tick ──────────────────────────────────────── */
    const onTickReceived = useCallback(() => {
        if (!runningRef.current) return;
        if (globalLock.current)  return;
        if (cooldownTicksRef.current > 0) { cooldownTicksRef.current--; return; }

        let bestSym  = '';
        let bestSig: TradeSignal | null = null;
        let bestConf = CONFIDENCE_THRESHOLD - 1;

        ALL_SYMBOLS.forEach(s => {
            const sd = symbolDataRef.current[s];
            if (!sd || sd.ticks.length < MIN_TICKS_BEFORE_TRADE) return;
            // Run each contract family separately so they compete fairly
            for (const family of CONTRACT_FAMILIES) {
                const sig = analyzeSignals(sd.ticks, sd.prices, family.types);
                if (sig && sig.confidence > bestConf) {
                    bestConf = sig.confidence;
                    bestSym  = s;
                    bestSig  = sig;
                }
            }
        });

        if (bestSym && bestSig) {
            // Signal confirmation: require same direction on 3 consecutive ticks
            signalHistoryRef.current.push({ sym: bestSym, type: bestSig.contract_type, conf: bestSig.confidence });
            if (signalHistoryRef.current.length > 3) signalHistoryRef.current.shift();
            const last3 = signalHistoryRef.current;
            const confirmed = last3.length === 3 && last3.every(s => s.sym === bestSym && s.type === bestSig.contract_type);
            if (confirmed) {
                signalHistoryRef.current = []; // clear after confirmed trade
                // Streak guard: if all 3 confirmation ticks moved in the predicted direction, skip (too extended)
                const prices = symbolDataRef.current[bestSym]?.prices;
                if (prices && prices.length >= 4) {
                    const last4 = prices.slice(-4);
                    const allUp   = last4[0] < last4[1] && last4[1] < last4[2] && last4[2] < last4[3];
                    const allDown = last4[0] > last4[1] && last4[1] > last4[2] && last4[2] > last4[3];
                    if ((bestSig.contract_type === 'CALL' && allUp) || (bestSig.contract_type === 'PUT' && allDown)) {
                        return; // market too extended in predicted direction, skip
                    }
                }
                // Signal alignment: at least 2 of the 3 confirmation ticks must have moved in predicted direction
                if (prices && prices.length >= 4) {
                    const pDir = prices.slice(-4);
                    let aligned = 0;
                    if (bestSig.contract_type === 'CALL') {
                        for (let i = 0; i < 3; i++) { if (pDir[i] < pDir[i+1]) aligned++; }
                    } else {
                        for (let i = 0; i < 3; i++) { if (pDir[i] > pDir[i+1]) aligned++; }
                    }
                    if (aligned < 2) return; // not enough ticks confirmed the direction
                }
                executeTrade(bestSym, bestSig).catch(() => {});
            }
        }
    }, [executeTrade]);

    // Ref for onTickReceived to avoid stale closure in WS handler
    const onTickRef = useRef(onTickReceived);
    onTickRef.current = onTickReceived;

    /* ── Start ───────────────────────────────────────────────────────────── */
    const startKiller = useCallback(() => {
        const stakeVal = Math.max(0.35, parseFloat(stake) || 0.35);
        const mgVal    = Math.max(1,    parseFloat(martingale) || 2);
        const tpVal    = Math.max(0.5,  parseFloat(takeProfit) || 10);
        const slVal    = Math.max(0.5,  parseFloat(stopLoss)   || 5);

        stakeParsed.current      = stakeVal;
        martingaleParsed.current = mgVal;
        tpRef.current            = tpVal;
        slRef.current            = slVal;
        pnlRef.current           = 0;
        globalLock.current       = false;
        activeContractsRef.current = 0;
        globalStakeRef.current   = stakeVal;
        consecutiveLossesRef.current = 0;
        cooldownTicksRef.current     = 0;

        vhEnabledRef.current = vhEnabled;
        vhThresholdRef.current = Math.max(1, parseInt(vhThreshold) || 1);
        vhStateRef.current = {
            enabled: vhEnabled,
            threshold: vhThresholdRef.current,
            is_virtual: vhEnabled,
            loss_count: 0,
        };
        if (vhEnabled) {
            addLog(`🤖 [VIRTUAL HOOK] Enabled — ${vhThresholdRef.current} virtual losses before real trades`, 'info');
        }

        setPnl(0);
        setActiveContracts(0);
        setSymbolDisplay({});
        contractMapRef.current = new Map();

        symbolDataRef.current = {};
        ALL_SYMBOLS.forEach(sym => {
            symbolDataRef.current[sym] = {
                ticks: [], prices: [], lastSignal: '—',
                wins: 0, losses: 0, ready: false,
            };
        });

        runningRef.current = true;
        setRunning(true);

        addLog(`⚔ Kill Market — Auto (Rise/Fall + Digits) | stake $${stakeVal}  MG ×${mgVal}  TP $${tpVal}  SL $${slVal}`, 'info');
        addLog('Connecting to Deriv API…', 'info');

        if (wsRef.current) { try { wsRef.current.close(); } catch (_) {} wsRef.current = null; }

        const handleMsg = (data: any) => {
            if (!runningRef.current) return;

            if (data.error) {
                if (data.msg_type === 'buy') {
                    addLog(`Buy error: ${data.error.message}`, 'info');
                    globalLock.current = false;
                    activeContractsRef.current = 0;
                    setActiveContracts(0);
                }
                return;
            }

            switch (data.msg_type) {

                case 'history': {
                    const sym: string = data.echo_req?.ticks_history;
                    if (!sym || !symbolDataRef.current[sym]) return;
                    const sd  = symbolDataRef.current[sym];
                    const pip = PIP_SIZES[sym] || 2;
                    const prices = (data.history.prices as (string | number)[]).map(p => Number(p));
                    const digits = prices.map(p => Number(p.toFixed(pip).slice(-1)));
                    sd.ticks  = digits.slice(-MAX_TICKS);
                    sd.prices = prices.slice(-MAX_TICKS);
                    sd.ready  = sd.ticks.length >= MIN_TICKS_BEFORE_TRADE;
                    addLog(`Loaded ${digits.length} ticks — ${SYMBOL_LABELS[sym]}`, 'info');
                    break;
                }

                case 'tick': {
                    const tick     = data.tick;
                    const sym: string = tick.symbol;
                    if (!sym || !symbolDataRef.current[sym]) return;
                    const sd  = symbolDataRef.current[sym];
                    const pip = PIP_SIZES[sym] || tick.pip_size || 2;
                    const price = Number(tick.quote);
                    const digit = Number(price.toFixed(pip).slice(-1));

                    sd.ticks  = [...sd.ticks.slice(-(MAX_TICKS - 1)), digit];
                    sd.prices = [...sd.prices.slice(-(MAX_TICKS - 1)), price];
                    sd.ready  = sd.ticks.length >= MIN_TICKS_BEFORE_TRADE;

                    onTickRef.current();
                    break;
                }

                case 'buy': {
                    const sym: string = data.echo_req?.parameters?.symbol;
                    if (!sym) return;
                    if (data.error) {
                        globalLock.current = false;
                        activeContractsRef.current = 0;
                        setActiveContracts(0);
                        return;
                    }
                    const cid = String(data.buy.contract_id);
                    contractMapRef.current.set(cid, { symbol: sym, stake: globalStakeRef.current, strategyNames: ['ensemble'] });
                    addLog(`Contract ${cid} open on ${SYMBOL_LABELS[sym]}`, 'info');
                    break;
                }

                case 'proposal_open_contract': {
                    const c = data.proposal_open_contract;
                    if (!c?.is_sold) return;
                    const cid   = String(c.contract_id);
                    const entry = contractMapRef.current.get(cid);
                    if (!entry) return;
                    contractMapRef.current.delete(cid);

                    const { symbol: sym, stake: tradeStake, strategyNames, duration } = entry;
                    const sd = symbolDataRef.current[sym];
                    if (!sd) return;

                    const profit = Number(c.profit);
                    const won    = profit >= 0;

                    strategyNames.forEach(n => recordOutcome(n, won));

                    pnlRef.current += profit;
                    setPnl(pnlRef.current);

                    try {
                        const pocWithDisplay = !(c as any).display_name ? { ...c, display_name: SYMBOL_LABELS[sym] } : c;
                        transactions.onBotContractEvent(pocWithDisplay);
                        run_panel.setHasOpenContract(false);
                    } catch (_) {}

                    if (won) {
                        sd.wins++;
                        consecutiveLossesRef.current = 0;
                        cooldownTicksRef.current = 0;
                        globalStakeRef.current = stakeParsed.current;
                        addLog(`✅ WON +$${profit.toFixed(2)} on ${SYMBOL_LABELS[sym]} | Next stake reset to $${stakeParsed.current.toFixed(2)} | P&L $${pnlRef.current.toFixed(2)}`, 'win');
                        if (vhStateRef.current.enabled && !vhStateRef.current.is_virtual) {
                            vhStateRef.current.is_virtual = true;
                            vhStateRef.current.loss_count = 0;
                            addLog(`🤖 [VIRTUAL HOOK] 🔄 Real WIN — switching back to VIRTUAL mode`, 'info');
                        }
                    } else {
                        sd.losses++;
                        consecutiveLossesRef.current++;
                        globalStakeRef.current = Number((tradeStake * martingaleParsed.current).toFixed(2));
                        if (consecutiveLossesRef.current >= 3) {
                            cooldownTicksRef.current = 8;
                            addLog(`⚠ ${consecutiveLossesRef.current} consecutive losses — cooldown ${cooldownTicksRef.current} ticks`, 'loss');
                        }
                        addLog(`❌ LOST -$${Math.abs(profit).toFixed(2)} on ${SYMBOL_LABELS[sym]} | Next stake $${globalStakeRef.current.toFixed(2)} | P&L $${pnlRef.current.toFixed(2)}`, 'loss');
                    }

                    flushDisplay(sym);
                    globalLock.current = false;
                    activeContractsRef.current = 0;
                    setActiveContracts(0);
                    checkLimits();
                    break;
                }
            }
        };

        const mws = openMakotiWS(
            handleMsg,
            () => {
                addLog('Connected ✓  Subscribing to all 10 volatilities…', 'info');
                if (!window._newSystemWS) {
                    mws.send({ proposal_open_contract: 1, subscribe: 1 });
                }
                ALL_SYMBOLS.forEach(sym => {
                    mws.send({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks', subscribe: 1 });
                });
            },
            () => {
                if (runningRef.current) {
                    addLog('Connection lost. Stopping.', 'info');
                    stopKiller();
                }
            }
        );
        wsRef.current = mws;
    }, [stake, martingale, takeProfit, stopLoss, addLog, flushDisplay, checkLimits, stopKiller, onTickReceived]);

    /* ── Derived display values ──────────────────────────────────────────── */
    const totalWins   = Object.values(symbolDisplay).reduce((a, b) => a + b.wins,  0);
    const totalLosses = Object.values(symbolDisplay).reduce((a, b) => a + b.losses, 0);
    const totalTrades = totalWins + totalLosses;
    const winRate     = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : '—';

    return (
        <div className='mw-killer'>
            {/* ── Input fields ── */}
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
                <div className='mw-field'>
                    <label className='mw-label'>Take Profit ($)</label>
                    <input className='mw-input' type='number' min='0.5' step='0.5'
                        value={takeProfit} onChange={e => setTakeProfit(e.target.value)} disabled={running} />
                </div>
                <div className='mw-field'>
                    <label className='mw-label'>Stop Loss ($)</label>
                    <input className='mw-input' type='number' min='0.5' step='0.5'
                        value={stopLoss} onChange={e => setStopLoss(e.target.value)} disabled={running} />
                </div>
            </div>

            {/* ── Virtual Hook toggle ── */}
            <div className='mw-killer__vh'>
                <label className='mw-killer__vh-toggle'>
                    <input type='checkbox' checked={vhEnabled}
                        onChange={e => setVhEnabled(e.target.checked)} disabled={running} />
                    <span>Virtual Hook</span>
                </label>
                {vhEnabled && (
                    <div className='mw-field mw-killer__vh-threshold'>
                        <label className='mw-label'>Loss Threshold:</label>
                        <input className='mw-input' type='number' min='1' step='1'
                            value={vhThreshold} onChange={e => setVhThreshold(e.target.value)} disabled={running} />
                    </div>
                )}
            </div>

            {/* ── Kill Market button ── */}
            <button
                className={`mw-btn${running ? ' mw-btn--stop' : ' mw-btn--kill'}`}
                onClick={running ? stopKiller : startKiller}
            >
                {running
                    ? <><span className='mw-pulse' /> STOP KILLER</>
                    : '⚔ KILL MARKET'}
            </button>

            {/* ── Running notice ── */}
            {running && (
                <div className='mw-killer__mode-note'>
                    Auto (RF + OU + EO) — 47-strategy ensemble engine
                    {activeContracts > 0 && <span className='mw-killer__active-dot'> ● TRADE LIVE</span>}
                </div>
            )}

            {/* ── Stats ── */}
            {(running || totalTrades > 0) && (
                <div className='mw-killer__stats'>
                    <div className={`mw-killer__pnl${pnl >= 0 ? ' mw-killer__pnl--pos' : ' mw-killer__pnl--neg'}`}>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                    </div>
                    <div className='mw-killer__meta'>
                        <span>Trades: {totalTrades}</span>
                        <span>W/L: {totalWins}/{totalLosses}</span>
                        <span>Win rate: {winRate}%</span>
                        <span>Stake: ${globalStakeRef.current.toFixed(2)}</span>
                    </div>
                </div>
            )}

            {/* ── Per-symbol rows ── */}
            {Object.keys(symbolDisplay).length > 0 && (
                <div className='mw-killer__symbols'>
                    {ALL_SYMBOLS.filter(s => symbolDisplay[s]).map(sym => {
                        const ss = symbolDisplay[sym];
                        const baseStake = parseFloat(stake) || 0.35;
                        const isMgActive = ss.stake > baseStake + 0.001;
                        return (
                            <div key={sym} className='mw-killer__sym-row'>
                                <span className='mw-killer__sym-name'>{SYMBOL_LABELS[sym]}</span>
                                <span className='mw-killer__sym-signal'>{ss.lastSignal}</span>
                                <span className='mw-killer__sym-wl'>
                                    <span className='mw-win'>{ss.wins}W</span>
                                    <span className='mw-loss'>{ss.losses}L</span>
                                </span>
                                {isMgActive && (
                                    <span className='mw-killer__sym-stake' title='Martingale stake'>
                                        ${ss.stake.toFixed(2)}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Log ── */}
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
