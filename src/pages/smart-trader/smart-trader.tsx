import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { localize } from '@deriv-com/translations';
import IframeWrapper from '@/components/iframe-wrapper';
import './smart-trader.scss';

const SmartTrader = observer(() => {
    // Trading mode dropdown state
    const [tradingMode, setTradingMode] = useState<string>('signals');

    // Trading mode options
    const TRADING_MODES = [
        { value: 'signals', label: 'Signals' },
        { value: 'all-analysis', label: 'All Analysis' },
        { value: 'risk-calculator', label: 'Risk Calculator' },
    ];

    // All Analysis functionality
    useEffect(() => {
        if (tradingMode === 'all-analysis') {
            // Initialize WebSocket connection and signals functionality
            const initializeSignals = () => {
                // Store ticks per subscribed symbol (filled dynamically)
                const ticksStorage: { [key: string]: number[] } = {};

                const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=337');

                const subscribeTicks = (symbol: string) => {
                    ws.send(
                        JSON.stringify({
                            ticks_history: symbol,
                            count: 255,
                            end: 'latest',
                            style: 'ticks',
                            subscribe: 1,
                        })
                    );
                };

                ws.onopen = () => {
                    console.log('WebSocket connected, requesting active symbols...');

                    // Request active symbols to get the correct 1s volatility indices
                    ws.send(
                        JSON.stringify({
                            active_symbols: 'brief',
                        })
                    );

                    // Also subscribe to standard volatility indices immediately
                    const standardSymbols = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100'];
                    standardSymbols.forEach(symbol => {
                        if (!ticksStorage[symbol]) ticksStorage[symbol] = [];
                        subscribeTicks(symbol);
                        console.log('Subscribed to standard symbol:', symbol);
                    });
                };

                const calculateTrendPercentage = (symbol: string, ticksCount: number) => {
                    const ticks = ticksStorage[symbol].slice(-ticksCount);
                    if (ticks.length < 2) return { risePercentage: 0, fallPercentage: 0 };

                    let riseCount = 0;
                    let fallCount = 0;

                    for (let i = 1; i < ticks.length; i++) {
                        if (ticks[i] > ticks[i - 1]) riseCount++;
                        else if (ticks[i] < ticks[i - 1]) fallCount++;
                    }

                    const total = riseCount + fallCount;
                    return {
                        risePercentage: total > 0 ? (riseCount / total) * 100 : 0,
                        fallPercentage: total > 0 ? (fallCount / total) * 100 : 0,
                    };
                };

                ws.onmessage = event => {
                    const data = JSON.parse(event.data);

                    // Log any errors
                    if (data.error) {
                        console.error(
                            'WebSocket error for symbol:',
                            data.echo_req?.ticks_history || 'unknown',
                            data.error
                        );
                        return;
                    }

                    // Handle active symbols response
                    if (data.active_symbols) {
                        console.log('Active symbols received:', data.active_symbols.length, 'symbols');

                        // Filter for 1-second volatility indices
                        const oneSecondVolatilityIndices = data.active_symbols.filter(
                            (symbol: any) => symbol.display_name && symbol.display_name.includes('(1s)')
                        );
                        console.log('1-Second Volatility Indices found:', oneSecondVolatilityIndices);

                        // Subscribe to all 1s volatility indices
                        oneSecondVolatilityIndices.forEach((symbolData: any) => {
                            const symbol = symbolData.symbol;
                            if (!ticksStorage[symbol]) ticksStorage[symbol] = [];
                            subscribeTicks(symbol);
                            console.log('Subscribed to 1s volatility symbol:', symbol, symbolData.display_name);
                        });
                        return;
                    }

                    if (data.history && data.history.prices) {
                        const symbol = data.echo_req.ticks_history;
                        if (!ticksStorage[symbol]) ticksStorage[symbol] = [];
                        ticksStorage[symbol] = data.history.prices.map((price: string) => parseFloat(price));
                        console.log(`History received for ${symbol}: ${ticksStorage[symbol].length} ticks`);
                    } else if (data.tick) {
                        const symbol = data.tick.symbol;
                        if (!ticksStorage[symbol]) ticksStorage[symbol] = [];
                        ticksStorage[symbol].push(parseFloat(data.tick.quote));
                        if (ticksStorage[symbol].length > 255) ticksStorage[symbol].shift();
                        console.log(
                            `Tick received for ${symbol}: ${data.tick.quote}, total ticks: ${ticksStorage[symbol].length}`
                        );
                    }
                };

                function updateTables() {
                    const riseFallTable = document.getElementById('riseFallTable');
                    const overUnderTable = document.getElementById('overUnderTable');

                    if (!riseFallTable || !overUnderTable) return;

                    riseFallTable.innerHTML = '';
                    overUnderTable.innerHTML = '';

                    Object.keys(ticksStorage).forEach(symbol => {
                        const ticks = ticksStorage[symbol];
                        if (ticks.length < 255) return;

                        // Calculate rise/fall percentages for 255 and 55 ticks
                        const { risePercentage: rise255, fallPercentage: fall255 } = calculateTrendPercentage(
                            symbol,
                            255
                        );
                        const { risePercentage: rise55, fallPercentage: fall55 } = calculateTrendPercentage(symbol, 55);

                        // Check if both conditions are met for a buy/sell signal
                        const isBuy = rise255 > 57 && rise55 > 55;
                        const isSell = fall255 > 57 && fall55 > 55;

                        // Define status classes for signals
                        const riseClass = isBuy ? 'rise' : 'neutral';
                        const fallClass = isSell ? 'fall' : 'neutral';

                        // Generate market label (add (1s) for 1-second indices)
                        const isOneSecond = symbol.includes('_1s') || symbol.includes('_1S') || symbol.includes('S');
                        let indexLabel = symbol
                            .replace('R_', '')
                            .replace('_1s', '')
                            .replace('_1S', '')
                            .replace('S', '');

                        // Generate rise/fall table row
                        riseFallTable.innerHTML += `<tr>
                            <td>Volatility ${indexLabel}${isOneSecond ? ' (1s)' : ''} index</td>
                            <td><span class="signal-box ${riseClass}">${isBuy ? 'Rise' : '----'}</span></td>
                            <td><span class="signal-box ${fallClass}">${isSell ? 'Fall' : '----'}</span></td>
                        </tr>`;

                        // Last digit analysis
                        const digitCounts = new Array(10).fill(0);
                        ticks.forEach(tick => {
                            const lastDigit = parseInt(tick.toString().slice(-1));
                            digitCounts[lastDigit]++;
                        });

                        const totalTicks = ticks.length;
                        const digitPercentages = digitCounts.map(count => (count / totalTicks) * 100);

                        const overClass =
                            digitPercentages[7] < 10 && digitPercentages[8] < 10 && digitPercentages[9] < 10
                                ? 'over'
                                : 'neutral';
                        const underClass =
                            digitPercentages[0] < 10 && digitPercentages[1] < 10 && digitPercentages[2] < 10
                                ? 'under'
                                : 'neutral';

                        // Generate over/under table row
                        overUnderTable.innerHTML += `<tr>
                            <td>Volatility ${indexLabel}${isOneSecond ? ' (1s)' : ''} index</td>
                            <td><span class="signal-box ${overClass}">${overClass === 'over' ? 'Over 2' : '----'}</span></td>
                            <td><span class="signal-box ${underClass}">${underClass === 'under' ? 'Under 7' : '----'}</span></td>
                        </tr>`;
                    });
                }

                const intervalId = setInterval(updateTables, 1000); // Update every second

                return () => {
                    clearInterval(intervalId);
                    ws.close();
                };
            };

            const cleanup = initializeSignals();
            return cleanup;
        }
    }, [tradingMode]);

    // Risk Calculator functionality
    useEffect(() => {
        if (tradingMode === 'risk-calculator') {
            const capitalInput = document.getElementById('capital') as HTMLInputElement;
            const stakeDisplay = document.getElementById('stake');
            const takeProfitDisplay = document.getElementById('takeProfit');
            const stopLossDisplay = document.getElementById('stopLoss');

            if (!capitalInput || !stakeDisplay || !takeProfitDisplay || !stopLossDisplay) {
                return;
            }

            const calculateResults = () => {
                const capital = parseFloat(capitalInput.value) || 0;
                if (capital < 0) {
                    capitalInput.value = '0';
                    updateDisplays('0.00', '0.00', '0.00');
                    return;
                }

                const initialStake = (capital * 0.02).toFixed(2);
                const takeProfit = (parseFloat(initialStake) * 5).toFixed(2);

                // Martingale stop loss: sum of stakes for 4 losses (double each time)
                let stopLoss = 0;
                let currentStake = parseFloat(initialStake);
                for (let i = 0; i < 4; i++) {
                    stopLoss += currentStake;
                    currentStake = currentStake * 2;
                }

                updateDisplays(initialStake, takeProfit, stopLoss.toFixed(2));
            };

            const updateDisplays = (stake: string, takeProfit: string, stopLoss: string) => {
                stakeDisplay.textContent = stake;
                takeProfitDisplay.textContent = takeProfit;
                stopLossDisplay.textContent = stopLoss;
            };

            capitalInput.addEventListener('input', calculateResults);
            capitalInput.addEventListener('touchend', calculateResults);

            // Initialize with default value
            calculateResults();

            return () => {
                capitalInput.removeEventListener('input', calculateResults);
                capitalInput.removeEventListener('touchend', calculateResults);
            };
        }
    }, [tradingMode]);

    return (
        <div className='smart-trader'>
            <div className='smart-trader__container'>
                <div className='smart-trader__topbar'>
                    <div className='smart-trader__mode-selector'>
                        <div className='smart-trader__mode-dropdown-container'>
                            <select
                                value={tradingMode}
                                onChange={e => setTradingMode(e.target.value)}
                                className='smart-trader__mode-dropdown'
                            >
                                {TRADING_MODES.map(mode => (
                                    <option key={mode.value} value={mode.value}>
                                        {mode.label}
                                    </option>
                                ))}
                            </select>
                            <div className='smart-trader__dropdown-indicator'>
                                <svg
                                    width='12'
                                    height='12'
                                    viewBox='0 0 24 24'
                                    fill='none'
                                    xmlns='http://www.w3.org/2000/svg'
                                >
                                    <path d='M7 10L12 15L17 10H7Z' fill='currentColor' />
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>

                <div className='smart-trader__content'>
                    {tradingMode === 'signals' ? (
                        <IframeWrapper
                            src='https://signals-scanner-vercel-app.vercel.app/'
                            title='Trading Signals'
                            className='smart-trader__signals-iframe'
                        />
                    ) : tradingMode === 'all-analysis' ? (
                        <div className='smart-trader__all-analysis'>
                            <div className='all-analysis-container'>
                                <h2>Rise / Fall</h2>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Market</th>
                                            <th>Rise 📈</th>
                                            <th>Fall 📉</th>
                                        </tr>
                                    </thead>
                                    <tbody id='riseFallTable'>
                                        <tr>
                                            <td>Volatility 100</td>
                                            <td>
                                                <span className='signal-box rise'>RISE</span>
                                            </td>
                                            <td>
                                                <span className='signal-box fall'>FALL</span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>

                                <h2>Over 2 / Under 7</h2>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Market</th>
                                            <th>Over 2</th>
                                            <th>Under 7</th>
                                        </tr>
                                    </thead>
                                    <tbody id='overUnderTable'>
                                        <tr>
                                            <td>Volatility 75</td>
                                            <td>
                                                <span className='signal-box over'>OVER</span>
                                            </td>
                                            <td>
                                                <span className='signal-box under'>UNDER</span>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ) : tradingMode === 'risk-calculator' ? (
                        <div className='smart-trader__risk-calculator'>
                            <div className='risk-calculator-container'>
                                <h1>Martingale Calculator</h1>
                                <div className='input-group'>
                                    <label htmlFor='capital'>Initial Capital (₹):</label>
                                    <input
                                        type='number'
                                        id='capital'
                                        min='0'
                                        step='0.01'
                                        placeholder='Enter capital'
                                        required
                                    />
                                </div>
                                <div className='results'>
                                    <div className='result-item'>
                                        <span>Stake (2% of Capital):</span>
                                        <span id='stake'>0.00</span>
                                    </div>
                                    <div className='result-item'>
                                        <span>Take Profit (5x Stake):</span>
                                        <span id='takeProfit'>0.00</span>
                                    </div>
                                    <div className='result-item'>
                                        <span>Stop Loss (4 Losses Sum):</span>
                                        <span id='stopLoss'>0.00</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className='smart-trader__placeholder'>
                            <h3>Welcome to Smart Trader</h3>
                            <p>Select a trading mode from the dropdown above to get started.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

export default SmartTrader;
