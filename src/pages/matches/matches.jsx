// INSIDER MATCHES GAME CHANGER Component
import React, { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { localize } from '@deriv-com/translations';
import {
    generateDerivApiInstance,
    V2GetActiveToken,
    V2GetActiveClientId,
} from '@/external/bot-skeleton/services/api/appId';
import { contract_stages } from '@/constants/contract-stage';
import { DBOT_TABS } from '@/constants/bot-contents';
import { useStore } from '@/hooks/useStore';
import './matches.css';

const Matches = observer(() => {
    const { dashboard } = useStore();
    const { active_tab } = dashboard;
    // State Management
    const [market, setMarket] = useState('');
    const [ticks, setTicks] = useState(1000);
    const [currentDigit, setCurrentDigit] = useState('--');
    const [digitStats, setDigitStats] = useState([]);
    const [symbols, setSymbols] = useState([]);
    const [predictions, setPredictions] = useState([]);
    const [defaultStake, setDefaultStake] = useState(0.5);
    const [useDefaultStake, setUseDefaultStake] = useState(true);
    const [isPlacingTrades, setIsPlacingTrades] = useState(false);
    const [alternatingMode, setAlternatingMode] = useState(false);
    const [alternatingModeState, setAlternatingModeState] = useState('most');
    const [takeProfit, setTakeProfit] = useState(5);
    const [stopLoss, setStopLoss] = useState(10);
    const [enableEntryPoint, setEnableEntryPoint] = useState(true);
    const [lastNDigits, setLastNDigits] = useState(5);
    const [entryCondition, setEntryCondition] = useState('most');
    const [whatToTrade, setWhatToTrade] = useState('most');
    const [predictionMode, setPredictionMode] = useState('most');

    // Refs
    const recentDigits = useRef([]);
    const allDigits = useRef([]);
    const isSubscribed = useRef(false);
    const tickSubscription = useRef(null);
    const pipSize = useRef(4);
    const autoTradingInterval = useRef(null);
    const contractSubscriptions = useRef([]);
    const profitLoss = useRef(0);
    const isAutoTrading = useRef(false);
    const entryConditionMet = useRef(false);
    const isProcessingTrade = useRef(false);

    // Store and API setup
    const store = useStore();
    const { run_panel, client, transactions } = store || {};
    const { registerBotListeners, unregisterBotListeners } = run_panel || {};
    const currency = client?.currency || 'USD';

    // API instances
    const apiRef = useRef(null);
    const [is_authorized, setIsAuthorized] = useState(false);
    const [account_currency, setAccountCurrency] = useState(currency);
    const [isAutoTradingGlobal, setIsAutoTradingGlobal] = useState(false);

    // Initialize API and load symbols
    useEffect(() => {
        if (active_tab !== DBOT_TABS.MATCHES) return;

        const init = async () => {
            const api = generateDerivApiInstance();
            apiRef.current = api;

            // Load symbols - Volatility and Jump Index markets
            try {
                const { active_symbols, error } = await api.send({ active_symbols: 'brief' });
                if (error) throw error;
                const syn = (active_symbols || [])
                    .filter(s => {
                        // Include Volatility markets
                        const isVolatility = /Volatility/i.test(s.display_name) || /^R_/.test(s.symbol);
                        // Include Jump Index markets
                        const isJumpIndex = /Jump/i.test(s.display_name) || /^JD/.test(s.symbol);
                        // Must be synthetic market
                        const isSynthetic = /synthetic/i.test(s.market) || /^R_/.test(s.symbol) || /^JD/.test(s.symbol);
                        return (isVolatility || isJumpIndex) && isSynthetic;
                    })
                    .map(s => ({ symbol: s.symbol, display_name: s.display_name }));
                setSymbols(syn);
                if (syn[0]?.symbol) {
                    setMarket(prev => prev || syn[0].symbol);
                }
            } catch (e) {
                console.error('Error loading symbols:', e);
            }
        };

        init();
        if (registerBotListeners) registerBotListeners();

        return () => {
            if (unregisterBotListeners) unregisterBotListeners();
            if (tickSubscription.current) {
                try {
                    if (tickSubscription.current.unsubscribe) {
                        tickSubscription.current.unsubscribe();
                    } else if (apiRef.current && tickSubscription.current) {
                        apiRef.current.forget({ forget: tickSubscription.current });
                    }
                } catch (e) {
                    console.error('Error unsubscribing ticks:', e);
                }
                tickSubscription.current = null;
            }
            if (autoTradingInterval.current) {
                clearInterval(autoTradingInterval.current);
                autoTradingInterval.current = null;
            }
            contractSubscriptions.current.forEach(sub => {
                try {
                    if (sub && typeof sub.unsubscribe === 'function') {
                        sub.unsubscribe();
                    }
                } catch (e) {
                    console.error('Error unsubscribing contract:', e);
                }
            });
            contractSubscriptions.current = [];
        };
    }, [active_tab]);

    // Update predictions when default stake changes
    useEffect(() => {
        if (useDefaultStake) {
            setPredictions(prev => prev.map(p => ({ ...p, stake: defaultStake })));
        }
    }, [defaultStake, useDefaultStake]);

    // Auto-update predictions in alternating mode
    useEffect(() => {
        if (alternatingMode && digitStats.length > 0 && !isPlacingTrades && !isAutoTradingGlobal) {
            selectDigits(alternatingModeState);
        }
    }, [alternatingMode, alternatingModeState]);

    // Update entry point predictions
    useEffect(() => {
        if (enableEntryPoint && digitStats.length > 0) {
            if (entryCondition === 'both') {
                setPredictionMode('least');
                selectDigits('least');
            } else if (whatToTrade === 'opposite') {
                const mode = entryCondition === 'most' ? 'least' : 'most';
                setPredictionMode(mode);
                selectDigits(mode);
            } else {
                const mode = whatToTrade === 'most' || whatToTrade === 'least' ? whatToTrade : 'most';
                setPredictionMode(mode);
                selectDigits(mode);
            }
        }
    }, [enableEntryPoint, whatToTrade, entryCondition]);

    // Subscribe to ticks
    useEffect(() => {
        if (active_tab !== DBOT_TABS.MATCHES) return;
        if (market && ticks && apiRef.current) {
            subscribeToTicks();
            return () => {
                if (tickSubscription.current) {
                    try {
                        if (typeof tickSubscription.current === 'string' && apiRef.current) {
                            apiRef.current.forget({ forget: tickSubscription.current });
                        } else if (
                            tickSubscription.current &&
                            typeof tickSubscription.current.unsubscribe === 'function'
                        ) {
                            tickSubscription.current.unsubscribe();
                        }
                    } catch (e) {
                        console.error('Error unsubscribing:', e);
                    }
                    tickSubscription.current = null;
                }
                isSubscribed.current = false;
            };
        }
    }, [market, ticks, active_tab]);

    const subscribeToTicks = async () => {
        if (!apiRef.current) {
            console.error('API not available for tick subscription');
            return;
        }

        const api = apiRef.current;

        // Clean up existing subscription
        if (tickSubscription.current) {
            try {
                if (typeof tickSubscription.current === 'string') {
                    api.forget({ forget: tickSubscription.current });
                } else if (tickSubscription.current && typeof tickSubscription.current.unsubscribe === 'function') {
                    tickSubscription.current.unsubscribe();
                }
            } catch (e) {
                console.error('Error cleaning up tick subscription:', e);
            }
            tickSubscription.current = null;
        }
        isSubscribed.current = false;
        allDigits.current = [];

        const tickCount = typeof ticks === 'string' ? parseInt(ticks) : ticks;
        if (!tickCount || tickCount < 1) {
            console.warn('Invalid tick count:', tickCount);
            return;
        }

        try {
            // Subscribe to live ticks
            const { subscription, error } = await api.send({ ticks: market, subscribe: 1 });
            if (error) throw error;
            if (subscription?.id) tickSubscription.current = subscription.id;

            // Listen for streaming ticks
            const onMsg = evt => {
                try {
                    const data = JSON.parse(evt.data);
                    if (data?.msg_type === 'tick' && data?.tick?.symbol === market) {
                        const quote = data.tick.quote;
                        const formattedPrice = parseFloat(quote).toFixed(pipSize.current || 4);
                        const digit = parseInt(formattedPrice[formattedPrice.length - 1]);

                        setCurrentDigit(digit);
                        allDigits.current.push(digit);
                        recentDigits.current.push(digit);
                        if (recentDigits.current.length > 10) {
                            recentDigits.current = recentDigits.current.slice(-10);
                        }

                        if (tickCount && allDigits.current.length > tickCount) {
                            allDigits.current = allDigits.current.slice(-tickCount);
                        }

                        analyzeDigits(allDigits.current);
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };

            api.connection?.addEventListener('message', onMsg);
            isSubscribed.current = true;

            // Also fetch historical ticks for initial analysis
            try {
                const historyResponse = await api.send({
                    ticks_history: market,
                    adjust_start_time: 1,
                    count: Math.min(tickCount, 1000),
                    end: 'latest',
                    start: 1,
                    style: 'ticks',
                });

                if (historyResponse?.history?.prices) {
                    const prices = historyResponse.history.prices;
                    pipSize.current = historyResponse.pip_size || 4;

                    const digits = prices.map(price => {
                        const formatted = price.toFixed(pipSize.current);
                        return parseInt(formatted[formatted.length - 1]);
                    });

                    allDigits.current = digits;
                    analyzeDigits(digits);
                }
            } catch (e) {
                console.error('Error fetching history:', e);
            }
        } catch (e) {
            console.error('Error subscribing to ticks:', e);
        }
    };

    // Analyze digits and calculate statistics
    const analyzeDigits = digits => {
        const counts = {};
        for (let i = 0; i <= 9; i++) {
            counts[i] = 0;
        }
        digits.forEach(digit => {
            counts[digit]++;
        });

        const stats = Object.entries(counts).map(([digit, count]) => ({
            digit: parseInt(digit),
            count,
            percentage: (count / digits.length) * 100,
        }));

        stats.sort((a, b) => b.count - a.count);
        setDigitStats(stats);
    };

    // Select digits based on mode
    const selectDigits = mode => {
        const selected = mode === 'most' ? digitStats.slice(0, 5) : digitStats.slice(-5);

        setPredictions(
            selected.map((stat, index) => ({
                id: Date.now() + index,
                digit: stat.digit,
                stake: defaultStake,
                enabled: true,
            }))
        );
    };

    // Update prediction stake
    const updatePredictionStake = (id, stake) => {
        setPredictions(prev => prev.map(p => (p.id === id ? { ...p, stake } : p)));
    };

    // Check if entry condition is met
    const checkEntryCondition = () => {
        const n = typeof lastNDigits === 'string' ? parseInt(lastNDigits) || 1 : lastNDigits;
        if (recentDigits.current.length < n) return false;

        const lastN = recentDigits.current.slice(-n);
        const mostDigits = digitStats.slice(0, 5).map(s => s.digit);
        const leastDigits = digitStats.slice(-5).map(s => s.digit);

        if (entryCondition === 'both') {
            const allMost = lastN.every(d => mostDigits.includes(d));
            const allLeast = lastN.every(d => leastDigits.includes(d));
            return allMost || allLeast;
        } else {
            const targetDigits = entryCondition === 'most' ? mostDigits : leastDigits;
            return lastN.every(d => targetDigits.includes(d));
        }
    };

    // Authorize if needed
    // DISABLED - replaced by DerivAuth.js
    // const authorizeIfNeeded = async () => {
    //     if (is_authorized || !apiRef.current) return;
    //     const token = V2GetActiveToken();
    //     if (!token) {
    //         console.warn('Please log in to place trades');
    //         throw new Error('No token');
    //     }
    //     try {
    //         const { authorize, error } = await apiRef.current.authorize(token);
    //         if (error) throw error;
    //         setIsAuthorized(true);
    //         const loginid = authorize?.loginid || V2GetActiveClientId();
    //         setAccountCurrency(authorize?.currency || currency);
    //     } catch (e) {
    //         console.error('Authorization error:', e);
    //         throw e;
    //     }
    // };

    // Place trades once
    const placeTradesOnce = async () => {
        if (!apiRef.current) {
            console.warn('API not initialized. Please check your connection.');
            return;
        }

        const enabledPredictions = predictions.filter(p => p.enabled);
        if (enabledPredictions.length === 0) {
            console.warn('Please add at least one enabled prediction');
            return;
        }

        if (!market) {
            console.warn('Please select a market.');
            return;
        }

        // Open run panel and set up for transactions
        if (run_panel) {
            run_panel.toggleDrawer(true);
            run_panel.setActiveTabIndex(1); // Transactions tab
            run_panel.run_id = `matches-${Date.now()}`;
            run_panel.setIsRunning(true);
            run_panel.setContractStage(contract_stages.STARTING);
        }

        setIsPlacingTrades(true);

        try {
            await authorizeIfNeeded();
            const api = apiRef.current;
            const curr = account_currency || currency;
            const symbol_display = symbols.find(s => s.symbol === market)?.display_name || market;

            // Place all trades in parallel using Promise.all
            const tradePromises = enabledPredictions.map(async prediction => {
                const stake = prediction.stake;
                try {
                    // Use buy() method directly like SpeedBot
                    const buy_req = {
                        buy: '1',
                        price: stake,
                        parameters: {
                            amount: stake,
                            basis: 'stake',
                            contract_type: 'DIGITMATCH',
                            currency: curr,
                            duration: 1,
                            duration_unit: 't',
                            symbol: market,
                            barrier: prediction.digit.toString(),
                        },
                    };

                    const { buy, error } = await api.buy(buy_req);
                    if (error) throw error;

                    if (buy?.contract_id) {
                        // Add to transactions panel immediately
                        try {
                            if (transactions?.onBotContractEvent) {
                                transactions.onBotContractEvent({
                                    contract_id: buy.contract_id,
                                    transaction_ids: { buy: buy.transaction_id },
                                    buy_price: buy.buy_price,
                                    currency: curr,
                                    contract_type: 'DIGITMATCH',
                                    underlying: market,
                                    display_name: symbol_display,
                                    date_start: Math.floor(Date.now() / 1000),
                                    status: 'open',
                                });
                            }
                        } catch (e) {
                            console.error('Error adding to transactions:', e);
                        }

                        if (run_panel) {
                            run_panel.setHasOpenContract(true);
                            run_panel.setContractStage(contract_stages.PURCHASE_SENT);
                        }

                        // Subscribe to contract updates
                        try {
                            const res = await api.send({
                                proposal_open_contract: 1,
                                contract_id: buy.contract_id,
                                subscribe: 1,
                            });

                            const { error: subError, proposal_open_contract: pocInit, subscription } = res || {};
                            if (subError) throw subError;

                            // Push initial snapshot if present
                            if (pocInit && String(pocInit?.contract_id || '') === String(buy.contract_id)) {
                                if (transactions?.onBotContractEvent) {
                                    transactions.onBotContractEvent(pocInit);
                                }
                                if (run_panel) {
                                    run_panel.setHasOpenContract(true);
                                }
                            }

                            // Listen for streaming updates
                            const onMsg = evt => {
                                try {
                                    const data = JSON.parse(evt.data);
                                    if (data?.msg_type === 'proposal_open_contract') {
                                        const poc = data.proposal_open_contract;
                                        if (String(poc?.contract_id || '') === String(buy.contract_id)) {
                                            if (transactions?.onBotContractEvent) {
                                                transactions.onBotContractEvent(poc);
                                            }
                                            if (run_panel) {
                                                run_panel.setHasOpenContract(true);
                                                if (poc?.is_sold || poc?.status === 'sold') {
                                                    run_panel.setContractStage(contract_stages.CONTRACT_CLOSED);
                                                    run_panel.setHasOpenContract(false);
                                                    api.connection?.removeEventListener('message', onMsg);
                                                }
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // Ignore parse errors
                                }
                            };

                            api.connection?.addEventListener('message', onMsg);
                            contractSubscriptions.current.push({
                                unsubscribe: () => api.connection?.removeEventListener('message', onMsg),
                            });
                        } catch (e) {
                            console.error('Error subscribing to contract:', e);
                        }

                        return { success: true, digit: prediction.digit, contract_id: buy.contract_id };
                    }
                    return { success: false, digit: prediction.digit, error: 'No contract ID returned' };
                } catch (error) {
                    console.error(`Error placing trade for digit ${prediction.digit}:`, error);
                    return { success: false, digit: prediction.digit, error: error.message || 'Unknown error' };
                }
            });

            // Wait for all trades to complete
            const results = await Promise.all(tradePromises);

            const successful = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);

            console.log(`=== Trade Once Complete ===`);
            console.log(`Successful: ${successful.length}/${results.length}`);
            console.log(`Failed: ${failed.length}/${results.length}`);

            if (failed.length > 0) {
                console.warn(
                    `${successful.length} trades placed successfully. ${failed.length} failed. Check console for details.`
                );
            } else {
                console.log(`Successfully placed ${successful.length} trade(s)! All trades are now active.`);
            }

            // Keep run panel running to show contracts - don't set to NOT_RUNNING here
            // It will be updated when contracts close
        } catch (error) {
            console.error('Error placing trades:', error);
            console.error(`Error placing trades: ${error.message || 'Unknown error'}`);
            if (run_panel) {
                run_panel.setIsRunning(false);
                run_panel.setContractStage(contract_stages.NOT_RUNNING);
            }
        } finally {
            setIsPlacingTrades(false);
        }
    };

    // Start auto trading
    const startAutoTrading = async () => {
        const enabledPredictions = predictions.filter(p => p.enabled);
        if (enabledPredictions.length === 0) {
            console.warn('Please add at least one enabled prediction');
            return;
        }

        // Open run panel and set up for transactions
        if (run_panel) {
            run_panel.toggleDrawer(true);
            run_panel.setActiveTabIndex(1); // Transactions tab
            run_panel.run_id = `matches-auto-${Date.now()}`;
            run_panel.setIsRunning(true);
            run_panel.setContractStage(contract_stages.STARTING);
        }

        setIsAutoTradingGlobal(true);
        isAutoTrading.current = true;
        profitLoss.current = 0;

        const tradeInterval = async () => {
            if (!isAutoTrading.current || !autoTradingInterval.current || isProcessingTrade.current) {
                return;
            }

            // Check take profit / stop loss
            if (takeProfit && profitLoss.current >= parseFloat(takeProfit.toString())) {
                console.log(`Take Profit reached: $${profitLoss.current.toFixed(2)}`);
                stopAutoTradingFunction();
                return;
            }

            if (stopLoss && profitLoss.current <= -parseFloat(stopLoss.toString())) {
                console.log(`Stop Loss reached: $${profitLoss.current.toFixed(2)}`);
                stopAutoTradingFunction();
                return;
            }

            // Check entry condition
            if (!checkEntryCondition()) {
                console.log('Entry point condition not met, waiting...');
                entryConditionMet.current = false;
                return;
            }

            if (enableEntryPoint && entryConditionMet.current) {
                console.log('Entry point still met, waiting for condition to reset...');
                return;
            }

            entryConditionMet.current = true;
            isProcessingTrade.current = true;

            // Update predictions based on mode
            if (alternatingMode) {
                selectDigits(alternatingModeState);
                setAlternatingModeState(prev => (prev === 'most' ? 'least' : 'most'));
            } else if (enableEntryPoint && entryCondition === 'both') {
                const n = typeof lastNDigits === 'string' ? parseInt(lastNDigits) || 1 : lastNDigits;
                const lastN = recentDigits.current.slice(-n);
                const mostDigits = digitStats.slice(0, 5).map(s => s.digit);
                const allMost = lastN.every(d => mostDigits.includes(d));
                selectDigits(allMost ? 'least' : 'most');
            } else if (enableEntryPoint && whatToTrade === 'opposite') {
                selectDigits(entryCondition === 'most' ? 'least' : 'most');
            } else if (predictionMode !== 'custom') {
                selectDigits(predictionMode === 'most' || predictionMode === 'least' ? predictionMode : 'most');
            }

            const enabledPredictions = predictions.filter(p => p.enabled);
            if (enabledPredictions.length === 0) {
                isProcessingTrade.current = false;
                return;
            }

            // Place trades
            if (!apiRef.current) {
                console.error('API not available for auto trading');
                isProcessingTrade.current = false;
                return;
            }

            const api = apiRef.current;
            const curr = account_currency || currency;
            const symbol_display = symbols.find(s => s.symbol === market)?.display_name || market;
            await authorizeIfNeeded().catch(() => {});

            const trades = enabledPredictions.map(async prediction => {
                const stake = prediction.stake;
                try {
                    const buy_req = {
                        buy: '1',
                        price: stake,
                        parameters: {
                            amount: stake,
                            basis: 'stake',
                            contract_type: 'DIGITMATCH',
                            currency: curr,
                            duration: 1,
                            duration_unit: 't',
                            symbol: market,
                            barrier: prediction.digit.toString(),
                        },
                    };

                    const { buy, error } = await api.buy(buy_req);
                    if (error) throw error;

                    if (buy?.contract_id) {
                        const contractId = buy.contract_id;

                        // Add to transactions panel immediately
                        try {
                            if (transactions?.onBotContractEvent) {
                                transactions.onBotContractEvent({
                                    contract_id: buy.contract_id,
                                    transaction_ids: { buy: buy.transaction_id },
                                    buy_price: buy.buy_price,
                                    currency: curr,
                                    contract_type: 'DIGITMATCH',
                                    underlying: market,
                                    display_name: symbol_display,
                                    date_start: Math.floor(Date.now() / 1000),
                                    status: 'open',
                                });
                            }
                        } catch (e) {
                            console.error('Error adding to transactions:', e);
                        }

                        if (run_panel) {
                            run_panel.setHasOpenContract(true);
                            run_panel.setContractStage(contract_stages.PURCHASE_SENT);
                        }

                        // Subscribe to contract updates
                        try {
                            const res = await api.send({
                                proposal_open_contract: 1,
                                contract_id: contractId,
                                subscribe: 1,
                            });

                            const { error: subError, proposal_open_contract: pocInit, subscription } = res || {};
                            if (subError) throw subError;

                            // Push initial snapshot if present
                            if (pocInit && String(pocInit?.contract_id || '') === String(contractId)) {
                                if (transactions?.onBotContractEvent) {
                                    transactions.onBotContractEvent(pocInit);
                                }
                                if (run_panel) {
                                    run_panel.setHasOpenContract(true);
                                }
                            }

                            // Listen for streaming updates
                            const handler = evt => {
                                try {
                                    const data = JSON.parse(evt.data);
                                    if (data?.msg_type === 'proposal_open_contract') {
                                        const poc = data.proposal_open_contract;
                                        if (String(poc?.contract_id || '') === String(contractId)) {
                                            if (transactions?.onBotContractEvent) {
                                                transactions.onBotContractEvent(poc);
                                            }
                                            if (run_panel) {
                                                run_panel.setHasOpenContract(true);
                                                if (poc?.is_sold || poc?.status === 'sold') {
                                                    const profit =
                                                        parseFloat(poc.sell_price || 0) -
                                                        parseFloat(poc.buy_price || 0);
                                                    profitLoss.current += profit;
                                                    run_panel.setContractStage(contract_stages.CONTRACT_CLOSED);
                                                    run_panel.setHasOpenContract(false);
                                                    api.connection?.removeEventListener('message', handler);
                                                }
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // Ignore parse errors
                                }
                            };

                            api.connection?.addEventListener('message', handler);
                            contractSubscriptions.current.push({
                                unsubscribe: () => api.connection?.removeEventListener('message', handler),
                            });
                        } catch (e) {
                            console.error('Error subscribing to contract:', e);
                        }
                    }
                } catch (error) {
                    console.error(`Auto trading error for digit ${prediction.digit}:`, error);
                }
            });

            await Promise.all(trades);
            isProcessingTrade.current = false;
        };

        entryConditionMet.current = false;
        await tradeInterval();
        autoTradingInterval.current = setInterval(tradeInterval, 500);
    };

    // Stop auto trading
    const stopAutoTradingFunction = () => {
        isAutoTrading.current = false;
        if (autoTradingInterval.current) {
            clearInterval(autoTradingInterval.current);
            autoTradingInterval.current = null;
        }
        entryConditionMet.current = false;
        isProcessingTrade.current = false;

        contractSubscriptions.current.forEach(sub => {
            try {
                if (sub && typeof sub.unsubscribe === 'function') {
                    sub.unsubscribe();
                }
            } catch (e) {
                console.error('Error unsubscribing:', e);
            }
        });
        contractSubscriptions.current = [];
        profitLoss.current = 0;
        setIsAutoTradingGlobal(false);

        if (run_panel) {
            run_panel.setIsRunning(false);
            run_panel.setHasOpenContract(false);
            run_panel.setContractStage(contract_stages.NOT_RUNNING);
        }
    };

    // Toggle prediction
    const togglePrediction = digit => {
        const existing = predictions.find(p => p.digit === digit);
        if (existing?.enabled) {
            setPredictions(prev => prev.filter(p => p.digit !== digit));
            setPredictionMode('custom');
        } else {
            if (predictions.length >= 10) {
                console.warn('Maximum 10 predictions allowed');
                return;
            }
            setPredictions(prev => [
                ...prev,
                {
                    id: Date.now() + digit,
                    digit,
                    stake: defaultStake,
                    enabled: true,
                },
            ]);
            setPredictionMode('custom');
        }
    };

    const enabledCount = predictions.filter(p => p.enabled).length;
    const totalStake = predictions
        .filter(p => p.enabled)
        .reduce((sum, p) => sum + (parseFloat(p.stake.toString()) || 0), 0);

    return (
        <div className='matches-container'>
            {/* Header with Title */}
            <div className='matches-header'>
                <div className='matches-title'>
                    <h2>{localize('MATCHES GAME CHANGER🔥')}</h2>
                </div>

                {/* Controls */}
                <div className='matches-controls'>
                    <div className='control-group'>
                        <label>{localize('Market')}:</label>
                        <select
                            value={market}
                            onChange={e => setMarket(e.target.value)}
                            disabled={isPlacingTrades || isAutoTradingGlobal}
                        >
                            {symbols.map(symbol => (
                                <option key={symbol.symbol} value={symbol.symbol}>
                                    {symbol.display_name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className='control-group'>
                        <label>{localize('Ticks')}:</label>
                        <input
                            type='number'
                            value={ticks}
                            onChange={e => {
                                const value = e.target.value;
                                if (value === '') setTicks('');
                                else {
                                    const num = parseInt(value);
                                    if (!isNaN(num) && num >= 1 && num <= 5000) {
                                        setTicks(num);
                                    }
                                }
                            }}
                            onBlur={e => {
                                if (e.target.value === '' || parseInt(e.target.value) < 1) {
                                    setTicks(1000);
                                }
                            }}
                            min={1}
                            max={5000}
                            placeholder='1000'
                            disabled={isPlacingTrades || isAutoTradingGlobal}
                        />
                    </div>

                    <div className='control-group'>
                        <span className='current-digit current-digit-blue'>{currentDigit}</span>
                    </div>
                </div>
            </div>

            {/* Digit Analysis */}
            <div className='digit-analysis'>
                <div className='digit-chart-container'>
                    <div className='digit-bars-chart'>
                        {digitStats.map((stat, index) => {
                            const isTop = index < 5;
                            const isBottom = index >= digitStats.length - 5;
                            const distance = Math.abs(index - 4.5);

                            return (
                                <div key={stat.digit} className='digit-bar-column'>
                                    <div className='percentage-label'>{stat.percentage.toFixed(2)}%</div>
                                    <div
                                        className={`bar-vertical ${isTop ? 'bar-top' : isBottom ? 'bar-bottom' : 'bar-neutral'}`}
                                        style={{
                                            height: `${30 + 14 * distance}%`,
                                            backgroundColor: isTop ? '#4fd1c5' : isBottom ? '#ef4444' : '#e5e7eb',
                                        }}
                                    >
                                        <div className='digit-label-inside'>{stat.digit}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                <div className='action-buttons-row'>
                    <button
                        className='action-button green-button'
                        onClick={() => {
                            selectDigits('most');
                            setPredictionMode('most');
                        }}
                        disabled={predictions.length >= 10}
                    >
                        {localize('Match most appearing digits')}
                    </button>
                    <button
                        className='action-button red-button'
                        onClick={() => {
                            selectDigits('least');
                            setPredictionMode('least');
                        }}
                        disabled={predictions.length >= 10}
                    >
                        {localize('Match least appearing digits')}
                    </button>
                </div>
            </div>

            {/* Predictions Section */}
            <div className='predictions-section'>
                <h3>
                    {localize('Predictions')} ({enabledCount}/10 Active)
                </h3>

                {/* Stake Control */}
                <div className='stake-control'>
                    <div className='toggle-container'>
                        <span className='toggle-label'>{localize('Use Default Stake')}:</span>
                        <label className='toggle-switch'>
                            <input
                                type='checkbox'
                                checked={useDefaultStake}
                                onChange={e => setUseDefaultStake(e.target.checked)}
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                            <span className='slider'></span>
                        </label>
                    </div>

                    <div className='default-stake-input'>
                        <label>{localize('Default Stake')}:</label>
                        <input
                            type='number'
                            value={defaultStake}
                            onChange={e => setDefaultStake(e.target.value === '' ? '' : parseFloat(e.target.value))}
                            step={0.01}
                            disabled={isPlacingTrades || isAutoTradingGlobal}
                        />
                    </div>
                </div>

                {/* Advanced Controls */}
                <div className='advanced-controls'>
                    <div className='toggle-container'>
                        <span className='toggle-label'>{localize('Alternating Mode')}:</span>
                        <label className='toggle-switch'>
                            <input
                                type='checkbox'
                                checked={alternatingMode}
                                onChange={e => setAlternatingMode(e.target.checked)}
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                            <span className='slider'></span>
                        </label>
                        <span className='alternating-hint'>
                            (Most ↔ Least)
                            {alternatingMode && (
                                <span className='current-mode'>
                                    {' '}
                                    - Current: <strong>{alternatingModeState === 'most' ? 'MOST' : 'LEAST'}</strong>
                                </span>
                            )}
                        </span>
                    </div>

                    <div className='toggle-container'>
                        <span className='toggle-label'>{localize('Enable Entry Point')}:</span>
                        <label className='toggle-switch'>
                            <input
                                type='checkbox'
                                checked={enableEntryPoint}
                                onChange={e => setEnableEntryPoint(e.target.checked)}
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                            <span className='slider'></span>
                        </label>
                        <span className='alternating-hint'>(Wait for condition before trading)</span>
                    </div>
                </div>

                {/* Entry Point Configuration */}
                {enableEntryPoint && (
                    <div className='entry-point-config'>
                        <h4>{localize('Entry Point Configuration')}</h4>
                        <div className='entry-point-controls'>
                            <div className='control-group'>
                                <label>{localize('Last N Digits')}:</label>
                                <input
                                    type='number'
                                    value={lastNDigits}
                                    onChange={e => {
                                        const value = e.target.value;
                                        if (value === '') setLastNDigits('');
                                        else {
                                            const num = parseInt(value);
                                            if (num >= 1 && num <= 10) {
                                                setLastNDigits(num);
                                            }
                                        }
                                    }}
                                    onBlur={e => {
                                        if (e.target.value === '' || parseInt(e.target.value) < 1) {
                                            setLastNDigits(5);
                                        }
                                    }}
                                    min={1}
                                    max={10}
                                    disabled={isPlacingTrades || isAutoTradingGlobal}
                                />
                            </div>

                            <div className='control-group'>
                                <label>{localize('Condition')}:</label>
                                <select
                                    value={entryCondition}
                                    onChange={e => setEntryCondition(e.target.value)}
                                    disabled={isPlacingTrades || isAutoTradingGlobal}
                                >
                                    <option value='most'>{localize('All Most Appearing')}</option>
                                    <option value='least'>{localize('All Least Appearing')}</option>
                                    <option value='both'>{localize('All Most OR All Least (Trade Opposite)')}</option>
                                </select>
                            </div>

                            {(entryCondition === 'most' || entryCondition === 'least') && (
                                <div className='control-group'>
                                    <label>{localize('What to Trade')}:</label>
                                    <select
                                        value={whatToTrade}
                                        onChange={e => setWhatToTrade(e.target.value)}
                                        disabled={isPlacingTrades || isAutoTradingGlobal || alternatingMode}
                                    >
                                        <option value='most'>{localize('Most Appearing')}</option>
                                        <option value='least'>{localize('Least Appearing')}</option>
                                        <option value='opposite'>{localize('Opposite of Entry Condition')}</option>
                                    </select>
                                    <span className='alternating-hint'>
                                        {whatToTrade === 'opposite'
                                            ? `(Will trade ${entryCondition === 'most' ? 'LEAST' : 'MOST'} appearing)`
                                            : whatToTrade === 'most'
                                              ? '(Will trade MOST appearing)'
                                              : '(Will trade LEAST appearing)'}
                                    </span>
                                </div>
                            )}
                        </div>

                        <div className='entry-status-inline'>
                            <div className='status-item'>
                                <strong>
                                    {localize('Last')} {lastNDigits} {localize('digits')}:
                                </strong>
                                <span className='digit-sequence'>
                                    {(() => {
                                        const n =
                                            typeof lastNDigits === 'string' ? parseInt(lastNDigits) || 1 : lastNDigits;
                                        return recentDigits.current.length >= n
                                            ? recentDigits.current.slice(-n).join(', ')
                                            : localize('Collecting data...');
                                    })()}
                                </span>
                            </div>
                            <div className='status-item'>
                                <span className={checkEntryCondition() ? 'condition-met' : 'condition-not-met'}>
                                    {checkEntryCondition()
                                        ? `✓ ${localize('Entry condition MET - Ready to trade')}`
                                        : `✗ ${localize('Entry condition NOT met - Waiting...')}`}
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Profit/Loss Section */}
                <div className='profit-loss-section'>
                    <div className='profit-loss-controls'>
                        <div className='input-group'>
                            <label>{localize('Take Profit')}:</label>
                            <input
                                type='number'
                                value={takeProfit}
                                onChange={e => setTakeProfit(e.target.value)}
                                min={0}
                                step={0.01}
                                placeholder='0.00'
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                        </div>
                        <div className='input-group'>
                            <label>{localize('Stop Loss')}:</label>
                            <input
                                type='number'
                                value={stopLoss}
                                onChange={e => setStopLoss(e.target.value)}
                                min={0}
                                step={0.01}
                                placeholder='0.00'
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                        </div>
                    </div>
                </div>

                {/* Predictions Table */}
                <table className='predictions-table'>
                    <tbody>
                        <tr className='prediction-row'>
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => {
                                const prediction = predictions.find(p => p.digit === digit);
                                const isEnabled = prediction?.enabled || false;

                                return (
                                    <td key={digit} className={`prediction-cell ${isEnabled ? 'selected' : ''}`}>
                                        <div className='prediction-cell-content'>
                                            <label className='checkbox-wrapper'>
                                                <input
                                                    type='checkbox'
                                                    className='prediction-checkbox'
                                                    checked={isEnabled}
                                                    onChange={e => {
                                                        if (e.target.checked) {
                                                            if (predictions.length >= 10) {
                                                                console.warn('Maximum 10 predictions allowed');
                                                                return;
                                                            }
                                                            setPredictions(prev => [
                                                                ...prev,
                                                                {
                                                                    id: Date.now() + digit,
                                                                    digit,
                                                                    stake: defaultStake,
                                                                    enabled: true,
                                                                },
                                                            ]);
                                                            setPredictionMode('custom');
                                                        } else {
                                                            setPredictions(prev => prev.filter(p => p.digit !== digit));
                                                            setPredictionMode('custom');
                                                        }
                                                    }}
                                                    disabled={isPlacingTrades || isAutoTradingGlobal}
                                                />
                                            </label>
                                            <div className='prediction-number'>{digit}</div>
                                        </div>
                                    </td>
                                );
                            })}
                        </tr>
                        <tr className='stake-row'>
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => {
                                const prediction = predictions.find(p => p.digit === digit);
                                const isEnabled = prediction?.enabled || false;

                                return (
                                    <td key={digit} className={`stake-cell ${isEnabled ? 'selected' : ''}`}>
                                        <input
                                            type='number'
                                            className='stake-input-box'
                                            value={prediction?.stake || defaultStake}
                                            onChange={e => {
                                                if (prediction) {
                                                    updatePredictionStake(
                                                        prediction.id,
                                                        e.target.value === '' ? '' : parseFloat(e.target.value)
                                                    );
                                                }
                                            }}
                                            step={0.01}
                                            disabled={
                                                !isEnabled || useDefaultStake || isPlacingTrades || isAutoTradingGlobal
                                            }
                                            placeholder='0.35'
                                        />
                                    </td>
                                );
                            })}
                        </tr>
                    </tbody>
                </table>

                {/* Predictions Footer */}
                <div className='predictions-footer'>
                    <p>
                        Total Stake: <span className='total-stake'>${totalStake.toFixed(2)}</span>
                    </p>
                    <p className='footer-hint'>
                        Adjust stakes by toggling off "Use Default Stake" and editing individual values
                    </p>
                </div>
            </div>

            {/* Trading Controls */}
            <div className='trading-controls'>
                <button
                    className='trade-button trade-once'
                    onClick={placeTradesOnce}
                    disabled={isPlacingTrades || isAutoTradingGlobal || enabledCount === 0}
                >
                    {isPlacingTrades ? localize('Placing Trades...') : localize('Trade Once')}
                </button>

                {isAutoTradingGlobal ? (
                    <button className='trade-button stop-auto' onClick={stopAutoTradingFunction}>
                        {localize('Stop Auto Trading')}
                    </button>
                ) : (
                    <button
                        className='trade-button auto-trade'
                        onClick={startAutoTrading}
                        disabled={isPlacingTrades || enabledCount === 0}
                    >
                        {localize('Start Auto Trading')}
                    </button>
                )}
            </div>
        </div>
    );
});

export default Matches;
