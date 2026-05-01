import React, { useState, useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import {
    Play, Square, Settings, TrendingUp, Activity, AlertCircle, HelpCircle, BarChart3,
} from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import './over-under.scss';

type Strategy = 'over_under' | 'differs' | 'differs_v2' | 'rise_fall' | 'rise_fall_v2' | 'manual';

const STRAT_META: Record<Strategy, { label: string; color: string; glow: string; desc: string }> = {
    over_under: { label: 'Over 5 / Under 4', color: '#3b82f6', glow: 'rgba(59,130,246,0.4)', desc: 'Fires Over 5 & Under 4 simultaneously on trigger digit' },
    differs:    { label: 'Differs', color: '#a855f7', glow: 'rgba(168,85,247,0.4)', desc: 'Detects pushback reversal pattern (3+ ticks + reversal)' },
    differs_v2: { label: 'Differs V2', color: '#ec4899', glow: 'rgba(236,72,153,0.4)', desc: 'Trades on doubles (e.g., 7,7) or triples (7,7,7)' },
    rise_fall:  { label: 'Rise / Fall', color: '#10b981', glow: 'rgba(16,185,129,0.4)', desc: 'MACD-based trend momentum — places Rise or Fall contract' },
    rise_fall_v2: { label: 'Rise / Fall V2', color: '#06b6d4', glow: 'rgba(6,182,212,0.4)', desc: 'MACD histogram momentum — 4 consecutive growing bars trigger a 4-tick Rise or Fall' },
    manual:     { label: 'Manual', color: '#f97316', glow: 'rgba(249,115,22,0.4)', desc: 'You choose contract type, barrier digit and trigger' },
};

const Toggle = ({ on, onToggle, disabled, color = '#3b82f6' }: {
    on: boolean; onToggle: () => void; disabled?: boolean; color?: string;
}) => (
    <div
        className={`ou-toggle ${on ? 'ou-toggle--on' : ''} ${disabled ? 'ou-toggle--disabled' : ''}`}
        style={{ '--toggle-color': color } as React.CSSProperties}
        onClick={() => !disabled && onToggle()}
    >
        <div className="ou-toggle__circle" />
    </div>
);

const SwitchTile = ({ label, on, onToggle, disabled, color }: {
    label: string; on: boolean; onToggle: () => void; disabled?: boolean; color?: string;
}) => (
    <div className="ou-f ou-f--col ou-f--gap-2">
        <div className="ou-f ou-f--between ou-f--center">
            <span className="ou-label" style={{ color }}>{label}</span>
            <Toggle on={on} onToggle={onToggle} disabled={disabled} color={color} />
        </div>
    </div>
);

const TriggerPanel = ({ color, is_trigger_enabled, setIsTriggerEnabled, use_second_trigger, setUseSecondTrigger, over_under, disabled }: any) => (
    <div className="ou-row-wrap" style={{ marginBottom: 12 }}>
        <div className="ou-row-label" style={{ color }}><AlertCircle size={11} /> Trigger</div>
        <div className="ou-grid">
            <SwitchTile label="Enable Trigger" on={is_trigger_enabled} onToggle={() => setIsTriggerEnabled(!is_trigger_enabled)} disabled={disabled} color={color} />
            {is_trigger_enabled && (
                <>
                    <SwitchTile label="2nd Trigger" on={use_second_trigger} onToggle={() => setUseSecondTrigger(!use_second_trigger)} disabled={disabled} color={color} />
                </>
            )}
        </div>
    </div>
);

const OverUnder = observer(() => {
    const { over_under } = useStore();
    const {
        connection_status, tick_history, last_digit,
        is_auto_running, stake, martingale, is_volatility_changer,
        is_differs_mode, is_differs_v2_mode, is_tatu_bora_mode, is_nne_kwisha_mode, is_all_vol_mode, is_2term_mode, is_rise_fall_mode, is_rise_fall_v2_mode, is_automate,
        use_second_trigger, is_manual_mode, manual_contract_type, manual_barrier, manual_duration, is_ai_scanning,
        recovery_contract_type, recovery_barrier, use_recovery_delay, is_recovery_enabled,
        recovery_entry_digit, recovery_second_entry_digit,
        is_turbo, selected_symbol, debug_info, is_analyzing_volatility, is_authorizing,
        differs_predicted_top4, is_digit_occurrence_filter_active, is_rebounce_active,
        is_trigger_enabled,
        setStake, setMartingale, setIsVolatilityChanger,
        setIsDiffersMode, setIsDiffersV2Mode, setIsTatuBoraMode, setIsNneKwishaMode, setIsAllVolMode, setIs2termMode, setIsRiseFallMode, setIsRiseFallV2Mode, setIsAutomate,
        setUseSecondTrigger, setIsManualMode, setManualContractType, setManualBarrier, setManualDuration,
        setRecoveryContractType, setRecoveryBarrier, setUseRecoveryDelay, setIsRecoveryEnabled,
        setRecoveryEntryDigit, setRecoverySecondEntryDigit,
        setIsTurbo, setSelectedSymbol, connectWebSocket, handleStartStop, clearDebug,
        setIsTriggerEnabled, setIsDigitOccurrenceFilterActive, setIsRebounceActive,
    } = over_under;

    const [showGuide, setShowGuide] = useState(false);
    const [showRecovery, setShowRecovery] = useState(false);

    const activeStrategy: Strategy = is_differs_mode ? 'differs'
        : is_differs_v2_mode ? 'differs_v2'
        : is_rise_fall_v2_mode ? 'rise_fall_v2'
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
        setIsRiseFallV2Mode(s === 'rise_fall_v2');
        setIsManualMode(s === 'manual');
    };

    useEffect(() => {
        // Always attempt to connect/reconnect when the component mounts.
        // The connectWebSocket() method itself has a guard that returns early
        // if already connected or connecting.
        connectWebSocket();
    }, [connectWebSocket]);

    const strategyButtons: Strategy[] = ['over_under', 'differs', 'differs_v2', 'rise_fall', 'rise_fall_v2', 'manual'];

    return (
        <div className="ou-container">
            {/* Header */}
            <div className="ou-header">
                <div className="ou-header__top">
                    <div className="ou-f ou-f--between ou-f--center">
                        <div className="ou-f ou-f--center ou-f--gap-3">
                            <div className="ou-title">Over / Under</div>
                            <div className={`ou-status ou-status--${connection_status.toLowerCase()}`}>
                                {connection_status}
                            </div>
                        </div>
                        <button className="ou-btn ou-btn--icon" onClick={() => setShowGuide(!showGuide)}>
                            <HelpCircle size={16} />
                        </button>
                    </div>
                </div>

                {/* Strategy Selector */}
                <div className="ou-row-wrap">
                    <div className="ou-row-label"><BarChart3 size={11} /> Strategy</div>
                    <div className="ou-strategy-grid">
                        {strategyButtons.map(s => (
                            <button
                                key={s}
                                className={`ou-strategy-btn ${activeStrategy === s ? 'ou-strategy-btn--active' : ''}`}
                                onClick={() => selectStrategy(s)}
                                disabled={disabled}
                                style={{
                                    '--btn-color': STRAT_META[s].color,
                                    '--btn-glow': STRAT_META[s].glow,
                                } as React.CSSProperties}
                            >
                                {STRAT_META[s].label}
                            </button>
                        ))}
                    </div>
                    <div className="ou-strat-desc">{meta.desc}</div>
                </div>
            </div>

            {/* Main Content */}
            <div className="ou-content">
                {/* Sidebar: Config */}
                <div className="ou-sidebar">
                    {/* Stake & Martingale */}
                    <div className="ou-row-wrap">
                        <div className="ou-row-label"><Settings size={11} /> Risk</div>
                        <div className="ou-grid">
                            <div className="ou-f ou-f--col ou-f--gap-2">
                                <label className="ou-label">Stake ($)</label>
                                <input
                                    type="number"
                                    className="ou-input"
                                    value={stake}
                                    onChange={e => setStake(Number(e.target.value))}
                                    disabled={disabled}
                                    step="0.01"
                                    min="0.01"
                                />
                            </div>
                            <div className="ou-f ou-f--col ou-f--gap-2">
                                <label className="ou-label">Martingale (×)</label>
                                <input
                                    type="number"
                                    className="ou-input"
                                    value={martingale}
                                    onChange={e => setMartingale(Number(e.target.value))}
                                    disabled={disabled}
                                    step="0.1"
                                    min="1"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Volatility Selection */}
                    <div className="ou-row-wrap">
                        <div className="ou-row-label"><TrendingUp size={11} /> Volatility</div>
                        <div className="ou-grid">
                            <div className="ou-f ou-f--col ou-f--gap-2">
                                <label className="ou-label">Symbol</label>
                                <select
                                    className="ou-input"
                                    value={selected_symbol}
                                    onChange={e => setSelectedSymbol(e.target.value)}
                                    disabled={disabled}
                                >
                                    <option value="R_100">R_100</option>
                                    <option value="R_75">R_75</option>
                                    <option value="R_50">R_50</option>
                                    <option value="R_25">R_25</option>
                                    <option value="R_10">R_10</option>
                                    <option value="1HZ100V">1HZ100V</option>
                                    <option value="1HZ75V">1HZ75V</option>
                                    <option value="1HZ50V">1HZ50V</option>
                                    <option value="1HZ25V">1HZ25V</option>
                                    <option value="1HZ10V">1HZ10V</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Strategy-Specific Options */}
                    {activeStrategy === 'over_under' && (
                        <div className="ou-row-wrap">
                            <div className="ou-row-label"><Activity size={11} /> Options</div>
                            <div className="ou-grid">
                                <SwitchTile label='Volatility Changer' on={is_volatility_changer} onToggle={() => setIsVolatilityChanger(!is_volatility_changer)} disabled={disabled} color='#3b82f6' />
                                <SwitchTile label='Turbo Mode' on={is_turbo} onToggle={() => setIsTurbo(!is_turbo)} disabled={disabled} color='#3b82f6' />
                                <SwitchTile label='Digit Filter' on={is_digit_occurrence_filter_active} onToggle={() => setIsDigitOccurrenceFilterActive(!is_digit_occurrence_filter_active)} disabled={disabled} color='#3b82f6' />
                                <SwitchTile label='Rebounce' on={is_rebounce_active} onToggle={() => setIsRebounceActive(!is_rebounce_active)} disabled={disabled} color='#3b82f6' />
                            </div>
                        </div>
                    )}

                    {activeStrategy === 'differs' && (
                        <div className="ou-row-wrap">
                            <div className="ou-row-label"><Activity size={11} /> Trigger &amp; Options</div>
                            <TriggerPanel
                                color='#a855f7'
                                is_trigger_enabled={is_trigger_enabled}
                                setIsTriggerEnabled={setIsTriggerEnabled}
                                use_second_trigger={use_second_trigger}
                                setUseSecondTrigger={setUseSecondTrigger}
                                over_under={over_under}
                                disabled={disabled}
                            />
                            <div className='ou-grid'>
                                <SwitchTile label='Volatility Changer' on={is_volatility_changer} onToggle={() => setIsVolatilityChanger(!is_volatility_changer)} disabled={disabled} color='#a855f7' />
                                <SwitchTile label='Turbo Mode' on={is_turbo} onToggle={() => setIsTurbo(!is_turbo)} disabled={disabled} color='#a855f7' />
                                <SwitchTile label='Automate' on={is_automate} onToggle={() => setIsAutomate(!is_automate)} disabled={disabled} color='#a855f7' />
                            </div>
                        </div>
                    )}

                    {activeStrategy === 'differs_v2' && (
                        <div className='ou-row-wrap'>
                            <div className='ou-row-label'><Activity size={11} /> Trigger &amp; Options</div>
                            <TriggerPanel
                                color='#ec4899'
                                is_trigger_enabled={is_trigger_enabled}
                                setIsTriggerEnabled={setIsTriggerEnabled}
                                use_second_trigger={use_second_trigger}
                                setUseSecondTrigger={setUseSecondTrigger}
                                over_under={over_under}
                                disabled={disabled}
                            />
                            <div className='ou-grid'>
                                <SwitchTile label='Tatu Bora' on={is_tatu_bora_mode} onToggle={() => setIsTatuBoraMode(!is_tatu_bora_mode)} disabled={disabled} color='#ec4899' />
                                <SwitchTile label='Nne Kwisha' on={is_nne_kwisha_mode} onToggle={() => setIsNneKwishaMode(!is_nne_kwisha_mode)} disabled={disabled} color='#ec4899' />
                                <SwitchTile label='2-Term Compound' on={is_2term_mode} onToggle={() => setIs2termMode(!is_2term_mode)} disabled={disabled} color='#ec4899' />
                                <SwitchTile label='Auto Cycle' on={is_automate} onToggle={() => setIsAutomate(!is_automate)} disabled={disabled} color='#ec4899' />
                                <SwitchTile label='All Volatilities' on={is_all_vol_mode} onToggle={() => setIsAllVolMode(!is_all_vol_mode)} disabled={disabled} color='#ec4899' />
                            </div>
                        </div>
                    )}

                    {activeStrategy === 'rise_fall' && (
                        <div className='ou-row-wrap'>
                            <div className='ou-row-label'><TrendingUp size={11} /> Options</div>
                            <div className='ou-grid'>
                       
                                <SwitchTile label='Auto Cycle' on={is_automate} onToggle={() => setIsAutomate(!is_automate)} disabled={disabled} color='#10b981' />
                            </div>
                        </div>
                    )}

                    {activeStrategy === 'rise_fall_v2' && (
                        <div className='ou-row-wrap'>
                            <div className='ou-row-label'><TrendingUp size={11} /> Options</div>
                            <div className='ou-strat-info' style={{ '--c': '#06b6d4' } as React.CSSProperties}>
                                <span className='ou-strat-info__dot' />
                                <span>Scans all volatilities for 3 seconds on start, selects the one with the longest MACD histogram bar, then waits for 4 consecutive growing bars before placing a 4-tick Rise or Fall contract.</span>
                            </div>
                            <div className='ou-grid' style={{ marginTop: 8 }}>
                                <SwitchTile label='Auto Switch Volatility' on={is_volatility_changer} onToggle={() => setIsVolatilityChanger(!is_volatility_changer)} disabled={disabled} color='#06b6d4' />
                            </div>
                        </div>
                    )}
                    {activeStrategy === 'manual' && (
                        <>
                            <div className='ou-row-wrap'>
                                <div className='ou-row-label'><Settings size={11} /> Contract</div>
                                <div className='ou-grid'>
                                    <div className='ou-f ou-f--col ou-f--gap-2'>
                                        <label className='ou-label'>Type</label>
                                        <select
                                            className='ou-input'
                                            value={manual_contract_type}
                                            onChange={e => setManualContractType(e.target.value)}
                                            disabled={disabled}
                                        >
                                            <option value='DIGITOVER'>Over</option>
                                            <option value='DIGITUNDER'>Under</option>
                                            <option value='DIGITDIFF'>Differs</option>
                                        </select>
                                    </div>
                                    <div className='ou-f ou-f--col ou-f--gap-2'>
                                        <label className='ou-label'>Barrier (0-9)</label>
                                        <input
                                            type='number'
                                            className='ou-input'
                                            value={manual_barrier}
                                            onChange={e => setManualBarrier(Number(e.target.value))}
                                            disabled={disabled}
                                            min='0'
                                            max='9'
                                        />
                                    </div>
                                    <div className='ou-f ou-f--col ou-f--gap-2'>
                                        <label className='ou-label'>Duration (ticks)</label>
                                        <input
                                            type='number'
                                            className='ou-input'
                                            value={manual_duration}
                                            onChange={e => setManualDuration(Number(e.target.value))}
                                            disabled={disabled}
                                            min='1'
                                            max='10'
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className='ou-row-wrap'>
                                <div className='ou-row-label'><AlertCircle size={11} /> Trigger</div>
                                <div className='ou-grid'>
                                    <SwitchTile label='Enable Trigger' on={is_trigger_enabled} onToggle={() => setIsTriggerEnabled(!is_trigger_enabled)} disabled={disabled} color='#f97316' />
                                </div>
                            </div>
                        </>
                    )}

                    {/* Recovery System */}
                    <div className='ou-row-wrap'>
                        <div className='ou-row-label' onClick={() => setShowRecovery(!showRecovery)} style={{ cursor: 'pointer' }}>
                            <AlertCircle size={11} /> Recovery {showRecovery ? '▼' : '▶'}
                        </div>
                        {showRecovery && (
                            <div className='ou-grid'>
                                <SwitchTile label='Enable' on={is_recovery_enabled} onToggle={() => setIsRecoveryEnabled(!is_recovery_enabled)} disabled={disabled} color='#ef4444' />
                                {is_recovery_enabled && (
                                    <>
                                        <div className='ou-f ou-f--col ou-f--gap-2'>
                                            <label className='ou-label'>Contract Type</label>
                                            <select
                                                className='ou-input'
                                                value={recovery_contract_type}
                                                onChange={e => setRecoveryContractType(e.target.value)}
                                                disabled={disabled}
                                            >
                                                <option value='DIGITOVER'>Over</option>
                                                <option value='DIGITUNDER'>Under</option>
                                                <option value='DIGITDIFF'>Differs</option>
                                            </select>
                                        </div>
                                        <div className='ou-f ou-f--col ou-f--gap-2'>
                                            <label className='ou-label'>Barrier (0-9)</label>
                                            <input
                                                type='number'
                                                className='ou-input'
                                                value={recovery_barrier}
                                                onChange={e => setRecoveryBarrier(Number(e.target.value))}
                                                disabled={disabled}
                                                min='0'
                                                max='9'
                                            />
                                        </div>
                                        <div className='ou-f ou-f--col ou-f--gap-2'>
                                            <label className='ou-label'>Entry Digit</label>
                                            <input
                                                type='number'
                                                className='ou-input'
                                                value={recovery_entry_digit}
                                                onChange={e => setRecoveryEntryDigit(Number(e.target.value))}
                                                disabled={disabled}
                                                min='0'
                                                max='9'
                                            />
                                        </div>
                                        <SwitchTile label='Use Delay' on={use_recovery_delay} onToggle={() => setUseRecoveryDelay(!use_recovery_delay)} disabled={disabled} color='#ef4444' />
                                        {use_recovery_delay && (
                                            <div className='ou-f ou-f--col ou-f--gap-2'>
                                                <label className='ou-label'>2nd Entry Digit</label>
                                                <input
                                                    type='number'
                                                    className='ou-input'
                                                    value={recovery_second_entry_digit}
                                                    onChange={e => setRecoverySecondEntryDigit(Number(e.target.value))}
                                                    disabled={disabled}
                                                    min='0'
                                                    max='9'
                                                />
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Turbo & Automate (for strategies that don't have it) */}
                    {activeStrategy !== 'differs_v2' && activeStrategy !== 'differs' && activeStrategy !== 'rise_fall' && activeStrategy !== 'rise_fall_v2' && (
                        <div className='ou-row-wrap'>
                            <div className='ou-row-label'><Settings size={11} /> Global</div>
                            <div className='ou-grid'>
                                <SwitchTile label='Turbo Mode' on={is_turbo} onToggle={() => setIsTurbo(!is_turbo)} disabled={disabled} color={meta.color} />
                            </div>
                        </div>
                    )}
                </div>

                {/* Main: Logs & Status */}
                <div className='ou-main'>
                    {/* Control Buttons */}
                    <div className='ou-controls'>
                        <button
                            className={`ou-btn ou-btn--lg ${is_auto_running ? 'ou-btn--stop' : 'ou-btn--play'}`}
                            onClick={handleStartStop}
                            disabled={is_authorizing}
                        >
                            {is_auto_running ? <Square size={18} /> : <Play size={18} />}
                            {is_auto_running ? 'Stop' : 'Run'}
                        </button>
                    </div>

                    {/* Status Display */}
                    <div className='ou-status-display'>
                        <div className='ou-status-item'>
                            <span className='ou-status-label'>Last Digit:</span>
                            <span className='ou-status-value'>{last_digit ?? '—'}</span>
                        </div>
                        <div className='ou-status-item'>
                            <span className='ou-status-label'>Ticks:</span>
                            <span className='ou-status-value'>{tick_history.length}</span>
                        </div>
                        {is_analyzing_volatility && (
                            <div className='ou-status-item'>
                                <span className='ou-status-label'>Analyzing volatilities...</span>
                            </div>
                        )}
                    </div>

                    {/* Logs */}
                    <div className='ou-logs'>
                        <div className='ou-logs__header'>
                            <span>Logs</span>
                            <button className='ou-btn ou-btn--sm' onClick={clearDebug}>Clear</button>
                        </div>
                        <div className='ou-logs__content'>
                            {debug_info.map((log, i) => (
                                <div key={i} className='ou-log-entry'>{log}</div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Guide Modal */}
            {showGuide && (
                <div className='ou-modal-overlay' onClick={() => setShowGuide(false)}>
                    <div className='ou-modal' onClick={e => e.stopPropagation()}>
                        <div className='ou-modal__header'>
                            <h2>Strategy Guide</h2>
                            <button className='ou-btn ou-btn--icon' onClick={() => setShowGuide(false)}>✕</button>
                        </div>
                        <div className='ou-modal__content'>
                            {[
                                { c: 'blue', t: 'Over 5 / Under 4', items: [
                                    '<b>Goal:</b> Fire simultaneous Over 5 & Under 4 contracts on a trigger digit.',
                                    '<b>Trigger:</b> When the last digit matches your chosen trigger, both contracts fire.',
                                    '<b>Volatility Vote:</b> If enabled, scans all volatilities and picks the one with the lowest occurrence of digits 4 & 5 in the last 1000 ticks.',
                                    '<b>Digit Filter:</b> Skips the trade if digit 4 or 5 has appeared more than 25% in the last 100 ticks.',
                                    '<b>Rebounce:</b> Waits for a digit to bounce (appear, disappear, reappear) before firing.',
                                    '<b>Turbo Mode:</b> Auto-restart after each round. Without it, the bot stops after one trade.',
                                ] },
                                { c: 'purple', t: 'Differs', items: [
                                    '<b>Goal:</b> Trade on reversal patterns — when price pushes in one direction then reverses.',
                                    '<b>Pattern:</b> Detects 3+ consecutive ticks in one direction, then a reversal. Fires a Differs contract on the reversal digit.',
                                    '<b>Safeguards:</b> Skips if the digit is too frequent (>9.8%), is the rarest or most common in the last 1000 ticks, or is rapidly increasing in frequency.',
                                    '<b>Prediction Engine:</b> Analyzes the last 200 ticks and flags digits predicted to appear soon.',
                                    '<b>Volatility Vote:</b> Picks the index with the lowest digit frequency variance.',
                                ] },
                                { c: 'pink', t: 'Differs V2', items: [
                                    '<b>Goal:</b> Trade on repeated digit patterns — doubles (7,7), triples (7,7,7), or quads (7,7,7,7).',
                                    '<b>Modes:</b> <b>Double</b> (default), <b>Tatu Bora</b> (triple), <b>Nne Kwisha</b> (quad).',
                                    '<b>Tatu Bora:</b> Wait for a TRIPLE (3 same digits in a row) before firing — rarer pattern, higher hit rate.',
                                    '<b>Nne Kwisha:</b> Wait for a QUAD (4 same digits in a row) — the strictest version, fewest trades.',
                                    '<b>Other Options:</b> <b>2-Term Compound</b>, <b>Auto Cycle</b>, <b>All Volatilities</b>, plus the same digit-frequency safeguards used in Differs.',
                                ] },
                                { c: 'green', t: 'Rise / Fall', items: [
                                    '<b>Goal:</b> Trade trend reversals using the MACD indicator.',
                                    '<b>Volatility Vote:</b> Pulls real recent prices from every volatility in parallel, computes each one\'s MACD histogram, and picks the index with the tallest bars over the last 15 candles (most active momentum).',
                                    '<b>RISE (CALL):</b> MACD line crosses ABOVE the signal line while BOTH lines are below the zero line — a turn from a downtrend.',
                                    '<b>FALL (PUT):</b> MACD line crosses BELOW the signal line while BOTH lines are above the zero line — a turn from an uptrend.',
                                    '<b>Anti-Wobble Filter:</b> The cross is only taken if the gap between the lines on the bar before the cross was at least 25% of the average gap over the last 5 bars — so two lines hugging each other won\'t produce a false signal.',
                                    '<b>Auto Cycle:</b> After at least 3 trades AND only when the last trade was a WIN, the volatility vote is re-run and the bot may switch indices. A losing streak holds the current index until a win returns.',
                                ] },
                                { c: 'cyan', t: 'Rise / Fall V2', items: [
                                    '<b>Goal:</b> Catch momentum exhaustion by trading the opposite direction after 4 bars of sustained growth.',
                                    '<b>Startup Scan (3 seconds):</b> On start, the bot fetches tick history for all 10 volatility indices simultaneously. After 3 seconds it computes the MACD (12,26,9) histogram for each and selects the one whose <b>latest histogram bar</b> has the greatest absolute magnitude — the symbol with the strongest momentum right now.',
                                    '<b>FALL (PUT) Entry — Overbought Exhaustion:</b> The histogram must be <b>above zero</b> and each bar must be <b>higher than the previous</b> for 4 consecutive ticks (e.g., 0.1 → 0.2 → 0.3 → 0.4). On the 4th consecutive increase, the momentum is exhausted → place a <b>FALL</b> contract expecting reversal DOWN.',
                                    '<b>RISE (CALL) Entry — Oversold Exhaustion:</b> The histogram must be <b>below zero</b> and each bar must be <b>more negative</b> than the previous for 4 consecutive ticks (e.g., -0.1 → -0.2 → -0.3 → -0.4). On the 4th consecutive increase in downward magnitude, the momentum is exhausted → place a <b>RISE</b> contract expecting reversal UP.',
                                    '<b>Contract Duration:</b> All trades are exactly <b>4 ticks</b>.',
                                    '<b>Growth Counter:</b> Resets to 0 immediately after a purchase or if the growth sequence breaks at any point — preventing multiple entries on the same move.',
                                    '<b>Auto Switch Volatility:</b> Optionally re-run the 3-second scan after each trade to stay on the most active index.',
                                ] },
                                { c: 'orange', t: 'Manual', items: [
                                    '<b>Goal:</b> You decide everything — contract type, barrier, duration, trigger.',
                                    '<b>Setup:</b> Choose <b>Contract Type</b> (Over / Under / Differs), the <b>Barrier</b> digit (0–9), and <b>Duration</b> in ticks (1–10).',
                                    '<b>Trigger:</b> Optional — fires only when the last digit matches your trigger, or every tick if disabled.',
                                ] },
                            ].map((section, i) => (
                                <div key={i} className='ou-guide-section'>
                                    <h3 style={{ color: ({ blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899', green: '#10b981', cyan: '#06b6d4', orange: '#f97316' } as any)[section.c] }}>
                                        {section.t}
                                    </h3>
                                    <ul>
                                        {section.items.map((item, j) => (
                                            <li key={j} dangerouslySetInnerHTML={{ __html: item }} />
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default OverUnder;
