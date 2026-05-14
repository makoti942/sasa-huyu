import React, { useState, useEffect, useRef } from 'react';
import { Localize } from '@deriv-com/translations';
import './tick-analyser.scss';

type ViewMode = 'summary' | 'detailed';

interface TickData {
    price: number;
    timestamp: number;
}

interface PatternStats {
    pattern: string;
    count: number;
    percentage: number;
}

interface AnalysisStats {
    riseCount: number;
    fallCount: number;
    noChangeCount: number;
    risePercentage: number;
    fallPercentage: number;
    noChangePercentage: number;
    evenCount: number;
    oddCount: number;
    evenPercentage: number;
    oddPercentage: number;
    overCount: number;
    underCount: number;
    overPercentage: number;
    underPercentage: number;
}

const TickAnalyser: React.FC = () => {
    const [viewMode, setViewMode] = useState<ViewMode>('summary');
    const [selectedSymbol, setSelectedSymbol] = useState<string>('R_10');
    const [tickCount, setTickCount] = useState<number>(1000);
    const [ticks, setTicks] = useState<TickData[]>([]);
    const [currentPrice, setCurrentPrice] = useState<number>(0);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [analysisStats, setAnalysisStats] = useState<AnalysisStats | null>(null);
    const [patternStats, setPatternStats] = useState<PatternStats[]>([]);
    const [lastDigits, setLastDigits] = useState<number[]>([]);
    const wsRef = useRef<WebSocket | null>(null);

    const symbols = [
        { value: 'R_10', label: 'Volatility 10 Index' },
        { value: 'R_25', label: 'Volatility 25 Index' },
        { value: 'R_50', label: 'Volatility 50 Index' },
        { value: 'R_75', label: 'Volatility 75 Index' },
        { value: 'R_100', label: 'Volatility 100 Index' },
    ];

    useEffect(() => {
        // DISABLED - replaced by DerivAuth.js
        // const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=337');
        // wsRef.current = ws;

        ws.onopen = () => {
            setIsLoading(false);
            // Subscribe to tick history
            ws.send(
                JSON.stringify({
                    ticks_history: selectedSymbol,
                    count: tickCount,
                    end: 'latest',
                    style: 'ticks',
                    subscribe: 1,
                })
            );
        };

        ws.onmessage = event => {
            try {
                const data = JSON.parse(event.data);

                if (data.error) {
                    console.error('WebSocket error:', data.error);
                    return;
                }

                if (data.history && data.history.prices) {
                    const prices = data.history.prices.map((price: string, index: number) => ({
                        price: parseFloat(price),
                        timestamp: Date.now() - (data.history.prices.length - index) * 1000,
                    }));
                    setTicks(prices);
                    if (prices.length > 0) {
                        setCurrentPrice(prices[prices.length - 1].price);
                    }
                } else if (data.tick) {
                    const newTick: TickData = {
                        price: parseFloat(data.tick.quote),
                        timestamp: data.tick.epoch * 1000,
                    };
                    setTicks(prev => {
                        const updated = [...prev, newTick];
                        if (updated.length > tickCount) {
                            updated.shift();
                        }
                        return updated;
                    });
                    setCurrentPrice(newTick.price);
                }
            } catch (error) {
                console.error('Error parsing WebSocket message:', error);
            }
        };

        ws.onerror = error => {
            console.error('WebSocket error:', error);
            setIsLoading(false);
        };

        ws.onclose = () => {
            console.log('WebSocket closed');
        };

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [selectedSymbol, tickCount]);

    useEffect(() => {
        if (ticks.length < 2) return;

        // Calculate analysis stats
        let riseCount = 0;
        let fallCount = 0;
        let noChangeCount = 0;
        let evenCount = 0;
        let oddCount = 0;
        let overCount = 0;
        let underCount = 0;

        const lastDigitsArray: number[] = [];
        const patternMap: { [key: string]: number } = {};

        for (let i = 1; i < ticks.length; i++) {
            const prevPrice = ticks[i - 1].price;
            const currPrice = ticks[i].price;
            const prevLastDigit = parseInt(prevPrice.toString().slice(-1));
            const currLastDigit = parseInt(currPrice.toString().slice(-1));

            lastDigitsArray.push(currLastDigit);

            // Rise/Fall analysis
            if (currPrice > prevPrice) {
                riseCount++;
            } else if (currPrice < prevPrice) {
                fallCount++;
            } else {
                noChangeCount++;
            }

            // Even/Odd analysis
            if (currLastDigit % 2 === 0) {
                evenCount++;
            } else {
                oddCount++;
            }

            // Over/Under analysis
            if (currLastDigit >= 7) {
                overCount++;
            } else if (currLastDigit <= 2) {
                underCount++;
            }

            // Pattern analysis (last 2-4 digits)
            for (let patternLen = 2; patternLen <= 4; patternLen++) {
                if (i >= patternLen) {
                    const pattern = ticks
                        .slice(i - patternLen, i + 1)
                        .map(t => parseInt(t.price.toString().slice(-1)))
                        .join('');
                    patternMap[pattern] = (patternMap[pattern] || 0) + 1;
                }
            }
        }

        const total = ticks.length - 1;
        const totalDigits = ticks.length;

        setAnalysisStats({
            riseCount,
            fallCount,
            noChangeCount,
            risePercentage: total > 0 ? Math.round((riseCount / total) * 10000) / 100 : 0,
            fallPercentage: total > 0 ? Math.round((fallCount / total) * 10000) / 100 : 0,
            noChangePercentage: total > 0 ? Math.round((noChangeCount / total) * 10000) / 100 : 0,
            evenCount,
            oddCount,
            evenPercentage: Math.round((evenCount / totalDigits) * 10000) / 100,
            oddPercentage: Math.round((oddCount / totalDigits) * 10000) / 100,
            overCount,
            underCount,
            overPercentage: Math.round((overCount / totalDigits) * 10000) / 100,
            underPercentage: Math.round((underCount / totalDigits) * 10000) / 100,
        });

        // Convert pattern map to array and sort
        const patterns: PatternStats[] = Object.entries(patternMap)
            .map(([pattern, count]) => ({
                pattern,
                count,
                percentage: Math.round((count / total) * 10000) / 100,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);

        setPatternStats(patterns);
        setLastDigits(lastDigitsArray.slice(-50)); // Last 50 digits
    }, [ticks]);

    const getLastDigit = (price: number): number => {
        return parseInt(price.toString().slice(-1));
    };

    const isEven = (digit: number): boolean => {
        return digit % 2 === 0;
    };

    const getPriceDirection = (): 'rise' | 'fall' | 'neutral' => {
        if (ticks.length < 2) return 'neutral';
        const last = ticks[ticks.length - 1].price;
        const prev = ticks[ticks.length - 2].price;
        if (last > prev) return 'rise';
        if (last < prev) return 'fall';
        return 'neutral';
    };

    const renderSummaryView = () => {
        if (!analysisStats) {
            return (
                <div className='tick-analyser__loading'>
                    <Localize i18n_default_text='Loading analysis...' />
                </div>
            );
        }

        return (
            <div className='tick-analyser__summary'>
                <div className='tick-analyser__current-tick'>
                    <div className='tick-analyser__price-display'>
                        <div className='tick-analyser__price-info'>
                            <span className='tick-analyser__current-price'>
                                <Localize i18n_default_text='Current Price' />: {currentPrice.toFixed(2)}
                            </span>
                            <span
                                className={`tick-analyser__last-digit ${isEven(getLastDigit(currentPrice)) ? 'even' : 'odd'}`}
                            >
                                {getLastDigit(currentPrice)}
                            </span>
                            <span className={`tick-analyser__price-arrow ${getPriceDirection()}`}>
                                {getPriceDirection() === 'rise' ? '↑' : getPriceDirection() === 'fall' ? '↓' : '→'}
                            </span>
                        </div>
                    </div>
                </div>

                <div className='tick-analyser__summary-stats'>
                    <div className='tick-analyser__stat'>
                        <div className='tick-analyser__stat-label'>
                            <Localize i18n_default_text='Rise' />
                        </div>
                        <div className='tick-analyser__stat-value tick-analyser__stat-value--positive'>
                            {analysisStats.risePercentage.toFixed(2)}%
                        </div>
                        <div className='tick-analyser__stat-count'>
                            {analysisStats.riseCount} <Localize i18n_default_text='ticks' />
                        </div>
                    </div>

                    <div className='tick-analyser__stat'>
                        <div className='tick-analyser__stat-label'>
                            <Localize i18n_default_text='Fall' />
                        </div>
                        <div className='tick-analyser__stat-value tick-analyser__stat-value--negative'>
                            {analysisStats.fallPercentage.toFixed(2)}%
                        </div>
                        <div className='tick-analyser__stat-count'>
                            {analysisStats.fallCount} <Localize i18n_default_text='ticks' />
                        </div>
                    </div>

                    <div className='tick-analyser__stat'>
                        <div className='tick-analyser__stat-label'>
                            <Localize i18n_default_text='Even' />
                        </div>
                        <div className='tick-analyser__stat-value'>{analysisStats.evenPercentage.toFixed(2)}%</div>
                        <div className='tick-analyser__stat-count'>
                            {analysisStats.evenCount} <Localize i18n_default_text='ticks' />
                        </div>
                    </div>

                    <div className='tick-analyser__stat'>
                        <div className='tick-analyser__stat-label'>
                            <Localize i18n_default_text='Odd' />
                        </div>
                        <div className='tick-analyser__stat-value'>{analysisStats.oddPercentage.toFixed(2)}%</div>
                        <div className='tick-analyser__stat-count'>
                            {analysisStats.oddCount} <Localize i18n_default_text='ticks' />
                        </div>
                    </div>

                    <div className='tick-analyser__stat'>
                        <div className='tick-analyser__stat-label'>
                            <Localize i18n_default_text='Over 7' />
                        </div>
                        <div className='tick-analyser__stat-value'>{analysisStats.overPercentage.toFixed(2)}%</div>
                        <div className='tick-analyser__stat-count'>
                            {analysisStats.overCount} <Localize i18n_default_text='ticks' />
                        </div>
                    </div>

                    <div className='tick-analyser__stat'>
                        <div className='tick-analyser__stat-label'>
                            <Localize i18n_default_text='Under 3' />
                        </div>
                        <div className='tick-analyser__stat-value'>{analysisStats.underPercentage.toFixed(2)}%</div>
                        <div className='tick-analyser__stat-count'>
                            {analysisStats.underCount} <Localize i18n_default_text='ticks' />
                        </div>
                    </div>
                </div>

                <div className='tick-analyser__pattern-summary'>
                    <h3 className='tick-analyser__section-title'>
                        <Localize i18n_default_text='Top Patterns' />
                    </h3>
                    <div className='tick-analyser__pattern-grid'>
                        {patternStats.slice(0, 6).map((pattern, index) => (
                            <div key={index} className='tick-analyser__pattern-card'>
                                <div className='tick-analyser__pattern-name'>{pattern.pattern}</div>
                                <div className='tick-analyser__pattern-count'>{pattern.count}</div>
                                <div className='tick-analyser__pattern-percentage'>
                                    {pattern.percentage.toFixed(2)}%
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const renderDetailedView = () => {
        if (!analysisStats) {
            return (
                <div className='tick-analyser__loading'>
                    <Localize i18n_default_text='Loading detailed analysis...' />
                </div>
            );
        }

        return (
            <div className='tick-analyser__detailed'>
                <div className='detailed-controls'>
                    <div className='control-group'>
                        <label>
                            <Localize i18n_default_text='Symbol' />
                        </label>
                        <select value={selectedSymbol} onChange={e => setSelectedSymbol(e.target.value)}>
                            {symbols.map(symbol => (
                                <option key={symbol.value} value={symbol.value}>
                                    {symbol.label}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className='control-group'>
                        <label>
                            <Localize i18n_default_text='Tick Count' />
                        </label>
                        <input
                            type='number'
                            value={tickCount}
                            onChange={e => setTickCount(Math.max(100, parseInt(e.target.value) || 1000))}
                            min='100'
                            max='10000'
                        />
                    </div>
                </div>

                <div className='market-info'>
                    <div className='current-price'>
                        <Localize i18n_default_text='Current Price' />: {currentPrice.toFixed(2)}
                    </div>
                    <div className='tick-count'>
                        <Localize i18n_default_text='Total Ticks' />: {ticks.length}
                    </div>
                </div>

                <div className='analysis-sections'>
                    <div className='analysis-section'>
                        <h3>
                            <Localize i18n_default_text='Rise / Fall Analysis' />
                        </h3>
                        <div className='percentage-display'>
                            <div className='percentage-item'>
                                <div>Rise</div>
                                <div style={{ color: '#4caf50' }}>{analysisStats.risePercentage.toFixed(2)}%</div>
                            </div>
                            <div className='percentage-item'>
                                <div>Fall</div>
                                <div style={{ color: '#f44336' }}>{analysisStats.fallPercentage.toFixed(2)}%</div>
                            </div>
                            <div className='percentage-item'>
                                <div>No Change</div>
                                <div>{analysisStats.noChangePercentage.toFixed(2)}%</div>
                            </div>
                        </div>
                        <div className='bar-chart'>
                            <div className='bar-container'>
                                <div
                                    className='bar'
                                    style={{
                                        width: `${analysisStats.risePercentage}%`,
                                        backgroundColor: '#4caf50',
                                    }}
                                >
                                    {analysisStats.risePercentage > 5 && `${analysisStats.risePercentage.toFixed(1)}%`}
                                </div>
                            </div>
                            <div className='bar-container'>
                                <div
                                    className='bar'
                                    style={{
                                        width: `${analysisStats.fallPercentage}%`,
                                        backgroundColor: '#f44336',
                                    }}
                                >
                                    {analysisStats.fallPercentage > 5 && `${analysisStats.fallPercentage.toFixed(1)}%`}
                                </div>
                            </div>
                        </div>
                        <div className='count-display'>
                            <span>Rise: {analysisStats.riseCount}</span>
                            <span>Fall: {analysisStats.fallCount}</span>
                            <span>No Change: {analysisStats.noChangeCount}</span>
                        </div>
                    </div>

                    <div className='analysis-section'>
                        <h3>
                            <Localize i18n_default_text='Even / Odd Analysis' />
                        </h3>
                        <div className='percentage-display'>
                            <div className='percentage-item'>
                                <div>Even</div>
                                <div style={{ color: '#4caf50' }}>{analysisStats.evenPercentage.toFixed(2)}%</div>
                            </div>
                            <div className='percentage-item'>
                                <div>Odd</div>
                                <div style={{ color: '#f44336' }}>{analysisStats.oddPercentage.toFixed(2)}%</div>
                            </div>
                        </div>
                        <div className='bar-chart'>
                            <div className='bar-container'>
                                <div
                                    className='bar'
                                    style={{
                                        width: `${analysisStats.evenPercentage}%`,
                                        backgroundColor: '#4caf50',
                                    }}
                                >
                                    {analysisStats.evenPercentage > 5 && `${analysisStats.evenPercentage.toFixed(1)}%`}
                                </div>
                            </div>
                            <div className='bar-container'>
                                <div
                                    className='bar'
                                    style={{
                                        width: `${analysisStats.oddPercentage}%`,
                                        backgroundColor: '#f44336',
                                    }}
                                >
                                    {analysisStats.oddPercentage > 5 && `${analysisStats.oddPercentage.toFixed(1)}%`}
                                </div>
                            </div>
                        </div>
                        <div className='count-display'>
                            <span>Even: {analysisStats.evenCount}</span>
                            <span>Odd: {analysisStats.oddCount}</span>
                        </div>
                    </div>

                    <div className='analysis-section'>
                        <h3>
                            <Localize i18n_default_text='Over / Under Analysis' />
                        </h3>
                        <div className='percentage-display'>
                            <div className='percentage-item'>
                                <div>Over 7</div>
                                <div style={{ color: '#4caf50' }}>{analysisStats.overPercentage.toFixed(2)}%</div>
                            </div>
                            <div className='percentage-item'>
                                <div>Under 3</div>
                                <div style={{ color: '#f44336' }}>{analysisStats.underPercentage.toFixed(2)}%</div>
                            </div>
                        </div>
                        <div className='bar-chart'>
                            <div className='bar-container'>
                                <div
                                    className='bar'
                                    style={{
                                        width: `${analysisStats.overPercentage}%`,
                                        backgroundColor: '#4caf50',
                                    }}
                                >
                                    {analysisStats.overPercentage > 5 && `${analysisStats.overPercentage.toFixed(1)}%`}
                                </div>
                            </div>
                            <div className='bar-container'>
                                <div
                                    className='bar'
                                    style={{
                                        width: `${analysisStats.underPercentage}%`,
                                        backgroundColor: '#f44336',
                                    }}
                                >
                                    {analysisStats.underPercentage > 5 &&
                                        `${analysisStats.underPercentage.toFixed(1)}%`}
                                </div>
                            </div>
                        </div>
                        <div className='count-display'>
                            <span>Over 7: {analysisStats.overCount}</span>
                            <span>Under 3: {analysisStats.underCount}</span>
                        </div>
                    </div>

                    <div className='analysis-section'>
                        <h3>
                            <Localize i18n_default_text='Last 50 Digits' />
                        </h3>
                        <div className='last-ticks-display'>
                            <div className='last-ticks-pattern'>
                                {lastDigits.map((digit, index) => (
                                    <span
                                        key={index}
                                        className={`tick-analyser__digit ${isEven(digit) ? 'even' : 'odd'}`}
                                    >
                                        {digit}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className='analysis-section'>
                        <h3>
                            <Localize i18n_default_text='Pattern Analysis' />
                        </h3>
                        <div className='tick-analyser__pattern-list'>
                            {patternStats.map((pattern, index) => (
                                <div key={index} className='tick-analyser__pattern-item'>
                                    <span className='tick-analyser__pattern-name'>{pattern.pattern}</span>
                                    <span className='tick-analyser__pattern-count'>{pattern.count}</span>
                                    <span className='tick-analyser__pattern-percentage'>
                                        {pattern.percentage.toFixed(2)}%
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className='tick-analyser'>
            <div className='tick-analyser__header'>
                <div className='tick-analyser__tabs'>
                    <button
                        className={`tick-analyser__tab ${viewMode === 'summary' ? 'active' : ''}`}
                        onClick={() => setViewMode('summary')}
                    >
                        <Localize i18n_default_text='Summary' />
                    </button>
                    <button
                        className={`tick-analyser__tab ${viewMode === 'detailed' ? 'active' : ''}`}
                        onClick={() => setViewMode('detailed')}
                    >
                        <Localize i18n_default_text='Detailed' />
                    </button>
                </div>
                <div className='tick-analyser__controls'>
                    <select
                        className='tick-analyser__market-select'
                        value={selectedSymbol}
                        onChange={e => setSelectedSymbol(e.target.value)}
                    >
                        {symbols.map(symbol => (
                            <option key={symbol.value} value={symbol.value}>
                                {symbol.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            <div className='tick-analyser__content'>
                {isLoading ? (
                    <div className='tick-analyser__loading'>
                        <Localize i18n_default_text='Connecting to tick stream...' />
                    </div>
                ) : viewMode === 'summary' ? (
                    renderSummaryView()
                ) : (
                    renderDetailedView()
                )}
            </div>
        </div>
    );
};

export default TickAnalyser;
