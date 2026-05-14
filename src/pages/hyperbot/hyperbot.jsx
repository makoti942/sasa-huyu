// XENON HYPERBOT - Over/Under Trading Component
import React, { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { localize } from '@deriv-com/translations';
import {
    generateDerivApiInstance,
    V2GetActiveToken,
    V2GetActiveClientId,
} from '@/external/bot-skeleton/services/api/appId';
import { contract_stages } from '@/constants/contract-stage';
import { useStore } from '@/hooks/useStore';
import './hyperbot.css';

const Hyperbot = observer(() => {
    // State Management
    const [market, setMarket] = useState('');
    const [ticks, setTicks] = useState(1000);
    const [currentDigit, setCurrentDigit] = useState('--');
    const [threshold, setThreshold] = useState(5);
    const [symbols, setSymbols] = useState([]);
    const [predictions, setPredictions] = useState([]);
    const [defaultStake, setDefaultStake] = useState(0.5);
    const [useDefaultStake, setUseDefaultStake] = useState(true);
    const [isPlacingTrades, setIsPlacingTrades] = useState(false);
    const [overUnderStats, setOverUnderStats] = useState({
        over: 0,
        under: 0,
        equal: 0,
        overPct: 0,
        underPct: 0,
        equalPct: 0,
    });
    const [recentOverUnder, setRecentOverUnder] = useState([]);
    const [isAutoTradingGlobal, setIsAutoTradingGlobal] = useState(false);
    const [enableEntryPoint, setEnableEntryPoint] = useState(false);
    const [entryPointDigit, setEntryPointDigit] = useState(5);
    const [lockEntryPoint, setLockEntryPoint] = useState(false);
    const [quadState, setQuadState] = useState({ status: 'waiting', lastDigits: [] });


    // Refs
    const recentDigits = useRef([]);
    const allDigits = useRef([]);
    const isSubscribed = useRef(false);
    const tickSubscription = useRef(null);
    const pipSize = useRef(4);
    const contractSubscriptions = useRef([]);
    const autoTradingInterval = useRef(null);
    const isAutoTrading = useRef(false);
    const isProcessingTrade = useRef(false);
    const entryPointMet = useRef(false);
    const enableEntryPointRef = useRef(enableEntryPoint);
    const entryPointDigitRef = useRef(entryPointDigit);

    // Keep refs in sync with state for tick handler
    useEffect(() => {
        enableEntryPointRef.current = enableEntryPoint;
    }, [enableEntryPoint]);

    useEffect(() => {
        entryPointDigitRef.current = entryPointDigit;
    }, [entryPointDigit]);

    // Store and API setup
    const store = useStore();
    const { run_panel, client, transactions } = store || {};
    const { registerBotListeners, unregisterBotListeners } = run_panel || {};
    const currency = client?.currency || 'USD';

    // Safety check - if store is not available, return null to prevent crash
    if (!store || !run_panel || !client) {
        return null;
    }

    // API instances
    const apiRef = useRef(null);
    const [is_authorized, setIsAuthorized] = useState(false);
    const [account_currency, setAccountCurrency] = useState(currency);

    // Initialize API and load symbols
    useEffect(() => {
        const init = async () => {
            const api = generateDerivApiInstance();
            apiRef.current = api;

            // Load symbols
            try {
                const { active_symbols, error } = await api.send({ active_symbols: 'brief' });
                if (error) throw error;
                const syn = (active_symbols || [])
                    .filter(s => /synthetic/i.test(s.market) || /^R_/.test(s.symbol))
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
            // Stop auto trading if running
            if (isAutoTrading.current && autoTradingInterval.current) {
                isAutoTrading.current = false;
                clearInterval(autoTradingInterval.current);
                autoTradingInterval.current = null;
                isProcessingTrade.current = false;
            }

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
    }, []);

    // Update predictions when default stake changes
    useEffect(() => {
        if (useDefaultStake) {
            setPredictions(prev => prev.map(p => ({ ...p, stake: defaultStake })));
        }
    }, [defaultStake, useDefaultStake]);

    // Update predictions when threshold changes - recalculate contract types
    useEffect(() => {
        const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
        setPredictions(prev =>
            prev
                .map(p => {
                    // FIXED LOGIC: Recalculate contract types when threshold changes
                    // - Digits UNDER threshold → DIGITOVER (win if result > digit)
                    // - Digits OVER threshold → DIGITUNDER (win if result < digit)
                    // - Digit EQUALS threshold → Remove (cannot trade)
                    if (p.digit < thresh) {
                        return { ...p, contractType: 'DIGITOVER' };
                    } else if (p.digit > thresh) {
                        return { ...p, contractType: 'DIGITUNDER' };
                    } else {
                        // Digit equals threshold - remove it
                        return null;
                    }
                })
                .filter(p => p !== null)
        );
    }, [threshold]);

    // Subscribe to ticks
    useEffect(() => {
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
    }, [market, ticks, threshold]);

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
                        
                        const priceStr = String(quote);
                        const digits = priceStr.replace('.', '').slice(-4);
            
                        if (digits.length === 4) {
                            const lastFourDigits = digits.split('').map(d => parseInt(d));
                            setCurrentDigit(lastFourDigits[3]); // Update single digit display
            
                            // Update quad state
                            setQuadState({ status: 'monitoring', lastDigits: lastFourDigits });
            
                            // Push the last single digit to other arrays for existing logic
                            allDigits.current.push(lastFourDigits[3]);
                            recentDigits.current.push(lastFourDigits[3]);
                            if (recentDigits.current.length > 50) {
                                recentDigits.current = recentDigits.current.slice(-50);
                            }
            
                            if (tickCount && allDigits.current.length > tickCount) {
                                allDigits.current = allDigits.current.slice(-tickCount);
                            }
            
                            // Keep other logic running on the last digit
                            analyzeOverUnder(allDigits.current);
                        } else {
                            setQuadState(prevState => ({ ...prevState, status: 'waiting' }));
                        }
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
                    analyzeOverUnder(digits);
                }
            } catch (e) {
                console.error('Error fetching history:', e);
            }
        } catch (e) {
            console.error('Error subscribing to ticks:', e);
        }
    };

    // Analyze over/under statistics
    const analyzeOverUnder = digits => {
        const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
        let over = 0,
            under = 0,
            equal = 0;
        const recent = [];

        digits.forEach(digit => {
            if (digit > thresh) {
                over++;
                recent.push('O');
            } else if (digit < thresh) {
                under++;
                recent.push('U');
            } else {
                equal++;
                recent.push('=');
            }
        });

        const total = digits.length || 1;
        setOverUnderStats({
            over,
            under,
            equal,
            overPct: (over / total) * 100,
            underPct: (under / total) * 100,
            equalPct: (equal / total) * 100,
        });

        // Keep last 20 for display
        setRecentOverUnder(recent.slice(-20));
    };

    // Update prediction stake
    const updatePredictionStake = (digit, stake) => {
        setPredictions(prev => prev.map(p => (p.digit === digit ? { ...p, stake } : p)));
    };

    // Toggle prediction for a digit
    const togglePrediction = digit => {
        const existing = predictions.find(p => p.digit === digit);
        if (existing?.enabled) {
            setPredictions(prev => prev.filter(p => p.digit !== digit));
        } else {
            if (predictions.length >= 10) {
                alert('Maximum 10 predictions allowed');
                return;
            }
            const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
            // FIXED LOGIC:
            // - Digits UNDER threshold → DIGITOVER (win if result > digit)
            //   Example: digit=1, threshold=5 → DIGITOVER barrier=1 → Win if result > 1
            // - Digits OVER threshold → DIGITUNDER (win if result < digit)
            //   Example: digit=6, threshold=5 → DIGITUNDER barrier=6 → Win if result < 6
            const contractType = digit < thresh ? 'DIGITOVER' : digit > thresh ? 'DIGITUNDER' : null;

            if (!contractType) {
                alert(
                    `Digit ${digit} equals threshold ${thresh}. Please select digits that are above or below the threshold.`
                );
                return;
            }

            setPredictions(prev => [
                ...prev,
                {
                    id: Date.now() + digit,
                    digit,
                    contractType,
                    stake: defaultStake,
                    enabled: true,
                },
            ]);
        }
    };

    // Select digits that are over threshold
    const selectOverDigits = () => {
        const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
        const overDigits = [];
        for (let i = thresh + 1; i <= 9; i++) {
            overDigits.push(i);
        }

        if (overDigits.length === 0) {
            alert(`No digits are over threshold ${thresh}`);
            return;
        }

        // FIXED: Digits OVER threshold use DIGITUNDER contracts (win if result < digit)
        // Example: Threshold=5, select digits 6,7,8,9
        //   - Digit 6: DIGITUNDER barrier=6 → Win if result < 6 (e.g., result=4 → 4<6 → WIN ✓)
        //   - Digit 7: DIGITUNDER barrier=7 → Win if result < 7 (e.g., result=4 → 4<7 → WIN ✓)
        //   - Digit 8: DIGITUNDER barrier=8 → Win if result < 8 (e.g., result=4 → 4<8 → WIN ✓)
        //   - Digit 9: DIGITUNDER barrier=9 → Win if result < 9 (e.g., result=4 → 4<9 → WIN ✓)
        const newPredictions = overDigits.map(digit => ({
            id: Date.now() + digit,
            digit,
            contractType: 'DIGITUNDER',
            stake: defaultStake,
            enabled: true,
        }));

        // Remove existing predictions for these digits and add new ones
        setPredictions(prev => {
            const filtered = prev.filter(p => !overDigits.includes(p.digit));
            return [...filtered, ...newPredictions];
        });
    };

    // Select digits that are under threshold
    const selectUnderDigits = () => {
        const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
        const underDigits = [];
        for (let i = 0; i < thresh; i++) {
            underDigits.push(i);
        }

        if (underDigits.length === 0) {
            alert(`No digits are under threshold ${thresh}`);
            return;
        }

        // FIXED: Digits UNDER threshold use DIGITOVER contracts (win if result > digit)
        // Example: Threshold=5, select digits 1,2,3,4
        //   - Digit 1: DIGITOVER barrier=1 → Win if result > 1 (e.g., result=5 → 5>1 → WIN ✓)
        //   - Digit 2: DIGITOVER barrier=2 → Win if result > 2 (e.g., result=5 → 5>2 → WIN ✓)
        //   - Digit 3: DIGITOVER barrier=3 → Win if result > 3 (e.g., result=5 → 5>3 → WIN ✓)
        //   - Digit 4: DIGITOVER barrier=4 → Win if result > 4 (e.g., result=5 → 5>4 → WIN ✓)
        const newPredictions = underDigits.map(digit => ({
            id: Date.now() + digit,
            digit,
            contractType: 'DIGITOVER',
            stake: defaultStake,
            enabled: true,
        }));

        // Remove existing predictions for these digits and add new ones
        setPredictions(prev => {
            const filtered = prev.filter(p => !underDigits.includes(p.digit));
            return [...filtered, ...newPredictions];
        });
    };

    // Authorize if needed
    // DISABLED - replaced by DerivAuth.js
    // const authorizeIfNeeded = async () => {
    //     if (is_authorized || !apiRef.current) return;
    //     const token = V2GetActiveToken();
    //     if (!token) {
    //         alert('Please log in to place trades');
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
            alert('API not initialized. Please check your connection.');
            return;
        }

        const enabledPredictions = predictions.filter(p => p.enabled);
        if (enabledPredictions.length === 0) {
            alert('Please select at least one digit to trade');
            return;
        }

        if (!market) {
            alert('Please select a market.');
            return;
        }

        const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
        if (isNaN(thresh) || thresh < 0 || thresh > 9) {
            alert('Please set a valid threshold (0-9)');
            return;
        }

        // Open run panel and set up for transactions
        if (run_panel) {
            run_panel.toggleDrawer(true);
            run_panel.setActiveTabIndex(1); // Transactions tab
            run_panel.run_id = `hyperbot-${Date.now()}`;
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
                    const contractType = prediction.contractType; // DIGITOVER or DIGITUNDER
                    // IMPORTANT: The barrier is the SELECTED DIGIT, not the threshold
                    //
                    // For digits UNDER threshold (e.g., 1,2,3,4 when threshold=5):
                    //   - Uses DIGITOVER with barrier = selected digit
                    //   - Win condition: result > digit
                    //   - Example: Select 1,2,3,4, result=5 → 5>1, 5>2, 5>3, 5>4 → ALL WIN ✓
                    //
                    // For digits OVER threshold (e.g., 6,7,8,9 when threshold=5):
                    //   - Uses DIGITUNDER with barrier = selected digit
                    //   - Win condition: result < digit
                    //   - Example: Select 6,7,8,9, result=4 → 4<6, 4<7, 4<8, 4<9 → ALL WIN ✓
                    const barrierDigit = prediction.digit;

                    // Use buy() method directly
                    const buy_req = {
                        buy: '1',
                        price: stake,
                        parameters: {
                            amount: stake,
                            basis: 'stake',
                            contract_type: contractType,
                            currency: curr,
                            duration: 1,
                            duration_unit: 't',
                            symbol: market,
                            barrier: String(barrierDigit),
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
                                    contract_type: contractType,
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

                        return {
                            success: true,
                            digit: prediction.digit,
                            contractType: prediction.contractType,
                            contract_id: buy.contract_id,
                        };
                    }
                    return { success: false, digit: prediction.digit, error: 'No contract ID returned' };
                } catch (error) {
                    console.error(
                        `Error placing trade for digit ${prediction.digit} (${prediction.contractType}):`,
                        error
                    );
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
                alert(
                    `${successful.length} trades placed successfully. ${failed.length} failed. Check console for details.`
                );
            } else {
                alert(`Successfully placed ${successful.length} trade(s)! All trades are now active.`);
            }

            // Keep run panel running to show contracts - don't set to NOT_RUNNING here
            // It will be updated when contracts close
        } catch (error) {
            console.error('Error placing trades:', error);
            alert(`Error placing trades: ${error.message || 'Unknown error'}`);
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
            alert('Please select at least one digit to trade');
            return;
        }

        if (!market) {
            alert('Please select a market.');
            return;
        }

        const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
        if (isNaN(thresh) || thresh < 0 || thresh > 9) {
            alert('Please set a valid threshold (0-9)');
            return;
        }

        // Ensure refs are synced with current state values BEFORE starting
        enableEntryPointRef.current = enableEntryPoint;
        const entryDigitValue = typeof entryPointDigit === 'string' ? parseInt(entryPointDigit) || 5 : entryPointDigit;
        entryPointDigitRef.current = entryDigitValue;

        // Log entry point status before starting
        if (enableEntryPoint) {
            console.log(`🚀 Starting auto trading with entry point enabled. Waiting for digit: ${entryDigitValue}`);
            console.log(
                `📊 Entry point refs - enabled: ${enableEntryPointRef.current}, digit: ${entryPointDigitRef.current}`
            );
        } else {
            console.log(`🚀 Starting auto trading without entry point (immediate trading)`);
        }

        // Open run panel and set up for transactions
        if (run_panel) {
            run_panel.toggleDrawer(true);
            run_panel.setActiveTabIndex(1); // Transactions tab
            run_panel.run_id = `hyperbot-auto-${Date.now()}`;
            run_panel.setIsRunning(true);
            run_panel.setContractStage(contract_stages.STARTING);
        }

        setIsAutoTradingGlobal(true);
        isAutoTrading.current = true;
        isProcessingTrade.current = false;

        // Reset entry point - must wait for the digit to appear
        entryPointMet.current = false;

        if (enableEntryPointRef.current) {
            console.log(
                `🔄 Entry point reset. Waiting for digit: ${entryPointDigitRef.current} to appear in tick stream...`
            );
        }

        const tradeInterval = async () => {
            if (!isAutoTrading.current || !autoTradingInterval.current || isProcessingTrade.current) {
                return;
            }

            // Check entry point condition - use refs to get latest values
            if (enableEntryPointRef.current) {
                const entryDigit =
                    typeof entryPointDigitRef.current === 'number'
                        ? entryPointDigitRef.current
                        : parseInt(entryPointDigitRef.current) || 5;

                if (!entryPointMet.current) {
                    // Entry point not met yet, wait for tick handler to detect it
                    // Don't log every iteration to avoid spam, only log occasionally
                    if (Math.random() < 0.01) {
                        // Log 1% of the time
                        const current =
                            typeof currentDigit === 'string'
                                ? currentDigit === '--'
                                    ? null
                                    : parseInt(currentDigit)
                                : currentDigit;
                        console.log(`⏳ Waiting for entry point digit ${entryDigit}. Current digit: ${current}`);
                    }
                    return;
                } else {
                    console.log(
                        `✅ Entry point condition met! Expected digit ${entryDigit} was detected. Proceeding with trades...`
                    );
                }
            }

            const enabledPredictions = predictions.filter(p => p.enabled);
            if (enabledPredictions.length === 0) {
                isProcessingTrade.current = false;
                return;
            }

            if (!apiRef.current) {
                console.error('API not available for auto trading');
                isProcessingTrade.current = false;
                return;
            }

            isProcessingTrade.current = true;

            const api = apiRef.current;
            const curr = account_currency || currency;
            const symbol_display = symbols.find(s => s.symbol === market)?.display_name || market;

            try {
                await authorizeIfNeeded();

                const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;

                // Place all trades in parallel
                const trades = enabledPredictions.map(async prediction => {
                    const stake = prediction.stake;
                    try {
                        const contractType = prediction.contractType; // DIGITOVER or DIGITUNDER
                        const barrierDigit = prediction.digit;

                        const buy_req = {
                            buy: '1',
                            price: stake,
                            parameters: {
                                amount: stake,
                                basis: 'stake',
                                contract_type: contractType,
                                currency: curr,
                                duration: 1,
                                duration_unit: 't',
                                symbol: market,
                                barrier: String(barrierDigit),
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
                                        contract_type: contractType,
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
                        }
                    } catch (error) {
                        console.error(
                            `Auto trading error for digit ${prediction.digit} (${prediction.contractType}):`,
                            error
                        );
                    }
                });

                await Promise.all(trades);

                // If lock entry point is enabled, reset entry point after trade
                if (lockEntryPoint && enableEntryPointRef.current) {
                    entryPointMet.current = false;
                    console.log(
                        `🔒 Entry point locked. Waiting for digit ${entryPointDigitRef.current} before next trade...`
                    );
                }
            } catch (error) {
                console.error('Auto trading error:', error);
            } finally {
                isProcessingTrade.current = false;
            }
        };

        // Start interval (will check entry point on each iteration)
        autoTradingInterval.current = setInterval(tradeInterval, 500);
    };

    // Stop auto trading
    const stopAutoTradingFunction = () => {
        isAutoTrading.current = false;
        if (autoTradingInterval.current) {
            clearInterval(autoTradingInterval.current);
            autoTradingInterval.current = null;
        }
        isProcessingTrade.current = false;

        // Don't unsubscribe from contract subscriptions - keep them for open contracts
        // Contracts will continue to be tracked until they close

        setIsAutoTradingGlobal(false);

        if (run_panel) {
            run_panel.setIsRunning(false);
            // Don't set hasOpenContract to false - contracts may still be open
            run_panel.setContractStage(contract_stages.NOT_RUNNING);
        }
    };

    const enabledCount = predictions.filter(p => p.enabled).length;
    const totalStake = predictions
        .filter(p => p.enabled)
        .reduce((sum, p) => {
            const stake = p.stake;
            if (stake == null) return sum;
            const stakeValue = typeof stake === 'number' ? stake : parseFloat(String(stake));
            return sum + (isNaN(stakeValue) ? 0 : stakeValue);
        }, 0);

    return (
        <div className='hyperbot-container'>
            {/* Header with Title */}
            <div className='hyperbot-header'>
                <div className='hyperbot-title'>
                    <h2>{localize('XENON HYPERBOT - Over/Under Trading')}</h2>
                </div>

                {/* Controls */}
                <div className='hyperbot-controls'>
                    <div className='control-group'>
                        <label>{localize('Market')}:</label>
                        <select value={market} onChange={e => setMarket(e.target.value)} disabled={isPlacingTrades}>
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
                            disabled={isPlacingTrades}
                        />
                    </div>

                    <div className='control-group'>
                        <label>{localize('Threshold')}:</label>
                        <input
                            type='number'
                            value={threshold}
                            onChange={e => {
                                const value = e.target.value;
                                if (value === '') setThreshold('');
                                else {
                                    const num = parseInt(value);
                                    if (!isNaN(num) && num >= 0 && num <= 9) {
                                        setThreshold(num);
                                    }
                                }
                            }}
                            onBlur={e => {
                                if (
                                    e.target.value === '' ||
                                    parseInt(e.target.value) < 0 ||
                                    parseInt(e.target.value) > 9
                                ) {
                                    setThreshold(5);
                                }
                            }}
                            min={0}
                            max={9}
                            placeholder='5'
                            disabled={isPlacingTrades}
                        />
                    </div>

                    <div className='control-group'>
                         {/* Live Monitor for Quad */}
                        <div className='quad-monitor'>
                            {quadState.status === 'waiting' ? (
                                <span>Waiting for quad...</span>
                            ) : (
                                <span>Last: {quadState.lastDigits.join(', ')}</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Over/Under Analysis */}
            <div className='over-under-analysis'>
                <div className='ou-stats-container'>
                    <div className='ou-stat-card ou-stat-under'>
                        <div className='ou-stat-title'>Under</div>
                        <div className='ou-stat-value'>
                            {overUnderStats.under}{' '}
                            <span className='ou-stat-pct'>({overUnderStats.underPct.toFixed(1)}%)</span>
                        </div>
                        <div className='ou-barline'>
                            <div
                                className='ou-fill ou-fill-under'
                                style={{ width: `${overUnderStats.underPct}%` }}
                            ></div>
                        </div>
                    </div>
                    <div className='ou-stat-card ou-stat-equal'>
                        <div className='ou-stat-title'>Equal</div>
                        <div className='ou-stat-value'>
                            {overUnderStats.equal}{' '}
                            <span className='ou-stat-pct'>({overUnderStats.equalPct.toFixed(1)}%)</span>
                        </div>
                        <div className='ou-barline'>
                            <div
                                className='ou-fill ou-fill-equal'
                                style={{ width: `${overUnderStats.equalPct}%` }}
                            ></div>
                        </div>
                    </div>
                    <div className='ou-stat-card ou-stat-over'>
                        <div className='ou-stat-title'>Over</div>
                        <div className='ou-stat-value'>
                            {overUnderStats.over}{' '}
                            <span className='ou-stat-pct'>({overUnderStats.overPct.toFixed(1)}%)</span>
                        </div>
                        <div className='ou-barline'>
                            <div className='ou-fill ou-fill-over' style={{ width: `${overUnderStats.overPct}%` }}></div>
                        </div>
                    </div>
                </div>

                {/* Recent Sequence */}
                <div className='ou-sequence'>
                    <div className='ou-sequence-header'>
                        <span>Recent U/=/O</span>
                    </div>
                    <div className='ou-chips'>
                        {recentOverUnder.map((chip, index) => (
                            <div
                                key={index}
                                className={`ou-chip ${chip === 'U' ? 'under' : chip === 'O' ? 'over' : 'equal'}`}
                            >
                                {chip}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Action Buttons */}
                <div className='action-buttons-row'>
                    <button
                        className='action-button green-button'
                        onClick={selectOverDigits}
                        disabled={isPlacingTrades || predictions.length >= 10}
                    >
                        {localize('Select Over Digits')}
                    </button>
                    <button
                        className='action-button red-button'
                        onClick={selectUnderDigits}
                        disabled={isPlacingTrades || predictions.length >= 10}
                    >
                        {localize('Select Under Digits')}
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
                                disabled={isPlacingTrades}
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
                            disabled={isPlacingTrades}
                        />
                    </div>
                </div>

                {/* Entry Point Control */}
                <div className='stake-control'>
                    <div className='toggle-container'>
                        <span className='toggle-label'>{localize('Entry Point')}:</span>
                        <label className='toggle-switch'>
                            <input
                                type='checkbox'
                                checked={enableEntryPoint}
                                onChange={e => {
                                    const checked = e.target.checked;
                                    setEnableEntryPoint(checked);
                                    enableEntryPointRef.current = checked;
                                    if (!checked) {
                                        entryPointMet.current = false;
                                    } else {
                                        // Reset entry point when enabling to wait for fresh digit
                                        entryPointMet.current = false;
                                        console.log(
                                            `Entry point enabled. Waiting for digit: ${entryPointDigitRef.current}`
                                        );
                                    }
                                }}
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                            <span className='slider'></span>
                        </label>
                    </div>

                    {enableEntryPoint && (
                        <div className='default-stake-input'>
                            <label>{localize('Wait for Digit')}:</label>
                            <input
                                type='number'
                                value={entryPointDigit}
                                onChange={e => {
                                    const value = e.target.value;
                                    if (value === '') {
                                        setEntryPointDigit('');
                                        entryPointDigitRef.current = 5; // Default to 5 if empty
                                    } else {
                                        const num = parseInt(value, 10);
                                        if (!isNaN(num) && num >= 0 && num <= 9) {
                                            // Always store as number in state
                                            setEntryPointDigit(num);
                                            entryPointDigitRef.current = num;
                                            entryPointMet.current = false; // Reset when digit changes
                                            console.log(
                                                `📝 Entry point digit changed to ${num} (type: ${typeof num}). Waiting for this digit...`
                                            );
                                        }
                                    }
                                }}
                                onBlur={e => {
                                    const value = e.target.value;
                                    const num = parseInt(value, 10);
                                    if (value === '' || isNaN(num) || num < 0 || num > 9) {
                                        // Reset to default
                                        setEntryPointDigit(5);
                                        entryPointDigitRef.current = 5;
                                        console.log(`📝 Entry point digit reset to default: 5`);
                                    } else {
                                        // Ensure state and ref are both numbers
                                        setEntryPointDigit(num);
                                        entryPointDigitRef.current = num;
                                        console.log(`📝 Entry point digit set to: ${num} (type: ${typeof num})`);
                                    }
                                }}
                                min={0}
                                max={9}
                                placeholder='5'
                                disabled={isPlacingTrades || isAutoTradingGlobal}
                            />
                        </div>
                    )}

                    {enableEntryPoint && (
                        <div className='toggle-container'>
                            <span className='toggle-label lock-entry-label'>{localize('Lock Entry Point')}:</span>
                            <label className='toggle-switch lock-entry-switch'>
                                <input
                                    type='checkbox'
                                    checked={lockEntryPoint}
                                    onChange={e => setLockEntryPoint(e.target.checked)}
                                    disabled={isPlacingTrades || isAutoTradingGlobal}
                                />
                                <span className='slider lock-entry-slider'></span>
                            </label>
                        </div>
                    )}
                </div>

                {/* Predictions Table - Digit Selection like Matches Bot */}
                <table className='predictions-table'>
                    <tbody>
                        <tr className='prediction-row'>
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => {
                                const prediction = predictions.find(p => p.digit === digit);
                                const isEnabled = prediction?.enabled || false;
                                const thresh = typeof threshold === 'string' ? parseInt(threshold) || 5 : threshold;
                                const isOverThreshold = digit > thresh;
                                const isUnderThreshold = digit < thresh;
                                const isEqualThreshold = digit === thresh;

                                return (
                                    <td
                                        key={digit}
                                        className={`prediction-cell ${isEnabled ? 'selected' : ''} ${isEqualThreshold ? 'disabled-digit' : ''}`}
                                    >
                                        <div className='prediction-cell-content'>
                                            <label className='checkbox-wrapper'>
                                                <input
                                                    type='checkbox'
                                                    className='prediction-checkbox'
                                                    checked={isEnabled}
                                                    onChange={e => {
                                                        if (e.target.checked) {
                                                            if (isEqualThreshold) {
                                                                alert(
                                                                    `Digit ${digit} equals threshold ${thresh}. Please select digits that are above or below the threshold.`
                                                                );
                                                                return;
                                                            }
                                                            if (predictions.length >= 10) {
                                                                alert('Maximum 10 predictions allowed');
                                                                return;
                                                            }
                                                            togglePrediction(digit);
                                                        } else {
                                                            setPredictions(prev => prev.filter(p => p.digit !== digit));
                                                        }
                                                    }}
                                                    disabled={isPlacingTrades || isEqualThreshold}
                                                />
                                            </label>
                                            <div className='prediction-number'>{digit}</div>
                                            {isEnabled && prediction && (
                                                <div className='prediction-type-badge'>
                                                    {prediction.contractType === 'DIGITOVER' ? 'O' : 'U'}
                                                </div>
                                            )}
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
                                                        digit,
                                                        e.target.value === '' ? '' : parseFloat(e.target.value)
                                                    );
                                                }
                                            }}
                                            step={0.01}
                                            disabled={!isEnabled || useDefaultStake || isPlacingTrades}
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
                        Threshold: {threshold} | Select digits to trade Over/Under. Digits equal to threshold cannot be
                        selected.
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

export default Hyperbot;
