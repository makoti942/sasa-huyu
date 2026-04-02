import React, { useEffect, useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Play, Square, Activity, TrendingUp, ShieldCheck, Zap,
    Info, ChevronDown, ChevronUp, Terminal, Trash2,
    BarChart2, Settings, Layers, Cpu, RefreshCw,
} from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import './over-under.scss';

type Strategy = 'over_under' | 'differs' | 'differs_v2' | 'rise_fall' | 'manual';

const STRAT_META: Record<Strategy, { label: string; color: string; glow: string; desc: string }> = {
    over_under: { label: 'Over 5 / Under 4', color: '#3b82f6', glow: 'rgba(59,130,246,0.4)', desc: 'Fires Over 5 & Under 4 simultaneously on trigger digit' },
    differs:    { label: 'Differs', color: '#a855f7', glow: 'rgba(168,85,247,0.4)', desc: 'Detects pushback reversal pattern (3+ ticks + reversal)' },
    differs_v2: { label: 'Differs V2', color: '#ec4899', glow: 'rgba(236,72,153,0.4)', desc: 'Trades on doubles (e.g., 7,7) or triples (7,7,7)' },
    rise_fall:  { label: 'Rise / Fall', color: '#10b981', glow: 'rgba(16,185,129,0.4)', desc: 'MACD-based trend momentum — places Rise or Fall contract' },
    manual:     { label: 'Manual', color: '#f97316', glow: 'rgba(249,115,22,0.4)', desc: 'You choose contract type, barrier digit and trigger' },
};

const Toggle = ({ on, onToggle, disabled, color = '#3b82f6' }: {
    on: boolean; onToggle: () => void; disabled?: boolean; color?: string;
}) => (
    <button
        className={`ou-sw ${on ? 'ou-sw--on' : ''}`}
        style={on ? { '--tc': color } as React.CSSProperties : {}}
        onClick={onToggle}
        disabled={disabled}
        type='button'
    >
        <span className='ou-sw__knob' />
    </button>
);

// Memoize TriggerInput to prevent re-renders on every tick
const TriggerInput = React.memo(({ field = 'primary', over_under, disabled }: {
    field?: 'primary' | 'secondary';
    over_under: any;
    disabled: boolean;
}) => {
    const val = field === 'primary' ? over_under.entry_digit : over_under.second_entry_digit;
    const isLit = field === 'primary'
        ? over_under.last_digit === over_under.entry_digit
        : over_under.last_last_digit === over_under.entry_digit && over_under.last_digit === over_under.second_entry_digit;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const setter = field === 'primary' ? over_under.setEntryDigit : over_under.setSecondEntryDigit;
        setter(Number(e.target.value));
    };

    return (
        <div className='ou-dbox'>
            <input
                type='number' min='0' max='9' value={val}
                onChange={handleChange}
                disabled={disabled}
            />
            <span className={`ou-led ${isLit ? 'ou-led--on' : ''}`} />
        </div>
    );
});

const OverUnder = observer(() => {
    const { over_under } = useStore();
    const {
        connection_status, tick_history, last_digit,
        is_auto_running, stake, martingale, is_volatility_changer,
        is_differs_mode, is_differs_v2_mode, is_tatu_bora_mode, is_nne_kwisha_mode, is_all_vol_mode, is_2term_mode, is_rise_fall_mode, is_automate,
        use_second_trigger, is_manual_mode, manual_contract_type, manual_barrier,
        recovery_contract_type, recovery_barrier, use_recovery_delay, is_recovery_enabled,
        recovery_entry_digit, recovery_second_entry_digit,
        is_turbo, selected_symbol, debug_info, is_analyzing_volatility, is_authorizing,
        differs_predicted_top4, is_digit_occurrence_filter_active, is_rebounce_active,
        setStake, setMartingale, setIsVolatilityChanger,
        setIsDiffersMode, setIsDiffersV2Mode, setIsTatuBoraMode, setIsNneKwishaMode, setIsAllVolMode, setIs2termMode, setIsRiseFallMode, setIsAutomate,
        setUseSecondTrigger, setIsManualMode, setManualContractType, setManualBarrier,
        setRecoveryContractType, setRecoveryBarrier, setUseRecoveryDelay, setIsRecoveryEnabled,
        setRecoveryEntryDigit, setRecoverySecondEntryDigit,
        setIsTurbo, setSelectedSymbol, connectWebSocket, handleStartStop, clearDebug,
        setIsDigitOccurrenceFilterActive, setIsRebounceActive,
    } = over_under;

    const [showGuide, setShowGuide] = useState(false);
    const [showRecovery, setShowRecovery] = useState(false);

    const activeStrategy: Strategy = is_differs_mode ? 'differs'
        : is_differs_v2_mode ? 'differs_v2'
        : is_rise_fall_mode ? 'rise_fall'
        : is_manual_mode ? 'manual'
        : 'over_under';

    const meta = STRAT_META[activeStrategy];
    const disabled = is_auto_running || is_authorizing;

    const selectStrategy = (s: Strategy) => {
        if (disabled) return;
        setIsDiffersMode(s === 'differs');
        setIsDiffersV2Mode(s === 'differs_v2');
        setIsRiseFallMode(s === 'rise_fall');
        setIsManualMode(s === 'manual');
    };

    useEffect(() => {
        if (over_under.connection_status === 'Offline') connectWebSocket();
        return () => over_under.dispose();
    }, [connectWebSocket, over_under]);

    const digitStats = useMemo(() => {
        const s = Array(10).fill(0);
        tick_history.forEach(d => { if (d >= 0 && d <= 9) s[d]++; });
        return s;
    }, [tick_history]);

    const { maxIdx, minIdx } = useMemo(() => {
        if (!tick_history.length) return { maxIdx: -1, minIdx: -1 };
        let mxV = -1, mnV = Infinity, mxI = -1, mnI = -1;
        digitStats.forEach((v, i) => {
            if (v > mxV) { mxV = v; mxI = i; }
            if (v < mnV) { mnV = v; mnI = i; }
        });
        return { maxIdx: mxI, minIdx: mnI };
    }, [digitStats, tick_history.length]);

    const totalTicks = tick_history.length || 1;

    const volatilityOptions = [
        { label: 'V 10 Index', value: 'R_10' },
        { label: 'V 25 Index', value: 'R_25' },
        { label: 'V 50 Index', value: 'R_50' },
        { label: 'V 75 Index', value: 'R_75' },
        { label: 'V 100 Index', value: 'R_100' },
        { label: 'V 10 (1s)', value: '1HZ10V' },
        { label: 'V 25 (1s)', value: '1HZ25V' },
        { label: 'V 50 (1s)', value: '1HZ50V' },
        { label: 'V 75 (1s)', value: '1HZ75V' },
        { label: 'V 100 (1s)', value: '1HZ100V' },
    ];

    const connState = is_authorizing ? 'pulse'
        : connection_status === 'Account Connected' ? 'ok'
        : connection_status === 'Live Ticks' ? 'live'
        : 'off';

    const connText = is_authorizing ? 'Authorizing'
        : connection_status === 'Account Connected' ? 'Connected'
        : connection_status === 'Live Ticks' ? 'Live'
        : connection_status || 'Offline';

    const ctaText = useMemo(() => {
        if (is_authorizing) return 'AUTHORIZING…';
        if (is_auto_running) return is_analyzing_volatility ? 'SCANNING…' : 'STOP BOT';
        return 'START BOT';
    }, [is_auto_running, is_analyzing_volatility, is_authorizing]);

    return (
        <div className='ou-root'>

            {/* ── GUIDE FAB ── */}
            <button className='ou-fab' onClick={() => setShowGuide(true)}>
                <Info size={14} /><span>Guide</span>
            </button>

            {/* ── GUIDE MODAL ── */}
            <AnimatePresence>
                {showGuide && (
                    <motion.div className='ou-overlay'
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        onClick={() => setShowGuide(false)}>
                        <motion.div className='ou-modal'
                            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 10 }}
                            onClick={e => e.stopPropagation()}>
                            <div className='ou-modal__head'>
                                <span><Info size={15} /> Strategy Guide</span>
                                <button onClick={() => setShowGuide(false)}>×</button>
                            </div>
                            <div className='ou-modal__body'>
                                {([
                                    { c: 'blue', t: 'Over/Under (Default)', items: ['<b>Goal:</b> Trade on market volatility.', '<b>How it Works:</b> You set one or two trigger digits. When the last digit of the market price matches your trigger, the tool executes two trades at once: a `DIGITOVER 5` contract and a `DIGITUNDER 4` contract.', '<b>Why it Works:</b> This is a straddle strategy. You win if the last digit is over 5 or under 4. You only lose if the last digit is exactly 4 or 5.'] },
                                    { c: 'purple', t: 'Differs', items: ['<b>Goal:</b> Identify and trade on a specific price action pattern called rejection.', '<b>How it Works:</b> The strategy looks for a surge (at least two consecutive ticks moving in the same direction) followed by a sharp reversal in the opposite direction.', '<b>Execution:</b> When this reversal happens, the strategy places a `DIGITDIFF` trade, betting that the next ticks last digit will be different from the reversal digit.', '<b>Advanced Analysis:</b> Before placing a trade, this strategy uses a prediction engine and several filters to avoid bad trades.'] },
                                    { c: 'pink', t: 'Differs V2', items: ['<b>Goal:</b> A faster, more direct version of the Differs strategy.', '<b>How it Works:</b> Instead of looking for a complex pattern, this strategy waits for a double – two consecutive ticks with the same last digit.', '<b>Execution:</b> As soon as a double occurs, it immediately places a `DIGITDIFF` trade, betting that the next ticks last digit will be different from the double digit.', '<b>Safeguards:</b> Includes several safety checks to avoid placing risky trades, such as avoiding digits 0 and 9, and checking if the digit is too frequent.'] },
                                    { c: 'green', t: 'Rise/Fall', items: ['<b>Goal:</b> To trade based on the classic MACD (Moving Average Convergence Divergence) indicator.', '<b>How it Works:</b> A trade is triggered when the MACD line and the signal line cross.', '<b>RISE (CALL) Trade:</b> Placed when the MACD line crosses above the signal line, while the MACD is still negative (potential upward trend).', '<b>FALL (PUT) Trade:</b> Placed when the MACD line crosses below the signal line, while the MACD is still positive (potential downward trend).'] },
                                    { c: 'orange', t: 'Manual', items: ['<b>Goal:</b> To give you full control over your trades.', '<b>How it Works:</b> You set the exact contract type and barrier you want to trade (e.g., `DIGITOVER 7`). You also set one or two trigger digits.', '<b>Execution:</b> When the last digit of the market price matches your trigger, the tool will execute the single trade that you have defined.'] },
                                ] as const).map(s => (
                                    <div key={s.t} className='ou-modal__sec'>
                                        <div className={`ou-modal__sh ou-modal__sh--${s.c}`}>{s.t}</div>
                                        {s.items.map((txt, i) => <p key={i} dangerouslySetInnerHTML={{ __html: txt }} />)}
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* ── HEADER ── */}
            <header className='ou-header'>
                <div className='ou-header__left'>
                    <div className='ou-header__icon'><Zap size={17} /></div>
                    <div>
                        <div className='ou-header__title'>Over / Under Terminal</div>
                        <div className='ou-header__sub'>Synthetic Indices · Digit Strategy Engine</div>
                    </div>
                </div>
                <div className={`ou-status ou-status--${connState}`}>
                    <span className='ou-status__dot' />{connText}
                </div>
            </header>

            {/* ── HEATMAP ── */}
            <div className='ou-heatmap'>
                {digitStats.map((count, i) => {
                    const pct = (count / totalTicks) * 100;
                    const hot = i === maxIdx && count > 0;
                    const cold = i === minIdx && count > 0;
                    const active = last_digit === i;
                    const predicted = (is_differs_mode || is_differs_v2_mode) && differs_predicted_top4.includes(i);
                    const predRank = predicted ? differs_predicted_top4.indexOf(i) + 1 : -1;
                    return (
                        <motion.div key={i}
                            className={`ou-cell${active ? ' ou-cell--active' : ''}${hot ? ' ou-cell--hot' : cold ? ' ou-cell--cold' : ''}${predicted ? ' ou-cell--predicted' : ''}`}
                            whileHover={{ y: -4, scale: 1.05 }}
                            transition={{ type: 'spring', stiffness: 360, damping: 20 }}>
                            <span className={`ou-cell__badge${hot ? ' hot' : cold ? ' cold' : predicted ? ' predicted' : ''}`}>
                                {hot ? 'HOT' : cold ? 'LOW' : predicted ? `P${predRank}` : ''}
                            </span>
                            <div className='ou-cell__num'>{i}</div>
                            <div className='ou-cell__bar'>
                                <motion.div className='ou-cell__fill'
                                    animate={{ height: `${Math.max(pct, 2)}%` }}
                                    transition={{ duration: 0.4, ease: 'easeOut' }}
                                    style={{ background: hot ? 'linear-gradient(180deg,#10b981,#059669)' : cold ? 'linear-gradient(180deg,#ef4444,#b91c1c)' : 'linear-gradient(180deg,#3b82f6,#1d4ed8)' }}
                                />
                            </div>
                            <div className='ou-cell__pct'>{pct.toFixed(1)}%</div>
                        </motion.div>
                    );
                })}
            </div>

            {/* ── BODY ── */}
            <div className='ou-body'>

                {/* ══ CONFIG PANEL ══ */}
                <div className='ou-panel'>

                    {/* Panel title */}
                    <div className='ou-panel__title'>
                        <Cpu size={14} /> Configuration
                    </div>

                    {/* ── ROW: Market ── */}
                    <div className='ou-row-wrap'>
                        <div className='ou-row-label'><BarChart2 size={11} /> Market</div>
                        <div className='ou-row-fields'>
                            <div className='ou-f ou-f--grow'>
                                <span className='ou-fl'>Index</span>
                                <select className='ou-sel' value={selected_symbol}
                                    onChange={e => setSelectedSymbol(e.target.value)} disabled={disabled || is_all_vol_mode}>
                                    {volatilityOptions.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                                </select>
                            </div>
                            <div className='ou-f'>
                                <span className='ou-fl'>Auto Switch</span>
                                <div className='ou-sw-row'>
                                    <Toggle on={is_volatility_changer} onToggle={() => setIsVolatilityChanger(!is_volatility_changer)} disabled={disabled} />
                                    <span className={`ou-sw-lbl${is_volatility_changer ? ' on' : ''}`}>{is_volatility_changer ? 'ON' : 'OFF'}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ── ROW: Strategy ── */}
                    <div className='ou-row-wrap'>
                        <div className='ou-row-label'><Layers size={11} /> Strategy</div>
                        <div className='ou-row-fields'>
                            <div className='ou-f ou-f--grow'>
                                <span className='ou-fl'>Mode</span>
                                <select className='ou-sel ou-sel--strat'
                                    value={activeStrategy}
                                    onChange={e => selectStrategy(e.target.value as Strategy)}
                                    disabled={disabled}
                                    style={{ borderColor: meta.color, color: meta.color }}>
                                    {(Object.entries(STRAT_META) as [Strategy, typeof STRAT_META[Strategy]][]).map(([val, s]) => (
                                        <option key={val} value={val}>{s.label}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        {/* Strategy description badge */}
                        <div className='ou-strat-info' style={{ '--c': meta.color } as React.CSSProperties}>
                            <span className='ou-strat-info__dot' />
                            <span>{meta.desc}</span>
                        </div>
                    </div>

                    {/* ── STRATEGY OPTIONS (animated) ── */}
                    <AnimatePresence mode='wait'>
                        <motion.div key={activeStrategy}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.18 }}
                            style={{ overflow: 'hidden' }}>

                            {activeStrategy === 'over_under' && (
                                 <div className='ou-row-wrap'>
                                 <div className='ou-row-label'><Zap size={11} /> Trigger</div>
                                 <div className='ou-row-fields'>
                                     <div className='ou-f'>
                                         <span className='ou-fl'>Digit</span>
                                         <div className='ou-trig-row'>
                                             <TriggerInput field='primary' over_under={over_under} disabled={disabled} />
                                             {use_second_trigger && <TriggerInput field='secondary' over_under={over_under} disabled={disabled} />}
                                             <button className={`ou-chip${use_second_trigger ? ' on' : ''}`}
                                                 onClick={() => setUseSecondTrigger(!use_second_trigger)} disabled={disabled}>
                                                 2ND
                                             </button>
                                         </div>
                                     </div>
                                     <div className='ou-f'>
                                         <span className='ou-fl'>All Vol Mode</span>
                                         <div className='ou-sw-row'>
                                             <Toggle on={is_all_vol_mode} onToggle={() => setIsAllVolMode(!is_all_vol_mode)} disabled={disabled} />
                                             <span className={`ou-sw-lbl${is_all_vol_mode ? ' on' : ''}`}>{is_all_vol_mode ? 'ON' : 'OFF'}</span>
                                         </div>
                                     </div>
                                     <div className='ou-f'>
                                        <span className='ou-fl'>Digit Filter</span>
                                        <div className='ou-sw-row'>
                                            <Toggle on={is_digit_occurrence_filter_active} onToggle={() => setIsDigitOccurrenceFilterActive(!is_digit_occurrence_filter_active)} disabled={disabled} />
                                            <span className={`ou-sw-lbl${is_digit_occurrence_filter_active ? ' on' : ''}`}>{is_digit_occurrence_filter_active ? 'ON' : 'OFF'}</span>
                                        </div>
                                    </div>
                                    {use_second_trigger && (
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Rebounce</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_rebounce_active} onToggle={() => setIsRebounceActive(!is_rebounce_active)} disabled={disabled} />
                                                <span className={`ou-sw-lbl${is_rebounce_active ? ' on' : ''}`}>{is_rebounce_active ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                    )}
                                 </div>
                             </div>
                            )}

                            {activeStrategy === 'differs' && (
                                <div className='ou-row-wrap'>
                                    <div className='ou-row-label'><Activity size={11} /> Options</div>
                                    <div className='ou-row-fields'>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>2-Term Compound</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_2term_mode} onToggle={() => setIs2termMode(!is_2term_mode)} disabled={disabled} color='#a855f7' />
                                                <span className={`ou-sw-lbl${is_2term_mode ? ' on' : ''}`} style={is_2term_mode ? { color: '#a855f7' } : {}}>{is_2term_mode ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Auto Cycle</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_automate} onToggle={() => setIsAutomate(!is_automate)} disabled={disabled} color='#a855f7' />
                                                <span className={`ou-sw-lbl${is_automate ? ' on' : ''}`} style={is_automate ? { color: '#a855f7' } : {}}>{is_automate ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>All Vol Mode</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_all_vol_mode} onToggle={() => setIsAllVolMode(!is_all_vol_mode)} disabled={disabled} color='#a855f7' />
                                                <span className={`ou-sw-lbl${is_all_vol_mode ? ' on' : ''}`} style={is_all_vol_mode ? { color: '#a855f7' } : {}}>{is_all_vol_mode ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeStrategy === 'differs_v2' && (
                                <div className='ou-row-wrap'>
                                    <div className='ou-row-label'><Activity size={11} /> Options</div>
                                    <div className='ou-row-fields'>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Tatu Bora</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_tatu_bora_mode} onToggle={() => setIsTatuBoraMode(!is_tatu_bora_mode)} disabled={disabled} color='#ec4899' />
                                                <span className={`ou-sw-lbl${is_tatu_bora_mode ? ' on' : ''}`} style={is_tatu_bora_mode ? { color: '#ec4899' } : {}}>{is_tatu_bora_mode ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Nne Kwisha</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_nne_kwisha_mode} onToggle={() => setIsNneKwishaMode(!is_nne_kwisha_mode)} disabled={disabled} color='#ec4899' />
                                                <span className={`ou-sw-lbl${is_nne_kwisha_mode ? ' on' : ''}`} style={is_nne_kwisha_mode ? { color: '#ec4899' } : {}}>{is_nne_kwisha_mode ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>2-Term Compound</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_2term_mode} onToggle={() => setIs2termMode(!is_2term_mode)} disabled={disabled} color='#ec4899' />
                                                <span className={`ou-sw-lbl${is_2term_mode ? ' on' : ''}`} style={is_2term_mode ? { color: '#ec4899' } : {}}>{is_2term_mode ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Auto Cycle</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_automate} onToggle={() => setIsAutomate(!is_automate)} disabled={disabled} color='#ec4899' />
                                                <span className={`ou-sw-lbl${is_automate ? ' on' : ''}`} style={is_automate ? { color: '#ec4899' } : {}}>{is_automate ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>All Vol Mode</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_all_vol_mode} onToggle={() => setIsAllVolMode(!is_all_vol_mode)} disabled={disabled} color='#ec4899' />
                                                <span className={`ou-sw-lbl${is_all_vol_mode ? ' on' : ''}`} style={is_all_vol_mode ? { color: '#ec4899' } : {}}>{is_all_vol_mode ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeStrategy === 'rise_fall' && (
                                <div className='ou-row-wrap'>
                                    <div className='ou-row-label'><TrendingUp size={11} /> Options</div>
                                    <div className='ou-row-fields'>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Auto Cycle</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_automate} onToggle={() => setIsAutomate(!is_automate)} disabled={disabled} color='#10b981' />
                                                <span className={`ou-sw-lbl${is_automate ? ' on' : ''}`} style={is_automate ? { color: '#10b981' } : {}}>{is_automate ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeStrategy === 'manual' && (
                                <div className='ou-row-wrap'>
                                    <div className='ou-row-label'><Settings size={11} /> Contract</div>
                                    <div className='ou-row-fields'>
                                        <div className='ou-f ou-f--grow'>
                                            <span className='ou-fl'>Type</span>
                                            <select className='ou-sel' value={manual_contract_type}
                                                onChange={e => setManualContractType(e.target.value)} disabled={disabled}>
                                                <option value='DIGITOVER'>Over</option>
                                                <option value='DIGITUNDER'>Under</option>
                                                <option value='DIGITDIFF'>Differs</option>
                                            </select>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Barrier</span>
                                            <input className='ou-inp' type='number' min='0' max='9'
                                                value={manual_barrier} onChange={e => setManualBarrier(e.target.value)} disabled={disabled} />
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Trigger</span>
                                            <div className='ou-trig-row'>
                                               <TriggerInput field='primary' over_under={over_under} disabled={disabled} />
                                                {use_second_trigger && <TriggerInput field='secondary' over_under={over_under} disabled={disabled} />}
                                                <button className={`ou-chip${use_second_trigger ? ' on' : ''}`}
                                                    onClick={() => setUseSecondTrigger(!use_second_trigger)} disabled={disabled}>
                                                    2ND
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    </AnimatePresence>

                    {/* ── ROW: Stake & Risk ── */}
                    <div className='ou-row-wrap'>
                        <div className='ou-row-label'><BarChart2 size={11} /> Stake &amp; Risk</div>
                        <div className='ou-row-fields'>
                            <div className='ou-f'>
                                <span className='ou-fl'>Stake ($)</span>
                                <input className='ou-inp' type='number' min='0.35' step='0.1'
                                    value={stake} onChange={e => setStake(Number(e.target.value))} disabled={disabled} />
                            </div>
                            <div className='ou-f'>
                                <span className='ou-fl'>Martingale ×</span>
                                <input className='ou-inp' type='number' min='1' step='0.1'
                                    value={martingale} onChange={e => setMartingale(Number(e.target.value))} disabled={disabled} />
                            </div>
                            <div className='ou-f'>
                                <span className='ou-fl'>Turbo</span>
                                <div className='ou-sw-row'>
                                    <Toggle on={is_turbo} onToggle={() => setIsTurbo(!is_turbo)} disabled={disabled} color='#f59e0b' />
                                    <span className={`ou-sw-lbl${is_turbo ? ' on' : ''}`} style={is_turbo ? { color: '#f59e0b' } : {}}>{is_turbo ? 'ON' : 'OFF'}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ── RECOVERY ── */}
                    <div className='ou-row-wrap ou-row-wrap--last'>
                        <button className='ou-collapse' onClick={() => setShowRecovery(!showRecovery)}>
                            <span><ShieldCheck size={11} /> Recovery System</span>
                            {showRecovery ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                        <AnimatePresence>
                            {showRecovery && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}
                                    style={{ overflow: 'hidden' }}>
                                    <div className='ou-row-fields' style={{ paddingTop: 10 }}>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Enable</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={is_recovery_enabled} onToggle={() => setIsRecoveryEnabled(!is_recovery_enabled)} disabled={disabled} color='#ef4444' />
                                                <span className={`ou-sw-lbl${is_recovery_enabled ? ' on' : ''}`} style={is_recovery_enabled ? { color: '#ef4444' } : {}}>{is_recovery_enabled ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                        <div className='ou-f ou-f--grow'>
                                            <span className='ou-fl'>Type</span>
                                            <select className='ou-sel' value={recovery_contract_type}
                                                onChange={e => setRecoveryContractType(e.target.value)} disabled={disabled || !is_recovery_enabled}>
                                                <option value='DIGITOVER'>Over</option>
                                                <option value='DIGITUNDER'>Under</option>
                                                <option value='DIGITDIFF'>Differs</option>
                                            </select>
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Barrier</span>
                                            <input className='ou-inp' type='number' min='0' max='9'
                                                value={recovery_barrier} onChange={e => setRecoveryBarrier(e.target.value)} disabled={disabled || !is_recovery_enabled} />
                                        </div>
                                        <div className='ou-f'>
                                            <span className='ou-fl'>Trig. Wait</span>
                                            <div className='ou-sw-row'>
                                                <Toggle on={use_recovery_delay} onToggle={() => setUseRecoveryDelay(!use_recovery_delay)} disabled={disabled || !is_recovery_enabled} color='#ef4444' />
                                                <span className={`ou-sw-lbl${use_recovery_delay ? ' on' : ''}`} style={use_recovery_delay ? { color: '#ef4444' } : {}}>{use_recovery_delay ? 'ON' : 'OFF'}</span>
                                            </div>
                                        </div>
                                    </div>
                                    {use_recovery_delay && (
                                        <div className='ou-row-fields' style={{ paddingTop: 8 }}>
                                            <div className='ou-f'>
                                                <span className='ou-fl'>Trigger</span>
                                                <input className='ou-inp' type='number' min='0' max='9'
                                                    value={recovery_entry_digit} onChange={e => setRecoveryEntryDigit(Number(e.target.value))} disabled={disabled || !is_recovery_enabled} />
                                            </div>
                                            <div className='ou-f'>
                                                <span className='ou-fl'>2ND</span>
                                                <div className='ou-sw-row'>
                                                    <Toggle on={use_second_trigger} onToggle={() => setUseSecondTrigger(!use_second_trigger)} disabled={disabled || !is_recovery_enabled || !use_recovery_delay} color='#ef4444' />
                                                </div>
                                            </div>
                                            {use_second_trigger && (
                                                <div className='ou-f'>
                                                    <span className='ou-fl'>2nd Trigger</span>
                                                    <input className='ou-inp' type='number' min='0' max='9'
                                                        value={recovery_second_entry_digit} onChange={e => setRecoverySecondEntryDigit(Number(e.target.value))} disabled={disabled || !is_recovery_enabled} />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* ── CTA ── */}
                    <div className='ou-cta-wrap'>
                        <motion.button
                            className={`ou-cta${is_auto_running ? ' ou-cta--stop' : ''}`}
                            style={{ '--ac': is_auto_running ? '#ef4444' : meta.color, '--ag': is_auto_running ? 'rgba(239,68,68,0.4)' : meta.glow } as React.CSSProperties}
                            onClick={handleStartStop}
                            disabled={is_authorizing}
                            whileHover={!is_authorizing ? { scale: 1.015 } : {}}
                            whileTap={!is_authorizing ? { scale: 0.985 } : {}}
                        >
                            <span className='ou-cta__ico'>
                                {is_auto_running
                                    ? (is_analyzing_volatility ? <RefreshCw size={17} className='ou-spin' /> : <Square size={17} />)
                                    : <Play size={17} />}
                            </span>
                            <span className='ou-cta__txt'>{ctaText}</span>
                            {is_auto_running && <span className='ou-cta__pulse' />}
                        </motion.button>
                    </div>
                </div>

                {/* ══ MONITOR PANEL ══ */}
                <div className='ou-monitor'>
                    <div className='ou-monitor__head'>
                        <span><Terminal size={13} /> Live Monitor</span>
                        <button className='ou-monitor__clr' onClick={clearDebug}><Trash2 size={12} /></button>
                    </div>
                    <div className='ou-monitor__body'>
                        {debug_info.length === 0 ? (
                            <div className='ou-monitor__empty'><Zap size={26} /><span>Waiting for signals…</span></div>
                        ) : (
                            <div className='ou-monitor__logs'>
                                {debug_info.map((line, i) => {
                                    const win = /WON/i.test(line), loss = /LOST/i.test(line), pat = /PATTERN/i.test(line);
                                    return (
                                        <div key={i} className={`ou-log${win ? ' ou-log--win' : loss ? ' ou-log--loss' : pat ? ' ou-log--pat' : ''}`}>
                                            <span className='ou-log__bar' />
                                            <span className='ou-log__txt'>{line}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});

export default OverUnder;
