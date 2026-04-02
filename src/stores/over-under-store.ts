
import { action, makeObservable, observable, reaction, runInAction } from 'mobx';
import { TStores } from '@/types/stores.types';
import RootStore from './root-store';
import { getAppId, getSocketURL } from '@/components/shared';
import { MessageTypes } from '@/external/bot-skeleton';
import { predictNextDigits } from '@/utils/differs-prediction-engine';

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
    is_automate = false;
    use_second_trigger = true;
    is_manual_mode = false;
    manual_contract_type = 'DIGITOVER';
    manual_barrier = '5';
    is_recovery_active = false;
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

    is_analyzing_volatility = false;
    analysis_queue: string[] = [];
    best_score = Infinity;
    best_symbol: string | null = null;
    current_analyzing_symbol: string | null = null;

    symbol_data: { [key: string]: { tick_history: number[], last_digit: number | null, last_last_digit: number | null, _tick_prices: number[] } } = {};

    private symbol_locks: { [key: string]: boolean } = {};
    private is_processing_round = false;
    private is_purchasing = false;
    private pending_instant_result_check: { [symbol: string]: { barrier: string, stake: number, contract_type: string } } = {};

    // New feature flags
    is_digit_occurrence_filter_active = false;
    is_rebounce_active = false;
    private rebounce_sequences: { [symbol: string]: boolean } = {};


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
            is_differs_v2_mode: observable,
            is_tatu_bora_mode: observable,
            is_nne_kwisha_mode: observable,
            is_all_vol_mode: observable,
            differs_predicted_top4: observable,
            differs_v2_predicted_digit: observable,
            differs_v2_post_trade_ticks: observable,
            differs_v2_analysis_ready: observable,
            differs_v2_5s_analysis_pending: observable,
            differs_v2_confidence_wait_start: observable,
            is_digit_occurrence_filter_active: observable,
            is_rebounce_active: observable,
            setStake: action.bound,
            setIsRiseFallMode: action.bound,
            setIs2termMode: action.bound,
            setMartingale: action.bound,
            setIsVolatilityChanger: action.bound,
            setIsDiffersMode: action.bound,
            setIsDiffersV2Mode: action.bound,
            setIsTatuBoraMode: action.bound,
            setIsNneKwishaMode: action.bound,
            setIsAllVolMode: action.bound,
            setIsAutomate: action.bound,
            setUseSecondTrigger: action.bound,
            setIsManualMode: action.bound,
            setManualContractType: action.bound,
            setManualBarrier: action.bound,
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
            setIsDigitOccurrenceFilterActive: action.bound,
            setIsRebounceActive: action.bound,
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
                const { score } = event.data;
                this.addLog(`Analysis for ${this.current_analyzing_symbol}: Score ${score.toFixed(2)}`);
                if (score < this.best_score) {
                    this.best_score = score;
                    this.best_symbol = this.current_analyzing_symbol;
                    this.addLog(`New best volatility: ${this.best_symbol} (Score: ${score.toFixed(2)})`);
                }
                this.processAnalysisQueue();
            };
            this.volatilityAnalyzer.onerror = (err) => {
                this.addLog(`⚠️ Volatility worker error: ${err.message}. Aborting analysis.`);
                runInAction(() => {
                    this.is_analyzing_volatility = false;
                    this.current_analyzing_symbol = null;
                    this.analysis_queue = [];
                });
                this._clearAnalysisTimeout();
                // Recreate the worker so it can be used again
                this.volatilityAnalyzer?.terminate();
                this.initializeWorker();
            };
        } catch (e) {
            this.addLog(`⚠️ Could not create volatility worker: ${e?.message}`);
        }
    }

    startVolatilityAnalysis() {
        if (!this.is_volatility_changer || this.is_analyzing_volatility) return;
        runInAction(() => {
            this.is_analyzing_volatility = true;
            this.analysis_queue = Object.keys(pip_sizes);
            this.best_score = Infinity;
            this.best_symbol = null;
        });
        this.addLog('Volatility analysis started...');
        this._armAnalysisTimeout();
        this.processAnalysisQueue();
    }

    processAnalysisQueue() {
        if (this.analysis_queue.length > 0) {
            const sym = this.analysis_queue.shift()!;
            runInAction(() => { this.current_analyzing_symbol = sym; });
            
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' }));
            } else {
                // WebSocket not ready — wait and retry
                this.addLog(`⏳ Waiting for WebSocket connection...`);
                const retryDelay = 500;
                let retryCount = 0;
                const maxRetries = 20; // Wait up to 10 seconds
                
                const waitForWs = () => {
                    retryCount++;
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.addLog(`✅ WebSocket ready, processing ${sym}...`);
                        this.ws.send(JSON.stringify({ ticks_history: sym, count: 1000, end: 'latest', style: 'ticks' }));
                    } else if (retryCount < maxRetries) {
                        setTimeout(waitForWs, retryDelay);
                    } else {
                        // Give up after max retries
                        this.addLog(`⚠️ WS connection timeout for ${sym}, using default.`);
                        runInAction(() => {
                            this.best_symbol = 'R_100';
                            this.best_score = 0;
                        });
                        this._clearAnalysisTimeout();
                        runInAction(() => {
                            this.is_analyzing_volatility = false;
                            this.current_analyzing_symbol = null;
                            this.analysis_queue = [];
                        });
                        this.addLog('Analysis complete. Using default symbol R_100.');
                    }
                };
                
                setTimeout(waitForWs, retryDelay);
            }
        } else {
            this._clearAnalysisTimeout();
            runInAction(() => {
                this.is_analyzing_volatility = false;
                this.current_analyzing_symbol = null;
            });
            if (this.best_symbol) {
                this.addLog(`Analysis complete. Best volatility: ${this.best_symbol}`);
                this.setSelectedSymbol(this.best_symbol);
                
                if (this.is_differs_v2_mode && this.is_auto_running) {
                    this.addLog("Differs V2: Switched to new symbol. Looking for trigger...");
                    return;
                }
            } else {
                this.addLog('Analysis complete. No suitable volatility found.');
            }
            if (this.is_auto_running && this.is_turbo) {
                this.addLog("Ready for next trade round.");
            }
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

    // ── Safety timeouts ── prevent flags getting permanently stuck ────────
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
                this.addLog('⚠️ Volatility analysis timeout — aborting analysis.');
                runInAction(() => {
                    this.is_analyzing_volatility = false;
                    this.current_analyzing_symbol = null;
                    this.analysis_queue = [];
                });
            }
        }, this.ANALYSIS_TIMEOUT_MS);
    }

    private _clearAnalysisTimeout() {
        if (this._analysisTimeout) { clearTimeout(this._analysisTimeout); this._analysisTimeout = null; }
    }

    clearDebug() { this.debug_info = []; }
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

    setIs2termMode(value: boolean) { this.is_2term_mode = value; }
    setIsRiseFallMode(value: boolean) { this.is_rise_fall_mode = value; }
    setIsAutomate(value: boolean) { this.is_automate = value; }
    setUseSecondTrigger(value: boolean) { this.use_second_trigger = value; }
    setIsManualMode(value: boolean) { this.is_manual_mode = value; }
    setManualContractType(value: string) { this.manual_contract_type = value; }
    setManualBarrier(value: string) { this.manual_barrier = value; }
    setIsRecoveryActive(value: boolean) { this.is_recovery_active = value; }
    setIsRecoveryEnabled(value: boolean) { this.is_recovery_enabled = value; }
    setRecoveryContractType(value: string) { this.recovery_contract_type = value; }
    setRecoveryBarrier(value: string) { this.recovery_barrier = value; }
    setUseRecoveryDelay(value: boolean) { this.use_recovery_delay = value; }
    setRecoveryEntryDigit(digit: number) { this.recovery_entry_digit = digit; }
    setRecoverySecondEntryDigit(digit: number) { this.recovery_second_entry_digit = digit; }
    setEntryDigit(digit: number) { this.entry_digit = digit; }
    setSecondEntryDigit(digit: number) { this.second_entry_digit = digit; }
    setIsTurbo(is_turbo: boolean) { this.is_turbo = is_turbo; }
    setIsDigitOccurrenceFilterActive(value: boolean) { this.is_digit_occurrence_filter_active = value; }
    setIsRebounceActive(value: boolean) { this.is_rebounce_active = value; }

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
        }
        this.is_purchasing = false;
        this.pending_instant_result_check = {};
        this.rebounce_sequences = {};
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

        // Always forget all previous tick subscriptions to ensure a clean state.
        this.ws.send(JSON.stringify({ forget_all: 'ticks' }));
        this.active_subscription_id = null;
        this.addLog('Cleared all previous tick subscriptions.');

        if (this.is_all_vol_mode) {
            this.symbol_data = {}; // Reset data object
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

    connectWebSocket() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.is_authorized) {
            this.addLog('Already connected and authorized.');
            return;
        }
        if (this.ws) { this.ws.onclose = null; this.ws.close(); }
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.addLog('Connecting...');
        this.connection_status = STATUS_CONNECTING;
        this.is_authorized = false;
        this.is_authorizing = true;
        const app_id = getAppId();
        const server_url = getSocketURL();
        try {
            this.ws = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);
            this.ws.onopen = () => {
                runInAction(() => { this.connection_status = STATUS_LIVE; });
                this.addLog(`Connection opened (App ID: ${app_id}). Requesting authorization...`);
                if (window.self !== window.top) {
                    window.parent.postMessage({ name: 'request_auth_token' }, '*');
                } else {
                    try {
                        const active_loginid = localStorage.getItem('active_loginid');
                        const client_accounts_str = localStorage.getItem('client.accounts');
                        if (client_accounts_str && active_loginid) {
                            const client_accounts = JSON.parse(client_accounts_str);
                            const token = client_accounts[active_loginid]?.token;
                            if (token) {
                                this.addLog(`Authorizing with token for ${active_loginid}...`);
                                this.ws?.send(JSON.stringify({ authorize: token }));
                                return;
                            }
                        }
                        const accountsListStr = localStorage.getItem('accountsList');
                        if (accountsListStr && active_loginid) {
                            const accountsList = JSON.parse(accountsListStr);
                            const token = accountsList[active_loginid];
                            if (token) {
                                this.addLog(`Authorizing with fallback token for ${active_loginid}...`);
                                this.ws?.send(JSON.stringify({ authorize: token }));
                                return;
                            }
                        }
                        const storeToken = this.root_store.client.getToken?.();
                        if (storeToken) {
                            this.addLog('Authorizing with store token...');
                            this.ws?.send(JSON.stringify({ authorize: storeToken }));
                            return;
                        }
                        this.addLog('No token found in storage. Proceeding with public ticks.');
                        runInAction(() => { this.is_authorizing = false; });
                        this.subscribeToTicks(this.selected_symbol);
                    } catch (e) {
                        this.addLog(`Token retrieval error: ${e.message}. Proceeding with public ticks.`);
                        runInAction(() => { this.is_authorizing = false; });
                        this.subscribeToTicks(this.selected_symbol);
                    }
                }
            };
            this.ws.onmessage = async (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data.subscription?.id) this.active_subscription_id = data.subscription.id;
                    if (data.error) {
                        this.addLog(`Error: ${data.error.message}`);
                        if (data.msg_type === 'buy') {
                             const symbol = data.echo_req.symbol;
                             if(symbol) this.symbol_locks[symbol] = false;
                             this.is_purchasing = false;
                        }
                    }
                    switch (data.msg_type) {
                        case 'history':
                            if (this.is_all_vol_mode) {
                                const symbol = data.echo_req.ticks_history;
                                if (!this.symbol_data[symbol]) {
                                    this.symbol_data[symbol] = { tick_history: [], last_digit: null, last_last_digit: null, _tick_prices: [] };
                                }
                                const pip_size = pip_sizes[symbol] || 2;
                                const prices = data.history.prices;
                                const digits = prices.map((p: string | number) => Number(p).toFixed(pip_size).slice(-1)).map(Number);
                                this.symbol_data[symbol].tick_history = digits;
                                this.symbol_data[symbol]._tick_prices = prices.map((p: string | number) => Number(p));
                                if (digits.length > 0) this.symbol_data[symbol].last_digit = digits[digits.length - 1];
                                this.addLog(`Loaded ${digits.length} historical ticks for ${symbol}.`);
                            } else if (data.echo_req.subscribe === 1) {
                                const pip_size = pip_sizes[this.selected_symbol] || 2;
                                const prices = data.history.prices;
                                const digits = prices.map((p: string | number) => Number(p).toFixed(pip_size).slice(-1)).map(Number);
                                this.tick_history = digits;
                                this._tick_prices = prices.map((p: string | number) => Number(p));
                                if (digits.length > 0) this.last_digit = digits[digits.length - 1];
                                this.addLog(`Loaded ${digits.length} historical ticks.`);
                            } else if (this.is_analyzing_volatility) {
                                const pip_size = pip_sizes[data.echo_req.ticks_history] || 2;
                                const rawPrices = data.history.prices.map((p: string | number) => Number(p));
                                const digits = rawPrices.map((p: number) => Number(p.toFixed(pip_size).slice(-1)));
                                const strategy = this.is_differs_mode ? 'differs'
                                    : this.is_differs_v2_mode ? 'differs_v2'
                                    : this.is_rise_fall_mode ? 'rise_fall'
                                    : this.is_manual_mode ? 'manual'
                                    : 'over_under';
                                this.volatilityAnalyzer?.postMessage({
                                    ticks: digits,
                                    prices: rawPrices,
                                    contract_type: this.is_recovery_active ? this.recovery_contract_type : (this.is_manual_mode ? this.manual_contract_type : (this.is_differs_mode || this.is_differs_v2_mode ? 'DIGITDIFF' : 'DIGITOVER')),
                                    barrier: this.is_recovery_active ? this.recovery_barrier : (this.is_manual_mode ? this.manual_barrier : '5'),
                                    strategy,
                                });
                            }
                            break;
                        case 'authorize':
                            this.is_authorizing = false;
                            if (data.error) {
                                this.addLog(`Authorization Failed: ${data.error.message}.`);
                                this.is_authorized = false;
                            } else {
                                this.addLog(`Authorization Successful for ${data.authorize.loginid}!`);
                                this.is_authorized = true;
                                this.connection_status = STATUS_AUTHORIZED;
                                this.ws?.send(JSON.stringify({ proposal_open_contract: 1, subscribe: 1 }));
                            }
                            this.subscribeToTicks(this.selected_symbol);
                            break;
                        case 'buy':
                            this.is_purchasing = false;
                            const symbol = data.echo_req.parameters.symbol;
                            if (data.error) {
                                if (symbol) this.symbol_locks[symbol] = false;
                            } else {
                                const contract_id = data.buy.contract_id;
                                this.addLog(`Purchase Sent: ${contract_id} on ${symbol}`);
                                this.active_contracts.add(String(contract_id));
                            }
                            break;
                        case 'proposal_open_contract':
                            const contract = data.proposal_open_contract;
                            const formattedContract = {
                                ...contract,
                                date_start: contract.date_start || Math.floor(Date.now() / 1000),
                                transaction_ids: contract.transaction_ids || { buy: contract.contract_id },
                                accountID: contract.accountID || this.root_store.client.loginid
                            };
                            if (this.root_store.summary_card) this.root_store.summary_card.onBotContractEvent(formattedContract);
                            if (this.root_store.transactions) this.root_store.transactions.onBotContractEvent(formattedContract);
                            if (contract.is_sold) {
                                const contract_id = String(contract.contract_id);
                                const symbol = contract.underlying;
                                if (symbol) this.symbol_locks[symbol] = false;
                                if (this.active_contracts.has(contract_id)) {
                                    const profit = contract.profit;
                                    this.contract_results.set(contract_id, { profit, symbol });
                                    this.addLog(`Trade Result [${contract_id}] on ${symbol}: ${profit >= 0 ? 'WON' : 'LOST'} ($${profit})`);
                                    this.active_contracts.delete(contract_id);
                                    if (this.active_contracts.size === 0 && !this.is_processing_round) {
                                        this.processRoundResults();
                                    }
                                }
                            }
                            break;
                        case 'tick':
                            const tick = data.tick;
                            const tick_symbol = tick.symbol;
                            const pip_size = tick.pip_size || pip_sizes[tick_symbol] || 2;
                            const quote_str = tick.quote.toFixed(pip_size);
                            const digit = parseInt(quote_str.slice(-1), 10);

                            if (this.is_all_vol_mode) {
                                if (!this.symbol_data[tick_symbol]) {
                                    this.symbol_data[tick_symbol] = { tick_history: [], last_digit: null, last_last_digit: null, _tick_prices: [] };
                                    this.addLog(`Received tick for unsubscribed symbol ${tick_symbol} in All Vol mode. Initializing...`);
                                }
                                const current_symbol_data = this.symbol_data[tick_symbol];
                                current_symbol_data.last_last_digit = current_symbol_data.last_digit;
                                current_symbol_data.last_digit = digit;
                                current_symbol_data.tick_history = [...current_symbol_data.tick_history.slice(-MAX_TICKS + 1), digit];
                                current_symbol_data._tick_prices = [...current_symbol_data._tick_prices.slice(-MAX_TICKS + 1), Number(tick.quote)];
                            } else {
                                this.last_last_digit = this.last_digit;
                                this.last_digit = digit;
                                this.tick_history = [...this.tick_history.slice(-MAX_TICKS + 1), digit];
                                this._tick_prices = [...this._tick_prices.slice(-MAX_TICKS + 1), Number(tick.quote)];
                            }
                            
                            // Fast Recovery for Differs V2
                            const pending_check = this.pending_instant_result_check[tick_symbol];
                            if (pending_check) {
                                const last_digit_for_check = this.is_all_vol_mode ? this.symbol_data[tick_symbol].last_digit : this.last_digit;
                                const barrier = pending_check.barrier;

                                if (String(last_digit_for_check) === barrier) {
                                    // INSTANT LOSS
                                    this.addLog(`⚡ Instant Result on ${tick_symbol}: LOST (Digit: ${last_digit_for_check}, Barrier: ${barrier})`);
                                    const next_stake = Number((pending_check.stake * this.martingale).toFixed(2));
                                    this.addLog(`⚡ Fast Recovery on ${tick_symbol}: Martingale triggered. New stake: ${next_stake}`);

                                    // Immediately set up the check for the *next* trade, then execute it.
                                    this.pending_instant_result_check[tick_symbol] = { ...pending_check, stake: next_stake };
                                    this.executeTrade(pending_check.contract_type, barrier, tick_symbol, next_stake, true);
                                } else {
                                    // INSTANT WIN
                                    this.addLog(`⚡ Instant Result on ${tick_symbol}: WON (Digit: ${last_digit_for_check}, Barrier: ${barrier})`);
                                     if (!this.is_2term_mode) {
                                        this.stake = this.initial_stake;
                                        this.addLog(`⚡ Stake reset to initial: ${this.initial_stake}`)
                                    }
                                    delete this.pending_instant_result_check[tick_symbol];
                                }
                                return; // IMPORTANT: Stop further processing of this tick to avoid conflicts.
                            }
                            
                            const is_general_busy = this.is_analyzing_volatility || this.is_processing_round || this.active_contracts.size > 0 || this.is_purchasing;

                            if (this.is_auto_running && !is_general_busy) {
                                if (this.is_all_vol_mode) {
                                    const active_symbol = tick_symbol;
                                    if (this.symbol_locks[active_symbol]) return;

                                    const symbol_data = this.symbol_data[active_symbol];
                                    if (!symbol_data) return;

                                    if (this.is_differs_mode) {
                                        this.analyzeAndExecuteDiffers(active_symbol);
                                    } else if (this.is_differs_v2_mode) {
                                        this.analyzeAndExecuteDiffersV2(active_symbol);
                                    } else if (!this.is_rise_fall_mode && !this.is_manual_mode) {
                                        this.handleOverUnderLogic(symbol_data);
                                    }
                                } else {
                                    if (this.symbol_locks[this.selected_symbol]) return;

                                    if (this.is_rise_fall_mode) {
                                        this.analyzeAndExecuteRiseFall();
                                    } else if (this.is_differs_mode) {
                                        this.analyzeAndExecuteDiffers();
                                    } else if (this.is_differs_v2_mode) {
                                        this.analyzeAndExecuteDiffersV2();
                                    } else {
                                        this.handleOverUnderLogic();
                                    }
                                }
                            }
                            break;
                    }
                } catch (error) { this.addLog(`Message parse error: ${error.message}`); }
            };
            this.ws.onclose = () => {
                this.addLog(`Connection closed. Reconnecting...`);
                this.connection_status = STATUS_OFFLINE;
                this.is_authorizing = false;
                this.is_authorized = false;
                this.reconnectTimeout = setTimeout(() => this.connectWebSocket(), 5000);
            };
            this.ws.onerror = (e) => this.addLog(`Connection Error: ${e.type}`);
        } catch (e) { this.addLog(`Connection failed to initialize: ${e.message}`); this.is_authorizing = false; }
    }

    handleOverUnderLogic(symbol_data?: any) {
        const data = symbol_data || this;
        const symbol = this.is_all_vol_mode && symbol_data ? Object.keys(this.symbol_data).find(key => this.symbol_data[key] === data) : this.selected_symbol;
    
        if (!symbol) return; // Should not happen

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
            const is_triggered = this.use_second_trigger ? (data.last_digit === this.entry_digit && data.last_last_digit === this.second_entry_digit) : (data.last_digit === this.entry_digit);
            if (is_triggered) {
                if (this.is_manual_mode) {
                    this.addLog(`Trigger: Manual ${this.manual_contract_type} ${this.manual_barrier} on ${symbol}`);
                    this.executeTrade(this.manual_contract_type, this.manual_barrier, symbol);
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

        if (mp > sp && mc < sc && mc > 0) {
            this.addLog(`Rise/Fall: MACD crossed BELOW signal (mc=${mc.toFixed(6)}, sc=${sc.toFixed(6)}). FALL!`);
            this.executeRiseFallTrade('PUT');
        } else if (mp < sp && mc > sc && mc < 0) {
            this.addLog(`Rise/Fall: MACD crossed ABOVE signal (mc=${mc.toFixed(6)}, sc=${sc.toFixed(6)}). RISE!`);
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

    analyzeAndExecuteDiffers(symbol?: string) {
        const current_symbol = symbol || this.selected_symbol;
        const data = this.is_all_vol_mode ? this.symbol_data[current_symbol] : this;
    
        if (!data || data.tick_history.length < 36 || this.symbol_locks[current_symbol]) return;
    
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
        // Set up the instant check for the fast recovery system.
        this.pending_instant_result_check[symbol] = { barrier, stake, contract_type };
        this.executeTrade(contract_type, barrier, symbol, stake);
    }
    
    analyzeAndExecuteDiffersV2(symbol?: string) {
        const current_symbol = symbol || this.selected_symbol;
        const data = this.is_all_vol_mode ? this.symbol_data[current_symbol] : this;

        if (this.pending_instant_result_check[current_symbol]) return;

        if (!data || data.tick_history.length < 4 || this.symbol_locks[current_symbol]) return;

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

            // Only apply restrictions if Nne Kwisha mode is OFF
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
                } else { // Win
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
                // Logic for other DiffersV2 modes (e.g., Nne Kwisha, standard double)
                if (all_loss) {
                    this.stake = Number((this.stake * this.martingale).toFixed(2));
                    this.addLog(`DiffersV2: Loss! Martingale - Stake: ${this.stake.toFixed(2)}`);
                } else { // Win
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
    
            // Common cleanup logic for all Differs V2 modes
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
            this.addLog('Rise/Fall: Monitoring MACD for next signal...');
            return;
        }
        
        if (all_loss) {
                this.addLog(`Loss detected. Standard recovery disabled for this mode.`);
                if (this.is_2term_mode) {
                    const nextStake = Number((this.stake + roundProfit).toFixed(2));
                    this.stake = nextStake > 0 ? nextStake : this.initial_stake;
                    this.addLog(`2term Applied on Loss: New stake: ${this.stake}`);
                } else {
                     this.stake = Number((this.stake * this.martingale).toFixed(2));
                     this.addLog(`Standard Martingale on Loss: New stake: ${this.stake}`);
                }
                if (this.is_volatility_changer && this.is_automate) this.startVolatilityAnalysis();
        } else { // Win
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

    executeTrade(contract_type: string, barrier: string, symbol?: string, stake?: number, is_fast_recovery = false) {
        const tradeSymbol = symbol || this.selected_symbol;

        // For fast recovery, we bypass the lock check because we need to trade immediately.
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
        this.addLog(`Trade: ${is_fast_recovery ? '⚡Fast Recovery' : ''} ${contract_type} ${barrier} on ${tradeSymbol} @ ${tradeAmount}`);
        this.ws.send(JSON.stringify({ buy: 1, price: tradeAmount, parameters: { amount: tradeAmount, basis: 'stake', currency: 'USD', duration: 1, duration_unit: 't', symbol: tradeSymbol, contract_type, barrier } }));
    }

    executeMultiTrade(symbol?: string) {
        const tradeSymbol = symbol || this.selected_symbol;
        const data = this.is_all_vol_mode ? this.symbol_data[tradeSymbol] : this;

        if (this.symbol_locks[tradeSymbol]) return;

        if (this.is_digit_occurrence_filter_active) {
            const history = data.tick_history.slice(-100);
            const losing_digits_count = history.filter(d => d === 4 || d === 5).length;
            const occurrence_percentage = (losing_digits_count / history.length) * 100;
            if (occurrence_percentage > 25) {
                this.addLog(`Trade on ${tradeSymbol} skipped. Losing digits (4,5) occurred ${occurrence_percentage.toFixed(1)}% in last 100 ticks.`);
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
        if (this.is_auto_running) { this.addLog('Tab switched. Bot continuing in background...'); return; }
        window.removeEventListener('message', this._boundAuthHandler);
        if (this._loginReaction) this._loginReaction();
        if (this._accountReaction) this._accountReaction();
        if (this.ws) { this.ws.onclose = null; this.ws.close(); }
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.volatilityAnalyzer?.terminate();
    }
}
