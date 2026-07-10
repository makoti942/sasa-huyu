import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Play, Square, TrendingUp, Target, BarChart2, DollarSign } from 'lucide-react';
import MakotiMagicStore from '@/stores/makoti-magic-store';
import './MakotiMagic.scss';

const SYMBOL_LABELS = {
  R_10: 'Vol 10', R_25: 'Vol 25', R_50: 'Vol 50', R_75: 'Vol 75', R_100: 'Vol 100',
  '1HZ10V': 'Vol 10 (1s)', '1HZ25V': 'Vol 25 (1s)', '1HZ50V': 'Vol 50 (1s)',
  '1HZ75V': 'Vol 75 (1s)', '1HZ100V': 'Vol 100 (1s)',
};

const ALL_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];

const MakotiMagic = observer(() => {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const {
    connectWebSocket, startRunning, stopRunning, setStake, setTradeEveryTick,
    stake, isRunning, connection_status, symbolData,
    activeContract, hasWon, isExecuting,
    wins, losses, pnl, tradeHistory, logs,
    chaseSymbol, chaseDigit, chaseLossCount,
    tradeEveryTick, bestPrediction,
  } = MakotiMagicStore;

  useEffect(() => {
    connectWebSocket();
    return () => MakotiMagicStore.dispose();
  }, []);

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(0) : '0';

  return (
    <div className='mm-root'>
      <div className='mm-bg'>
        {Array.from({ length: 60 }).map((_, i) => (
          <span key={i} className='mm-bg__char' style={{ animationDelay: `${Math.random() * 5}s` }}>
            {Math.floor(Math.random() * 10)}
          </span>
        ))}
      </div>

      <div className='mm-layout'>
        {/* ── LEFT PANEL: Controls ── */}
        <div className='mm-panel mm-panel--controls'>
          <div className='mm-panel__head'>
            <Zap size={16} />
            <span>Makoti Magic</span>
            <div className='mm-conn'>
              <div className={`mm-dot mm-dot--${connection_status.split(' ')[0].toLowerCase()}`} />
              {connection_status}
            </div>
          </div>

          <div className='mm-field'>
            <label className='mm-field__label'><DollarSign size={12} /> Stake (USD)</label>
            <input className='mm-field__input' type='number' min='0.35' step='0.1'
              inputMode='decimal' autoComplete='off' autoCorrect='off'
              value={stake} onChange={e => setStake(e.target.value)} disabled={isRunning} />
          </div>

          <label className='mm-checkbox'>
            <input type='checkbox' checked={tradeEveryTick}
              onChange={e => setTradeEveryTick(e.target.checked)} disabled={isRunning} />
            <span>Trade on every tick</span>
          </label>

          <div className='mm-actions'>
            {!isRunning ? (
              <button className='mm-btn mm-btn--run' onClick={startRunning}>
                <Play size={18} />
                <span>{hasWon ? 'WON — Rerun' : 'RUN'}</span>
              </button>
            ) : (
              <button className='mm-btn mm-btn--stop' onClick={stopRunning}>
                <Square size={18} />
                <span>STOP</span>
              </button>
            )}
          </div>

          <div className='mm-stats'>
            <div className='mm-stat'>
              <div className='mm-stat__val mm-stat__val--green'>{wins}</div>
              <div className='mm-stat__lbl'>Wins</div>
            </div>
            <div className='mm-stat'>
              <div className='mm-stat__val mm-stat__val--red'>{losses}</div>
              <div className='mm-stat__lbl'>Losses</div>
            </div>
            <div className='mm-stat'>
              <div className='mm-stat__val' style={{ color: pnl >= 0 ? '#4caf50' : '#f44336' }}>
                {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
              </div>
              <div className='mm-stat__lbl'>P&L</div>
            </div>
            <div className='mm-stat'>
              <div className='mm-stat__val'>{winRate}%</div>
              <div className='mm-stat__lbl'>Win Rate</div>
            </div>
          </div>

          {activeContract && (
            <div className='mm-active-trade'>
              <Target size={14} className='mm-active-trade__icon' />
              <div>
                <div className='mm-active-trade__title'>ACTIVE TRADE</div>
                <div className='mm-active-trade__detail'>
                  {SYMBOL_LABELS[activeContract.symbol]} — D{activeContract.digit} — ${activeContract.stake}
                </div>
              </div>
            </div>
          )}

          {chaseSymbol && chaseDigit !== null && isRunning && (
            <div className='mm-chase'>
              <span>🔁 CHASE: {SYMBOL_LABELS[chaseSymbol]} D{chaseDigit}</span>
              {chaseLossCount > 0 && <span className='mm-chase__losses'>Losses: {chaseLossCount}</span>}
            </div>
          )}

          {isRunning && (
            <div className='mm-scan-count'>
              {isExecuting
                ? '⏳ Executing...'
                : tradeEveryTick
                  ? '⚡ Every tick mode — firing on each tick'
                  : '🔍 Scanning...'}
            </div>
          )}

          {tradeEveryTick && bestPrediction && isRunning && (
            <div className='mm-signal'>
              <span>Next: {SYMBOL_LABELS[bestPrediction.symbol]} D{bestPrediction.digit}</span>
            </div>
          )}
        </div>

        {/* ── CENTER: Symbol Grid (hidden on mobile) ── */}
        {!isMobile && (
          <div className='mm-panel mm-panel--grid'>
            <div className='mm-panel__head'>
              <BarChart2 size={16} />
              <span>Live Analysis</span>
            </div>
            <div className='mm-symbol-grid'>
              {ALL_SYMBOLS.map(sym => {
                const sd = symbolData[sym];
                const pred = sd?.prediction;
                const conf = sd?.confidence || 0;
                const isChaseTarget = chaseSymbol === sym && chaseDigit !== null;
                const ticks = sd?.ticks?.length || 0;
                return (
                  <div key={sym} className={`mm-scard ${isChaseTarget ? 'mm-scard--chase' : ''}`}>
                    <div className='mm-scard__name'>{SYMBOL_LABELS[sym]}</div>
                    <div className='mm-scard__ticks'>{ticks} ticks</div>
                    {pred ? (
                      <>
                        <div className='mm-scard__digit' style={{ color: conf >= 0.14 ? '#4caf50' : '#888' }}>
                          D{pred.digit}
                        </div>
                        <div className='mm-scard__conf'>
                          <div className='mm-scard__bar'>
                            <div className='mm-scard__fill' style={{ width: `${(conf / 0.25) * 100}%`, background: conf >= 0.14 ? '#4caf50' : conf >= 0.12 ? '#ff9800' : '#f44336' }} />
                          </div>
                          <span>{(conf * 100).toFixed(0)}%</span>
                        </div>
                      </>
                    ) : (
                      <div className='mm-scard__waiting'>Collecting...</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── RIGHT: Logs ── */}
        <div className='mm-panel mm-panel--logs'>
          <div className='mm-panel__head'>
            <TrendingUp size={16} />
            <span>Activity</span>
          </div>
          <div className='mm-logs'>
            {logs.length === 0 && <div className='mm-logs__empty'>No activity yet.</div>}
            {logs.map((log, i) => (
              <div key={i} className={`mm-log mm-log--${log.type}`}>
                <span className='mm-log__text'>{log.text}</span>
              </div>
            ))}
          </div>
          {tradeHistory.length > 0 && (
            <div className='mm-history'>
              <div className='mm-history__title'>Trade History</div>
              {tradeHistory.slice(-10).reverse().map((t, i) => (
                <div key={i} className={`mm-history__item ${t.won ? 'mm-history__item--win' : 'mm-history__item--loss'}`}>
                  <span>{SYMBOL_LABELS[t.symbol] || t.symbol}</span>
                  <span>D{t.digit}</span>
                  <span style={{ color: t.won ? '#4caf50' : '#f44336' }}>
                    {t.won ? '+' : ''}{t.profit.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default MakotiMagic;
