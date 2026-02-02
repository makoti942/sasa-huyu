import React, { useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { api_base } from '@/external/bot-skeleton';
import './over-under.scss';

const OverUnder = observer(() => {
    const { summary_card, journal, client } = useStore();
    const [digitStats, setDigitStats] = useState(Array(10).fill(0));
    const [lastDigit, setLastDigit] = useState<number | null>(null);
    const [isAutoRunning, setIsAutoRunning] = useState(false);
    const [settings, setSettings] = useState({
        stake: 1,
        entryDigit: 7,
        isTurbo: false,
    });

    // Sync with market and update professional stats
    useEffect(() => {
        const ticks_sub = api_base.api.onMessage().subscribe((msg: any) => {
            if (msg.msg_type === 'tick') {
                const digit = parseInt(msg.tick.quote.toString().slice(-1));
                setLastDigit(digit);
                setDigitStats(prev => {
                    const newStats = [...prev];
                    newStats[digit] += 1;
                    const total = newStats.reduce((a, b) => a + b, 0);
                    if (total > 100) { // Keep rolling window of 100
                        const firstDigit = parseInt(msg.tick.quote.toString().slice(-1)); // Simplified for example
                        newStats[digit] -= 0.5; 
                    }
                    return newStats;
                });

                if (isAutoRunning && digit === settings.entryDigit) {
                    executeMultiTrade();
                    if (!settings.isTurbo) setIsAutoRunning(false);
                }
            }
        });
        return () => ticks_sub.unsubscribe();
    }, [isAutoRunning, settings]);

    const executeMultiTrade = async () => {
        const common_params = {
            amount: settings.stake,
            currency: client.currency,
            symbol: 'R_100', // You can make this dynamic
            duration: 1,
            duration_unit: 't',
        };

        try {
            // Push "Pending" to Journal for professional look
            journal.pushMessage({ message: 'Executing Multi-Trade Entry...', type: 'info' });

            const contracts = [
                api_base.api.buy({ ...common_params, contract_type: 'DIGITOVER', barrier: 5 }),
                api_base.api.buy({ ...common_params, contract_type: 'DIGITUNDER', barrier: 4 })
            ];

            const results = await Promise.all(contracts);
            
            // Sync results with the main Bot Results panel
            results.forEach(res => {
                if (res.buy) {
                    summary_card.onContractStatusChange(res.buy.contract_id);
                }
            });
        } catch (error) {
            journal.pushMessage({ message: error.message, type: 'error' });
        }
    };

    return (
        <div className="over-under-container">
            <div className="stats-grid">
                {digitStats.map((count, i) => {
                    const percentage = ((count / digitStats.reduce((a, b) => a + b, 0)) * 100 || 0).toFixed(1);
                    return (
                        <div key={i} className={`digit-card ${lastDigit === i ? 'active' : ''}`}>
                            <span className="digit-num">{i}</span>
                            <span className="digit-percent">{percentage}%</span>
                        </div>
                    );
                })}
            </div>

            <div className="controls-panel">
                <div className="input-group">
                    <label>Stake</label>
                    <input type="number" value={settings.stake} onChange={e => setSettings({...settings, stake: Number(e.target.value)})} />
                </div>
                <div className="input-group">
                    <label>Entry Digit</label>
                    <select value={settings.entryDigit} onChange={e => setSettings({...settings, entryDigit: Number(e.target.value)})}>
                        {[0,1,2,3,4,5,6,7,8,9].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                </div>
                <div className="toggle-group">
                    <button className={`btn-secondary ${settings.isTurbo ? 'on' : ''}`} onClick={() => setSettings({...settings, isTurbo: !settings.isTurbo})}>
                        Turbo Mode: {settings.isTurbo ? 'ON' : 'OFF'}
                    </button>
                </div>
                <button className={`btn-primary ${isAutoRunning ? 'running' : ''}`} onClick={() => setIsAutoRunning(!isAutoRunning)}>
                    {isAutoRunning ? 'STOPPING...' : 'START AUTO TRADE'}
                </button>
            </div>
        </div>
    );
});

export default OverUnder;
