import React, { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { api_base } from '@/external/bot-skeleton';
import './over-under.scss';

const OverUnder = observer(() => {
    const { client } = useStore();
    const [digit, setDigit] = useState(0);
    const [stats, setStats] = useState(new Array(10).fill(0));
    const [activeSymbol, setActiveSymbol] = useState('R_100');
    const [stake, setStake] = useState(1);
    const [entryDigit, setEntryDigit] = useState(5);
    const [isAuto, setIsAuto] = useState(false);
    const [turbo, setTurbo] = useState(false);
    const lastDigits = useRef<number[]>([]);

    // Connect to Deriv Ticks
    useEffect(() => {
        const ticks = api_base.api.onMessage().subscribe((msg: any) => {
            if (msg.data.msg_type === 'tick' && msg.data.tick.symbol === activeSymbol) {
                const lastDigit = parseInt(msg.data.tick.quote.toString().slice(-1));
                setDigit(lastDigit);
                
                // Update Stats (Last 100)
                lastDigits.current = [...lastDigits.current, lastDigit].slice(-100);
                const newStats = new Array(10).fill(0);
                lastDigits.current.forEach(d => newStats[d]++);
                setStats(newStats.map(v => (v / lastDigits.current.length) * 100));

                // Auto Trade Logic
                if (isAuto && lastDigit === entryDigit) {
                    executeTrades();
                }
            }
        });
        api_base.api.send({ ticks: activeSymbol });
        return () => ticks.unsubscribe();
    }, [activeSymbol, isAuto, entryDigit]);

    const executeTrades = async () => {
        const tradeParams = (type: string, barrier: string) => ({
            buy: 1,
            price: stake,
            parameters: {
                amount: stake,
                basis: 'stake',
                contract_type: type,
                currency: client.currency,
                duration: 1,
                duration_unit: 't',
                barrier: barrier,
                symbol: activeSymbol,
            },
        });

        // MULTI-TRADE: Execute both at once
        await Promise.all([
            api_base.api.send(tradeParams('DIGITUNDER', '4')),
            api_base.api.send(tradeParams('DIGITOVER', '5'))
        ]);
        
        if (!turbo) setIsAuto(false); // Stop if not turbo
    };

    return (
        <div className="over-under-container">
            <div className="digit-display">
                <div className="current-digit">{digit}</div>
                <div className="stats-bar">
                    {stats.map((s, i) => (
                        <div key={i} className={`stat-col ${digit === i ? 'active' : ''}`}>
                            <div className="bar" style={{height: `${s}%`}}></div>
                            <span>{i}</span>
                            <small>{s.toFixed(0)}%</small>
                        </div>
                    ))}
                </div>
            </div>

            <div className="controls">
                <input type="number" value={stake} onChange={e => setStake(Number(e.target.value))} placeholder="Stake" />
                <input type="number" value={entryDigit} onChange={e => setEntryDigit(Number(e.target.value))} placeholder="Entry Digit" />
                
                <div className="buttons">
                    <button onClick={executeTrades}>Manual Trade (Both)</button>
                    <button className={isAuto ? 'active' : ''} onClick={() => setIsAuto(!isAuto)}>
                        {isAuto ? 'Stop Auto' : 'Start Auto'}
                    </button>
                    <label>
                        Turbo <input type="checkbox" checked={turbo} onChange={e => setTurbo(e.target.checked)} />
                    </label>
                </div>
            </div>
        </div>
    );
});

export default OverUnder;
