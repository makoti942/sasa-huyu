
import { action, makeObservable, observable, reaction, runInAction } from 'mobx';
import { TStores } from '@/types/stores.types';
import RootStore from './root-store';
import { getAppId, getSocketURL } from '@/components/shared';
import { MessageTypes } from '@/external/bot-skeleton';
import { predictNextDigits } from '@/utils/differs-prediction-engine';
import { analyzeDigits, GoldenEntry, AnalysisResult } from '@/utils/ai-analysis-engine';

const STATUS_OFFLINE = 'Offline';
const STATUS_CONNECTING = 'Connecting...';
const STATUS_LIVE = 'Live Ticks';
const STATUS_AUTHORIZED = 'Account Connected';

const MAX_TICKS = 1000;

const pip_sizes = {
    'R_100': 2,
    'R_75': 4,
    'R_50': 4,
    'R_25': 3,
    'R_10': 3,
    '1HZ100V': 2,
    '1HZ75V': 2,
    '1HZ50V': 2,
    '1HZ25V': 2,
    '1HZ10V': 2,
};

export default class OverUnderStore {
    root_store: RootStore;
    ws: WebSocket | null = null;
    reconnectTimeout: NodeJS.Timeout | null = null;
    is_authorized = false;
    is_authorizing = false;
    debug_info: string[] = [];
    volatilityAnalyzer: Worker | null = null;

    connection_status = STATUS_OFFLINE;
    tick_history: number[] = [];
    last_digit: number | null = null;
    is_auto_running = false;
    stake = 1;
    initial_stake = 1;
    martingale = 2;
    is_volatility_changer = false;
    is_differs_mode = false;
    is_differs_v2_mode = false;
    is_tatu_bora_mode = false;
    is_nne_kwisha_mode = false;
    is_all_vol_mode = false;
    is_trigger_enabled = false;
    is_automate = false;
    use_second_trigger = true;
    is_manual_mode = false;
    manual_contract_type = 'DIGITOVER';
    manual_barrier = '5';
    manual_duration = 5;
    is_recovery_active = false;
    recovery_symbol: string | null = null;
    is_recovery_enabled = false;
    recovery_contract_type = 'DIGITOVER';
    recovery_barrier = '5';
    use_recovery_delay = false;
    recovery_entry_digit = 7;
    recovery_second_entry_digit = 7;
    entry_digit = 7;
    second_entry_digit = 7;
    last_last_digit: number | null = null;
    is_turbo = false;
    selected_symbol = 'R_100';
    active_contracts: Set<string> = new Set();
    contract_results: Map<string, { profit: number, symbol: string }> = new Map();
    active_subscription_id: string | null = null;
    differs_barrier_digit: number | null = null;
    is_differs_recovery_mode = false;
    is_2term_mode = false;
    is_rise_fall_mode = false;
    is_rise_fall_v2_mode = false;
    rise_fall_v2_duration = 1;
    last_profit = 0;
    differs_predicted_top4: number[] = [];
    differs_v2_predicted_digit: number | null = null;
    differs_v2_post_trade_ticks = 0;
    differs_v2_analysis_ready = false;
    differs_v2_5s_analysis_pending = false;
    differs_v2_confidence_wait_start: number | null = null;
    private _tick_prices: number[] = [];
    total_loss_to_recover = 0;
    differs_digit_appearance_count = 0;
    private rise_fall_trade_count = 0;
    private rise_fall_v2_growth_counters: { [symbol: string]: number } = {};
    private rise_fall_v2_prev_histogram: { [symbol: string]: number } = {};

    is_analyzing_volatility = false;
    analysis_queue: string[] = [];
    best_score = Infinity;
    best_symbol: string | null = null;
    current_analyzing_symbol: string | null = null;
    private analysis_pending: Set<string> = new Set();
    private analysis_scores: Map<string, number> = new Map();
    private analysis_momentum: Map<string, number> = new Map();
    private analysis_strategy: string | null = null;

    symbol_data: { [key: string]: { tick_history: number[], last_digit: number | null, last_last_digit: number | null, _tick_prices: number[] } } = {};

    private symbol_locks: { [key: string]: boolean } = {};
    private is_processing_round = false;
    private is_purchasing = false;
    private pending_instant_result_check: { [symbol: string]: { barrier: string, stake: number, contract_type: string, ticks_to_check: number } } = {};

    is_digit_occurrence_filter_active = false;
    is_ai_scanning = false;
    ai_scan_results: GoldenEntry[] = [];
    is_rebounce_active = false;
    private rebounce_sequences: { [symbol: string]: boolean } = {};
    last_ai_signal_analysis: string | null = null;


    private _boundAuthHandler: (event: MessageEvent) => void;
    private _loginReaction: () => void;
    private _accountReaction: () => void;
    private _purchaseTimeout: NodeJS.Timeout | null = null;
    private _analysisTimeout: NodeJS.Timeout | null = null;
    private readonly PURCHASE_TIMEOUT_MS = 30_000;
    private readonly ANALYSIS_TIMEOUT_MS = 60_000;

    constructor(root_store: RootStore) {
        makeObservable(this, {
            connection_status: observable,
            tick_history: observable,
            last_digit: observable,
            last_last_digit: observable,
            is_auto_running: observable,
            stake: observable,
            initial_stake: observable,
            martingale: observable,
            is_volatility_changer: observable,
            is_differs_mode: observable,
            is_automate: observable,
            use_second_trigger: observable,
            is_manual_mode: observable,
            manual_contract_type: observable,
            manual_barrier: observable,
            manual_duration: observable,
            is_recovery_active: observable,
            is_recovery_enabled: observable,
            recovery_contract_type: observable,
            recovery_barrier: observable,
            use_recovery_delay: observable,
            recovery_entry_digit: observable,
            recovery_second_entry_digit: observable,
            entry_digit: observable,
            second_entry_digit: observable,
            is_turbo: observable,
            selected_symbol: observable,
            debug_info: observable,
            is_analyzing_volatility: observable,
            current_analyzing_symbol: observable,
            is_authorizing: observable,
            differs_barrier_digit: observable,
            is_differs_recovery_mode: observable,
            is_2term_mode: observable,
            is_rise_fall_mode: observable,
            is_rise_fall_v2_mode: observable,
            rise_fall_v2_duration: observable,
            is_differs_v2_mode: observable,
            is_tatu_bora_mode: observable,
            is_nne_kwisha_mode: observable,
            is_all_vol_mode: observable,
            is_trigger_enabled: observable,
            differs_predicted_top4: observable,
            differs_v2_predicted_digit: observable,
            differs_v2_post_trade_ticks: observable,
            differs_v2_analysis_ready: observable,
            differs_v2_5s_analysis_pending: observable,
            differs_v2_confidence_wait_start: observable,
            is_digit_occurrence_filter_active: observable,
            is_rebounce_active: observable,
            is_ai_scanning: observable,
            ai_scan_results: observable,
            last_ai_signal_analysis: observable,
            setStake: action.bound,
            setIsRiseFallMode: action.bound,
            setIsRiseFallV2Mode: action.bound,
            setRiseFallV2Duration: action.bound,
            setIs2termMode: action.bound,
            setMartingale: action.bound,
            setIsVolatilityChanger: action.bound,
            setIsDiffersMode: action.bound,
            setIsDiffersV2Mode: action.bound,
            setIsTatuBoraMode: action.bound,
            setIsNneKwishaMode: action.bound,
            setIsAllVolMode: action.bound,
            setIsTriggerEnabled: action.bound,
            setIsAutomate: action.bound,
            setUseSecondTrigger: action.bound,
            setIsManualMode: action.bound,
            setManualContractType: action.bound,
            setManualBarrier: action.bound,
            setManualDuration: action.bound,
            setIsRecoveryActive: action.bound,
            setIsRecoveryEnabled: action.bound,
            setRecoveryContractType: action.bound,
            setRecoveryBarrier: action.bound,
            setUseRecoveryDelay: action.bound,
            setRecoveryEntryDigit: action.bound,
            setRecoverySecondEntryDigit: action.bound,
            setEntryDigit: action.bound,
            setSecondEntryDigit: action.bound,
            setIsTurbo: action.bound,
            setSelectedSymbol: action.bound,
            setIsAutoRunning: action.bound,
            connectWebSocket: action.bound,
            handleStartStop: action.bound,
            addLog: action.bound,
            clearDebug: action.bound,
            resetStrategyToggles: action.bound,
            setIsDigitOccurrenceFilterActive: action.bound,
            setIsRebounceActive: action.bound,
            setIsAiScanning: action.bound,
            setAiScanResults: action.bound,
        });
        this.root_store = root_store;
        this.initializeWorker();
        this._boundAuthHandler = this.handleAuthResponse.bind(this);
        window.addEventListener('message', this._boundAuthHandler);

        this._loginReaction = reaction(
            () => this.root_store.client.is_logged_in,
            (is_logged_in) => {
                if (is_logged_in && !this.is_authorized) {
                    this.addLog('Global login detected, reconnecting...');
                    this.connectWebSocket();
                }
            }
        );

        this._accountReaction = reaction(
            () => this.root_store.client.loginid,
            (loginid) => {
                if (loginid) {
                    this.addLog(`Account switched to ${loginid}, reconnecting...`);
                    this.connectWebSocket();
                }
            }
        );
    }

    handleAuthResponse(event: MessageEvent) {
        if (event.data?.name !== 'auth_token') return;
        const token = event.data?.token;
        if (token && this.ws?.readyState === WebSocket.OPEN) {
            this.addLog('Auth token received from parent, authorizing...');
            this.ws.send(JSON.stringify({ authorize: token }));
        } else {
            this.addLog('Parent window auth failed. Proceeding with public ticks.');
            this.is_authorizing = false;
            this.subscribeToTicks(this.selected_symbol);
        }
    }

    initializeWorker() {
        try {
            this.volatilityAnalyzer = new Worker(new URL('../workers/volatility-analyzer.ts', import.meta.url));
            this.volatilityAnalyzer.onmessage = (event) => {
                const { score, symbol, momentum } = event.data as {
                    score: number; symbol?: string; momentum?: number | null;
                };
                if (!symbol) return;

                this.analysis_scores.set(symbol, score);
                if (typeof momentum === 'number' && isFinite(momentum)) {
                    this.analysis_momentum.set(symbol, momentum);
                }
                this.analysis_pending.delete(symbol);

                if (score < this.best_score) {
                    this.best_score = score;
                    this.best_symbol = symbol;
                }

                if (this.analysis_pending.size === 0) {
                    this.finalizeVolatilityAnalysis();
                }
            };
            this.volatilityAnalyzer.onerror = (err) => {
                this.addLog(`⚠️ Volatility worker error: ${err.message}. Aborting analysis.`);
                runInAction(() => {
                    this.is_analyzing_volatility = false;
                    this.current_analyzing_symbol = null;
                    this.analysis_queue = [];
                });
                this._clearAnalysisTimeout();
                this.volatilityAnalyzer?.terminate();
                this.initializeWorker();
            };
        } catch (e) {
            this.addLog(`⚠️ Could not create volatility worker: ${e?.message}`);
        }
    }

    startVolatilityAnalysis() {
        if (!this.is_volatility_changer || this.is_analyzing_volatility) return;

        const symbols = Object.keys(pip_sizes);
        const strategy = this.is_differs_mode ? 'differs'
            : this.is_differs_v2_mode ? 'differs_v2'
            : this.is_rise_fall_v2_mode ? 'rise_fall_v2'
            : this.is_rise_fall_mode ? 'rise_fall'
            : this.is_manual_mode ? 'manual'
            : 'over_under';

        runInAction(() => {
            this.is_analyzing_volatility = true;
            this.analysis_queue = [];
            this.analysis_pending = new Set(symbols);
            this.analysis_scores = new Map();
            this.analysis_momentum = new Map();
            this.analysis_strategy = strategy;
            this.best_score = Infinity;
            this.best_symbol = null;
            this.current_analyzing_symbol = null;
        });

        this.addLog(`Volatility analysis started — voting across ${symbols.length} volatilities in parallel...`);
        this._armAnalysisTimeout();

        const sendAll = () => {
            symbols.forEach(sym => {
                this.ws!.send(JSON.stringify({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' }));
            });
        };

        if (this.ws?.readyState === WebSocket.OPEN) {
            sendAll();
            return;
        }

        this.addLog('⏳ Waiting for WebSocket connection...');
        const retryDelay = 500;
        let retryCount = 0;
        const maxRetries = 20;
        const waitForWs = () => {
            retryCount++;
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.addLog('✅ WebSocket ready, requesting all volatilities...');
                sendAll();
            } else if (retryCount < maxRetries) {
                setTimeout(waitForWs, retryDelay);
            } else {
                this.addLog('⚠️ WS connection timeout, using default symbol R_100.');
                runInAction(() => {
                    this.best_symbol = 'R_100';
                    this.best_score = 0;
                    this.is_analyzing_volatility = false;
                    this.analysis_pending.clear();
                });
                this._clearAnalysisTimeout();
            }
        };
        setTimeout(waitForWs, retryDelay);
    }

    finalizeVolatilityAnalysis() {
        this._clearAnalysisTimeout();

        // Build the percentage tally. For rise/fall we use the raw normalised
        // momentum (longest histogram bars) so percentages are meaningful;
        // for the others we invert the score so a lower score is a bigger
        // share (still produces the same winner as before).
        const entries: { symbol: string; weight: number }[] = [];
        if (this.analysis_strategy === 'rise_fall') {
            this.analysis_momentum.forEach((m, sym) => {
                if (isFinite(m) && m > 0) entries.push({ symbol: sym, weight: m });
            });
        } else {
            this.analysis_scores.forEach((s, sym) => {
                if (!isFinite(s)) return;
                // Invert score so lower-is-better becomes higher-is-better.
                const w = 1 / (1 + Math.max(0, s));
                entries.push({ symbol: sym, weight: w });
            });
        }

        const total = entries.reduce((a, b) => a + b.weight, 0);
        if (total > 0) {
            entries
                .map(e => ({ ...e, pct: (e.weight / total) * 100 }))
                .sort((a, b) => b.pct - a.pct)
                .forEach(e => {
                    this.addLog(`Vote ${e.symbol}: ${e.pct.toFixed(2)}%`);
                });

            const winner = entries.reduce((a, b) => (b.weight > a.weight ? b : a));
            const winnerPct = (winner.weight / total) * 100;
            runInAction(() => { this.best_symbol = winner.symbol; });
            this.addLog(`Analysis complete. Winner: ${winner.symbol} with ${winnerPct.toFixed(2)}% of the vote.`);
        } else {
            this.addLog('Analysis complete. No volatility produced a usable score.');
        }

        runInAction(() => {
            this.is_analyzing_volatility = false;
            this.current_analyzing_symbol = null;
            this.analysis_pending.clear();
        });

        if (this.best_symbol) {
            this.setSelectedSymbol(this.best_symbol);
            if (this.is_differs_v2_mode && this.is_auto_running) {
                this.addLog('Differs V2: Switched to new symbol. Looking for trigger...');
                return;
            }
        }

        if (this.is_auto_running && this.is_turbo) {
            this.addLog('Ready for next trade round.');
        }
    }

    addLog(msg: string) {
        const timestamp = new Date().toLocaleTimeString();
        const new_log = `[${timestamp}] ${msg}`;
        runInAction(() => {
            this.debug_info.unshift(new_log);
            if (this.debug_info.length > 200) this.debug_info.pop();
        });
        if (this.root_store.journal) {
            this.root_store.journal.pushMessage(msg, MessageTypes.NOTIFY);
        }
    }

    private _armPurchaseTimeout(symbol: string) {
        this._clearPurchaseTimeout();
        this._purchaseTimeout = setTimeout(() => {
            if (this.symbol_locks[symbol]) {
                this.addLog(`⚠️ Purchase timeout on ${symbol} — resetting lock.`);
                this.symbol_locks[symbol] = false;
                this.is_purchasing = false;
            }
        }, this.PURCHASE_TIMEOUT_MS);
    }

    private _clearPurchaseTimeout() {
        if (this._purchaseTimeout) { clearTimeout(this._purchaseTimeout); this._purchaseTimeout = null; }
    }

    private _armAnalysisTimeout() {
        if (this._analysisTimeout) clearTimeout(this._analysisTimeout);
        this._analysisTimeout = setTimeout(() => {
            if (this.is_analyzing_volatility) {
                this.addLog(`⚠️ Volatility analysis timeout — aborting (still missing ${this.analysis_pending.size} symbols).`);
                runInAction(() => {
                    this.is_analyzing_volatility = false;
                    this.current_analyzing_symbol = null;
                    this.analysis_queue = [];
                    this.analysis_pending.clear();
                });
            }
        }, this.ANALYSIS_TIMEOUT_MS);
    }

    private _clearAnalysisTimeout() {
        if (this._analysisTimeout) { clearTimeout(this._analysisTimeout); this._analysisTimeout = null; }
    }

    clearDebug() { this.debug_info = []; }
    
    resetStrategyToggles() {
        this.is_all_vol_mode = false;
        this.is_automate = false;
        this.is_2term_mode = false;
        this.is_volatility_changer = false;
        this.is_tatu_bora_mode = false;
        this.is_nne_kwisha_mode = false;
        this.is_trigger_enabled = false;
        this.use_second_trigger = true;
        this.is_digit_occurrence_filter_active = false;
        this.is_rebounce_active = false;
        
        // Ensure subscriptions are updated if All Vol mode was on
        if (this.ws?.readyState === WebSocket.OPEN && (this.connection_status === STATUS_LIVE || this.connection_status === STATUS_AUTHORIZED)) {
            this.subscribeToTicks(this.selected_symbol);
        }
    }
    setStake(stake: number) { this.stake = stake; if (!this.is_auto_running) this.initial_stake = stake; }
    setMartingale(value: number) { this.martingale = value; }
    setIsVolatilityChanger(value: boolean) { this.is_volatility_changer = value; }
    setIsDiffersMode(value: boolean) { this.is_differs_mode = value; }
    setIsDiffersV2Mode(value: boolean) { this.is_differs_v2_mode = value; }
    setIsTatuBoraMode(value: boolean) { this.is_tatu_bora_mode = value; }
    setIsNneKwishaMode(value: boolean) { this.is_nne_kwisha_mode = value; }

    setIsAllVolMode(value: boolean) {
        if (this.is_all_vol_mode === value) return;
        this.is_all_vol_mode = value;
        if (this.ws?.readyState === WebSocket.OPEN && (this.connection_status === STATUS_LIVE || this.connection_status === STATUS_AUTHORIZED)) {
            this.addLog(`All Vol Mode changed to ${value ? 'ON' : 'OFF'}. Updating subscriptions.`);
            this.subscribeToTicks(this.selected_symbol);
        }
    }

    setIsTriggerEnabled(value: boolean) { this.is_trigger_enabled = value; }

    setIs2termMode(value: boolean) { this.is_2term_mode = value; }
    setIsRiseFallMode(value: boolean) { this.is_rise_fall_mode = value; }
    setIsRiseFallV2Mode(value: boolean) { this.is_rise_fall_v2_mode = value; }
    setRiseFallV2Duration(value: number) { this.rise_fall_v2_duration = Math.max(1, Math.min(10, value)); }
    setIsAutomate(value: boolean) { this.is_automate = value; }
    setUseSecondTrigger(value: boolean) { this.use_second_trigger = value; }
    setIsManualMode(value: boolean) { this.is_manual_mode = value; }
    setManualContractType(value: string) { this.manual_contract_type = value; }
    setManualBarrier(value: string) { this.manual_barrier = value; }
    setManualDuration(value: number) { this.manual_duration = value; }
    setIsRecoveryActive(value: boolean) { this.is_recovery_active = value; }
    setIsRecoveryEnabled(value: boolean) { this.is_recovery_enabled = value; }
    setRecoveryContractType(value: string) { this.recovery_contract_type = value; }
    setRecoveryBarrier(value: string) { this.recovery_barrier = value; }
    setUseRecoveryDelay(value: boolean) { this.use_recovery_delay = value; }
    setRecoveryEntryDigit(digit: number) { this.recovery_entry_digit = digit; }
    setRecoverySecondEntryDigit(digit: number) { this.recovery_second_entry_digit = digit; }
    setEntryDigit(digit: number) { 
        runInAction(() => {
            this.entry_digit = digit; 
        });
    }
    setSecondEntryDigit(digit: number) { 
        runInAction(() => {
            this.second_entry_digit = digit; 
        });
    }
    setIsTurbo(is_turbo: boolean) { this.is_turbo = is_turbo; }
    setIsDigitOccurrenceFilterActive(value: boolean) { this.is_digit_occurrence_filter_active = value; }
    setIsRebounceActive(value: boolean) { this.is_rebounce_active = value; }
    setIsAiScanning(value: boolean) { this.is_ai_scanning = value; }
    setAiScanResults(results: GoldenEntry[]) { this.ai_scan_results = results; }

    startAiManualScan() {
        if (this.tick_history.length < 200) {
            this.addLog('AI Scan requires at least 200 historical ticks for accurate analysis.');
            return;
        }

        runInAction(() => { this.is_ai_scanning = true; });
        this.addLog('🤖 AI Engine v2.6: Starting advanced analysis...');

        // 1. Get an instant analysis from the engine
        const history = [...this.tick_history];
        const result = analyzeDigits(history, this.selected_symbol);
        this.addLog('Initial analysis complete. Observing live market for 5 seconds to confirm...');

        // 2. Start a 5-second live confirmation period
        setTimeout(() => {
            runInAction(() => {
                this.is_ai_scanning = false;
                this.setAiScanResults(result.goldenEntries);

                let entryToUse = result.bestEntry;

                if (entryToUse && entryToUse.analysis === this.last_ai_signal_analysis && result.goldenEntries.length > 1) {
                    this.addLog('AI Engine: Top signal is a repeat. Using second-best option.');
                    entryToUse = result.goldenEntries[1];
                }

                if (entryToUse) {
                    this.last_ai_signal_analysis = entryToUse.analysis;

                    this.setManualContractType(entryToUse.contractType);
                    this.setManualBarrier(entryToUse.barrier);
                    this.setManualDuration(entryToUse.duration);
                    this.setEntryDigit(entryToUse.triggerDigits[0]);
                    this.setUseSecondTrigger(false);

                    this.addLog(`SIGNAL (Confirmed): ${entryToUse.analysis}`);
                    this.addLog('✅ UI configured. Ready to run. Waiting for trigger digit.');
                } else if (result.goldenEntries.length > 0) {
                    this.addLog(result.goldenEntries[0].analysis);
                    this.addLog('🤖 AI Engine: No high-confidence signals found after confirmation.');
                } else {
                    this.addLog('🤖 AI Engine: Analysis complete, but no valid signals were found.');
                }
            });
        }, 5000); // 5-second delay
    }


    setSelectedSymbol(symbol: string) {
        if (this.selected_symbol === symbol) return;
        this.selected_symbol = symbol;
        if (this.connection_status === STATUS_LIVE || this.connection_status === STATUS_AUTHORIZED) {
            this.subscribeToTicks(symbol);
        }
    }

    setIsAutoRunning(is_running: boolean) {
        this.is_auto_running = is_running;
        if (is_running) {
            this.active_contracts.clear();
            this.contract_results.clear();
            this.symbol_locks = {};
            this.is_processing_round = false;
            this.differs_barrier_digit = null;
            this.is_differs_recovery_mode = false;
            this.differs_v2_predicted_digit = null;
            this.differs_v2_post_trade_ticks = 0;
            this.rise_fall_trade_count = 0;
        }
        this.is_purchasing = false;
        this.pending_instant_result_check = {};
        this.rebounce_sequences = {};
        this.rise_fall_v2_growth_counters = {};
        this.rise_fall_v2_prev_histogram = {};
    }

    handleStartStop() {
        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!is_logged_in) {
            this.addLog("Error: Please log in to start trading.");
            if (localStorage.getItem('active_loginid')) {
                this.addLog("Attempting to recover session...");
                this.connectWebSocket();
            }
            return;
        }
        this.setIsAutoRunning(!this.is_auto_running);
        if (this.is_auto_running) {
            this.initial_stake = this.stake;
            this.setIsRecoveryActive(false);
            this.differs_v2_post_trade_ticks = 0;
            this.differs_v2_analysis_ready = false;
            
            if (this.is_differs_v2_mode) {
                runInAction(() => {
                    this.differs_predicted_top4 = [];
                    this.differs_v2_predicted_digit = null;
                    this.is_processing_round = false;
                });
                this.addLog("Tool started. Differs V2: Analyzing historical data (7s)...");
                
                setTimeout(() => {
                    if (this.is_auto_running && this.is_differs_v2_mode) {
                        runInAction(() => {
                            this.differs_v2_analysis_ready = true;
                            this.is_processing_round = false;
                        });
                        this.addLog("Differs V2: Analysis complete. Predicting & executing...");
                        this.analyzeAndExecuteDiffersV2();
                    }
                }, 7000);
            } else if (this.is_rise_fall_v2_mode) {
                this.addLog('Rise/Fall V2: Loading all volatilities — scanning MACD histograms (3s)...');
                this.startRiseFallV2VolatilityScan();
            } else {
                this.addLog("Tool started. Waiting for trigger...");
                if (this.is_volatility_changer) this.startVolatilityAnalysis();
            }
        } else {
            this.addLog("Tool stopped by user.");
            this.setIsRecoveryActive(false);
        }
    }

    subscribeToTicks(symbol: string) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
        this.active_subscription_id = null;
        this.addLog('Cleared all previous tick subscriptions.');

        if (this.is_all_vol_mode) {
            this.symbol_data = {};
            for (const sym in pip_sizes) {
                this.addLog(`Subscribing to: ${sym}`);
                this.ws.send(JSON.stringify({ ticks_history: sym, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
                this.symbol_data[sym] = { tick_history: [], last_digit: null, last_last_digit: null, _tick_prices: [] };
            }
        } else {
            this.addLog(`Subscribing to: ${symbol}`);
            this.ws.send(JSON.stringify({ ticks_history: symbol, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
            this.tick_history = [];
            this.last_digit = null;
            this.last_last_digit = null;
            this._tick_prices = [];
        }
    }

    // DISABLED - replaced by DerivAuth.js
    // connectWebSocket() {
    //     if (this.ws && this.ws.readyState === WebSocket.OPEN && this.is_authorized) {
    //         this.addLog('Already connected and authorized.');
    //         return;
    //     }
    //     if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    //     if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    //     this.addLog('Connecting...');
    //     this.connection_status = STATUS_CONNECTING;
    //     this.is_authorized = false;
    //     this.is_authorizing = true;
    //     const app_id = getAppId();
    //     const server_url = getSocketURL();
    //     try {
    //         this.ws = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);
    //         this.ws.onopen = () => {
    //             runInAction(() => { this.connection_status = STATUS_LIVE; });
    //             this.addLog(`Connection opened (App ID: ${app_id}). Requesting authorization...`);
    //             if (window.self !== window.top) {
    //                 window.parent.postMessage({ name: 'request_auth_token' }, '*');
    //             } else {
    //                 try {
    //                     const active_loginid = localStorage.getItem('active_loginid');
    //                     const client_accounts_str = localStorage.getItem('client.accounts');
    //                     if (client_accounts_str && active_loginid) {
    //                         const client_accounts = JSON.parse(client_accounts_str);
    //                         const token = client_accounts[active_loginid]?.token;
    //                         if (token) {
    //                             this.addLog(`Authorizing with token for ${active_loginid}...`);
    //                             this.ws?.send(JSON.stringify({ authorize: token }));
    //                             return;
    //                         }
    //                     }
    //                     const accountsListStr = localStorage.getItem('accountsList');
    //                     if (accountsListStr && active_loginid) {
    //                         const accountsList = JSON.parse(accountsListStr);
    //                         const token = accountsList[active_loginid];
    //                         if (token) {
    //                             this.addLog(`Authorizing with fallback token for ${active_loginid}...`);
    //                             this.ws?.send(JSON.stringify({ authorize: token }));
    //                             return;
    //                         }
    //                     }
    //                     const storeToken = this.root_store.client.getToken?.();
    //                     if (storeToken) {
    //                         this.addLog('Authorizing with store token...');
    //                         this.ws?.send(JSON.stringify({ authorize: storeToken }));
    //                         return;
    //                     }
    //                     this.addLog('No token found in storage. Proceeding with public ticks.');
    //                     runInAction(() => { this.is_authorizing = false; });
    //                     this.subscribeToTicks(this.selected_symbol);
    //                 } catch (e) {
    //                     this.addLog(`Token retrieval error: ${e.message}. Proceeding with public ticks.`);
    //                     runInAction(() => { this.is_authorizing = false; });
    //                     this.subscribeToTicks(this.selected_symbol);
    //                 }
    //             }
    //         };
            // DISABLED - replaced by DerivAuth.js
            // this.ws.onmessage = async (msg) => {
            //     try {
            //         const data = JSON.parse(msg.data);
            //         if (data.subscription?.id) this.active_subscription_id = data.subscription.id;
            //         if (data.error) {
            //             this.addLog(`Error: ${data.error.message}`);
            //             if (data.msg_type === 'buy') {
            //                  const symbol = data.echo_req.symbol;
            //                  if(symbol) this.symbol_locks[symbol] = false;
            //                  this.is_purchasing = false;
            //             }
            //         }
            //         switch (data.msg_type) {
            //     case 'history':
            //         if (this.is_all_vol_mode) {
            //             const symbol = data.echo_req.ticks_history;
            //             if (!this.symbol_data[symbol]) {
            //                 this.symbol_data[symbol] = { tick_history: [], last_digit: null, last_last_digit: null, _tick_prices: [] };
            //             }
            //             ... (onmessage, onclose, onerror handlers) ...
            //         }
            //         break;
            //     case 'authorize':
            //     case 'buy':
            //     case 'proposal_open_contract':
            //     case 'tick':
            // }
            // } catch (error) { this.addLog(`Message parse error: ${error.message}`); }
            // };
            // this.ws.onclose = () => {
            //     this.addLog(`Connection closed. Reconnecting...`);
            //     this.connection_status = STATUS_OFFLINE;
            //     this.is_authorizing = false;
            //     this.is_authorized = false;
            //     this.reconnectTimeout = setTimeout(() => this.connectWebSocket(), 5000);
            // };
            // this.ws.onerror = (e) => this.addLog(`Connection Error: ${e.type}`);
        // } catch (e) { this.addLog(`Connection failed to initialize: ${e.message}`); this.is_authorizing = false; }
    // }

    handleOverUnderLogic(symbol_data?: any) {
        const data = symbol_data || this;
        const symbol = this.is_all_vol_mode && symbol_data ? Object.keys(this.symbol_data).find(key => this.symbol_data[key] === data) : this.selected_symbol;
    
        if (!symbol) return;

        // When manual + recovery is armed, ONLY the recovery_symbol may
        // trade. The dedicated immediate-recovery branch in the tick handler
        // takes care of firing it; we suppress all other manual triggers
        // here so we never start parallel trades on different volatilities.
        if (this.is_manual_mode && this.is_recovery_active) {
            return;
        }

        if (!this.is_trigger_enabled) {
            if (this.is_manual_mode) {
                this.addLog(`Trigger: Manual ${this.manual_contract_type} ${this.manual_barrier} on ${symbol} (No trigger digit)`);
                this.executeTrade(this.manual_contract_type, this.manual_barrier, symbol, undefined, false, this.manual_duration);
            } else if (this.is_differs_mode || this.is_differs_v2_mode) {
                const barrier = String(data.last_digit);
                this.addLog(`Trigger: Differs on ${barrier} for ${symbol} (No trigger digit)`);
                this.executeTrade('DIGITDIFF', barrier, symbol);
            } else {
                this.addLog(`Trigger: O5/U4 on ${symbol} (No trigger digit)`);
                this.executeMultiTrade(symbol);
            }
            return;
        }

        if (this.is_rebounce_active && this.use_second_trigger) {
            if (this.rebounce_sequences[symbol]) {
                if (data.last_digit === 4 || data.last_digit === 5) {
                    this.addLog(`Rebounce: Condition met on ${symbol}. Executing trade.`);
                    this.executeMultiTrade(symbol);
                } else {
                    this.addLog(`Rebounce: Resetting on ${symbol}. Last digit was ${data.last_digit}.`);
                }
                this.rebounce_sequences[symbol] = false;
            } else {
                const is_triggered = data.last_digit === this.entry_digit && data.last_last_digit === this.second_entry_digit;
                if (is_triggered) {
                    this.addLog(`Rebounce: Initial trigger detected on ${symbol}. Waiting for 4 or 5.`);
                    this.rebounce_sequences[symbol] = true;
                }
            }
        } else {
            // The main trigger logic. It now considers whether we are using one or two triggers.
            const is_triggered = this.use_second_trigger ? (data.last_digit === this.entry_digit && data.last_last_digit === this.second_entry_digit) : (data.last_digit === this.entry_digit);
            if (is_triggered) {
                if (this.is_manual_mode) {
                    this.addLog(`Trigger: Manual ${this.manual_contract_type} ${this.manual_barrier} on ${symbol}`);
                    this.executeTrade(this.manual_contract_type, this.manual_barrier, symbol, undefined, false, this.manual_duration);
                } else if (this.is_differs_mode || this.is_differs_v2_mode) {
                    const barrier = String(data.last_digit);
                    this.addLog(`Trigger: Differs on ${barrier} for ${symbol}`);
                    this.executeTrade('DIGITDIFF', barrier, symbol);
                } else {
                    this.addLog(`Trigger: O5/U4 on ${symbol}`);
                    this.executeMultiTrade(symbol);
                }
            }
        }
    }
    

    calculateEMA(prices: number[], period: number): number[] {
        if (prices.length < period) return [];
        const k = 2 / (period + 1);
        const result: number[] = [];
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
        result.push(ema);
        for (let i = period; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }

    analyzeAndExecuteRiseFall() {
        if (this._tick_prices.length < 300 || this.symbol_locks[this.selected_symbol]) return;

        const fast_ema = this.calculateEMA(this._tick_prices, 12);
        const slow_ema = this.calculateEMA(this._tick_prices, 26);

        const macd_length = slow_ema.length;
        const fast_offset = fast_ema.length - macd_length;
        const macd_line: number[] = [];
        for (let i = 0; i < macd_length; i++) {
            macd_line.push(fast_ema[fast_offset + i] - slow_ema[i]);
        }

        const signal_line = this.calculateEMA(macd_line, 9);
        if (signal_line.length < 2) return;

        const mc = macd_line[macd_line.length - 1];
        const mp = macd_line[macd_line.length - 2];
        const sc = signal_line[signal_line.length - 1];
        const sp = signal_line[signal_line.length - 2];

        // Reject crosses where the two lines were already hugging each other
        // before the crossover. We require the gap on the bar BEFORE the
        // cross to be at least 25 % of the average absolute histogram value
        // over the previous 5 bars — this guarantees the lines were
        // meaningfully apart and the cross is a genuine reversal, not a
        // tiny wobble of two near-identical lines.
        const sig_len = signal_line.length;
        const lookback = Math.min(5, sig_len - 1);
        let avg_abs_gap = 0;
        if (lookback > 0) {
            let total = 0;
            for (let i = 1; i <= lookback; i++) {
                const m_i = macd_line[macd_line.length - i];
                const s_i = signal_line[sig_len - i];
                total += Math.abs(m_i - s_i);
            }
            avg_abs_gap = total / lookback;
        }
        const prev_gap = Math.abs(mp - sp);
        const min_gap = avg_abs_gap * 0.25;
        const has_clear_separation = prev_gap >= min_gap;

        if (mp > sp && mc < sc && mc > 0 && sc > 0) {
            if (!has_clear_separation) {
                this.addLog(`Rise/Fall: SKIP cross — lines were too close before crossing (gap ${prev_gap.toFixed(6)} < min ${min_gap.toFixed(6)}).`);
                return;
            }
            this.addLog(`Rise/Fall: MACD crossed BELOW signal ABOVE zero (mc=${mc.toFixed(6)}, sc=${sc.toFixed(6)}, prev gap=${prev_gap.toFixed(6)}). FALL!`);
            this.executeRiseFallTrade('PUT');
        } else if (mp < sp && mc > sc && mc < 0 && sc < 0) {
            if (!has_clear_separation) {
                this.addLog(`Rise/Fall: SKIP cross — lines were too close before crossing (gap ${prev_gap.toFixed(6)} < min ${min_gap.toFixed(6)}).`);
                return;
            }
            this.addLog(`Rise/Fall: MACD crossed ABOVE signal BELOW zero (mc=${mc.toFixed(6)}, sc=${sc.toFixed(6)}, prev gap=${prev_gap.toFixed(6)}). RISE!`);
            this.executeRiseFallTrade('CALL');
        }
    }

    executeRiseFallTrade(contract_type: 'CALL' | 'PUT') {
        const symbol = this.selected_symbol;
        if (this.symbol_locks[symbol]) return;
        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) return;
        this.symbol_locks[symbol] = true;
        const tradeAmount = Number(this.stake);
        this.addLog(`Rise/Fall Trade: ${contract_type === 'CALL' ? 'RISE' : 'FALL'} @ $${tradeAmount}`);
        this.ws.send(JSON.stringify({
            buy: 1,
            price: tradeAmount,
            parameters: {
                amount: tradeAmount,
                basis: 'stake',
                currency: 'USD',
                duration: 1,
                duration_unit: 't',
                symbol: symbol,
                contract_type,
            },
        }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RISE / FALL V2  —  MACD Histogram momentum strategy
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * On startup: fetch tick history for every volatility in parallel,
     * compute each one's MACD (12,26,9) histogram, and after 3 seconds
     * select the symbol whose latest histogram bar has the greatest
     * absolute magnitude (longest bar = most momentum).
     */
    startRiseFallV2VolatilityScan() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.addLog('Rise/Fall V2: WebSocket not ready — retrying in 500ms...');
            setTimeout(() => {
                if (this.is_auto_running && this.is_rise_fall_v2_mode) this.startRiseFallV2VolatilityScan();
            }, 500);
            return;
        }

        const symbols = Object.keys(pip_sizes);
        const scores: Map<string, number> = new Map();
        let received = 0;

        // Temporary one-shot message handler that collects history responses
        // for the scan without interfering with the live tick subscription.
        const scanHandler = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data);
                if (data.msg_type !== 'history' || data.echo_req?.subscribe === 1) return;
                const sym: string = data.echo_req.ticks_history;
                if (!symbols.includes(sym)) return;

                const rawPrices: number[] = data.history.prices.map((p: string | number) => Number(p));
                if (rawPrices.length >= 35) {
                    const histogram = this.calcMACDHistogram(rawPrices);
                    if (histogram.length > 0) {
                        const lastBar = histogram[histogram.length - 1];
                        scores.set(sym, Math.abs(lastBar));
                    }
                }

                received++;
                if (received >= symbols.length) {
                    this.ws?.removeEventListener('message', scanHandler);
                }
            } catch (_) { /* ignore parse errors */ }
        };

        this.ws.addEventListener('message', scanHandler);

        // Request tick history for all symbols (no subscribe flag — one-shot)
        symbols.forEach(sym => {
            this.ws!.send(JSON.stringify({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' }));
        });

        // After 3 seconds, pick the winner and start trading
        setTimeout(() => {
            this.ws?.removeEventListener('message', scanHandler);

            if (!this.is_auto_running || !this.is_rise_fall_v2_mode) return;

            if (scores.size === 0) {
                this.addLog('Rise/Fall V2: No MACD data available — defaulting to R_100.');
                this.setSelectedSymbol('R_100');
            } else {
                let bestSym = '';
                let bestScore = -Infinity;
                scores.forEach((score, sym) => {
                    const pct = ((score / [...scores.values()].reduce((a, b) => a + b, 0)) * 100);
                    this.addLog(`Rise/Fall V2 scan — ${sym}: histogram magnitude ${score.toExponential(3)} (${pct.toFixed(1)}%)`);
                    if (score > bestScore) { bestScore = score; bestSym = sym; }
                });
                this.addLog(`Rise/Fall V2: Selected ${bestSym} — strongest MACD histogram bar. Waiting for entry signal...`);
                this.setSelectedSymbol(bestSym);
            }

            // Reset growth counters for the chosen symbol
            this.rise_fall_v2_growth_counters = {};
            this.rise_fall_v2_prev_histogram = {};
        }, 3000);
    }

    /**
     * Helper: compute MACD (12,26,9) histogram array from raw price series.
     */
    calcMACDHistogram(prices: number[]): number[] {
        if (prices.length < 35) return [];
        const ema12 = this.calculateEMA(prices, 12);
        const ema26 = this.calculateEMA(prices, 26);
        // Align: ema26 is shorter; offset ema12 to match
        const offset = ema12.length - ema26.length;
        const macdLine: number[] = ema26.map((v, i) => ema12[offset + i] - v);
        const signal = this.calculateEMA(macdLine, 9);
        const sigOffset = macdLine.length - signal.length;
        return signal.map((s, i) => macdLine[sigOffset + i] - s);
    }

    /**
     * Called on every tick when Rise/Fall V2 is active.
     * Tracks 5 consecutive growing histogram bars and fires a trade on the 5th (with 1-bar crossover delay).
     */
    analyzeAndExecuteRiseFallV2(target_symbol?: string) {
        const symbol = target_symbol || this.selected_symbol;
        if (this.symbol_locks[symbol]) return;
        
        const prices = target_symbol ? this.symbol_data[target_symbol]?._tick_prices : this._tick_prices;
        if (!prices || prices.length < 35) return;

        const histogram = this.calcMACDHistogram(prices);
        if (histogram.length < 2) return;

        const currentBar = histogram[histogram.length - 1];
        const prevBar = this.rise_fall_v2_prev_histogram[symbol];

        // Store current bar for next tick comparison
        this.rise_fall_v2_prev_histogram[symbol] = currentBar;

        // Initialise counter if needed
        if (this.rise_fall_v2_growth_counters[symbol] === undefined) {
            this.rise_fall_v2_growth_counters[symbol] = 0;
        }

        if (prevBar === undefined) {
            // First tick — nothing to compare yet
            return;
        }

        const isAboveZero = currentBar > 0;
        const isBelowZero = currentBar < 0;

        // ── FALL (Overbought Reversion) ──────────────────────────────
        // Histogram above 0 and growing upward (0.1 → 0.2 → 0.3 → 0.4)
        // Momentum exhaustion: expect reversal DOWN → place FALL
        if (isAboveZero && currentBar > prevBar) {
            // Growth sequence is valid only if we were already above 0 last tick
            if (prevBar > 0) {
                this.rise_fall_v2_growth_counters[symbol]++;
                this.addLog(`Rise/Fall V2 [${symbol}]: FALL growth ${this.rise_fall_v2_growth_counters[symbol]}/5 (hist=${currentBar.toExponential(3)})`);
                if (this.rise_fall_v2_growth_counters[symbol] >= 5) {
                    this.addLog(`Rise/Fall V2 [${symbol}]: 5 consecutive FALL growth bars detected. Placing FALL contract (overbought exhaustion).`);
                    this.rise_fall_v2_growth_counters[symbol] = 0;
                    this.executeRiseFallV2Trade('PUT', symbol);
                }
            } else {
                // Crossed zero — wait for next bar to start counting
                this.rise_fall_v2_growth_counters[symbol] = 0;
            }
        // ── RISE (Oversold Reversion) ──────────────────────────────
        // Histogram below 0 and growing downward (-0.1 → -0.2 → -0.3 → -0.4)
        // Momentum exhaustion: expect reversal UP → place RISE
        } else if (isBelowZero && currentBar < prevBar) {
            // Growth sequence is valid only if we were already below 0 last tick
            if (prevBar < 0) {
                this.rise_fall_v2_growth_counters[symbol]++;
                this.addLog(`Rise/Fall V2 [${symbol}]: RISE growth ${this.rise_fall_v2_growth_counters[symbol]}/5 (hist=${currentBar.toExponential(3)})`);
                if (this.rise_fall_v2_growth_counters[symbol] >= 5) {
                    this.addLog(`Rise/Fall V2 [${symbol}]: 5 consecutive RISE growth bars detected. Placing RISE contract (oversold exhaustion).`);
                    this.rise_fall_v2_growth_counters[symbol] = 0;
                    this.executeRiseFallV2Trade('CALL', symbol);
                }
            } else {
                // Crossed zero — wait for next bar to start counting
                this.rise_fall_v2_growth_counters[symbol] = 0;
            }
        } else {
            // Growth sequence broke — reset counter
            if (this.rise_fall_v2_growth_counters[symbol] > 0) {
                this.addLog(`Rise/Fall V2 [${symbol}]: Growth sequence broken. Counter reset.`);
            }
            this.rise_fall_v2_growth_counters[symbol] = 0;
        }
    }

    executeRiseFallV2Trade(contract_type: 'CALL' | 'PUT', symbol: string) {
        if (this.symbol_locks[symbol]) return;
        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) return;
        this.symbol_locks[symbol] = true;
        const tradeAmount = Number(this.stake.toFixed(2));
        const rfv2Duration = this.rise_fall_v2_duration || 1;
        this.addLog(`Rise/Fall V2 Trade: ${contract_type === 'CALL' ? 'RISE' : 'FALL'} @ $${tradeAmount} on ${symbol} (${rfv2Duration} tick${rfv2Duration > 1 ? 's' : ''})`);
        this.ws.send(JSON.stringify({
            buy: 1,
            price: tradeAmount,
            parameters: {
                amount: tradeAmount,
                basis: 'stake',
                currency: 'USD',
                duration: rfv2Duration,
                duration_unit: 't',
                symbol,
                contract_type,
            },
        }));
    }

    analyzeAndExecuteDiffers(symbol?: string) {
        const current_symbol = symbol || this.selected_symbol;
        const data = this.is_all_vol_mode ? this.symbol_data[current_symbol] : this;
    
        if (!data || data.tick_history.length < 36 || this.symbol_locks[current_symbol]) return;

        if (this.is_trigger_enabled && !this.is_differs_mode && !this.is_differs_v2_mode) {
            this.handleOverUnderLogic(data);
            return;
        }
    
        const digits = data.tick_history;
        const n = digits.length;
        const curr_digit = digits[n - 1];
        const prev_digit = digits[n - 2];
    
        if (curr_digit === prev_digit) return;
    
        const curr_direction: 'up' | 'down' = curr_digit > prev_digit ? 'up' : 'down';
        const surge_direction: 'up' | 'down' = curr_direction === 'up' ? 'down' : 'up';
    
        let surge_count = 0;
        for (let i = n - 2; i >= 1; i--) {
            if (digits[i] === digits[i - 1]) break;
            const tick_dir: 'up' | 'down' = digits[i] > digits[i - 1] ? 'up' : 'down';
            if (tick_dir === surge_direction) {
                surge_count++;
            } else {
                break;
            }
        }
    
        if (surge_count >= 2) {
            const rejection_digit = data.last_digit;
            const history = data.tick_history.slice(-1000);
            const totalTicks = history.length;
            const digitCounts = Array(10).fill(0) as number[];
            history.forEach(d => { if (d >= 0 && d <= 9) digitCounts[d]++; });
    
            const digitCount = digitCounts[rejection_digit!];
            const digitPct = totalTicks > 0 ? (digitCount / totalTicks) * 100 : 0;
    
            const reasons_to_skip: string[] = [];
    
            if (digitPct >= 9.8) {
                reasons_to_skip.push(`too frequent (${digitPct.toFixed(1)}%)`);
            }
    
            const minCount = Math.min(...digitCounts.filter(c => c > 0));
            const maxCount = Math.max(...digitCounts);
            if (digitCount === minCount || digitCount === maxCount) {
                reasons_to_skip.push('is most or least frequent');
            }
    
            const getPct = (digit: number, hist: number[]) => {
                if (hist.length === 0) return 0;
                const count = hist.filter(d => d === digit).length;
                return (count / hist.length) * 100;
            };
            const old_history = data.tick_history.slice(0, -35);
            const new_history = data.tick_history;
            const oldPct = getPct(rejection_digit!, old_history);
            const newPct = getPct(rejection_digit!, new_history);
            const increase = newPct - oldPct;
            if (increase > 0.5) {
                reasons_to_skip.push(`rapidly increasing (+${increase.toFixed(2)}%)`);
            }
    
            const last10 = history.slice(-10);
            const recentCount = last10.filter(d => d === rejection_digit).length;
            if (recentCount > 3) {
                reasons_to_skip.push(`appeared ${recentCount}x in last 10 ticks`);
            }
    
            const predictionInput = data.tick_history.slice(-200);
            const prediction = predictNextDigits(predictionInput);
            runInAction(() => { this.differs_predicted_top4 = prediction.top4Digits; });
            this.addLog(`Prediction Engine on ${current_symbol}: ${prediction.summary}`);
    
            if (prediction.top4Digits.includes(rejection_digit!)) {
                reasons_to_skip.push('flagged by prediction engine');
            }
    
            if (reasons_to_skip.length > 0) {
                this.addLog(`Differs: SKIP digit ${rejection_digit} on ${current_symbol} — ${reasons_to_skip.join(', ')}. Re-analyzing...`);
                return;
            }
    
            this.differs_barrier_digit = rejection_digit;
            this.addLog(`Differs: PATTERN! ${surge_count}x ${surge_direction} surge → ${curr_direction} reversal. Digit ${rejection_digit} on ${current_symbol}. DIFFER!`);
            this.executeTrade('DIGITDIFF', String(rejection_digit), current_symbol);
        } else {
            this.addLog(`Differs on ${current_symbol}: Watching... ${surge_count}x ${surge_direction} (need 2+ consecutive)`);
        }
    }

    executeDiffersV2Trade(contract_type: string, barrier: string, symbol: string, stake: number) {
        this.pending_instant_result_check[symbol] = { barrier, stake, contract_type, ticks_to_check: 2 };
        this.executeTrade(contract_type, barrier, symbol, stake);
    }
    
    analyzeAndExecuteDiffersV2(symbol?: string) {
        const current_symbol = symbol || this.selected_symbol;
        const data = this.is_all_vol_mode ? this.symbol_data[current_symbol] : this;

        if (this.pending_instant_result_check[current_symbol]) return;

        if (!data || data.tick_history.length < 4 || this.symbol_locks[current_symbol]) return;

        if (this.is_trigger_enabled && !this.is_differs_mode && !this.is_differs_v2_mode) {
            this.handleOverUnderLogic(data);
            return;
        }

        const history = data.tick_history;
        const lastTick = data.last_digit;
        const n = history.length;

        let trigger_condition = false;
        let trigger_name = 'double';

        if (this.is_nne_kwisha_mode) {
            trigger_name = 'quad';
            if (n >= 4 && lastTick === history[n - 2] && lastTick === history[n - 3] && lastTick === history[n - 4]) {
                trigger_condition = true;
            }
        } else if (this.is_tatu_bora_mode) {
            trigger_name = 'triple';
            if (n >= 3 && lastTick === history[n - 2] && lastTick === history[n - 3]) {
                trigger_condition = true;
            }
        } else {
            if (n >= 2 && lastTick === history[n - 2]) {
                trigger_condition = true;
            }
        }

        if (trigger_condition) {
            const barrier_digit = lastTick;
            let should_execute = true;

            if (!this.is_nne_kwisha_mode) {
                const history_1000 = data.tick_history.slice(-1000);
                const totalTicks = history_1000.length;
                const digitCounts = Array(10).fill(0);
                history_1000.forEach(d => { if (d >= 0 && d <= 9) digitCounts[d]++; });

                const digitCount = digitCounts[barrier_digit!];
                const digitPct = totalTicks > 0 ? (digitCount / totalTicks) * 100 : 0;

                const reasons_to_skip: string[] = [];

                if (barrier_digit === 0 || barrier_digit === 9) {
                    reasons_to_skip.push('digit is 0 or 9');
                }

                if (digitPct >= 10.3) {
                    reasons_to_skip.push(`too frequent (${digitPct.toFixed(1)}%)`);
                }

                const minCount = Math.min(...digitCounts.filter(c => c > 0));
                const maxCount = Math.max(...digitCounts);
                if (digitCount === minCount || digitCount === maxCount) {
                    reasons_to_skip.push('is most or least frequent');
                }

                const getPct = (digit: number, hist: number[]) => {
                    if (hist.length === 0) return 0;
                    const count = hist.filter(d => d === digit).length;
                    return (count / hist.length) * 100;
                };
                const old_history = data.tick_history.slice(0, -27);
                const new_history = data.tick_history;
                const oldPct = getPct(barrier_digit!, old_history);
                const newPct = getPct(barrier_digit!, new_history);
                const increase = newPct - oldPct;
                if (increase > 0.4) {
                    reasons_to_skip.push(`rapidly increasing (+${increase.toFixed(2)}%)`);
                }

                if (reasons_to_skip.length > 0) {
                    this.addLog(`DiffersV2: SKIP digit ${barrier_digit} on ${current_symbol} — ${reasons_to_skip.join(', ')}. Re-analyzing...`);
                    should_execute = false;
                }
            }

            if (should_execute) {
                runInAction(() => {
                    this.differs_v2_predicted_digit = lastTick;
                    this.differs_predicted_top4 = [lastTick!];
                });

                this.addLog(`DiffersV2: ${trigger_name} ${lastTick} detected on ${current_symbol} → DIFFER on ${lastTick}`);
                this.executeDiffersV2Trade('DIGITDIFF', String(lastTick), current_symbol, Number(this.stake.toFixed(2)));
            }
        } else {
            const sequence_length = this.is_nne_kwisha_mode ? 4 : (this.is_tatu_bora_mode ? 3 : 2);
            const sequence = history.slice(-sequence_length).join(',');
            const current_trigger_name = this.is_nne_kwisha_mode ? 'quad' : (this.is_tatu_bora_mode ? 'triple' : 'double');
            this.addLog(`DiffersV2 on ${current_symbol}: Waiting for ${current_trigger_name}... Last: ${sequence}`);
        }
    }

    processRoundResults() {
        this.is_processing_round = true;
        const roundProfit = Array.from(this.contract_results.values()).reduce((sum, p) => sum + p.profit, 0);
        const all_loss = Array.from(this.contract_results.values()).every(p => p.profit < 0);
        
        this.addLog(`Round finished. Profit: ${roundProfit.toFixed(2)}, All lost: ${all_loss}`);

        if (this.is_differs_v2_mode) {
            if (this.is_tatu_bora_mode) {
                if (all_loss) {
                    this.stake = this.initial_stake;
                    this.addLog(`Tatu Bora: Loss! Stake reset to initial: ${this.stake.toFixed(2)}`);
                } else {
                    if (this.is_2term_mode) {
                        const nextStake = Number((this.stake + roundProfit).toFixed(2));
                        this.stake = nextStake;
                        this.addLog(`Tatu Bora: Win! 2-term ON - New Stake: ${this.stake.toFixed(2)}`);
                    } else {
                        this.stake = this.initial_stake;
                        this.addLog(`Tatu Bora: Win! Stake reset to initial: ${this.stake.toFixed(2)}`);
                    }
                }
            } else {
                if (all_loss) {
                    this.stake = Number((this.stake * this.martingale).toFixed(2));
                    this.addLog(`DiffersV2: Loss! Martingale - Stake: ${this.stake.toFixed(2)}`);
                } else {
                    if (this.is_2term_mode) {
                        const nextStake = Number((this.stake + roundProfit).toFixed(2));
                        this.stake = nextStake;
                        this.addLog(`DiffersV2: Win! 2-term ON - Stake: ${this.stake.toFixed(2)}`);
                    } else {
                        this.stake = this.initial_stake;
                        this.addLog(`DiffersV2: Win! Stake reset: ${this.stake.toFixed(2)}`);
                    }
                }
            }
    
            runInAction(() => {
                this.differs_predicted_top4 = [];
                this.differs_v2_predicted_digit = null;
                this.is_processing_round = false;
            });
            
            this.contract_results.clear();
    
            if (!this.is_turbo) {
                this.setIsAutoRunning(false);
                this.addLog('DiffersV2: Turbo Mode is off. Stopping auto-run.');
                return;
            }
            
            if (this.is_volatility_changer && this.is_automate) {
                this.startVolatilityAnalysis();
            } else {
                this.addLog(`DiffersV2: Looking for next trigger...`);
            }
            return;
        }

        if (this.is_rise_fall_mode) {
            if (all_loss) {
                this.stake = Number((this.stake * this.martingale).toFixed(2));
                this.addLog(`Rise/Fall: Loss. Martingale stake: ${this.stake}`);
            } else {
                this.stake = this.initial_stake;
                this.addLog(`Rise/Fall: Win. Stake reset to: ${this.stake}`);
            }
            this.contract_results.clear();
            this.is_processing_round = false;

            this.rise_fall_trade_count += 1;
            const was_win = !all_loss;
            if (this.is_volatility_changer && this.rise_fall_trade_count >= 3 && was_win) {
                this.rise_fall_trade_count = 0;
                this.addLog('Rise/Fall: 3 trades reached on a WIN — re-voting best volatility...');
                this.startVolatilityAnalysis();
            } else if (this.is_volatility_changer && this.rise_fall_trade_count >= 3 && !was_win) {
                this.addLog(`Rise/Fall: 3 trades reached but last was a LOSS. Holding re-analysis until next WIN.`);
            } else if (this.is_volatility_changer) {
                this.addLog(`Rise/Fall: Trade ${this.rise_fall_trade_count}/3 since last vote. Monitoring MACD...`);
            } else {
                this.addLog('Rise/Fall: Monitoring MACD for next signal...');
            }
            return;
        }

        if (this.is_rise_fall_v2_mode) {
            if (all_loss) {
                this.stake = Number((this.stake * this.martingale).toFixed(2));
                this.addLog(`Rise/Fall V2: Loss. Martingale stake → ${this.stake}`);
            } else {
                this.stake = this.initial_stake;
                this.addLog(`Rise/Fall V2: Win. Stake reset to ${this.stake}`);
            }
            this.contract_results.clear();
            this.is_processing_round = false;
            // Reset growth counter so we don't re-enter on the same move
            this.rise_fall_v2_growth_counters[this.selected_symbol] = 0;
            this.rise_fall_v2_prev_histogram[this.selected_symbol] = undefined as any;
            // Auto Switch Volatility: re-scan all volatilities after every WIN
            // to find the best momentum index before resuming signal detection.
            if (!all_loss && this.is_volatility_changer) {
                this.addLog('Rise/Fall V2: WIN detected — auto-scanning all volatilities for best momentum...');
                this.startRiseFallV2VolatilityScan();
            } else {
                this.addLog('Rise/Fall V2: Monitoring MACD histogram for next entry signal...');
            }
            return;
        }
        
        if (all_loss) {
                if (this.is_recovery_enabled) {
                    this.is_recovery_active = true;
                    // Remember the symbol the loss happened on so recovery
                    // executes on the next tick of THAT same volatility,
                    // even when All Vol mode is on.
                    const loss_entry = Array.from(this.contract_results.values()).find(r => r.profit < 0);
                    this.recovery_symbol = loss_entry ? loss_entry.symbol : this.selected_symbol;
                    this.addLog(`Loss detected on ${this.recovery_symbol}. Recovery System ACTIVATED — will fire on next tick.`);
                } else {
                    this.addLog(`Loss detected. Standard recovery disabled for this mode.`);
                }

                if (this.is_2term_mode) {
                    const nextStake = Number((this.stake + roundProfit).toFixed(2));
                    this.stake = nextStake > 0 ? nextStake : this.initial_stake;
                    this.addLog(`2term Applied on Loss: New stake: ${this.stake}`);
                } else {
                     this.stake = Number((this.stake * this.martingale).toFixed(2));
                     this.addLog(`Standard Martingale on Loss: New stake: ${this.stake}`);
                }
                if (this.is_volatility_changer && this.is_automate) this.startVolatilityAnalysis();
        } else {
                if (this.is_recovery_active) {
                    this.is_recovery_active = false;
                    this.recovery_symbol = null;
                    this.addLog(`Win detected. Recovery System DEACTIVATED.`);
                }
                
                if (this.is_2term_mode) {
                    const nextStake = Number((this.stake + roundProfit).toFixed(2));
                    this.addLog(`2term Applied on Win: Stake updated with profit ${roundProfit.toFixed(2)}. New stake: ${nextStake}`);
                    this.stake = nextStake;
                } else {
                    this.stake = this.initial_stake;
                    this.addLog(`Win detected. Stake reset to initial: ${this.stake}`);
                }
                if (this.is_volatility_changer) this.startVolatilityAnalysis();
        }
        
        this.contract_results.clear();
        this.is_processing_round = false;
        if (!this.is_turbo) {
            this.setIsAutoRunning(false);
            this.addLog('Turbo Mode is off. Stopping auto-run.');
        } else { this.addLog("Waiting for next trigger..."); }
    }

    executeTrade(contract_type: string, barrier: string, symbol?: string, stake?: number, is_fast_recovery = false, duration?: number) {
        const tradeSymbol = symbol || this.selected_symbol;

        if (!is_fast_recovery && this.symbol_locks[tradeSymbol]) {
            return;
        }

        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) {
            return;
        }
        
        if (!is_fast_recovery) {
             this.is_purchasing = true;
        }

        this.symbol_locks[tradeSymbol] = true;
        this._armPurchaseTimeout(tradeSymbol);
        
        const tradeAmount = stake ?? Number(this.stake.toFixed(2));
        const tradeDuration = duration || (this.is_manual_mode ? this.manual_duration : 1);
        this.addLog(`Trade: ${is_fast_recovery ? '⚡Fast Recovery' : ''} ${contract_type} ${barrier} on ${tradeSymbol} @ ${tradeAmount}`);
        this.ws.send(JSON.stringify({ buy: 1, price: tradeAmount, parameters: { amount: tradeAmount, basis: 'stake', currency: 'USD', duration: tradeDuration, duration_unit: 't', symbol: tradeSymbol, contract_type, barrier } }));
    }

    executeMultiTrade(symbol?: string) {
        const tradeSymbol = symbol || this.selected_symbol;
        const data = this.is_all_vol_mode ? this.symbol_data[tradeSymbol] : this;

        if (this.symbol_locks[tradeSymbol]) return;

        if (this.is_digit_occurrence_filter_active) {
            const history_100 = data.tick_history.slice(-100);
            if (history_100.length > 0) {
                const losing_digits_count = history_100.filter(d => d === 4 || d === 5).length;
                const occurrence_percentage = (losing_digits_count / history_100.length) * 100;
                if (occurrence_percentage > 25) {
                    this.addLog(`Trade on ${tradeSymbol} skipped. Losing digits (4,5) occurred ${occurrence_percentage.toFixed(1)}% in last 100 ticks.`);
                    return;
                }
            }

            const history_1000 = data.tick_history;
            if (history_1000.length > 0) {
                const count4 = history_1000.filter(d => d === 4).length;
                const count5 = history_1000.filter(d => d === 5).length;
                const pct4 = (count4 / history_1000.length) * 100;
                const pct5 = (count5 / history_1000.length) * 100;

                if (pct4 > 10.2) {
                    this.addLog(`Trade on ${tradeSymbol} skipped. Digit 4 is too frequent (${pct4.toFixed(1)}% in last 1000 ticks).`);
                    return;
                }
                if (pct5 > 10.2) {
                    this.addLog(`Trade on ${tradeSymbol} skipped. Digit 5 is too frequent (${pct5.toFixed(1)}% in last 1000 ticks).`);
                    return;
                }
            }

            const getPct = (digit: number, hist: number[]) => {
                if (hist.length === 0) return 0;
                const count = hist.filter(d => d === digit).length;
                return (count / hist.length) * 100;
            };
            const old_history = data.tick_history.slice(0, -35);
            const new_history = data.tick_history;

            const oldPct4 = getPct(4, old_history);
            const newPct4 = getPct(4, new_history);
            const increase4 = newPct4 - oldPct4;

            if (increase4 > 0.5) {
                this.addLog(`Trade on ${tradeSymbol} skipped. Digit 4 is rapidly increasing (+${increase4.toFixed(2)}%).`);
                return;
            }

            const oldPct5 = getPct(5, old_history);
            const newPct5 = getPct(5, new_history);
            const increase5 = newPct5 - oldPct5;

            if (increase5 > 0.5) {
                this.addLog(`Trade on ${tradeSymbol} skipped. Digit 5 is rapidly increasing (+${increase5.toFixed(2)}%).`);
                return;
            }
        }

        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) return;
        
        this.is_purchasing = true;
        this.symbol_locks[tradeSymbol] = true;
        this._armPurchaseTimeout(tradeSymbol);
        
        const tradeAmount = Number(this.stake.toFixed(2));
        this.addLog(`Trade: O5/U4 on ${tradeSymbol} @ ${tradeAmount}`);
        
        const baseParams = { amount: tradeAmount, basis: 'stake', currency: 'USD', duration: 1, duration_unit: 't', symbol: tradeSymbol };
        this.ws.send(JSON.stringify({ buy: 1, price: tradeAmount, parameters: { ...baseParams, contract_type: 'DIGITOVER', barrier: '5' } }));
        this.ws.send(JSON.stringify({ buy: 1, price: tradeAmount, parameters: { ...baseParams, contract_type: 'DIGITUNDER', barrier: '4' } }));
    }

    dispose() {
        // If the bot is actively running, keep everything alive so it continues in the background.
        if (this.is_auto_running) { this.addLog('Tab switched. Bot continuing in background...'); return; }

        // Close the WebSocket and cancel any pending reconnect.
        if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
        if (this.reconnectTimeout) { clearTimeout(this.reconnectTimeout); this.reconnectTimeout = null; }

        // IMPORTANT: Reset connection_status to 'Offline' so that when the component
        // re-mounts (navigating back to this tab) the useEffect guard correctly
        // triggers connectWebSocket() again.
        runInAction(() => {
            this.connection_status = STATUS_OFFLINE;
            this.is_authorized = false;
            this.is_authorizing = false;
        });

        // NOTE: Do NOT dispose _loginReaction, _accountReaction, or remove
        // _boundAuthHandler here. This store is a singleton (created once in
        // RootStore and shared for the entire app session). Those listeners must
        // remain alive across tab navigations so that login/account-switch events
        // are still handled correctly after the component re-mounts.
        // They are only truly cleaned up if the entire app is torn down.
    }
}
