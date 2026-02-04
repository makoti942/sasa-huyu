import React, { useState, useRef, useEffect } from 'react';

const MakotiMagic = () => {
    const [token, setToken] = useState('');
    const [stake, setStake] = useState(0.35);
    const [is_hunting, setIsHunting] = useState(false);
    const [results, setResults] = useState([]);
    const [total_pl, setTotalPL] = useState(0);
    const [status, setStatus] = useState('OFFLINE');
    
    const workerRef = useRef(null);

    useEffect(() => {
        const workerBlob = new Blob([`
            let ws;
            let active = false;
            let isWaiting = false;

            self.onmessage = function(e) {
                const { type, payload } = e.data;
                
                if (type === 'START') {
                    active = true;
                    if(ws) ws.close();

                    ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
                    
                    ws.onopen = () => {
                        ws.send(JSON.stringify({ authorize: payload.token }));
                    };
                    
                    ws.onmessage = (msg) => {
                        const res = JSON.parse(msg.data);
                        
                        if (res.msg_type === 'authorize') {
                            self.postMessage({ type: 'STATUS', data: 'CONNECTED' });
                            ws.send(JSON.stringify({ ticks: '1HZ100V', subscribe: 1 }));
                        }

                        // ZERO-LATENCY INJECTION
                        if (active && res.msg_type === 'tick' && !isWaiting) {
                            // 1. Capture Data Instantly
                            const tickId = res.tick.id;
                            const digit = parseInt(res.tick.quote.toString().slice(-1));
                            
                            isWaiting = true; // Lock

                            // 2. SEND IMMEDIATELY (No Timeout, No Delay)
                            // We construct the string manually to save JSON.stringify time
                            ws.send(JSON.stringify({
                                buy: 1,
                                price: payload.stake,
                                parameters: { 
                                    amount: payload.stake, 
                                    basis: 'stake', 
                                    contract_type: 'DIGITMATCH', 
                                    currency: 'USD', 
                                    symbol: '1HZ100V', 
                                    duration: 1, 
                                    duration_unit: 't', 
                                    barrier: digit 
                                },
                                subscribe: 1,
                                passthrough: { target_tick_id: tickId } // Tag packet to measure lag later
                            }));
                        }

                        // RESULT PROCESSING
                        if (res.msg_type === 'proposal_open_contract') {
                            const contract = res.proposal_open_contract;
                            
                            if (contract.is_sold) {
                                isWaiting = false; // Unlock
                                
                                // Calculate Lag: Did we hit the same tick ID we saw?
                                // If entry_tick > target_tick, we were late.
                                const entryTickId = contract.entry_tick;
                                const targetTickId = res.echo_req.passthrough?.target_tick_id;
                                let lag = '?';
                                if (entryTickId && targetTickId) {
                                    lag = entryTickId - targetTickId;
                                }

                                self.postMessage({ 
                                    type: 'RESULT', 
                                    data: { ...contract, lag: lag } 
                                });
                            }
                        }
                    };
                }

                if (type === 'STOP') {
                    active = false;
                    if(ws) ws.close();
                    self.postMessage({ type: 'STATUS', data: 'OFFLINE' });
                }
            };
        `], { type: 'application/javascript' });

        workerRef.current = new Worker(URL.createObjectURL(workerBlob));
        
        workerRef.current.onmessage = (e) => {
            const { type, data } = e.data;
            if (type === 'STATUS') setStatus(data);
            if (type === 'RESULT') {
                setResults(prev => [{
                    id: data.contract_id,
                    target: data.barrier,
                    exit: data.exit_tick_display_value?.slice(-1) || '?',
                    profit: data.profit,
                    lag: data.lag,
                    status: data.status
                }, ...prev].slice(0, 10));
                setTotalPL(v => v + data.profit);
            }
        };

        return () => workerRef.current.terminate();
    }, []);

    const handleToggle = () => {
        if (!is_hunting) {
            setIsHunting(true);
            setResults([]);
            workerRef.current.postMessage({ 
                type: 'START', 
                payload: { token: token.trim(), stake: Number(stake) } 
            });
        } else {
            setIsHunting(false);
            workerRef.current.postMessage({ type: 'STOP' });
        }
    };

    return (
        <div style={ui.page}>
            <div style={ui.card}>
                <h1 style={ui.title}>ZERO-LATENCY <span style={{color:'#0f0'}}>V16</span></h1>
                
                <div style={ui.statsRow}>
                    <div style={{color: status === 'CONNECTED' ? '#0f0' : '#f44', fontWeight:'bold'}}>{status}</div>
                    <div style={{fontSize: '28px', color: total_pl >= 0 ? '#0f0' : '#f44'}}>${total_pl.toFixed(2)}</div>
                </div>

                <div style={ui.form}>
                    <input type="password" value={token} onChange={e => setToken(e.target.value)} style={ui.input} placeholder="API TOKEN" />
                    <input type="number" value={stake} onChange={e => setStake(e.target.value)} style={ui.input} placeholder="STAKE" />
                    
                    <button onClick={handleToggle} style={is_hunting ? ui.btnStop : ui.btnStart}>
                        {is_hunting ? 'STOP ENGINE' : 'START DIRECT INJECTION'}
                    </button>
                </div>

                <div style={ui.table}>
                    <div style={ui.th}>
                        <span>LAG</span><span>TGT</span><span>EXIT</span><span>PROFIT</span>
                    </div>
                    {results.map((r) => (
                        <div key={r.id} style={ui.tr}>
                            <span style={{color: r.lag === 0 ? '#0f0' : '#f44', fontWeight:'bold'}}>
                                {r.lag === 0 ? 'SYNC' : `+${r.lag} TICK`}
                            </span>
                            <span style={{color:'#fff', fontWeight:'bold'}}>{r.target}</span>
                            <span style={{color: r.target === r.exit ? '#0f0' : '#f44'}}>{r.exit}</span>
                            <span style={{color: r.profit >= 0 ? '#0f0' : '#f44'}}>{r.profit.toFixed(2)}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

const ui = {
    page: { background: '#000', minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: 'monospace' },
    card: { width: '450px', background: '#080808', padding: '30px', borderRadius: '15px', border: '1px solid #222', textAlign: 'center' },
    title: { fontSize: '24px', color: '#fff', marginBottom: '10px', letterSpacing: '2px' },
    statsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', padding: '10px', borderBottom: '1px solid #1a1a1a' },
    form: { display: 'flex', flexDirection: 'column', gap: '15px' },
    input: { width: '100%', padding: '15px', background: '#000', border: '1px solid #333', color: '#0f0', fontSize: '18px', boxSizing: 'border-box', borderRadius: '5px' },
    btnStart: { padding: '15px', background: '#0f0', color: '#000', border: 'none', borderRadius: '5px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer' },
    btnStop: { padding: '15px', background: '#400', color: '#f44', border: 'none', borderRadius: '5px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer' },
    table: { marginTop: '25px' },
    th: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#444', marginBottom: '10px', padding: '0 10px' },
    tr: { display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#111', borderRadius: '5px', marginBottom: '5px', color: '#fff', fontSize: '16px' }
};

export default MakotiMagic;
