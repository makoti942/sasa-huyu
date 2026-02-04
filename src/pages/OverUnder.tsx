import React, { useState, useEffect, useMemo, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import './over-under.scss';

// Connection Statuses
const STATUS_OFFLINE = 'Offline';
const STATUS_CONNECTING = 'Connecting...';
const STATUS_LIVE = 'Live Ticks';
const STATUS_AUTHORIZED = 'Account Connected';

const MAX_TICKS = 1000;

const OverUnder = observer(() => {
    const { journal, client } = useStore();
    const ws = useRef<WebSocket | null>(null);
    const reconnectTimeout = useRef<NodeJS.Timeout | null>(null);
    const isAuthorized = useRef(false);
    const [debugInfo, setDebugInfo] = useState<string[]>([]);

    // State
    const [connectionStatus, setConnectionStatus] = useState(STATUS_OFFLINE);
    const [tickHistory, setTickHistory] = useState<number[]>([]);
    const [lastDigit, setLastDigit] = useState<number | null>(null);
    const [isAutoRunning, setIsAutoRunning] = useState(false);
    
    // Settings
    const [stake, setStake] = useState(1);
    const [entryDigit, setEntryDigit] = useState(7);
    const [isTurbo, setIsTurbo] = useState(false);
    const [selectedSymbol, setSelectedSymbol] = useState('R_100');

    const volatilityIndices = [
        { text: 'Volatility 100 Index', value: 'R_100' },
        { text: 'Volatility 75 Index', value: 'R_75' },
        { text: 'Volatility 50 Index', value: 'R_50' },
        { text: 'Volatility 25 Index', value: 'R_25' },
        { text: 'Volatility 10 Index', value: 'R_10' },
        { text: 'Volatility 100 (1s) Index', value: '1HZ100V' },
        { text: 'Volatility 75 (1s) Index', value: '1HZ75V' },
        { text: 'Volatility 50 (1s) Index', value: '1HZ50V' },
        { text: 'Volatility 25 (1s) Index', value: '1HZ25V' },
        { text: 'Volatility 10 (1s) Index', value: '1HZ10V' },
    ];

    const addLog = (msg: string) => {
        console.log(`[OverUnder] ${msg}`);
        setDebugInfo(prev => [msg, ...prev].slice(0, 5));
    };

    const subscribeToTicks = (symbol: string) => {
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            addLog('WS not open for subscribe');
            return;
        }
        
        addLog(`Fetching history & subscribing: ${symbol}`);
        ws.current.send(JSON.stringify({ forget_all: 'ticks' }));
        
        // Fetch last 1000 ticks history + subscribe to live ticks
        ws.current.send(JSON.stringify({ 
            ticks_history: symbol, 
            count: MAX_TICKS,
            end: 'latest',
            style: 'ticks',
            subscribe: 1 
        }));
        
        setTickHistory([]);
        setLastDigit(null);
    };

    const connectWebSocket = () => {
        if (ws.current) {
            ws.current.onclose = null;
            ws.current.close();
        }

        if (reconnectTimeout.current) {
            clearTimeout(reconnectTimeout.current);
        }

        addLog('Connecting...');
        setConnectionStatus(STATUS_CONNECTING);
        isAuthorized.current = false;
        
        const app_id = localStorage.getItem('config.app_id') || '117164';
        const server_url = localStorage.getItem('config.server_url') || 'ws.derivws.com';
        
        try {
            ws.current = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);

            ws.current.onopen = () => {
                addLog('WS Opened');
                setConnectionStatus(STATUS_LIVE);
                subscribeToTicks(selectedSymbol);

                const token = localStorage.getItem('authToken') || 
                              localStorage.getItem('token') || 
                              JSON.parse(localStorage.getItem('accountsList') || '{}')[client.loginid];
                
                if (token) {
                    ws.current?.send(JSON.stringify({ authorize: token }));
                }
            };

            ws.current.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);

                    if (data.msg_type === 'authorize') {
                        if (!data.error) {
                            addLog('Authorized!');
                            isAuthorized.current = true;
                            setConnectionStatus(STATUS_AUTHORIZED);
                        }
                    }

                    // Handle Tick History (Initial Load)
                    if (data.msg_type === 'history') {
                        const prices = data.history.prices;
                        const digits = prices.map((p: string) => parseInt(p.slice(-1)));
                        setTickHistory(digits);
                        if (digits.length > 0) {
                            setLastDigit(digits[digits.length - 1]);
                        }
                        addLog(`Loaded ${digits.length} historical ticks`);
                    }

                    // Handle Live Ticks
                    if (data.msg_type === 'tick') {
                        const quote = data.tick.quote.toString();
                        const digit = parseInt(quote.charAt(quote.length - 1));
                        
                        setLastDigit(digit);
                        setTickHistory(prev => {
                            const newHistory = [...prev, digit];
                            if (newHistory.length > MAX_TICKS) {
                                return newHistory.slice(-MAX_TICKS);
                            }
                            return newHistory;
                        });

                        if (isAutoRunning && digit === entryDigit) {
                            executeMultiTrade();
                        }
                    }

                    if (data.error && data.msg_type !== 'authorize') {
                        addLog(`Error: ${data.error.message}`);
                    }
                } catch (error) {
                    console.error('Error parsing WS message', error);
                }
            };

            ws.current.onclose = (e) => {
                addLog(`WS Closed: ${e.code}`);
                setConnectionStatus(STATUS_OFFLINE);
                reconnectTimeout.current = setTimeout(connectWebSocket, 5000);
            };
        } catch (e) {
            addLog(`WS Init Fail: ${e.message}`);
        }
    };

    useEffect(() => {
        connectWebSocket();
        return () => {
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
            if (ws.current) ws.current.close();
        };
    }, []);

    useEffect(() => {
        if (connectionStatus === STATUS_LIVE || connectionStatus === STATUS_AUTHORIZED) {
            subscribeToTicks(selectedSymbol);
        }
    }, [selectedSymbol]);

    const executeMultiTrade = () => {
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN || !isAuthorized.current) {
            if (!isAuthorized.current && journal?.pushMessage) {
                journal.pushMessage({ message: '⚠️ Login required to trade.', type: 'error' });
            }
            setIsAutoRunning(false);
            return;
        }

        const currency = client.currency || 'USD';
        const baseParams = {
            buy: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: 'stake',
                currency: currency,
                duration: 1,
                duration_unit: 't',
                symbol: selectedSymbol,
            }
        };

        ws.current.send(JSON.stringify({
            ...baseParams,
            parameters: { ...baseParams.parameters, contract_type: 'DIGITOVER', barrier: '5' }
        }));

        ws.current.send(JSON.stringify({
            ...baseParams,
            parameters: { ...baseParams.parameters, contract_type: 'DIGITUNDER', barrier: '4' }
        }));
        
        if (!isTurbo) setIsAutoRunning(false);
    };

    // Calculate percentages based on 1000-tick window
    const digitStats = useMemo(() => {
        const stats = Array(10).fill(0);
        tickHistory.forEach(digit => {
            if (digit >= 0 && digit <= 9) {
                stats[digit]++;
            }
        });
        return stats;
    }, [tickHistory]);

    const totalTicksCount = tickHistory.length || 1;

    const getStatusClassName = () => {
        switch(connectionStatus) {
            case STATUS_AUTHORIZED: return 'connected';
            case STATUS_LIVE: return 'authorizing';
            default: return 'disconnected';
        }
    };

    return (
        <div className="over-under-container">
            <div className="stats-grid">
                {digitStats.map((count, i) => {
                    const percentage = ((count / totalTicksCount) * 100).toFixed(1);
                    return (
                        <div key={i} className={`digit-card ${lastDigit === i ? 'active' : ''}`}>
                            <span className="digit-num">{i}</span>
                            <span className="digit-percent">{percentage}%</span>
                            <div className="digit-bar-wrapper">
                                <div className="digit-bar-fill" style={{ height: `${percentage}%` }}></div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="controls-panel">
                <div className="input-group">
                    <label>Status ({totalTicksCount} ticks)</label>
                    <div className={`connection-status ${getStatusClassName()}`}>
                        {connectionStatus}
                    </div>
                </div>

                <div className="input-group">
                    <label>Index</label>
                    <select className="ui-select" value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)}>
                        {volatilityIndices.map(idx => <option key={idx.value} value={idx.value}>{idx.text}</option>)}
                    </select>
                </div>

                <div className="input-group">
                    <label>Stake</label>
                    <input className="ui-input" type="number" value={stake} onChange={(e) => setStake(Number(e.target.value))} />
                </div>

                <div className="input-group">
                    <label>Trigger</label>
                    <div className="entry-config">
                        <input className="ui-input digit-entry" type="number" min="0" max="9" value={entryDigit} onChange={(e) => setEntryDigit(Number(e.target.value))} />
                        <div className={`status-led ${lastDigit === entryDigit ? 'glow' : ''}`}></div>
                    </div>
                </div>

                <div className="button-group">
                    <button className={`btn-secondary ${isTurbo ? 'active' : ''}`} onClick={() => setIsTurbo(!isTurbo)}>
                        {isTurbo ? 'TURBO ON' : 'TURBO OFF'}
                    </button>
                    <button className={`btn-primary ${isAutoRunning ? 'running' : ''}`} onClick={() => setIsAutoRunning(!isAutoRunning)}>
                        {isAutoRunning ? 'STOP' : 'START'}
                    </button>
                </div>
            </div>
            
            <div style={{marginTop: '20px', padding: '10px', background: '#111', borderRadius: '8px', fontSize: '10px', color: '#666'}}>
                <div style={{fontWeight: 'bold', marginBottom: '5px'}}>DEBUG LOG:</div>
                {debugInfo.map((log, i) => <div key={i}>• {log}</div>)}
            </div>
        </div>
    );
});

export default OverUnder;
