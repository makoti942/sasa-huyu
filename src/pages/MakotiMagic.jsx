import React, { useState, useRef, useEffect } from 'react';
import { observer } from 'mobx-react-lite';

const MakotiMagic = observer(() => {
    const [token, setToken] = useState('');
    const [stake, setStake] = useState(0.35);
    const [currency, setCurrency] = useState('USD');
    const [is_hunting, setIsHunting] = useState(false);
    const [results, setResults] = useState([]);
    const [total_pl, setTotalPL] = useState(0);
    const [status, setStatus] = useState('OFFLINE');
    
    const workerRef = useRef(null);

    useEffect(() => {
        const workerBlob = new Blob([`
            let ws;
            let active = false;

            self.onmessage = function(e) {
                const { type, payload } = e.data;
                
                if (type === 'START') {
                    active = true;
                    ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
                    
                    ws.onopen = () => ws.send(JSON.stringify({ authorize: payload.token }));
                    
                    ws.onmessage = (msg) => {
                        const res = JSON.parse(msg.data);
                        
                        if (res.error) {
                            self.postMessage({ type: 'ERROR', data: res.error.message });
                            return;
                        }

                        if (res.msg_type === 'authorize') {
                            self.postMessage({ type: 'STATUS', data: 'CONNECTED' });
                            // Subscribe to ticks and proposal updates
                            ws.send(JSON.stringify({ ticks: '1HZ100V', subscribe: 1 }));
                        }

                        if (active && res.msg_type === 'tick') {
                            const quote = res.tick.quote.toString();
                            const digit = quote.slice(-1);
                            
                            // GATE HACK: Inject trade for CURRENT digit
                            ws.send(JSON.stringify({
                                buy: 1, 
                                price: payload.stake,
                                parameters: {
                                    amount: payload.stake,
                                    basis: 'stake',
                                    contract_type: 'DIGITMATCH',
                                    currency: payload.currency,
                                    duration: 1,
                                    duration_unit: 't',
                                    symbol: '1HZ100V',
                                    barrier: parseInt(digit)
                                },
                                subscribe: 1 // Crucial: Subscribe to result
                            }));
                        }

                        // Catch the result immediately
                        if (res.msg_type === 'proposal_open_contract') {
                            const contract = res.proposal_open_contract;
                            if (contract.is_sold) {
                                self.postMessage({ type: 'RESULT', data: {
                                    id: contract.contract_id,
                                    target: contract.barrier,
                                    exit: contract.exit_tick_display_value.slice(-1),
                                    profit: contract.profit,
                                    status: contract.status
                                }});
                            }
                        }
                    };
                }

                if (type === 'STOP') {
                    active = false;
                    if(ws) ws.close();
                }
            };
        `], { type: 'application/javascript' });

        workerRef.current = new Worker(URL.createObjectURL(workerBlob));

        workerRef.current.onmessage = (e) => {
            const { type, data } = e.data;
            if (type === 'STATUS') setStatus(data);
            if (type === 'ERROR') alert(data);
            if (type === 'RESULT') {
                // Check if this result is already in the list to avoid duplicates
                setResults(prev => {
                    if (prev.find(r => r.id === data.id)) return prev;
                    return [data, ...prev].slice(0, 10);
                });
                setTotalPL(v => v + data.profit);
            }
        };

        return () => workerRef.current.terminate();
    }, []);

    const handleToggle = () => {
        if (!is_hunting) {
            if (!token) return alert("Enter Token");
            setStatus('CONNECTING...');
            workerRef.current.postMessage({ 
                type: 'START', 
                payload: { token: token.trim(), stake: Number(stake), currency } 
            });
        } else {
            workerRef.current.postMessage({ type: 'STOP' });
            setStatus('OFFLINE');
        }
        setIsHunting(!is_hunting);
    };

    return (
        <div style={ui.container}>
            <div style={ui.header}>
                <span style={{color: status === 'CONNECTED' ? '#0f0' : '#f00'}}>{status}</span>
                <div style={ui.balance}>NET: ${total_pl.toFixed(2)}</div>
            </div>

            <div style={ui.inputRow}>
                <input placeholder="API Token" type="password" value={token} onChange={e => setToken(e.target.value)} style={ui.input} />
                <input type="number" value={stake} onChange={e => setStake(e.target.value)} style={ui.numInput} />
                <select value={currency} onChange={e => setCurrency(e.target.value)} style={ui.select}>
                    <option value="USD">USD</option>
                    <option value="VRTC">VRTC</option>
                </select>
            </div>

            <button onClick={handleToggle} style={is_hunting ? ui.btnStop : ui.btnStart}>
                {is_hunting ? 'STOP ENGINE' : 'START SURGICAL STRIKE'}
            </button>

            <div style={ui.log}>
                <table style={{width: '100%', textAlign: 'left'}}>
                    <thead>
                        <tr>
                            <th>TGT</th>
                            <th>EXIT</th>
                            <th>PROFIT</th>
                        </tr>
                    </thead>
                    <tbody>
                        {results.map(r => (
                            <tr key={r.id}>
                                <td style={{color: '#0f0'}}>{r.target}</td>
                                <td style={{color: r.target === r.exit ? '#0f0' : '#f44'}}>{r.exit}</td>
                                <td style={{color: r.profit > 0 ? '#0f0' : '#f44'}}>{r.profit}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
});

const ui = {
    container: { background: '#000', color: '#fff', minHeight: '100vh', padding: '10px', fontFamily: 'monospace' },
    header: { display: 'flex', justifyContent: 'space-between', marginBottom: '20px' },
    balance: { fontSize: '20px', fontWeight: 'bold' },
    inputRow: { display: 'flex', gap: '5px', marginBottom: '10px' },
    input: { flex: 2, background: '#111', color: '#fff', border: '1px solid #333', padding: '10px' },
    numInput: { flex: 0.5, background: '#111', color: '#fff', border: '1px solid #333', padding: '10px' },
    select: { flex: 1, background: '#111', color: '#fff', border: '1px solid #333' },
    btnStart: { width: '100%', padding: '15px', background: '#040', color: '#0f0', border: 'none', fontWeight: 'bold', cursor: 'pointer' },
    btnStop: { width: '100%', padding: '15px', background: '#400', color: '#f44', border: 'none', fontWeight: 'bold', cursor: 'pointer' },
    log: { marginTop: '20px', borderTop: '1px solid #222', paddingTop: '10px' }
};

export default MakotiMagic;
