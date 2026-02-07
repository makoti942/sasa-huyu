import React, { useState, useRef, useEffect } from 'react';

const MakotiMagic = () => {
    const [token, setToken] = useState('');
    const [stake, setStake] = useState(0.35);
    const [is_hunting, setIsHunting] = useState(false);
    const [results, setResults] = useState([]);
    const [total_pl, setTotalPL] = useState(0);
    const [status, setStatus] = useState('OFFLINE');
    const [liveDigit, setLiveDigit] = useState('-');
    
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
                    ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
                    
                    ws.onopen = () => ws.send(JSON.stringify({ authorize: payload.token }));
                    
                    ws.onmessage = (msg) => {
                        const res = JSON.parse(msg.data);
                        
                        if (res.msg_type === 'authorize') {
                            self.postMessage({ type: 'STATUS', data: 'CONNECTED' });
                            ws.send(JSON.stringify({ ticks: '1HZ100V', subscribe: 1 }));
                        }

                        // THE OVERLAP SHOTGUN (4 STRIKES)
                        if (active && res.msg_type === 'tick' && !isWaiting) {
                            const q = res.tick.quote.toString();
                            const d = q[q.length - 1]; 
                            
                            self.postMessage({ type: 'TICK', data: d });
                            isWaiting = true; 

                            // PRE-FLIGHT RAW STRING (Max Speed)
                            const packet = '{"buy":1,"price":'+payload.stake+',"parameters":{"amount":'+payload.stake+',"basis":"stake","contract_type":"DIGITMATCH","currency":"USD","duration":1,"duration_unit":"t","symbol":"1HZ100V","barrier":'+d+'},"subscribe":1}';

                            // 4-STRIKE PRESSURE BURST
                            ws.send(packet);
                            ws.send(packet);
                            ws.send(packet);
                            ws.send(packet);
                        }

                        if (res.msg_type === 'proposal_open_contract' && res.proposal_open_contract.is_sold) {
                            isWaiting = false; 
                            self.postMessage({ type: 'RESULT', data: res.proposal_open_contract });
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
            if (type === 'TICK') setLiveDigit(data);
            if (type === 'RESULT') {
                setResults(prev => [{
                    id: data.contract_id,
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
                <h2 style={ui.title}>SHOTGUN OVERLAP <span style={{color:'#0f0'}}>V24</span></h2>
                
                <div style={ui.monitor}>
                    <div style={{fontSize:'80px', color:'#0f0', fontWeight:'900', textShadow:'0 0 30px #0f0'}}>{liveDigit}</div>
                </div>

                <div style={ui.statsRow}>
                    <div style={{color: status === 'CONNECTED' ? '#0f0' : '#f44', fontWeight:'bold'}}>{status}</div>
                    <div style={{fontSize: '34px', color: total_pl >= 0 ? '#0f0' : '#f44'}}>${total_pl.toFixed(2)}</div>
                </div>

                <div style={ui.form}>
                    <button 
                        onClick={() => window.open('https://app.deriv.com/account/api-token', '_blank')} 
                        style={ui.btnSecondary}
                    >
                        GET YOUR API TOKEN
                    </button>
                    <input type="password" value={token} onChange={e => setToken(e.target.value)} style={ui.input} placeholder="API TOKEN" />
                    <input type="number" value={stake} onChange={e => setStake(e.target.value)} style={ui.input} placeholder="STAKE ($)" />
                    <button onClick={handleToggle} style={is_hunting ? ui.btnStop : ui.btnStart}>
                        {is_hunting ? 'STOP BURST' : 'EXECUTE 4-STRIKE'}
                    </button>
                </div>

                <div style={ui.table}>
                    {results.map((r) => (
                        <div key={r.id} style={ui.tr}>
                            <span>TGT: <b>{r.target}</b></span>
                            <span style={{color: r.target === r.exit ? '#0f0' : '#f44'}}>EXIT: <b>{r.exit}</b></span>
                            <span style={{fontWeight:'bold'}}>{r.profit > 0 ? 'MATCH!' : 'MISS'}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

const ui = {
    page: { background: '#000', minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: 'monospace' },
    card: { width: '420px', background: '#070707', padding: '30px', borderRadius: '20px', border: '2px solid #1a1a1a', textAlign: 'center' },
    title: { fontSize: '22px', color: '#fff', marginBottom: '15px', letterSpacing: '2px' },
    monitor: { background: '#000', padding: '15px', borderRadius: '15px', border: '1px solid #333', marginBottom: '25px' },
    statsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' },
    form: { display: 'flex', flexDirection: 'column', gap: '12px' },
    input: { width: '100%', padding: '15px', background: '#000', border: '1px solid #333', color: '#0f0', fontSize: '18px', boxSizing: 'border-box' },
    btnStart: { padding: '20px', background: '#0f0', color: '#000', border: 'none', fontWeight: '900', fontSize: '18px', cursor: 'pointer', borderRadius: '10px' },
    btnStop: { padding: '20px', background: '#300', color: '#f44', border: 'none', fontWeight: '900', fontSize: '18px', cursor: 'pointer', borderRadius: '10px' },
    btnSecondary: { padding: '15px', background: '#222', color: '#fff', border: '1px solid #333', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer', borderRadius: '10px', textAlign: 'center' },
    table: { marginTop: '25px' },
    tr: { display: 'flex', justifyContent: 'space-between', padding: '12px', background: '#111', marginBottom: '6px', borderRadius: '8px', color: '#eee' }
};

export default MakotiMagic;
