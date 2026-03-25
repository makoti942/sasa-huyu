
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
    is_automate = false;
    use_second_trigger = true;
    is_manual_mode = false;
    manual_contract_type = 'DIGITOVER';
    manual_barrier = '5';
    is_recovery_active = false;
    recovery_contract_type = 'DIGITOVER';
    recovery_barrier = '5';
    use_recovery_delay = false;
    entry_digit = 7;
    second_entry_digit = 7;
    last_last_digit: number | null = null;
    is_turbo = false;
    selected_symbol = 'R_100';
    active_contracts: Set<string> = new Set();
    contract_results: Map<string, number> = new Map();
    active_subscription_id: string | null = null;
    differs_barrier_digit: number | null = null;
    is_differs_recovery_mode = false;
    is_2term_mode = false;
    is_rise_fall_mode = false;
    last_profit = 0;
    differs_predicted_top4: number[] = [];
    private _tick_prices: number[] = [];
    total_loss_to_recover = 0;
    differs_digit_appearance_count = 0;

    is_analyzing_volatility = false;
    analysis_queue: string[] = [];
    best_score = Infinity;
    best_symbol: string | null = null;
    current_analyzing_symbol: string | null = null;

    private is_purchasing = false;
    private is_processing_round = false;

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
            recovery_contract_type: observable,
            recovery_barrier: observable,
            use_recovery_delay: observable,
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
            differs_predicted_top4: observable,
            setStake: action.bound,
            setIsRiseFallMode: action.bound,
            setIs2termMode: action.bound,
            setMartingale: action.bound,
            setIsVolatilityChanger: action.bound,
            setIsDiffersMode: action.bound,
            setIsAutomate: action.bound,
            setUseSecondTrigger: action.bound,
            setIsManualMode: action.bound,
            setManualContractType: action.bound,
            setManualBarrier: action.bound,
            setIsRecoveryActive: action.bound,
            setRecoveryContractType: action.bound,
            setRecoveryBarrier: action.bound,
            setUseRecoveryDelay: action.bound,
            setEntryDigit: action.bound,
            setSecondEntryDigit: action.bound,
            setIsTurbo: action.bound,
            setSelectedSymbol: action.bound,
            setIsAutoRunning: action.bound,
            connectWebSocket: action.bound,
            handleStartStop: action.bound,
            addLog: action.bound,
            clearDebug: action.bound,
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
                // WebSocket not ready — skip this symbol and continue
                this.addLog(`⚠️ WS not open during analysis, skipping ${sym}.`);
                this.processAnalysisQueue();
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
    private _armPurchaseTimeout() {
        if (this._purchaseTimeout) clearTimeout(this._purchaseTimeout);
        this._purchaseTimeout = setTimeout(() => {
            if (this.is_purchasing) {
                this.addLog('⚠️ Purchase timeout — resetting purchase lock.');
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
    setIs2termMode(value: boolean) { this.is_2term_mode = value; }
    setIsRiseFallMode(value: boolean) { this.is_rise_fall_mode = value; }
    setIsAutomate(value: boolean) { this.is_automate = value; }
    setUseSecondTrigger(value: boolean) { this.use_second_trigger = value; }
    setIsManualMode(value: boolean) { this.is_manual_mode = value; }
    setManualContractType(value: string) { this.manual_contract_type = value; }
    setManualBarrier(value: string) { this.manual_barrier = value; }
    setIsRecoveryActive(value: boolean) { this.is_recovery_active = value; }
    setRecoveryContractType(value: string) { this.recovery_contract_type = value; }
    setRecoveryBarrier(value: string) { this.recovery_barrier = value; }
    setUseRecoveryDelay(value: boolean) { this.use_recovery_delay = value; }
    setEntryDigit(digit: number) { this.entry_digit = digit; }
    setSecondEntryDigit(digit: number) { this.second_entry_digit = digit; }
    setIsTurbo(is_turbo: boolean) { this.is_turbo = is_turbo; }

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
            this.is_purchasing = false;
            this.is_processing_round = false;
            this.differs_barrier_digit = null;
            this.is_differs_recovery_mode = false;
        }
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
            this.addLog("Tool started. Waiting for trigger...");
            if (this.is_volatility_changer) this.startVolatilityAnalysis();
        } else {
            this.addLog("Tool stopped by user.");
            this.setIsRecoveryActive(false);
        }
    }

    subscribeToTicks(symbol: string) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.active_subscription_id) {
            this.ws.send(JSON.stringify({ forget: this.active_subscription_id }));
            this.active_subscription_id = null;
        }
        this.addLog(`Subscribing to: ${symbol}`);
        this.ws.send(JSON.stringify({ ticks_history: symbol, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
        this.tick_history = [];
        this.last_digit = null;
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
                        if (data.msg_type === 'buy') this.is_purchasing = false;
                    }
                    switch (data.msg_type) {
                        case 'history':
                            if (data.echo_req.subscribe === 1) {
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
                                    : this.is_rise_fall_mode ? 'rise_fall'
                                    : this.is_manual_mode ? 'manual'
                                    : 'over_under';
                                this.volatilityAnalyzer?.postMessage({
                                    ticks: digits,
                                    prices: rawPrices,
                                    contract_type: this.is_recovery_active ? this.recovery_contract_type : (this.is_manual_mode ? this.manual_contract_type : (this.is_differs_mode ? 'DIGITDIFF' : 'DIGITOVER')),
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
                            if (!data.error) {
                                const contract_id = data.buy.contract_id;
                                this.addLog(`Purchase Sent: ${contract_id}`);
                                this.active_contracts.add(String(contract_id));
                            }
                            this.is_purchasing = false;
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
                                if (this.active_contracts.has(contract_id)) {
                                    const profit = contract.profit;
                                    this.contract_results.set(contract_id, profit);
                                    this.addLog(`Trade Result [${contract_id}]: ${profit >= 0 ? 'WON' : 'LOST'} ($${profit})`);
                                    this.active_contracts.delete(contract_id);
                                    if (this.active_contracts.size === 0 && !this.is_processing_round) this.processRoundResults();
                                }
                            }
                            break;
                        case 'tick':
                            const quote_str = data.tick.quote.toFixed(data.tick.pip_size);
                            const digit = parseInt(quote_str.slice(-1), 10);
                            this.last_last_digit = this.last_digit;
                            this.last_digit = digit;
                            this.tick_history = [...this.tick_history.slice(-MAX_TICKS + 1), digit];
                            this._tick_prices = [...this._tick_prices.slice(-MAX_TICKS + 1), Number(data.tick.quote)];
                            if (this.is_auto_running && !this.is_analyzing_volatility && !this.is_purchasing && !this.is_processing_round && this.active_contracts.size === 0) {
                                if (this.is_rise_fall_mode) {
                                    this.analyzeAndExecuteRiseFall();
                                } else if (this.is_differs_mode && !this.is_differs_recovery_mode && !this.is_recovery_active) {
                                    this.analyzeAndExecuteDiffers();
                                } else {
                                    // Recovery mode: non-differs should execute immediately
                                    if (this.is_recovery_active && !this.is_differs_mode) {
                                        this.addLog(`Recovery: Executing immediately...`);
                                        this.executeTrade(this.recovery_contract_type, this.recovery_barrier);
                                    } else if (this.is_manual_mode && this.is_recovery_active) {
                                        this.addLog(`Recovery: Executing immediately...`);
                                        this.executeTrade(this.manual_contract_type, this.manual_barrier);
                                    } else {
                                        // Normal or Differs-Recovery mode: wait for trigger
                                        let is_triggered = this.use_second_trigger ? (this.last_digit === this.entry_digit && this.last_last_digit === this.second_entry_digit) : (this.last_digit === this.entry_digit);
                                        if (is_triggered) {
                                            if (this.is_recovery_active) {
                                                this.addLog(`Trigger: Recovery ${this.recovery_contract_type} ${this.recovery_barrier}`);
                                                this.executeTrade(this.recovery_contract_type, this.recovery_barrier);
                                            } else if (this.is_manual_mode) {
                                                this.addLog(`Trigger: Manual ${this.manual_contract_type} ${this.manual_barrier}`);
                                                this.executeTrade(this.manual_contract_type, this.manual_barrier);
                                            } else if (!this.is_differs_mode) {
                                                this.addLog(`Trigger: O5/U4`);
                                                this.executeMultiTrade();
                                            }
                                        }
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
        // Require at least 300 ticks so that all EMAs (12, 26, 9) are fully
        // warmed up — matching the 1000-tick pre-loaded history the XML DBot
        // always has before its first signal fires.
        if (this._tick_prices.length < 300 || this.is_purchasing) return;

        const fast_ema = this.calculateEMA(this._tick_prices, 12);
        const slow_ema = this.calculateEMA(this._tick_prices, 26);

        const macd_length = slow_ema.length;
        const fast_offset = fast_ema.length - macd_length;
        const macd_.line: number[] = [];
        for (let i = 0; i < macd_length; i++) {
            macd_line.push(fast_ema[fast_offset + i] - slow_ema[i]);
        }

        const signal_line = this.calculateEMA(macd_line, 9);
        if (signal_line.length < 2) return;

        const mc = macd_line[macd_line.length - 1];
        const mp = macd_line[macd_line.length - 2];
        const sc = signal_line[signal_line.length - 1];
        const sp = signal_line[signal_line.length - 2];

        // Exact same conditions as the XML bot:
        // FALL (PUT):  previous MACD above signal → current MACD below signal, MACD still positive
        // RISE (CALL): previous MACD below signal → current MACD above signal, MACD still negative
        if (mp > sp && mc < sc && mc > 0) {
            this.addLog(`Rise/Fall: MACD crossed BELOW signal (mc=${mc.toFixed(6)}, sc=${sc.toFixed(6)}). FALL!`);
            this.executeRiseFallTrade('PUT');
        } else if (mp < sp && mc > sc && mc < 0) {
            this.addLog(`Rise/Fall: MACD crossed ABOVE signal (mc=${mc.toFixed(6)}, sc=${sc.toFixed(6)}). RISE!`);
            this.executeRiseFallTrade('CALL');
        }
    }

    executeRiseFallTrade(contract_type: 'CALL' | 'PUT') {
        if (this.is_purchasing) return;
        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) return;
        this.is_purchasing = true;
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
                symbol: this.selected_symbol,
                contract_type,
            },
        }));
    }

    analyzeAndExecuteDiffers() {
        if (this._tick_prices.length < 5 || this.is_purchasing) return;

        const prices = this._tick_prices;
        const n = prices.length;
        const curr_price = prices[n - 1];
        const prev_price = prices[n - 2];

        if (curr_price === prev_price) return;

        const curr_direction: 'up' | 'down' = curr_price > prev_price ? 'up' : 'down';
        const surge_direction: 'up' | 'down' = curr_direction === 'up' ? 'down' : 'up';

        let surge_count = 0;
        for (let i = n - 2; i >= 1; i--) {
            if (prices[i] === prices[i - 1]) break;
            const tick_dir: 'up' | 'down' = prices[i] > prices[i - 1] ? 'up' : 'down';
            if (tick_dir === surge_direction) {
                surge_count++;
            } else {
                break;
            }
        }

        if (surge_count >= 3) {
            const rejection_digit = this.last_digit;
            const history = this.tick_history.slice(-1000);
            const totalTicks = history.length;
            const digitCounts = Array(10).fill(0) as number[];
            history.forEach(d => { if (d >= 0 && d <= 9) digitCounts[d]++; });

            const digitCount = digitCounts[rejection_digit!];
            const digitPct = totalTicks > 0 ? (digitCount / totalTicks) * 100 : 0;

            if (digitPct > 9.8) {
                this.addLog(
                    `Differs: SKIP digit ${rejection_digit} — too frequent (${digitPct.toFixed(1)}% in last ${totalTicks} ticks, limit 9.8%). Re-analyzing...`
                );
                return;
            }

            const minCount = Math.min(...digitCounts.filter((_, i) => digitCounts[i] > 0));
            if (digitCount === minCount && totalTicks > 0) {
                this.addLog(
                    `Differs: SKIP digit ${rejection_digit} — least appearing digit (${digitCount} times). Re-analyzing...`
                );
                return;
            }

            const last10 = history.slice(-10);
            const recentCount = last10.filter(d => d === rejection_digit).length;

            if (recentCount > 3) {
                this.addLog(
                    `Differs: SKIP digit ${rejection_digit} — rapidly increasing (appeared ${recentCount}x in last 10 ticks, limit 3). Re-analyzing...`
                );
                return;
            }

            const predictionInput = this.tick_history.slice(-200);
            const prediction = predictNextDigits(predictionInput);
            runInAction(() => { this.differs_predicted_top4 = prediction.top4Digits; });
            this.addLog(`Prediction Engine: ${prediction.summary}`);

            if (prediction.top4Digits.includes(rejection_digit!)) {
                this.addLog(
                    `Differs: BLOCKED digit ${rejection_digit} — prediction engine flagged it as likely to appear (top4: [${prediction.top4Digits.join(',')}]). Skipping trade.`
                );
                return;
            }

            this.differs_barrier_digit = rejection_digit;

            this.addLog(
                `Differs: PATTERN! ${surge_count}x ${surge_direction} surge → ` +
                `${curr_direction} reversal. Digit ${rejection_digit} (${digitPct.toFixed(1)}%, ${recentCount}x recent). ` +
                `Prediction engine cleared. DIFFER!`
            );

            this.executeTrade('DIGITDIFF', String(rejection_digit));
        } else {
            this.addLog(`Differs: Watching... ${surge_count}x ${surge_direction} (need 3+ consecutive)`);
        }
    }

    processRoundResults() {
        this.is_processing_round = true;
        const roundProfit = Array.from(this.contract_results.values()).reduce((sum, p) => sum + p, 0);
        const all_loss = Array.from(this.contract_results.values()).every(p => p < 0);
        
        this.addLog(`Round finished. Profit: ${roundProfit.toFixed(2)}, All lost: ${all_loss}`);

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
            // Update total loss to recover
            this.total_loss_to_recover += Math.abs(roundProfit);
            
            // Martingale applies to current stake
            this.stake = Number((this.stake * this.martingale).toFixed(2));
            this.addLog(`Loss detected. Total to recover: ${this.total_loss_to_recover.toFixed(2)}. Martingale Stake: ${this.stake}`);
            
            this.setIsRecoveryActive(true);
            if (this.is_differs_mode) {
                this.is_differs_recovery_mode = true;
                this.differs_barrier_digit = null;
                this.addLog(`Recovery: Waiting for trigger...`);
            } else if (this.is_manual_mode) {
                this.addLog(`Recovery: Executing...`);
                this.executeTrade(this.manual_contract_type, this.manual_barrier);
            } else {
                this.addLog(`Recovery: Executing...`);
                this.executeTrade(this.recovery_contract_type, this.recovery_barrier);
            }
        } else {
            if (this.is_recovery_active) {
                this.total_loss_to_recover -= roundProfit;
                if (this.total_loss_to_recover <= 0) {
                    this.total_loss_to_recover = 0;
                    this.setIsRecoveryActive(false);
                    this.is_differs_recovery_mode = false;
                    this.stake = this.initial_stake;
                    this.addLog(`Recovery complete! Resetting to initial stake: ${this.stake}`);
                    if (this.is_volatility_changer) this.startVolatilityAnalysis();
                } else {
                    this.addLog(`Recovery in progress. Remaining loss: ${this.total_loss_to_recover.toFixed(2)}. Continuing with stake: ${this.stake}`);
                }
            } else {
                // Normal win logic - only apply 2-term if button is ON
                // This applies to ALL strategies (differs, manual, and multi-trade like O5/U4)
                if (this.is_2term_mode) {
                    const nextStake = Number((this.stake + roundProfit).toFixed(2));
                    this.addLog(`2term Applied: Stake updated with profit ${roundProfit.toFixed(2)}. New stake: ${nextStake}`);
                    this.stake = nextStake;
                    this.addLog(`Win detected. 2-term mode is ON, stake increased to: ${this.stake}`);
                } else {
                    // 2-term is OFF: Always reset to initial stake
                    this.stake = this.initial_stake;
                    this.addLog(`Win detected. 2-term mode is OFF, resetting to initial stake: ${this.stake}`);
                }
                if (this.is_volatility_changer) this.startVolatilityAnalysis();
            }
        }
        
        this.contract_results.clear();
        this.is_processing_round = false;
        if (!this.is_turbo) {
            this.setIsAutoRunning(false);
            this.addLog('Turbo Mode is off. Stopping auto-run.');
        } else { this.addLog("Waiting for next trigger..."); }
    }

    executeTrade(contract_type: string, barrier: string) {
        if (this.is_purchasing) return;
        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) return;
        this.is_purchasing = true;
        // Use initial_stake for recovery trades, otherwise use current stake
        const tradeAmount = this.is_recovery_active ? Number(this.initial_stake) : Number(this.stake);
        this.addLog(`Trade: ${contract_type} ${barrier} @ ${tradeAmount}`);
        this.ws.send(JSON.stringify({ buy: 1, price: tradeAmount, parameters: { amount: tradeAmount, basis: 'stake', currency: 'USD', duration: 1, duration_unit: 't', symbol: this.selected_symbol, contract_type, barrier } }));
    }

    executeMultiTrade() {
        if (this.is_purchasing) return;
        const is_logged_in = this.is_authorized || this.root_store.client.is_logged_in || !!localStorage.getItem('active_loginid');
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !is_logged_in) return;
        this.is_purchasing = true;
        // Use initial_stake for recovery trades, otherwise use current stake
        const tradeAmount = this.is_recovery_active ? Number(this.initial_stake) : Number(this.stake);
        this.addLog(`Trade: O5/U4 @ ${tradeAmount}`);
        const baseParams = { amount: tradeAmount, basis: 'stake', currency: 'USD', duration: 1, duration_unit: 't', symbol: this.selected_symbol };
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
