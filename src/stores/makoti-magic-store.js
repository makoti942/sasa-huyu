import { makeAutoObservable, action, runInAction } from 'mobx';
import { predictNextDigits } from '@/utils/differs-prediction-engine';

const STATUS_OFFLINE = 'Offline';
const STATUS_LIVE = 'Live';
const MAX_TICKS = 200;
const MIN_CONFIDENCE = 0.31;
const MAX_SCAN_ATTEMPTS = 50;

class MakotiMagicStore {
    is_loading = false;
    is_running = false;
    connection_status = STATUS_OFFLINE;
    last_digit = null;
    prediction = null;
    selected_symbol = 'R_100';
    ws = null;
    tick_history = [];
    active_subscription_id = null;
    is_initialized = false;
    tick_prices = [];
    scan_count = 0;
    last_scan_time = null;
    scan_interval_ms = 1000;
    bot_load_callback = null;
    scan_attempts = 0;
    is_auto_scanning = false;

    constructor() {
        makeAutoObservable(this, {
            runScan: action,
            connectWebSocket: action,
            setSelectedSymbol: action,
            subscribeToTicks: action,
            handleTick: action,
            loadBot: action,
            setBotLoadCallback: action,
            dispose: action,
            performPrediction: action,
        });
    }

    setBotLoadCallback = (callback) => {
        this.bot_load_callback = callback;
    }

    setSelectedSymbol = (symbol) => {
        this.selected_symbol = symbol;
        if (this.connection_status === STATUS_LIVE) {
            this.subscribeToTicks(symbol);
        }
    }

    subscribeToTicks = (symbol) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.active_subscription_id) {
            this.ws.send(JSON.stringify({ forget: this.active_subscription_id }));
            this.active_subscription_id = null;
        }
        this.ws.send(JSON.stringify({ ticks_history: symbol, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
        this.tick_history = [];
        this.tick_prices = [];
    }

    handleTick = (data) => {
        const pip_sizes = {
            'R_100': 2, 'R_75': 4, 'R_50': 4, 'R_25': 3, 'R_10': 3,
            '1HZ100V': 2, '1HZ75V': 2, '1HZ50V': 2, '1HZ25V': 2, '1HZ10V': 2,
        };
        const pip_size = pip_sizes[this.selected_symbol] || 2;
        const quote_str = data.tick.quote.toFixed(pip_size);
        const digit = parseInt(quote_str.slice(-1), 10);
        const price = Number(data.tick.quote);

        this.last_digit = digit;
        this.tick_history = [...this.tick_history.slice(-MAX_TICKS + 1), digit];
        this.tick_prices = [...this.tick_prices.slice(-MAX_TICKS + 1), price];
    }

    performPrediction = () => {
        if (this.tick_history.length < 5) {
            runInAction(() => {
                this.prediction = {
                    predictedDigit: null,
                    confidence: 0,
                    tickRange: null,
                    rankedDigits: [],
                    summary: 'Collecting tick data...',
                };
            });
            return { continueScanning: true };
        }

        const history = this.tick_history.slice(-200);
        const result = predictNextDigits(history);
        const topDigit = result.rankedDigits[0];

        const tickRange = Math.floor(Math.random() * 4) + 4;
        const confidence = topDigit?.score ?? 0;

        runInAction(() => {
            this.prediction = {
                predictedDigit: topDigit?.digit ?? null,
                confidence: confidence,
                tickRange: tickRange,
                rankedDigits: result.rankedDigits.slice(0, 10),
                summary: result.summary,
                symbol: this.selected_symbol,
            };
        });

        if (confidence >= MIN_CONFIDENCE || this.scan_attempts >= MAX_SCAN_ATTEMPTS) {
            return { continueScanning: false, confidence, digit: topDigit?.digit };
        }

        return { continueScanning: true, confidence, digit: topDigit?.digit };
    }

    // DISABLED - replaced by DerivAuth.js
    // connectWebSocket = () => {
    //     if (this.ws && this.ws.readyState === WebSocket.OPEN && this.is_initialized) {
    //         return;
    //     }

    //     if (this.ws) {
    //         this.ws.onclose = null;
    //         this.ws.close();
    //     }

    //     const server_url = localStorage.getItem('config.server_url') || 'ws.derivws.com';
    //     const app_id = localStorage.getItem('config.app_id') || '337';

    //     runInAction(() => {
    //         this.connection_status = 'Connecting...';
    //     });

    //     this.ws = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);

    //     this.ws.onopen = () => {
    //         runInAction(() => {
    //             this.connection_status = STATUS_LIVE;
    //             this.is_initialized = true;
    //         });

    //         const token = localStorage.getItem('authToken') || localStorage.getItem('token');
    //         if (token) {
    //             this.ws.send(JSON.stringify({ authorize: token }));
    //         }
    //         this.subscribeToTicks(this.selected_symbol);
    //     };

    //     this.ws.onmessage = (msg) => {
    //         try {
    //             const data = JSON.parse(msg.data);
    //             if (data.error) {
    //                 console.error(data.error.message);
    //                 return;
    //             }

    //             if (data.subscription?.id) {
    //                 this.active_subscription_id = data.subscription.id;
    //             }

    //             if (data.msg_type === 'history') {
    //                 const pip_sizes = {
    //                     'R_100': 2, 'R_75': 4, 'R_50': 4, 'R_25': 3, 'R_10': 3,
    //                     '1HZ100V': 2, '1HZ75V': 2, '1HZ50V': 2, '1HZ25V': 2, '1HZ10V': 2,
    //                 };
    //                 const pip_size = pip_sizes[this.selected_symbol] || 2;
    //                 const prices = data.history.prices;
    //                 const digits = prices.map((p) => Number(p).toFixed(pip_size).slice(-1)).map(Number);

    //                 runInAction(() => {
    //                     this.tick_history = digits;
    //                     this.tick_prices = prices.map((p) => Number(p));
    //                     if (digits.length > 0) {
    //                         this.last_digit = digits[digits.length - 1];
    //                     }
    //                 });
    //             }

    //             if (data.msg_type === 'tick') {
    //                 this.handleTick(data);
    //             }

    //             if (data.msg_type === 'authorize' && !data.error) {
    //                 runInAction(() => {
    //                     this.connection_status = 'Connected';
    //                 });
    //                 this.subscribeToTicks(this.selected_symbol);
    //             }
    //         } catch (error) {
    //             console.error('Message parse error:', error);
    //         }
    //     };

    //     this.ws.onclose = () => {
    //         runInAction(() => {
    //             this.connection_status = STATUS_OFFLINE;
    //             this.is_initialized = false;
    //         });
            setTimeout(() => this.connectWebSocket(), 5000);
        };

        this.ws.onerror = (e) => {
            console.error('WebSocket error:', e);
            runInAction(() => {
                this.connection_status = 'Error';
            });
        };
    }

    runScan = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.error('WebSocket is not connected.');
            return;
        }

        if (this.is_loading) {
            return;
        }

        this.is_loading = true;
        this.scan_attempts = 0;
        this.is_auto_scanning = true;

        this.runAutoScan();
    }

    runAutoScan = () => {
        if (!this.is_auto_scanning) return;

        this.scan_attempts++;

        setTimeout(() => {
            const result = this.performPrediction();

            if (result.continueScanning && this.scan_attempts < MAX_SCAN_ATTEMPTS) {
                this.runAutoScan();
            } else {
                runInAction(() => {
                    this.is_loading = false;
                    this.is_auto_scanning = false;
                });
            }
        }, 800);
    };

    stopScan = () => {
        this.is_auto_scanning = false;
        this.is_loading = false;
    };

    loadBot = async () => {
        if (!this.prediction || this.prediction.predictedDigit === null) {
            console.error('No prediction available to load.');
            return;
        }

        const predictedDigit = this.prediction.predictedDigit;
        const symbol = this.prediction.symbol;

        try {
            const response = await fetch('/matches.xml');
            let xmlContent = await response.text();
            
            xmlContent = xmlContent.replace(/PREDICTION_VALUE/g, String(predictedDigit));
            xmlContent = xmlContent.replace(/<field name="SYMBOL_LIST">[^<]*<\/field>/, `<field name="SYMBOL_LIST">${symbol}</field>`);

            if (this.bot_load_callback) {
                this.bot_load_callback(xmlContent);
            }
        } catch (error) {
            console.error('Failed to load bot XML:', error);
        }
    };

    dispose = () => {
        this.is_auto_scanning = false;
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
    };
}

export default new MakotiMagicStore();
