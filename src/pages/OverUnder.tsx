import React, { useEffect, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import './over-under.scss';

const OverUnder = observer(() => {
    const { over_under } = useStore();
    const {
        connection_status,
        tick_history,
        last_digit,
        is_auto_running,
        stake,
        martingale,
        is_volatility_changer,
        use_second_trigger,
        is_manual_mode,
        manual_contract_type,
        manual_barrier,
        is_recovery_active,
        recovery_contract_type,
        recovery_barrier,
        use_recovery_delay,
        entry_digit,
        second_entry_digit,
        is_turbo,
        selected_symbol,
        debug_info,
        setStake,
        setMartingale,
        setIsVolatilityChanger,
        setUseSecondTrigger,
        setIsManualMode,
        setManualContractType,
        setManualBarrier,
        setIsRecoveryActive,
        setRecoveryContractType,
        setRecoveryBarrier,
        setUseRecoveryDelay,
        setEntryDigit,
        setSecondEntryDigit,
        setIsTurbo,
        setSelectedSymbol,
        connectWebSocket,
        handleStartStop,
        clearDebug,
    } = over_under;

    useEffect(() => {
        connectWebSocket();
        return () => {
            if (over_under.reconnectTimeout) clearTimeout(over_under.reconnectTimeout);
            if (over_under.ws) over_under.ws.close();
            over_under.addLog("Component unmounted. Connection closed.");
        };
    }, [connectWebSocket, over_under]);

    const digitStats = useMemo(() => {
        const stats = Array(10).fill(0);
        tick_history.forEach(digit => {
            if (digit >= 0 && digit <= 9) {
                stats[digit]++;
            }
        });
        return stats;
    }, [tick_history]);

    const { maxIdx, minIdx } = useMemo(() => {
        if (tick_history.length === 0) return { maxIdx: -1, minIdx: -1 };
        let maxVal = -1, minVal = Infinity, maxIdx = -1, minIdx = -1;
        digitStats.forEach((val, idx) => {
            if (val > maxVal) { maxVal = val; maxIdx = idx; }
            if (val < minVal) { minVal = val; minIdx = idx; }
        });
        return { maxIdx, minIdx };
    }, [digitStats]);

    const totalTicksCount = tick_history.length || 1;
    
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

    const getStatusClassName = () => {
        switch(connection_status) {
            case 'Account Connected': return 'connected';
            case 'Live Ticks': return 'authorizing';
            default: return 'disconnected';
        }
    };

    return (
        <div className="over-under-container" style={{ height: 'calc(100vh - 15rem)', overflowY: 'auto' }}>
            <div className="stats-grid">
                {digitStats.map((count, i) => {
                    const percentage = ((count / totalTicksCount) * 100).toFixed(1);
                    const isHot = i === maxIdx && count > 0;
                    const isCold = i === minIdx && count > 0;
                    let barColor = 'red';
                    if (isHot) barColor = '#00ff00';
                    if (isCold) barColor = '#000000';

                    return (
                        <div key={i} className={`digit-card ${last_digit === i ? 'active' : ''}`}>
                            <span className="digit-num">{i}</span>
                            <span className="digit-percent">{percentage}%</span>
                            <div className="digit-bar-wrapper">
                                <div className="digit-bar-fill" style={{ height: `${percentage}%`, backgroundColor: barColor }}/>
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="controls-panel">
                 <div className="input-group">
                    <label>Status ({tick_history.length} ticks)</label>
                    <div className={`connection-status ${getStatusClassName()}`}>{connection_status}</div>
                </div>
                <div className="input-row">
                    <div className="input-group">
                        <label>Index</label>
                        <select className="ui-select" value={selected_symbol} onChange={(e) => setSelectedSymbol(e.target.value)} disabled={is_auto_running}>
                            {volatilityIndices.map(idx => <option key={idx.value} value={idx.value}>{idx.text}</option>)}
                        </select>
                    </div>
                    <div className="input-group">
                        <label>Trigger Digits</label>
                        <div className="entry-config-row">
                            <div className="entry-config">
                                <input className="ui-input digit-entry" type="number" min="0" max="9" value={entry_digit} onChange={(e) => setEntryDigit(Number(e.target.value))} disabled={is_auto_running} title="First Trigger" />
                                <div className={`status-led ${over_under.last_digit === Number(entry_digit) ? 'glow' : ''}`}></div>
                            </div>
                            {use_second_trigger && (
                                <div className="entry-config">
                                    <input className="ui-input digit-entry" type="number" min="0" max="9" value={second_entry_digit} onChange={(e) => setSecondEntryDigit(Number(e.target.value))} disabled={is_auto_running} title="Second Trigger" />
                                    <div className={`status-led ${over_under.last_last_digit === Number(entry_digit) && over_under.last_digit === Number(second_entry_digit) ? 'glow' : ''}`}></div>
                                </div>
                            )}
                            <button 
                                className={`ui-switch mini ${use_second_trigger ? 'active' : ''}`}
                                onClick={() => setUseSecondTrigger(!use_second_trigger)}
                                disabled={is_auto_running}
                                title="Toggle Second Trigger"
                            >
                                2ND
                            </button>
                        </div>
                    </div>
                </div>
                <div className="input-row">
                    <div className="input-group">
                        <label>Stake</label>
                        <input className="ui-input" type="number" value={stake} onChange={(e) => setStake(Number(e.target.value))} disabled={is_auto_running} />
                    </div>
                    <div className="input-group">
                        <label>Martingale</label>
                        <input className="ui-input" type="number" step="0.1" value={martingale} onChange={(e) => setMartingale(Number(e.target.value))} disabled={is_auto_running} />
                    </div>
                </div>
                <div className="input-row switches-row">
                    <div className="input-group switch-group">
                        <label>Volatility Changer</label>
                        <button 
                            className={`ui-switch ${is_volatility_changer ? 'active' : ''}`} 
                            onClick={() => setIsVolatilityChanger(!is_volatility_changer)}
                            disabled={is_auto_running}
                        >
                            {is_volatility_changer ? 'ON' : 'OFF'}
                        </button>
                    </div>
                    <div className="input-group switch-group">
                        <label>Manual Mode</label>
                        <button 
                            className={`ui-switch ${is_manual_mode ? 'active' : ''}`} 
                            onClick={() => setIsManualMode(!is_manual_mode)}
                            disabled={is_auto_running}
                        >
                            {is_manual_mode ? 'ON' : 'OFF'}
                        </button>
                    </div>
                </div>

                {is_manual_mode && (
                    <div className="manual-config-box">
                        <div className="input-row">
                            <div className="input-group">
                                <label>Manual Type</label>
                                <select className="ui-select" value={manual_contract_type} onChange={(e) => setManualContractType(e.target.value)} disabled={is_auto_running}>
                                    <option value="DIGITOVER">OVER</option>
                                    <option value="DIGITUNDER">UNDER</option>
                                </select>
                            </div>
                            <div className="input-group">
                                <label>Barrier</label>
                                <input className="ui-input" type="number" min="0" max="9" value={manual_barrier} onChange={(e) => setManualBarrier(e.target.value)} disabled={is_auto_running} />
                            </div>
                        </div>
                    </div>
                )}

                <div className="recovery-config-box">
                    <div className="input-row">
                        <div className="input-group switch-group">
                            <label>Recovery Delay</label>
                            <button 
                                className={`ui-switch ${use_recovery_delay ? 'active' : ''}`} 
                                onClick={() => setUseRecoveryDelay(!use_recovery_delay)}
                                disabled={is_auto_running}
                            >
                                {use_recovery_delay ? 'WAIT' : 'NOW'}
                            </button>
                        </div>
                        <div className="input-group">
                            <label>Recovery Type</label>
                            <select className="ui-select" value={recovery_contract_type} onChange={(e) => setRecoveryContractType(e.target.value)} disabled={is_auto_running}>
                                <option value="DIGITOVER">OVER</option>
                                <option value="DIGITUNDER">UNDER</option>
                            </select>
                        </div>
                        <div className="input-group">
                            <label>Recovery Barrier</label>
                            <input className="ui-input" type="number" min="0" max="9" value={recovery_barrier} onChange={(e) => setRecoveryBarrier(e.target.value)} disabled={is_auto_running} />
                        </div>
                    </div>
                </div>

                <div className="button-group">
                    <button className={`btn-secondary ${is_turbo ? 'active' : ''}`} onClick={() => setIsTurbo(!is_turbo)} disabled={is_auto_running}>
                        {is_turbo ? 'TURBO ON' : 'TURBO OFF'}
                    </button>
                    <button className={`btn-primary ${is_auto_running ? 'running' : ''}`} onClick={handleStartStop}>
                        {is_auto_running ? 'STOP' : 'START'}
                    </button>
                </div>
            </div>
            
            <div className="debug-monitor">
                <div className="debug-header">
                    <span>REAL-TIME MONITOR</span>
                    <button onClick={clearDebug} className="clear-btn">Clear</button>
                </div>
                <div className="debug-content">
                    {debug_info.map((log, i) => <div key={i} className="log-item">{log}</div>)}
                </div>
            </div>
        </div>
    );
});

export default OverUnder;
