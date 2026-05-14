// DIFFBOT - Digits Market Trading Component
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
import './diffbot.css';

const Diffbot = observer(() => {
    // State Management
    const [market, setMarket] = useState('');
    const [selectedDigit, setSelectedDigit] = useState(5);
    const [numberOfContracts, setNumberOfContracts] = useState(1);
    const [stake, setStake] = useState(0.5);
    const [symbols, setSymbols] = useState([]);
    const [isPlacingTrades, setIsPlacingTrades] = useState(false);
    const [currentDigit, setCurrentDigit] = useState('--');
    const [predictedDigit, setPredictedDigit] = useState(null); // AI predicted digit (least frequent)
    const [digitStats, setDigitStats] = useState([]); // Frequency analysis for all digits
    const [analysisCount, setAnalysisCount] = useState(100); // Number of ticks to analyze

    // Refs
    const isSubscribed = useRef(false);
    const tickSubscription = useRef(null);
    const contractSubscriptions = useRef([]);
    const allDigits = useRef([]); // Store all digits for analysis
    const pipSize = useRef(4);
    const messageHandlerRef = useRef(null); // Store message handler for cleanup

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

    // Subscribe to ticks to show current digit
    useEffect(() => {
        if (market && apiRef.current) {
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
                if (apiRef.current?.connection && messageHandlerRef.current) {
                    apiRef.current.connection.removeEventListener('message', messageHandlerRef.current);
                    messageHandlerRef.current = null;
                }
                isSubscribed.current = false;
            };
        }
    }, [market, analysisCount]);

    // Analyze digits to find least frequent (prediction)
    const analyzeDigits = digits => {
        if (!digits || digits.length === 0) return;

        // Count frequency of each digit (0-9)
        const digitCounts = Array(10).fill(0);
        digits.forEach(d => {
            if (d >= 0 && d <= 9) {
                digitCounts[d]++;
            }
        });

        // Calculate statistics
        const total = digits.length;
        const stats = digitCounts.map((count, digit) => ({
            digit,
            count,
            percentage: total > 0 ? ((count / total) * 100).toFixed(2) : 0,
            frequency: count,
        }));

        // Sort by frequency (ascending) - least frequent first
        stats.sort((a, b) => a.count - b.count);

        setDigitStats(stats);

        // Find the least frequent digit(s) - if multiple have same count, pick the first one
        const leastFrequent = stats.find(s => s.count === stats[0].count);
        if (leastFrequent) {
            setPredictedDigit(leastFrequent.digit);
        }
    };

    const subscribeToTicks = async () => {
        if (!apiRef.current || !market) {
            console.error('API not available or market not selected');
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

        // Remove old message listener
        if (api.connection && messageHandlerRef.current) {
            api.connection.removeEventListener('message', messageHandlerRef.current);
            messageHandlerRef.current = null;
        }

        isSubscribed.current = false;
        allDigits.current = [];
        setCurrentDigit('--');
        setPredictedDigit(null);
        setDigitStats([]);

        const analysisNum = typeof analysisCount === 'string' ? parseInt(analysisCount) || 100 : analysisCount;
        if (!analysisNum || analysisNum < 1) {
            console.warn('Invalid analysis count:', analysisNum);
            return;
        }

        try {
            // Subscribe to live ticks - exact same method as Matches/Hyperbot
            const { subscription, error } = await api.send({ ticks: market, subscribe: 1 });
            if (error) {
                console.error('Subscription error:', error);
                throw error;
            }
            if (subscription?.id) {
                tickSubscription.current = subscription.id;
                console.log('✅ Subscribed to ticks for', market, 'Subscription ID:', subscription.id);
            }

            // Listen for streaming ticks - exact same pattern as Matches/Hyperbot
            const onMsg = evt => {
                try {
                    const data = JSON.parse(evt.data);
                    if (data?.msg_type === 'tick' && data?.tick?.symbol === market) {
                        const quote = data.tick.quote;
                        const formattedPrice = parseFloat(quote).toFixed(pipSize.current || 4);
                        const digit = parseInt(formattedPrice[formattedPrice.length - 1]);

                        if (!isNaN(digit) && digit >= 0 && digit <= 9) {
                            setCurrentDigit(digit);
                            allDigits.current.push(digit);

                            // Keep only last N digits for analysis
                            if (allDigits.current.length > analysisNum) {
                                allDigits.current = allDigits.current.slice(-analysisNum);
                            }

                            // Analyze digits to find least frequent
                            analyzeDigits(allDigits.current);
                        }
                    }

                    // Handle forget confirmation
                    if (data?.forget?.id && data?.forget?.id === tickSubscription.current) {
                        console.log('Tick subscription stopped');
                        isSubscribed.current = false;
                    }
                } catch (e) {
                    // Ignore parse errors for non-JSON messages
                }
            };

            messageHandlerRef.current = onMsg;

            // Attach listener - same as Matches/Hyperbot
            if (api.connection) {
                api.connection.addEventListener('message', onMsg);
                isSubscribed.current = true;
                console.log('✅ Message listener attached for', market);
            } else {
                console.error('❌ API connection not available');
            }

            // Also fetch historical ticks for initial analysis
            try {
                const historyResponse = await api.send({
                    ticks_history: market,
                    adjust_start_time: 1,
                    count: Math.min(analysisNum, 1000),
                    end: 'latest',
                    start: 1,
                    style: 'ticks',
                });

                if (historyResponse?.history?.prices) {
                    const prices = historyResponse.history.prices;
                    pipSize.current = historyResponse.pip_size || 4;

                    const digits = prices
                        .map(price => {
                            const formatted = parseFloat(price).toFixed(pipSize.current);
                            return parseInt(formatted[formatted.length - 1]);
                        })
                        .filter(d => !isNaN(d) && d >= 0 && d <= 9);

                    if (digits.length > 0) {
                        allDigits.current = digits;
                        analyzeDigits(digits);
                        // Set current digit to the last historical digit
                        setCurrentDigit(digits[digits.length - 1]);
                        console.log('✅ Loaded', digits.length, 'historical digits');
                    }
                }
            } catch (e) {
                console.error('Error fetching historical ticks:', e);
            }
        } catch (error) {
            console.error('❌ Error subscribing to ticks:', error);
            setCurrentDigit('--');
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

    // Place trades - multiple contracts for the selected digit
    const placeTrades = async () => {
        if (!apiRef.current) {
            console.warn('API not initialized. Please check your connection.');
            return;
        }

        if (!market) {
            console.warn('Please select a market.');
            return;
        }

        const numContracts =
            typeof numberOfContracts === 'string' ? parseInt(numberOfContracts) || 1 : numberOfContracts;
        if (numContracts < 1) {
            console.warn('Number of contracts must be at least 1');
            return;
        }

        const stakeAmount = typeof stake === 'string' ? parseFloat(stake) || 0.5 : stake;
        if (stakeAmount <= 0) {
            console.warn('Stake must be greater than 0');
            return;
        }

        // Open run panel and set up for transactions
        if (run_panel) {
            run_panel.toggleDrawer(true);
            run_panel.setActiveTabIndex(1); // Transactions tab
            run_panel.run_id = `diffbot-${Date.now()}`;
            run_panel.setIsRunning(true);
            run_panel.setContractStage(contract_stages.STARTING);
        }

        setIsPlacingTrades(true);

        try {
            await authorizeIfNeeded();
            const api = apiRef.current;
            const curr = account_currency || currency;
            const symbol_display = symbols.find(s => s.symbol === market)?.display_name || market;

            // Place all contracts in parallel using Promise.all
            const tradePromises = Array.from({ length: numContracts }, async (_, index) => {
                try {
                    const buy_req = {
                        buy: '1',
                        price: stakeAmount,
                        parameters: {
                            amount: stakeAmount,
                            basis: 'stake',
                            contract_type: 'DIGITDIFF', // Differs - wins if result is NOT the selected digit
                            currency: curr,
                            duration: 1,
                            duration_unit: 't',
                            symbol: market,
                            barrier: String(selectedDigit),
                        },
                    };

                    console.log(
                        `Placing contract ${index + 1}/${numContracts} for DIGITDIFF digit ${selectedDigit}:`,
                        buy_req
                    );
                    const { buy, error } = await api.buy(buy_req);
                    if (error) {
                        console.error(`Error buying contract ${index + 1}:`, error);
                        throw error;
                    }
                    console.log(`Contract ${index + 1} placed successfully:`, buy);

                    if (buy?.contract_id) {
                        // Add to transactions panel immediately (same as Matches)
                        try {
                            if (transactions?.onBotContractEvent) {
                                transactions.onBotContractEvent({
                                    contract_id: buy.contract_id,
                                    transaction_ids: { buy: buy.transaction_id },
                                    buy_price: buy.buy_price,
                                    currency: curr,
                                    contract_type: 'DIGITDIFF',
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

                        // Subscribe to contract updates (same method as Matches)
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

                            // Listen for streaming updates (same as Matches)
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

                        return { success: true, contract_id: buy.contract_id, index };
                    }
                    return { success: false, error: 'No contract ID returned', index };
                } catch (error) {
                    console.error(`Error placing contract ${index + 1}:`, error);
                    return { success: false, error: error.message || 'Unknown error', index };
                }
            });

            // Wait for all trades to complete
            const results = await Promise.all(tradePromises);

            const successful = results.filter(r => r.success);
            const failed = results.filter(r => !r.success);

            console.log(`=== Diffbot Trade Complete ===`);
            console.log(`Digit: ${selectedDigit}`);
            console.log(`Successful: ${successful.length}/${results.length}`);
            console.log(`Failed: ${failed.length}/${results.length}`);

            if (failed.length > 0) {
                console.error('Failed contracts:', failed);
                alert(
                    `${successful.length} contracts placed successfully. ${failed.length} failed. Check console for details.`
                );
            } else {
                console.log(
                    `✅ Successfully placed ${successful.length} contract(s) for DIGITDIFF digit ${selectedDigit}!`
                );
                alert(
                    `Successfully placed ${successful.length} contract(s)! You win if the result digit is NOT ${selectedDigit}.`
                );
            }

            // Keep run panel running to show contracts
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

    return (
        <div className='diffbot-container'>
            <div className='diffbot-header'>
                <h1>Diffbot - Digits Market Trading</h1>
                <p>Place multiple contracts for a selected digit in one run</p>
            </div>

            <div className='diffbot-content'>
                <div className='diffbot-controls'>
                    <div className='control-group'>
                        <label htmlFor='market-select'>Market:</label>
                        <select
                            id='market-select'
                            value={market}
                            onChange={e => setMarket(e.target.value)}
                            disabled={isPlacingTrades}
                        >
                            <option value=''>Select Market</option>
                            {symbols.map(s => (
                                <option key={s.symbol} value={s.symbol}>
                                    {s.display_name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className='control-group'>
                        <label htmlFor='digit-select'>Select Digit (0-9):</label>
                        <select
                            id='digit-select'
                            value={selectedDigit}
                            onChange={e => setSelectedDigit(parseInt(e.target.value))}
                            disabled={isPlacingTrades}
                        >
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => (
                                <option key={digit} value={digit}>
                                    {digit}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className='control-group'>
                        <label htmlFor='contracts-input'>Number of Contracts:</label>
                        <input
                            id='contracts-input'
                            type='number'
                            min='1'
                            max='10'
                            value={numberOfContracts}
                            onChange={e => setNumberOfContracts(parseInt(e.target.value) || 1)}
                            disabled={isPlacingTrades}
                        />
                    </div>

                    <div className='control-group'>
                        <label htmlFor='stake-input'>Stake per Contract:</label>
                        <input
                            id='stake-input'
                            type='number'
                            min='0.01'
                            step='0.01'
                            value={stake}
                            onChange={e => setStake(parseFloat(e.target.value) || 0.5)}
                            disabled={isPlacingTrades}
                        />
                    </div>

                    <div className='control-group'>
                        <label htmlFor='analysis-count'>Analysis Count (Ticks):</label>
                        <input
                            id='analysis-count'
                            type='number'
                            min='10'
                            max='1000'
                            value={analysisCount}
                            onChange={e => setAnalysisCount(parseInt(e.target.value) || 100)}
                            disabled={isPlacingTrades}
                        />
                    </div>

                    <div className='control-group'>
                        <label>Current Digit:</label>
                        <div className='current-digit-display'>
                            <span className={`digit-value ${currentDigit === predictedDigit ? 'predicted-digit' : ''}`}>
                                {currentDigit === '--' ? '--' : currentDigit}
                            </span>
                        </div>
                    </div>

                    <div className='control-group'>
                        <label>AI Prediction (Least Frequent):</label>
                        <div className='prediction-display'>
                            <span className='predicted-digit-value'>
                                {predictedDigit !== null ? predictedDigit : '--'}
                            </span>
                            {predictedDigit !== null && digitStats.length > 0 && (
                                <span className='prediction-info'>
                                    (Appeared {digitStats.find(s => s.digit === predictedDigit)?.count || 0} times)
                                </span>
                            )}
                        </div>
                    </div>

                    <div className='control-group'>
                        <button
                            className='use-prediction-btn'
                            onClick={() => predictedDigit !== null && setSelectedDigit(predictedDigit)}
                            disabled={predictedDigit === null || isPlacingTrades}
                        >
                            Use Predicted Digit ({predictedDigit !== null ? predictedDigit : '--'})
                        </button>
                    </div>

                    <div className='control-group'>
                        <button
                            className='place-trades-btn'
                            onClick={placeTrades}
                            disabled={isPlacingTrades || !market || numberOfContracts < 1 || stake <= 0}
                        >
                            {isPlacingTrades
                                ? 'Placing Trades...'
                                : `Place ${numberOfContracts} Contract(s) - Differs from Digit ${selectedDigit}`}
                        </button>
                    </div>
                </div>

                <div className='diffbot-info'>
                    <h3>How Diffbot Works:</h3>
                    <ul>
                        <li>Select a digit (0-9) that you want to "differ" from</li>
                        <li>Set the number of contracts to place in one run</li>
                        <li>Set the stake amount per contract</li>
                        <li>Click "Place Contracts" to place all contracts simultaneously</li>
                        <li>All contracts will target the same selected digit</li>
                        <li>
                            Each contract uses <strong>DIGITDIFF</strong> - you <strong>WIN</strong> if the result digit
                            is <strong>NOT</strong> the selected digit
                        </li>
                        <li>
                            Example: If you select digit 3, you win if result is 0,1,2,4,5,6,7,8,9 (any digit except 3)
                        </li>
                    </ul>

                    <h3 style={{ marginTop: '20px' }}>AI Analysis:</h3>
                    <ul>
                        <li>Analyzes the last N ticks (configurable) to find the least frequent digit</li>
                        <li>
                            The predicted digit (least frequent) is shown in{' '}
                            <span style={{ color: '#dc2626', fontWeight: 'bold' }}>RED</span>
                        </li>
                        <li>Current digit is highlighted in red if it matches the prediction</li>
                        <li>Click "Use Predicted Digit" to automatically select the AI-suggested digit</li>
                        <li>Analysis updates in real-time as new ticks arrive</li>
                    </ul>

                    {digitStats.length > 0 && (
                        <div className='digit-stats'>
                            <h3 style={{ marginTop: '20px' }}>Digit Frequency Analysis:</h3>
                            <div className='stats-grid'>
                                {digitStats.map(stat => (
                                    <div
                                        key={stat.digit}
                                        className={`stat-item ${stat.digit === predictedDigit ? 'least-frequent' : ''}`}
                                    >
                                        <span className='stat-digit'>{stat.digit}</span>
                                        <span className='stat-count'>{stat.count}</span>
                                        <span className='stat-percentage'>{stat.percentage}%</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

export default Diffbot;
