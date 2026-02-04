import React, { useState, useRef, useEffect } from 'react';

const MakotiMagic = () => {
    const [token, setToken] = useState('');
    const [stake, setStake] = useState(0.35);
    const [offset, setOffset] = useState(0); 
    const [is_hunting, setIsHunting] = useState(false);
    const [results, setResults] = useState([]);
    const [total_pl, setTotalPL] = useState(0);
    const [status, setStatus] = useState('OFFLINE');
    
    const workerRef = useRef(null);

    useEffect(() => {
        // WORKER LOGIC
        const workerBlob = new Blob([`
            let ws;
            let active = false; // Moved to global scope of Worker
            let isWaiting = false; 

            self.onmessage = function(e) {
                const { type, payload } = e.data;
                
                if (type === 'START') {
                    active = true;
                    // Reset connection if exists
                    if(ws) ws.close();

                    ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
                    
                    ws.onopen = () => {
                        ws.send(JSON.stringify({ authorize: payload.token }));
                    };
                    
                    ws.onmessage = (msg) => {
                        const res = JSON.parse(msg.data);
                        
                        if (res.error) {
                            self.postMessage({ type: 'STATUS', data: 'ERROR: ' + res.error.code });
                            return;
                        }

                        if (res.msg_type === 'authorize') {
                            self.postMessage({ type: 'STATUS', data: 'CONNECTED' });
                            ws.send(JSON.stringify({ ticks: '1HZ100V', subscribe: 1 }));
                        }

                        // THE INJECTION TRIGGER
                        if (active && res.msg_type === 'tick' && !isWaiting) {
                            const digit = parseInt(res.tick.quote.toString().slice(-1));
                            isWaiting = true; // Lock immediately

                            // EXECUTE TRADE
                            setTimeout(() => {
                                if(!active || !ws || ws.readyState !== 1) return;
                                
                                ws.send(JSON.stringify({
                                    buy: 1, 
                                    price: payload.stake,
                                    parameters: {
                                        amount: payload.stake,
                                        basis: 'stake',
                                        contract_type: 'DIGITMATCH',
                                        currency: 'USD',
                                        duration: 1,
                                        duration_unit: 't',
                                        symbol: '1HZ100V',
                                        barrier: digit
                                    },
                                    subscribe: 1 // CRITICAL FIX: Ensures we get the result
                                }));
                            }, payload.offset);
                        }

                        // LISTEN FOR RESULTS
                        if (res.msg_type === 'proposal_open_contract') {
                            const contract = res.proposal_open_contract;
                            
                            // Only unlock if the contract is actually finished
                            if (contract.is_sold) {
                                isWaiting = false; 
                                self.postMessage({ type: 'RESULT', data: contract });
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
                    stake: data.buy_price,
                    target: data.barrier,
                    exit: data.exit_tick_display_value?.slice(-1) || '?',
                    profit: data.profit
                }, ...prev].slice(0, 8));
                setTotalPL(v => v + data.profit);
            }
        };

        return () => workerRef.current.terminate();
    }, []);

    const handleToggle = () => {
        if (!is_hunting) {
            if (!token) return alert("Please enter API Token");
            setIsHunting(true);
            setResults([]); // Clear previous session results
            workerRef.current.postMessage({ 
                type: 'START', 
                payload: { token: token.trim(), stake: Number(stake), offset: Number(offset) } 
            });
        } else {
            setIsHunting(false);
            workerRef.current.postMessage({ type: 'STOP' });
        }
    };

    return (
        <div style={ui.page}>
            <div style={ui.card}>
                <h1 style={ui.title}>MAKOTI <span style={{color:'#0f0'}}>V15</span></h1>
                
                <div style={ui.statsRow}>
                    <div style={{color: status === 'CONNECTED' ? '#0f0' : '#f44', fontWeight:'bold', fontSize:'14px'}}>{status}</div>
                    <div style={{fontSize: '32px', color: total_pl >= 0 ? '#0f0' : '#f44'}}>${total_pl.toFixed(2)}</div>
                </div>

                <div style={ui.form}>
                    <div style={ui.field}>
                        <label style={ui.label}>API TOKEN</label>
                        <input type="password" value={token} onChange={e => setToken(e.target.value)} style={ui.input} />
                    </div>
                    
                    <div style={ui.row}>
                        <div style={ui.field}>
                            <label style={ui.label}>STAKE ($)</label>
                            <input type="number" value={stake} onChange={e => setStake(e.target.value)} style={ui.input} />
                        </div>
                        <div style={ui.field}>
                            <label style={ui.label}>OFFSET (MS)</label>
                            <input type="number" value={offset} onChange={e => setOffset(e.target.value)} style={ui.input} />
                        </div>
                    </div>

                    <button onClick={handleToggle} style={is_hunting ? ui.btnStop : ui.btnStart}>
                        {is_hunting ? 'STOP ENGINE' : 'START SURGICAL STRIKE'}
                    </button>
                </div>

                <div style={ui.table}>
                    <div style={ui.th}>
                        <span>STAKE</span><span>TGT</span><span>EXIT</span><span>P/L</span>
                    </div>
                    {results.map((r) => (
                        <div key={r.id} style={ui.tr}>
                            <span>{r.stake}</span>
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
    card: { width: '450px', background: '#0a0a0a', padding: '30px', borderRadius: '15px', border: '1px solid #222', textAlign: 'center' },
    title: { fontSize: '24px', color: '#fff', marginBottom: '10px', letterSpacing: '2px' },
    statsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', padding: '10px', borderBottom: '1px solid #1a1a1a' },
    form: { display: 'flex', flexDirection: 'column', gap: '15px' },
    field: { textAlign: 'left', flex: 1 },
    label: { fontSize: '10px', color: '#555', marginBottom: '5px', display: 'block' },
    input: { width: '100%', padding: '12px', background: '#000', border: '1px solid #333', color: '#0f0', fontSize: '18px', boxSizing: 'border-box', borderRadius: '5px' },
    row: { display: 'flex', gap: '10px' },
    btnStart: { padding: '15px', background: '#0f0', color: '#000', border: 'none', borderRadius: '5px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer' },
    btnStop: { padding: '15px', background: '#400', color: '#f44', border: 'none', borderRadius: '5px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer' },
    table: { marginTop: '25px' },
    th: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#444', marginBottom: '10px', padding: '0 10px' },
    tr: { display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#111', borderRadius: '5px', marginBottom: '5px', color: '#fff', fontSize: '16px' }
};

export default MakotiMagic;
