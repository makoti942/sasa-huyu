import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getSocketURL, getAppId } from '@/components/shared';
import { sendViaNewSystemWithPromise, onNewSystemMessage, sendViaNewSystem } from '@/auth/NewDerivAuth';

const pip_sizes: Record<string, number> = {
  R_100: 2, R_75: 4, R_50: 4, R_25: 3, R_10: 3,
  '1HZ100V': 2, '1HZ75V': 2, '1HZ50V': 2, '1HZ25V': 2, '1HZ10V': 2,
};
const SYMBOLS = Object.keys(pip_sizes);
const MAX_TICKS = 1000;

const TRADE_TYPES = [
  { value: 'rise_fall', label: 'Rise/Fall' },
  { value: 'over_under', label: 'Over/Under' },
  { value: 'digits', label: 'Digits' },
  { value: 'even_odd', label: 'Even/Odd' },
  { value: 'accumulator', label: 'Accumulator' },
];

function getPipSize(symbol: string): number { return pip_sizes[symbol] || 2; }
function extractDigit(quote: number, pip_size: number): number {
  const q = Number(quote);
  if (isNaN(q)) return 0;
  return parseInt(q.toFixed(pip_size).slice(-1), 10);
}

interface ContractInfo {
  id: string; contract_type: string; stake: number; symbol: string;
  entry_tick: number; entry_digit: number; exit_tick?: number;
  exit_digit?: number; profit?: number; is_sold: boolean; is_win?: boolean;
}

const contractLabels: Record<string, string> = {
  CALL: 'Rise', PUT: 'Fall', DIGITOVER: 'Over', DIGITUNDER: 'Under',
  DIGITMATCH: 'Match', DIGITDIFF: 'Diff', DIGITEVEN: 'Even', DIGITODD: 'Odd',
  ACCU: 'Buy',
};

const NewDTrader: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const tickPrices = useRef<number[]>([]);
  const animRef = useRef<number>(0);
  const priceRef = useRef<number | null>(null);
  const digitRef = useRef<number | null>(null);
  const activeContractsRef = useRef<ContractInfo[]>([]);
  const stakeRef = useRef(5);
  const symbolRef = useRef('R_100');
  const barrierRef = useRef('5');
  const durationRef = useRef(1);
  const durationUnitRef = useRef<'t' | 'm'>('t');
  const tradeTypeRef = useRef('rise_fall');
  const pipSizeRef = useRef(2);
  const growthRateRef = useRef(0.01);

  const [symbol, setSymbol] = useState('R_100');
  const [tradeType, setTradeType] = useState('rise_fall');
  const [stake, setStake] = useState(5);
  const [barrier, setBarrier] = useState('5');
  const [duration, setDuration] = useState(1);
  const [durationUnit, setDurationUnit] = useState<'t' | 'm'>('t');
  const [allowEquals, setAllowEquals] = useState(false);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentDigit, setCurrentDigit] = useState<number | null>(null);
  const [tickHistory, setTickHistory] = useState<number[]>([]);
  const [digitCounts, setDigitCounts] = useState<number[]>(Array(10).fill(0));
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [balance, setBalance] = useState<number | null>(null);
  const [activeContracts, setActiveContracts] = useState<ContractInfo[]>([]);
  const [contractHistory, setContractHistory] = useState<ContractInfo[]>([]);
  const [sessionStats, setSessionStats] = useState({ wins: 0, losses: 0, profit: 0 });
  const [isTrading, setIsTrading] = useState(false);
  const [exitHighlight, setExitHighlight] = useState<{ digit: number; win: boolean } | null>(null);
  const [showChart, setShowChart] = useState(true);
  const [contractType, setContractType] = useState('CALL');
  const [payout, setPayout] = useState<string | null>(null);
  const [tradeResult, setTradeResult] = useState<{ isWin: boolean; profit: number; contract_type: string; entry_digit: number; exit_digit: number } | null>(null);
  const [growthRate, setGrowthRate] = useState(0.01);
  const [takeProfit, setTakeProfit] = useState('');

  const isPhone = typeof window !== 'undefined' && window.innerWidth < 768;
  const contractTypes = TRADE_TYPES.find(t => t.value === tradeType)?.label || 'Rise/Fall';

  stakeRef.current = stake; symbolRef.current = symbol; barrierRef.current = barrier;
  durationRef.current = duration; durationUnitRef.current = durationUnit;
  tradeTypeRef.current = tradeType; pipSizeRef.current = getPipSize(symbol);
  growthRateRef.current = growthRate;

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const pad = { top: 10, right: 60, bottom: 20, left: 5 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;
    ctx.clearRect(0, 0, W, H);

    const prices = tickPrices.current;
    if (prices.length < 2) {
      ctx.fillStyle = '#555';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for ticks...', W / 2, H / 2);
      return;
    }

    const visible = prices.slice(-300);
    const minP = Math.min(...visible);
    const maxP = Math.max(...visible);
    const range = maxP - minP || 1;
    const padding = range * 0.05;
    const yMin = minP - padding;
    const yMax = maxP + padding;
    const yRange = yMax - yMin;
    const toX = (i: number) => pad.left + (i / (visible.length - 1)) * chartW;
    const toY = (v: number) => pad.top + chartH - ((v - yMin) / yRange) * chartH;

    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (i / 5) * chartH;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      const val = yMax - (i / 5) * yRange;
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val.toFixed(2), W - pad.right + 55, y + 3);
    }

    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    gradient.addColorStop(0, 'rgba(200,200,200,0.2)');
    gradient.addColorStop(1, 'rgba(200,200,200,0.02)');
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(visible[0]));
    for (let i = 1; i < visible.length; i++) ctx.lineTo(toX(i), toY(visible[i]));
    ctx.lineTo(toX(visible.length - 1), pad.top + chartH);
    ctx.lineTo(toX(0), pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(toX(0), toY(visible[0]));
    for (let i = 1; i < visible.length; i++) ctx.lineTo(toX(i), toY(visible[i]));
    ctx.strokeStyle = '#85acb0';
    ctx.lineWidth = 2;
    ctx.stroke();

    const lastX = toX(visible.length - 1);
    const lastY = toY(visible[visible.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#85acb0';
    ctx.fill();

    ctx.strokeStyle = 'rgba(133,172,176,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(lastX, pad.top);
    ctx.lineTo(lastX, pad.top + chartH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#333';
    ctx.strokeStyle = '#85acb0';
    ctx.lineWidth = 1;
    const label = visible[visible.length - 1].toFixed(2);
    const tw = ctx.measureText(label).width + 16;
    const lx = lastX - tw / 2;
    const ly = lastY > pad.top + chartH / 2 ? lastY - 20 : lastY + 10;
    ctx.fillStyle = '#85acb0';
    ctx.beginPath();
    ctx.roundRect(lx, ly, tw, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, lx + tw / 2, ly + 13);
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const ro = new ResizeObserver(() => drawChart());
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [drawChart]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(function loop() {
      drawChart();
      animRef.current = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(animRef.current);
  }, [drawChart]);

  const connectTicks = useCallback((sym: string) => {
    if (wsRef.current) { try { wsRef.current.onclose = null; wsRef.current.close(); } catch {} }
    tickPrices.current = [];
    priceRef.current = null; digitRef.current = null;
    setCurrentPrice(null); setCurrentDigit(null);
    setTickHistory([]); setDigitCounts(Array(10).fill(0));

    const server_url = getSocketURL()?.replace(/[^a-zA-Z0-9.]/g, '');
    const app_id = getAppId();
    if (!server_url || !app_id) return;
    const ws = new WebSocket(`wss://${server_url}/websockets/v3?app_id=${app_id}`);
    wsRef.current = ws;
    setConnectionStatus('Connecting...');
    ws.onopen = () => {
      if (ws !== wsRef.current) return;
      ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
      ws.send(JSON.stringify({ ticks_history: sym, count: MAX_TICKS, end: 'latest', style: 'ticks', subscribe: 1 }));
      setConnectionStatus('Live');
    };
    ws.onmessage = (event) => {
      if (ws !== wsRef.current) return;
      try {
        const data = JSON.parse(event.data);
        if (data.msg_type === 'tick' && data.tick?.quote) {
          const tick = data.tick;
          const ps = tick.pip_size || getPipSize(tick.symbol || sym);
          const digit = extractDigit(tick.quote, ps);
          tickPrices.current = [...tickPrices.current.slice(-MAX_TICKS + 1), tick.quote];
          priceRef.current = tick.quote; digitRef.current = digit;
          setCurrentPrice(tick.quote); setCurrentDigit(digit);
          setTickHistory(prev => {
            const next = [...prev.slice(-MAX_TICKS + 1), digit];
            const counts = Array(10).fill(0) as number[];
            next.forEach(d => { if (d >= 0 && d <= 9) counts[d]++; });
            setDigitCounts(counts); return next;
          });
        } else if (data.msg_type === 'history' && data.history?.prices) {
          const prices: number[] = data.history.prices;
          const ps = getPipSize(sym);
          tickPrices.current = prices.slice(-MAX_TICKS);
          if (prices.length > 0) {
            const lastP = prices[prices.length - 1];
            const digits = prices.map((p: number) => extractDigit(p, ps));
            priceRef.current = lastP; digitRef.current = digits[digits.length - 1];
            setCurrentPrice(lastP); setCurrentDigit(digits[digits.length - 1]);
            setTickHistory(digits.slice(-MAX_TICKS));
            const counts = Array(10).fill(0) as number[];
            digits.slice(-MAX_TICKS).forEach((d: number) => { if (d >= 0 && d <= 9) counts[d]++; });
            setDigitCounts(counts);
          }
        }
      } catch {}
    };
    ws.onclose = () => {
      if (ws !== wsRef.current) return;
      setConnectionStatus('Disconnected');
      setTimeout(() => connectTicks(sym), 3000);
    };
    ws.onerror = () => { if (ws === wsRef.current) ws.close(); };
  }, []);

  useEffect(() => {
    connectTicks(symbol);
    return () => { if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }};
  }, [symbol, connectTicks]);

  useEffect(() => {
    const unsub = onNewSystemMessage((event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.msg_type === 'balance' && !data.error) {
          const bal = data.balance?.balance ?? data.balance?.accounts?.total;
          if (bal != null) setBalance(Number(bal));
          return;
        }
        if (data.msg_type === 'buy') {
          setIsTrading(false);
          if (!data.error && data.buy?.contract_id) {
            const cid = String(data.buy.contract_id);
            const nc: ContractInfo = {
              id: cid, contract_type: '', stake: stakeRef.current,
              symbol: symbolRef.current, entry_tick: priceRef.current || 0,
              entry_digit: digitRef.current || 0, is_sold: false,
            };
            setActiveContracts(prev => { activeContractsRef.current = [...prev, nc]; return activeContractsRef.current; });
            sendViaNewSystem({ proposal_open_contract: 1, contract_id: data.buy.contract_id, subscribe: 1 });
            sendViaNewSystem({ balance: 1 });
          }
          return;
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
          const poc = data.proposal_open_contract;
          const cid = String(poc.contract_id);
          if (poc.is_sold) {
            const exitTick = poc.exit_tick ?? 0;
            const exitDigit = exitTick ? extractDigit(exitTick, pipSizeRef.current) : 0;
            const profit = Number(poc.profit ?? 0);
            const isWin = profit >= 0;
            const ac = activeContractsRef.current.find(c => c.id === cid);
            const entryTickRaw = poc.entry_tick ?? ac?.entry_tick;
            const entryDigit = entryTickRaw ? extractDigit(entryTickRaw, pipSizeRef.current) : (ac?.entry_digit ?? 0);
            setExitHighlight({ digit: exitDigit, win: isWin });
            setTimeout(() => setExitHighlight(null), 3000);
            setTradeResult({ isWin, profit, contract_type: poc.contract_type || ac?.contract_type || '', entry_digit: entryDigit, exit_digit: exitDigit });
            setActiveContracts(prev => { activeContractsRef.current = prev.filter(c => c.id !== cid); return activeContractsRef.current; });
            setContractHistory(prev => {
              if (prev.find(c => c.id === cid)) return prev;
              return [...prev, { id: cid, contract_type: poc.contract_type || ac?.contract_type || '', stake: Number(poc.buy_price ?? ac?.stake ?? 0), symbol: poc.symbol || ac?.symbol || '', entry_tick: entryTickRaw || 0, exit_tick: exitTick, profit, is_sold: true, entry_digit: entryDigit, exit_digit: exitDigit, is_win: isWin }];
            });
            setSessionStats(prev => ({ wins: prev.wins + (isWin ? 1 : 0), losses: prev.losses + (isWin ? 0 : 1), profit: prev.profit + profit }));
            sendViaNewSystem({ balance: 1 });
          } else {
            setActiveContracts(prev => { const u = prev.map(c => c.id === cid ? { ...c, entry_tick: poc.entry_tick ?? c.entry_tick } : c); activeContractsRef.current = u; return u; });
          }
          return;
        }
      } catch {}
    });
    return unsub;
  }, []);

  const handleBuyContract = async (ct: string) => {
    if (isTrading) return;
    setIsTrading(true);
    const isAccu = tradeType === 'accumulator';
    const params: Record<string, any> = {
      amount: stake, basis: 'stake', currency: 'USD',
      symbol, contract_type: ct,
    };
    if (isAccu) {
      params.growth_rate = growthRate;
      if (takeProfit) {
        params.limit_order = { take_profit: Number(takeProfit) };
      }
    } else {
      params.duration = duration;
      params.duration_unit = durationUnit;
    }
    if (ct === 'DIGITOVER' || ct === 'DIGITUNDER' || ct === 'DIGITMATCH' || ct === 'DIGITDIFF') {
      params.barrier = barrier;
    }
    try {
      const res = await sendViaNewSystemWithPromise({ buy: 1, price: stake, parameters: params });
      if (res?.error) {
        console.error('Buy error:', res.error);
      }
    } catch (e) {
      console.error('Buy failed:', e);
    }
    setIsTrading(false);
  };

  const requestProposal = async (ct: string) => {
    try {
      const isAccu = tradeType === 'accumulator';
      const params: Record<string, any> = {
        proposal: 1, amount: stake, basis: 'stake', currency: 'USD',
        symbol, contract_type: ct,
      };
      if (isAccu) {
        params.growth_rate = growthRate;
      } else {
        params.duration = duration;
        params.duration_unit = durationUnit;
      }
      if (ct === 'DIGITOVER' || ct === 'DIGITUNDER' || ct === 'DIGITMATCH' || ct === 'DIGITDIFF') {
        params.barrier = barrier;
      }
      const res = await sendViaNewSystemWithPromise(params);
      if (res?.proposal?.payout) {
        setPayout(Number(res.proposal.payout).toFixed(2));
      } else if (isAccu && res?.proposal?.longcode) {
        setPayout('ACCU');
      }
    } catch { setPayout(null); }
  };

  useEffect(() => {
    setPayout(null);
    const t = setTimeout(() => requestProposal(contractType), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractType, stake, duration, durationUnit, symbol, barrier, growthRate, tradeType]);

  const currentContracts: string[] = (() => {
    switch (tradeType) {
      case 'rise_fall': return ['CALL', 'PUT'];
      case 'over_under': return ['DIGITOVER', 'DIGITUNDER'];
      case 'digits': return ['DIGITMATCH', 'DIGITDIFF'];
      case 'even_odd': return ['DIGITEVEN', 'DIGITODD'];
      case 'accumulator': return ['ACCU'];
      default: return ['CALL', 'PUT'];
    }
  })();

  useEffect(() => { setContractType(currentContracts[0]); }, [tradeType, currentContracts[0]]);

  useEffect(() => {
    if (!tradeResult) return;
    const t = setTimeout(() => setTradeResult(null), 2000);
    return () => clearTimeout(t);
  }, [tradeResult]);

  const navTradeTypes = [
    { value: 'rise_fall', label: 'Rise/Fall' },
    { value: 'over_under', label: 'Over/Under' },
    { value: 'digits', label: 'Digits' },
    { value: 'even_odd', label: 'Even/Odd' },
    { value: 'accumulator', label: 'Accumulator' },
  ];

  const fieldRow: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 0', borderBottom: '1px solid #2a2a2a',
  };
  const fieldLabel: React.CSSProperties = { color: '#999', fontSize: '12px' };
  const fieldVal: React.CSSProperties = {
    background: '#2a2a2a', color: '#ddd', border: '1px solid #444',
    borderRadius: '4px', padding: '4px 8px', fontSize: '13px', textAlign: 'right', width: '80px',
  };

  if (!isPhone) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', color: '#ddd', fontSize: '13px', background: '#111' }}>
        {/* TOP NAV BAR */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '6px 16px', background: '#1a1a1a', borderBottom: '1px solid #333', gap: '4px', overflowX: 'auto' }}>
          {navTradeTypes.map(t => (
            <button key={t.value} onClick={() => setTradeType(t.value)}
              style={{
                padding: '6px 14px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap',
                background: tradeType === t.value ? '#2a2a2a' : 'transparent',
                color: tradeType === t.value ? '#fff' : '#888',
                fontWeight: tradeType === t.value ? 'bold' : 'normal',
              }}>
              {t.value === 'rise_fall' ? '\uD83D\uDD25 ' : ''}{t.label}
            </button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px' }}>
            <span style={{ color: connectionStatus === 'Live' ? '#4caf50' : '#ff9800' }}>\u25CF</span>
            <span>{connectionStatus}</span>
            {currentDigit !== null && <span style={{ color: '#ffeb3b', fontWeight: 'bold', fontSize: '15px' }}>{currentDigit}</span>}
          </div>
        </div>

        {/* MAIN AREA */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* CHART */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', background: '#151515', borderBottom: '1px solid #222' }}>
              <select value={symbol} onChange={e => setSymbol(e.target.value)}
                style={{ background: '#1a1a1a', color: '#ddd', border: '1px solid #333', borderRadius: '4px', padding: '3px 8px', fontSize: '12px' }}>
                {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              {currentPrice !== null && (
                <span style={{ color: '#fff', fontSize: '14px', fontWeight: 'bold' }}>
                  {currentPrice.toFixed(2)}
                </span>
              )}
              {currentPrice !== null && (
                <span style={{ color: '#888', fontSize: '11px' }}>
                  {currentPrice.toFixed(2)} ({((currentPrice - (tickPrices.current[tickPrices.current.length - 2] || currentPrice)) / currentPrice * 100).toFixed(2)}%)
                </span>
              )}
            </div>
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0', background: '#1a1a1a', borderTop: '1px solid #333' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                {Array.from({ length: 10 }, (_, i) => {
                  const isCurrent = currentDigit === i;
                  const isHighlight = exitHighlight?.digit === i;
                  const hlColor = exitHighlight ? (exitHighlight.win ? '#4caf50' : '#f44336') : '#ffeb3b';
                  const isBarrier = String(i) === barrier;
                  const pct = tickHistory.length > 0 ? (digitCounts[i] / tickHistory.length) * 100 : 0;
                  return (
                    <div key={i} style={{ textAlign: 'center', cursor: 'pointer' }} onClick={() => setBarrier(String(i))}>
                      <div style={{
                        width: '36px', height: '36px', borderRadius: '50%', display: 'flex', alignItems: 'center',
                        justifyContent: 'center',
                        background: isHighlight ? hlColor : (isCurrent ? '#ffeb3b' : (isBarrier ? '#4fc3f7' : '#e0e0e0')),
                        color: (isCurrent || isBarrier) && !isHighlight ? '#000' : '#333',
                        fontWeight: 'bold', fontSize: '15px',
                        boxShadow: isCurrent ? '0 0 8px rgba(255,235,59,0.6)' : (isBarrier ? '0 0 8px rgba(79,195,247,0.6)' : 'none'),
                      }}>{i}</div>
                      <div style={{ marginTop: '2px', height: '3px', background: '#444', borderRadius: '2px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: isHighlight ? hlColor : (pct > 12 ? '#4caf50' : pct > 9 ? '#ff9800' : '#f44336') }} />
                      </div>
                      <div style={{ fontSize: '9px', color: '#aaa' }}>{pct.toFixed(1)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* RIGHT SIDEBAR - TRADING PANEL */}
          <div style={{ width: '280px', minWidth: '280px', background: '#1a1a1a', borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '12px', flex: 1, overflow: 'auto' }}>
              <div style={{ textAlign: 'right', marginBottom: '8px' }}>
                <a style={{ color: '#4fc3f7', fontSize: '11px', cursor: 'pointer', textDecoration: 'none' }}>
                  How to trade {contractTypes}?
                </a>
              </div>

              {/* Direction/Contract Type Toggle */}
              {tradeType === 'accumulator' ? (
                <div style={{ textAlign: 'center', padding: '10px', marginBottom: '8px', background: '#1a3a1a', borderRadius: '6px', border: '1px solid #2a5a2a' }}>
                  <span style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '14px' }}>Accumulator</span>
                  <div style={{ color: '#888', fontSize: '11px', marginTop: '2px' }}>Compounding per tick</div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  {currentContracts.map(ct => (
                    <button key={ct} onClick={() => setContractType(ct)}
                      style={{
                        flex: 1, padding: '10px', borderRadius: '6px', border: contractType === ct ? '2px solid #ff4444' : '2px solid #333',
                        background: contractType === ct ? '#2a1a1a' : '#1a1a1a',
                        color: contractType === ct ? '#ff4444' : '#666', cursor: 'pointer',
                        fontWeight: contractType === ct ? 'bold' : 'normal', fontSize: '13px',
                      }}>
                      {contractLabels[ct] || ct}
                    </button>
                  ))}
                </div>
              )}

              {/* Barrier (for digits/over_under) */}
              {(tradeType === 'over_under' || tradeType === 'digits') && (
                <div style={fieldRow}>
                  <span style={fieldLabel}>Barrier</span>
                  <input type="number" min={0} max={9} value={barrier}
                    onChange={e => setBarrier(e.target.value.replace(/[^0-9]/g, '').slice(0, 1) || '0')}
                    style={{ ...fieldVal, width: '60px', textAlign: 'center' }} />
                </div>
              )}

              {/* Growth Rate (only for Accumulator) */}
              {tradeType === 'accumulator' ? (
                <>
                  <div style={fieldRow}>
                    <span style={fieldLabel}>Growth Rate</span>
                    <select value={growthRate} onChange={e => setGrowthRate(Number(e.target.value))}
                      style={{ background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: '4px', padding: '4px 8px', fontSize: '12px' }}>
                      <option value={0.01}>1%</option>
                      <option value={0.02}>2%</option>
                      <option value={0.03}>3%</option>
                      <option value={0.04}>4%</option>
                      <option value={0.05}>5%</option>
                    </select>
                  </div>
                  <div style={fieldRow}>
                    <span style={fieldLabel}>Take Profit</span>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <span style={{ color: '#888', fontSize: '12px' }}>$</span>
                      <input type="number" min={0} value={takeProfit}
                        onChange={e => setTakeProfit(e.target.value)}
                        placeholder="Optional"
                        style={{ ...fieldVal, width: '80px' }} />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Duration */}
                  <div style={fieldRow}>
                    <span style={fieldLabel}>Duration</span>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <input type="number" min={1} value={duration}
                        onChange={e => setDuration(Math.max(1, Number(e.target.value) || 1))}
                        style={{ ...fieldVal, width: '50px', textAlign: 'center' }} />
                      <select value={durationUnit} onChange={e => setDurationUnit(e.target.value as 't' | 'm')}
                        style={{ background: '#2a2a2a', color: '#ddd', border: '1px solid #444', borderRadius: '4px', padding: '4px 6px', fontSize: '12px' }}>
                        <option value="m">min</option>
                        <option value="t">ticks</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {/* Stake */}
              <div style={fieldRow}>
                <span style={fieldLabel}>Stake</span>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <span style={{ color: '#888', fontSize: '12px' }}>$</span>
                  <input type="number" min={0.5} step={0.5} value={stake}
                    onChange={e => setStake(Math.max(0.5, Number(e.target.value) || 0.5))}
                    style={{ ...fieldVal, width: '80px' }} />
                </div>
              </div>

              {/* Allow Equals (only for Rise/Fall) */}
              {tradeType === 'rise_fall' && (
                <div style={fieldRow}>
                  <span style={fieldLabel}>Allow Equals</span>
                  <div onClick={() => setAllowEquals(!allowEquals)}
                    style={{
                      width: '36px', height: '20px', borderRadius: '10px',
                      background: allowEquals ? '#4caf50' : '#444', cursor: 'pointer',
                      position: 'relative', transition: 'background 0.2s',
                    }}>
                    <div style={{
                      width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: '2px',
                      left: allowEquals ? '18px' : '2px', transition: 'left 0.2s',
                    }} />
                  </div>
                </div>
              )}

              {/* Buy Button + Payout */}
              <div style={{ marginTop: '16px' }}>
                <button onClick={() => handleBuyContract(contractType)}
                  disabled={isTrading || currentPrice === null}
                  style={{
                    width: '100%', padding: '14px', borderRadius: '6px', border: 'none',
                    background: isTrading ? '#555' : (tradeType === 'accumulator' ? '#2e7d32' : '#d32f2f'), color: '#fff',
                    cursor: isTrading ? 'not-allowed' : 'pointer',
                    fontWeight: 'bold', fontSize: '15px',
                  }}>
                  {isTrading ? 'Buying...' : (tradeType === 'accumulator' ? 'Buy Accumulator' : `Buy ${contractLabels[contractType] || contractType}`)}
                </button>
                {tradeType === 'accumulator' ? (
                  <div style={{ textAlign: 'center', marginTop: '8px', color: '#888', fontSize: '11px' }}>
                    Growth: {growthRate * 100}% · Stake: ${stake}
                  </div>
                ) : payout && (
                  <div style={{ textAlign: 'center', marginTop: '8px', color: '#888', fontSize: '12px' }}>
                    Payout: ${payout}
                  </div>
                )}
              </div>
            </div>

            {/* Active + History mini section */}
            <div style={{ borderTop: '1px solid #222', padding: '8px 12px', maxHeight: '110px', overflow: 'auto', fontSize: '11px' }}>
              <div style={{ color: '#666', marginBottom: '4px' }}>
                Active: {activeContracts.length} | W:{sessionStats.wins} L:{sessionStats.losses} P&L:{sessionStats.profit.toFixed(2)}
              </div>
              {contractHistory.slice(-5).reverse().map(c => (
                <div key={c.id} style={{
                  padding: '2px 4px', marginBottom: '2px', borderLeft: `2px solid ${c.is_win ? '#4caf50' : '#f44336'}`,
                  color: '#888', fontSize: '10px',
                }}>
                  {c.contract_type === 'ACCU'
                    ? `ACCU ${c.is_win ? `+$${c.profit?.toFixed(2) || '0'}` : `-$${Math.abs(c.profit || 0).toFixed(2)}`}`
                    : `${c.contract_type} ${c.entry_digit}→${c.exit_digit ?? '?'} ${c.is_win ? `+$${c.profit?.toFixed(2) || '0'}` : `-$${Math.abs(c.profit || 0).toFixed(2)}`}`
                  }
                </div>
              ))}
            </div>
          </div>
        </div>
        {tradeResult && (
          <div style={{
            position: 'fixed', top: '16px', right: '16px', zIndex: 9999,
            background: tradeResult.isWin ? '#1b5e20' : '#b71c1c',
            color: '#fff', padding: '12px 20px', borderRadius: '8px',
            fontSize: '14px', fontWeight: 'bold', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}>
            {tradeResult.isWin ? 'WIN' : 'LOSS'} · {tradeResult.contract_type} · {tradeResult.entry_digit}→{tradeResult.exit_digit} · {tradeResult.isWin ? '+' : ''}${tradeResult.profit.toFixed(2)}
          </div>
        )}
      </div>
    );
  }

  /* ─── PHONE LAYOUT ─── all in one screen, no scroll */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: '#333', fontSize: '13px', background: '#fff', overflow: 'hidden' }}>
      {/* TOP NAV — compact */}
      <div style={{ display: 'flex', gap: '4px', padding: '6px 8px', background: '#f0f0f0', overflowX: 'auto', whiteSpace: 'nowrap', borderBottom: '1px solid #ddd', alignItems: 'center', minHeight: '36px' }}>
        <select value={symbol} onChange={e => setSymbol(e.target.value)}
          style={{ background: '#fff', color: '#333', border: '1px solid #ccc', borderRadius: '4px', padding: '2px 4px', fontSize: '10px' }}>
          {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {navTradeTypes.map(t => (
          <button key={t.value} onClick={() => setTradeType(t.value)}
            style={{
              padding: '4px 10px', borderRadius: '14px', border: 'none', cursor: 'pointer',
              fontSize: '10px', whiteSpace: 'nowrap', fontWeight: tradeType === t.value ? 'bold' : 'normal',
              background: tradeType === t.value ? '#222' : 'transparent',
              color: tradeType === t.value ? '#fff' : '#555',
            }}>
            {t.value === 'rise_fall' ? '\uD83D\uDD25 ' : ''}{t.label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: connectionStatus === 'Live' ? '#4caf50' : '#ff9800', fontSize: '8px' }}>\u25CF</span>
      </div>

      {/* CHART (rise_fall / accumulator) OR DIGIT CIRCLES */}
      {tradeType === 'rise_fall' || tradeType === 'accumulator' ? (
        <div style={{ flex: '1 1 auto', position: 'relative', minHeight: 0, background: '#111' }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', background: '#fff', minHeight: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px 14px', width: '100%', maxWidth: '340px' }}>
            {Array.from({ length: 10 }, (_, i) => {
              const isCurrent = currentDigit === i;
              const isHighlight = exitHighlight?.digit === i;
              const hlColor = exitHighlight ? (exitHighlight.win ? '#4caf50' : '#f44336') : '#ffeb3b';
              const isBarrier = String(i) === barrier;
              const pct = tickHistory.length > 0 ? (digitCounts[i] / tickHistory.length) * 100 : 0;
              const halfAngle = (pct / 100) * 180;
              const barColor = isHighlight ? hlColor : (pct > 12 ? '#4caf50' : pct > 9 ? '#ff9800' : '#f44336');
              return (
                <div key={i} style={{ textAlign: 'center', cursor: 'pointer', position: 'relative' }} onClick={() => setBarrier(String(i))}>
                  {/* Pyramid cursor arrow for current digit */}
                  {isCurrent && (
                    <div style={{
                      position: 'absolute', top: '-10px', left: '50%', marginLeft: '-5px',
                      width: '0', height: '0',
                      borderLeft: '5px solid transparent',
                      borderRight: '5px solid transparent',
                      borderTop: '7px solid #ffeb3b',
                      zIndex: 2,
                    }} />
                  )}
                  {/* Outer ring container */}
                  <div style={{ position: 'relative', width: '48px', height: '48px', margin: '0 auto' }}>
                    {/* Ring track */}
                    <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#ddd' }} />
                    {/* Ring fill — conic gradient growing upward on both sides */}
                    <div style={{
                      position: 'absolute', inset: 0, borderRadius: '50%',
                      background: `conic-gradient(from ${180 - halfAngle}deg, ${barColor} 0deg, ${barColor} ${2 * halfAngle}deg, transparent ${2 * halfAngle}deg)`,
                    }} />
                    {/* Inner circle with digit */}
                    <div style={{
                      position: 'absolute', top: '6px', left: '6px',
                      width: '36px', height: '36px', borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: isHighlight ? hlColor : (isCurrent ? '#ffeb3b' : (isBarrier ? '#4fc3f7' : '#e0e0e0')),
                      color: (isCurrent || isBarrier) && !isHighlight ? '#000' : '#333',
                      fontWeight: 'bold', fontSize: '16px',
                      boxShadow: isCurrent ? '0 0 8px rgba(255,235,59,0.6)' : (isBarrier ? '0 0 8px rgba(79,195,247,0.6)' : 'none'),
                    }}>
                      {i}
                    </div>
                  </div>
                  <div style={{ fontSize: '9px', color: '#999', marginTop: '2px' }}>{pct.toFixed(1)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* BOTTOM TRADING PANEL — fixed, no scroll */}
      <div style={{ background: '#fff', borderTop: '1px solid #e0e0e0', padding: '6px 10px 10px' }}>
        {/* Direction Toggle */}
        {tradeType === 'accumulator' ? (
          <div style={{ textAlign: 'center', padding: '6px', marginBottom: '6px', background: '#e8f5e9', borderRadius: '6px', border: '1px solid #c8e6c9' }}>
            <span style={{ color: '#2e7d32', fontWeight: 'bold', fontSize: '13px' }}>Accumulator</span>
            <span style={{ color: '#666', fontSize: '10px', marginLeft: '6px' }}>{growthRate * 100}% / tick</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0', marginBottom: '6px', borderRadius: '6px', overflow: 'hidden', border: '1px solid #ddd' }}>
            {currentContracts.map(ct => (
              <button key={ct} onClick={() => setContractType(ct)}
                style={{
                  flex: 1, padding: '8px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold',
                  background: contractType === ct ? '#fff' : '#f5f5f5',
                  color: contractType === ct ? '#4caf50' : '#999',
                  borderBottom: contractType === ct ? '2px solid #4caf50' : '2px solid transparent',
                }}>
                {contractLabels[ct] || ct}
              </button>
            ))}
          </div>
        )}

        {/* Trade Parameters Row */}
        {tradeType === 'accumulator' ? (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Growth Rate</div>
              <select value={growthRate} onChange={e => setGrowthRate(Number(e.target.value))}
                style={{ background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', outline: 'none', padding: '0', width: '100%' }}>
                <option value={0.01}>1%</option>
                <option value={0.02}>2%</option>
                <option value={0.03}>3%</option>
                <option value={0.04}>4%</option>
                <option value={0.05}>5%</option>
              </select>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Stake</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <span style={{ color: '#333', fontSize: '12px', fontWeight: 'bold' }}>$</span>
                <input type="number" min={0.5} step={0.5} value={stake}
                  onChange={e => setStake(Math.max(0.5, Number(e.target.value) || 0.5))}
                  style={{ width: '40px', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
              </div>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Take Profit</div>
              <input type="number" min={0} value={takeProfit}
                onChange={e => setTakeProfit(e.target.value)}
                placeholder="$"
                style={{ width: '100%', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Duration</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <input type="number" min={1} value={duration}
                  onChange={e => setDuration(Math.max(1, Number(e.target.value) || 1))}
                  style={{ width: '36px', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
                <select value={durationUnit} onChange={e => setDurationUnit(e.target.value as 't' | 'm')}
                  style={{ background: 'transparent', color: '#666', border: 'none', fontSize: '10px', outline: 'none', padding: '0' }}>
                  <option value="t">ticks</option>
                  <option value="m">min</option>
                </select>
              </div>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Stake</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                <span style={{ color: '#333', fontSize: '12px', fontWeight: 'bold' }}>$</span>
                <input type="number" min={0.5} step={0.5} value={stake}
                  onChange={e => setStake(Math.max(0.5, Number(e.target.value) || 0.5))}
                  style={{ width: '40px', background: 'transparent', color: '#333', border: 'none', fontSize: '12px', fontWeight: 'bold', padding: '0', outline: 'none' }} />
              </div>
            </div>
            <div style={{ flex: 1, background: '#f5f5f5', borderRadius: '6px', padding: '4px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: '8px', color: '#999', marginBottom: '1px' }}>Allow equals</div>
              <div onClick={() => setAllowEquals(!allowEquals)} style={{ cursor: 'pointer' }}>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: allowEquals ? '#4caf50' : '#ccc' }}>
                  {allowEquals ? 'On' : '\u2014'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Barrier (if applicable) */}
        {(tradeType === 'over_under' || tradeType === 'digits') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <span style={{ fontSize: '10px', color: '#999' }}>Barrier:</span>
            <input type="number" min={0} max={9} value={barrier}
              onChange={e => setBarrier(e.target.value.replace(/[^0-9]/g, '').slice(0, 1) || '0')}
              style={{ width: '40px', background: '#f5f5f5', color: '#333', border: '1px solid #ddd', borderRadius: '4px', padding: '3px 6px', fontSize: '12px', textAlign: 'center' }} />
          </div>
        )}

        {/* Buy Button */}
        <button onClick={() => handleBuyContract(contractType)}
          disabled={isTrading || currentPrice === null}
          style={{
            width: '100%', padding: '12px', borderRadius: '6px', border: 'none',
            background: isTrading ? '#aaa' : (tradeType === 'accumulator' ? '#2e7d32' : '#4caf50'), color: '#fff',
            cursor: isTrading ? 'not-allowed' : 'pointer',
            fontWeight: 'bold', fontSize: '15px',
          }}>
          {isTrading ? 'Buying...' : (tradeType === 'accumulator' ? 'Buy Accumulator' : 'Buy')}
        </button>
        {tradeType === 'accumulator' ? (
          <div style={{ textAlign: 'center', marginTop: '4px', color: '#999', fontSize: '10px' }}>
            {growthRate * 100}% growth · ${stake} stake
          </div>
        ) : payout && (
          <div style={{ textAlign: 'center', marginTop: '4px', color: '#999', fontSize: '11px' }}>
            Payout: ${payout}
          </div>
        )}
      </div>
      {tradeResult && (
        <div style={{
          position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)', zIndex: 9999,
          background: tradeResult.isWin ? '#1b5e20' : '#b71c1c',
          color: '#fff', padding: '10px 18px', borderRadius: '8px',
          fontSize: '13px', fontWeight: 'bold', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          whiteSpace: 'nowrap',
        }}>
          {tradeResult.isWin ? 'WIN' : 'LOSS'} · {tradeResult.contract_type} · {tradeResult.entry_digit}→{tradeResult.exit_digit} · {tradeResult.isWin ? '+' : ''}${tradeResult.profit.toFixed(2)}
        </div>
      )}
    </div>
  );
};

export default NewDTrader;
