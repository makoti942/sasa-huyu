import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import Text from '@/components/shared_ui/text';
import { localize } from '@deriv-com/translations';
import {
    generateDerivApiInstance,
    V2GetActiveClientId,
    V2GetActiveToken,
} from '@/external/bot-skeleton/services/api/appId';
import { contract_stages } from '@/constants/contract-stage';
import { useStore } from '@/hooks/useStore';
import { isSpecialCRAccount } from '@/utils/special-accounts-config';
import './speedbot.scss';

// Minimal trade types we will support initially
const TRADE_TYPES = [
    { value: 'DIGITOVER', label: 'Digits Over' },
    { value: 'DIGITUNDER', label: 'Digits Under' },
    { value: 'DIGITEVEN', label: 'Even' },
    { value: 'DIGITODD', label: 'Odd' },
    { value: 'DIGITMATCH', label: 'Matches' },
    { value: 'DIGITDIFF', label: 'Differs' },
    { value: 'OVER_UNDER', label: 'Over/Under' },
];

// Safe version of tradeOptionToBuy without Blockly dependencies
const tradeOptionToBuy = (contract_type: string, trade_option: any) => {
    const buy = {
        buy: '1',
        price: trade_option.amount,
        parameters: {
            amount: trade_option.amount,
            basis: trade_option.basis,
            contract_type,
            currency: trade_option.currency,
            duration: trade_option.duration,
            duration_unit: trade_option.duration_unit,
            symbol: trade_option.symbol,
        },
    };
    if (trade_option.prediction !== undefined) {
        buy.parameters.selected_tick = trade_option.prediction;
    }
    if (!['TICKLOW', 'TICKHIGH'].includes(contract_type) && trade_option.prediction !== undefined) {
        buy.parameters.barrier = trade_option.prediction;
    }
    return buy;
};

const SpeedBot = observer(() => {
    const store = useStore();
    const { run_panel, transactions } = store;

    const apiRef = useRef<any>(null);
    const tickStreamIdRef = useRef<string | null>(null);
    const messageHandlerRef = useRef<((evt: MessageEvent) => void) | null>(null);

    const lastOutcomeWasLossRef = useRef(false);

    const [is_authorized, setIsAuthorized] = useState(false);
    const [account_currency, setAccountCurrency] = useState<string>('USD');
    const [symbols, setSymbols] = useState<Array<{ symbol: string; display_name: string }>>([]);

    // Form state
    const [symbol, setSymbol] = useState<string>('');
    const [tradeType, setTradeType] = useState<string>('DIGITOVER');
    const [ticks, setTicks] = useState<string>('1');
    const [stake, setStake] = useState<string>('0.5');
    const [baseStake, setBaseStake] = useState<number>(0.5);
    // Predictions
    const [ouPredPreLoss, setOuPredPreLoss] = useState<string>('5');
    const [ouPredPostLoss, setOuPredPostLoss] = useState<string>('7');
    const [mdPrediction, setMdPrediction] = useState<string>('5'); // for match/diff
    // Martingale/recovery
    const [martingaleMultiplier, setMartingaleMultiplier] = useState<string>('1.0');

    // Live digits state
    const [digits, setDigits] = useState<number[]>([]);
    const [lastDigit, setLastDigit] = useState<number | null>(null);
    const [ticksProcessed, setTicksProcessed] = useState<number>(0);

    const [status, setStatus] = useState<string>('');
    // UI toggles and counters
    const [altEvenOdd, setAltEvenOdd] = useState<boolean>(false);
    const [altOnLoss, setAltOnLoss] = useState<boolean>(false);
    const [consecWins, setConsecWins] = useState<number>(0);
    const [consecLosses, setConsecLosses] = useState<number>(0);

    const [is_running, setIsRunning] = useState(false);
    const stopFlagRef = useRef<boolean>(false);

    const getHintClass = (d: number) => {
        if (tradeType === 'DIGITEVEN') return d % 2 === 0 ? 'is-green' : 'is-red';
        if (tradeType === 'DIGITODD') return d % 2 !== 0 ? 'is-green' : 'is-red';
        if (tradeType === 'DIGITOVER' || tradeType === 'DIGITUNDER') {
            const activePred = lastOutcomeWasLossRef.current ? ouPredPostLoss : ouPredPreLoss;
            if (tradeType === 'DIGITOVER') {
                if (d > Number(activePred)) return 'is-green';
                if (d < Number(activePred)) return 'is-red';
                return 'is-neutral';
            }
            if (tradeType === 'DIGITUNDER') {
                if (d < Number(activePred)) return 'is-green';
                if (d > Number(activePred)) return 'is-red';
                return 'is-neutral';
            }
        }
        return '';
    };

    useEffect(() => {
        // Initialize API connection and fetch active symbols
        const api = generateDerivApiInstance();
        apiRef.current = api;
        const init = async () => {
            try {
                // Fetch active symbols (volatility indices)
                const { active_symbols, error: asErr } = await api.send({ active_symbols: 'brief' });
                if (asErr) throw asErr;
                const syn = (active_symbols || [])
                    .filter((s: any) => /synthetic/i.test(s.market) || /^R_/.test(s.symbol))
                    .map((s: any) => ({ symbol: s.symbol, display_name: s.display_name }));
                setSymbols(syn);
                if (!symbol && syn[0]?.symbol) setSymbol(syn[0].symbol);
                if (syn[0]?.symbol) startTicks(syn[0].symbol);
            } catch (e: any) {
                // eslint-disable-next-line no-console
                console.error('SpeedBot init error', e);
                setStatus(e?.message || 'Failed to load symbols');
            }
        };
        init();

        return () => {
            // Clean up streams and socket
            try {
                if (tickStreamIdRef.current) {
                    apiRef.current?.forget({ forget: tickStreamIdRef.current });
                    tickStreamIdRef.current = null;
                }
                if (messageHandlerRef.current) {
                    apiRef.current?.connection?.removeEventListener('message', messageHandlerRef.current);
                    messageHandlerRef.current = null;
                }
                api?.disconnect?.();
            } catch {
                /* noop */
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // DISABLED - replaced by DerivAuth.js
    // const authorizeIfNeeded = async () => {
    //     if (is_authorized) return;
    //     const token = V2GetActiveToken();
    //     if (!token) {
    //         setStatus('No token found. Please log in and select an account.');
    //         throw new Error('No token');
    //     }
    //     const { authorize, error } = await apiRef.current.authorize(token);
    //     if (error) {
    //         setStatus(`Authorization error: ${error.message || error.code}`);
    //         throw error;
    //     }
    //     setIsAuthorized(true);
    //     const loginid = authorize?.loginid || V2GetActiveClientId();
    //     setAccountCurrency(authorize?.currency || 'USD');
    //     try {
    //         // Sync SpeedBot auth state into shared ClientStore so Transactions store keys correctly by account
    //         store?.client?.setLoginId?.(loginid || '');
    //         store?.client?.setCurrency?.(authorize?.currency || 'USD');
    //         store?.client?.setIsLoggedIn?.(true);
    //     } catch {}
    // };

    const stopTicks = () => {
        try {
            if (tickStreamIdRef.current) {
                apiRef.current?.forget({ forget: tickStreamIdRef.current });
                tickStreamIdRef.current = null;
            }
            if (messageHandlerRef.current) {
                apiRef.current?.connection?.removeEventListener('message', messageHandlerRef.current);
                messageHandlerRef.current = null;
            }
        } catch {}
    };

    const startTicks = async (sym: string) => {
        stopTicks();
        setDigits([]);
        setLastDigit(null);
        setTicksProcessed(0);
        try {
            const { subscription, error } = await apiRef.current.send({ ticks: sym, subscribe: 1 });
            if (error) throw error;
            if (subscription?.id) tickStreamIdRef.current = subscription.id;
            // Listen for streaming ticks on the raw websocket
            const onMsg = (evt: MessageEvent) => {
                try {
                    const data = JSON.parse(evt.data as any);
                    if (data?.msg_type === 'tick' && data?.tick?.symbol === sym) {
                        const quote = data.tick.quote;
                        const digit = Number(String(quote).slice(-1));
                        setLastDigit(digit);
                        setDigits(prev => [...prev.slice(-8), digit]);
                        setTicksProcessed(prev => prev + 1);
                    }
                    if (data?.forget?.id && data?.forget?.id === tickStreamIdRef.current) {
                        // stopped
                    }
                } catch {}
            };
            messageHandlerRef.current = onMsg;
            apiRef.current?.connection?.addEventListener('message', onMsg);
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('startTicks error', e);
        }
    };

    const purchaseOnce = async () => {
        // CRITICAL: For special CR accounts, ensure we're using demo account token
        // IMPORTANT: Only apply special CR logic if account is actually in the special CR list
        // For normal accounts, use standard authorization flow without any interference
        const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
        const currentLoginId = V2GetActiveClientId();
        
        // Strict check: only true if account is actually in the special CR accounts list
        const isSpecialCR = (showAsCR && isSpecialCRAccount(showAsCR)) || (currentLoginId && isSpecialCRAccount(currentLoginId));
        
        console.log('[SpeedBot] 🔍 Account check:', {
            showAsCR,
            currentLoginId,
            isSpecialCR
        });
        
        if (isSpecialCR) {
            // ONLY for special CR accounts - re-authorize with demo account token before each purchase
            // This ensures the API uses demo account balance, preventing "insufficient funds" errors
            const demoToken = V2GetActiveToken(); // This already returns demo token for special CR accounts
            
            if (demoToken && apiRef.current) {
                console.log('[SpeedBot] 🎯 Special CR account detected - re-authorizing with demo account');
                const { authorize, error: authError } = await apiRef.current.authorize(demoToken);
                if (authError) {
                    console.error('[SpeedBot] ❌ Failed to authorize with demo token:', authError);
                    throw new Error(`Authorization failed: ${authError.message || authError.code}`);
                }
                if (authorize) {
                    console.log('[SpeedBot] ✅ Authorized with demo account:', authorize.loginid, 'Balance:', authorize.balance);
                    setIsAuthorized(true);
                    setAccountCurrency(authorize?.currency || 'USD');
                }
            } else {
                console.warn('[SpeedBot] ⚠️ Demo token not found for special CR account');
                // Fallback to normal authorization
                await authorizeIfNeeded();
            }
        } else {
            // Normal account - use standard authorization flow without any special CR interference
            console.log('[SpeedBot] ✅ Normal account detected - using standard authorization flow');
            await authorizeIfNeeded();
        }

        const trade_option: any = {
            amount: Number(stake),
            basis: 'stake',
            contractTypes: [tradeType === 'OVER_UNDER' ? (lastOutcomeWasLossRef.current ? 'DIGITUNDER' : 'DIGITOVER') : tradeType],
            currency: account_currency,
            duration: Number(ticks),
            duration_unit: 't',
            symbol,
        };
        // Choose prediction based on trade type and last outcome
        if (tradeType === 'DIGITOVER' || tradeType === 'DIGITUNDER' || tradeType === 'OVER_UNDER') {
            trade_option.prediction = Number(lastOutcomeWasLossRef.current ? ouPredPostLoss : ouPredPreLoss);
        } else if (tradeType === 'DIGITMATCH' || tradeType === 'DIGITDIFF') {
            trade_option.prediction = Number(mdPrediction);
        }

        const buy_req = tradeOptionToBuy(tradeType === 'OVER_UNDER' ? (lastOutcomeWasLossRef.current ? 'DIGITUNDER' : 'DIGITOVER') : tradeType, trade_option);
        const { buy, error } = await apiRef.current.buy(buy_req);
        if (error) throw error;
        setStatus(`Purchased: ${buy?.longcode || 'Contract'} (ID: ${buy?.contract_id})`);
        return buy;
    };

    const onRun = async () => {
        setStatus('');
        setIsRunning(true);
        stopFlagRef.current = false;
        run_panel.toggleDrawer(true);
        run_panel.setActiveTabIndex(1); // Transactions tab index in run panel tabs
        run_panel.run_id = `speedbot-${Date.now()}`;
        run_panel.setIsRunning(true);
        run_panel.setContractStage(contract_stages.STARTING);

        try {
            let lossStreak = 0;
            let step = 0;
            const stakeNum = Number(stake);
            const martingaleNum = Number(martingaleMultiplier);
            baseStake !== stakeNum && setBaseStake(stakeNum);
            while (!stopFlagRef.current) {
                // Adjust stake and prediction based on prior outcomes (simple martingale)
                const effectiveStake =
                    step > 0 ? Number((baseStake * Math.pow(martingaleNum, step)).toFixed(2)) : baseStake;
                // apply effective stake to buy
                setStake(effectiveStake.toString());

                const isOU = tradeType === 'DIGITOVER' || tradeType === 'DIGITUNDER' || tradeType === 'OVER_UNDER';
                if (isOU) {
                    lastOutcomeWasLossRef.current = lossStreak > 0;
                }

                const buy = await purchaseOnce();

                // Seed an initial transaction row immediately so the UI shows a live row like Bot Builder
                try {
                    const symbol_display = symbols.find(s => s.symbol === symbol)?.display_name || symbol;
                    transactions.onBotContractEvent({
                        contract_id: buy?.contract_id,
                        transaction_ids: { buy: buy?.transaction_id },
                        buy_price: buy?.buy_price,
                        currency: account_currency,
                        contract_type: (tradeType === 'OVER_UNDER' ? (lastOutcomeWasLossRef.current ? 'DIGITUNDER' : 'DIGITOVER') : tradeType) as any,
                        underlying: symbol,
                        display_name: symbol_display,
                        date_start: Math.floor(Date.now() / 1000),
                        status: 'open',
                    } as any);
                } catch {}

                // Reflect stage immediately after successful buy
                run_panel.setHasOpenContract(true);
                run_panel.setContractStage(contract_stages.PURCHASE_SENT);

                // subscribe to contract updates for this purchase and push to transactions
                try {
                    const res = await apiRef.current.send({
                        proposal_open_contract: 1,
                        contract_id: buy?.contract_id,
                        subscribe: 1,
                    });
                    const { error, proposal_open_contract: pocInit, subscription } = res || {};
                    if (error) throw error;

                    let pocSubId: string | null = subscription?.id || null;
                    const targetId = String(buy?.contract_id || '');

                    // Push initial snapshot if present in the first response
                    if (pocInit && String(pocInit?.contract_id || '') === targetId) {
                        transactions.onBotContractEvent(pocInit);
                        run_panel.setHasOpenContract(true);
                    }

                    // Listen for subsequent streaming updates
                    const onMsg = (evt: MessageEvent) => {
                        try {
                            const data = JSON.parse(evt.data as any);
                            if (data?.msg_type === 'proposal_open_contract') {
                                const poc = data.proposal_open_contract;
                                // capture subscription id for later forget
                                if (!pocSubId && data?.subscription?.id) pocSubId = data.subscription.id;
                                if (String(poc?.contract_id || '') === targetId) {
                                    transactions.onBotContractEvent(poc);
                                    run_panel.setHasOpenContract(true);
                                    if (poc?.is_sold || poc?.status === 'sold') {
                                        run_panel.setContractStage(contract_stages.CONTRACT_CLOSED);
                                        run_panel.setHasOpenContract(false);
                                        if (pocSubId) apiRef.current?.forget?.({ forget: pocSubId });
                                        apiRef.current?.connection?.removeEventListener('message', onMsg);
                                        const profit = Number(poc?.profit || 0);
                                        if (profit > 0) {
                                            lastOutcomeWasLossRef.current = false;
                                            lossStreak = 0;
                                            step = 0;
                                            setStake(baseStake.toString());
                                        } else {
                                            lastOutcomeWasLossRef.current = true;
                                            lossStreak++;
                                            step = Math.min(step + 1, 50);
                                        }
                                    }
                                }
                            }
                        } catch {
                            // noop
                        }
                    };
                    apiRef.current?.connection?.addEventListener('message', onMsg);
                } catch (subErr) {
                    // eslint-disable-next-line no-console
                    console.error('subscribe poc error', subErr);
                }

                // Wait minimally between purchases: we'll wait for ticks duration completion by polling poc completion
                // Simple delay to prevent spamming if API rejects immediate buy loop
                await new Promise(res => setTimeout(res, 500));
            }
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error('SpeedBot run loop error', e);
            const msg = e?.message || e?.error?.message || 'Something went wrong';
            setStatus(`Error: ${msg}`);
        } finally {
            setIsRunning(false);
            run_panel.setIsRunning(false);
            run_panel.setHasOpenContract(false);
            run_panel.setContractStage(contract_stages.NOT_RUNNING);
        }
    };

    const onStop = () => {
        stopFlagRef.current = true;
        setIsRunning(false);
    };

    // Expose stop function globally for floating button access
    useEffect(() => {
        (window as any).speedbotStop = onStop;
        return () => {
            delete (window as any).speedbotStop;
        };
    }, []);

    // Allow the global Run panel button to stop SpeedBot as well.
    // When the Run panel toggles to not running while SpeedBot is running, stop SpeedBot.
    useEffect(() => {
        if (!run_panel.is_running && is_running) {
            stopFlagRef.current = true;
            setIsRunning(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [run_panel.is_running, is_running]);

    return (
        <div className='speedbot'>
            <div className='speedbot__container'>
                <div className='speedbot__header'>
                    <h1 className='speedbot__title'>SpeedBot</h1>
                    <p className='speedbot__subtitle'>High-speed automated trading bot</p>
                </div>

                <div className='speedbot__card'>
                    <div className='speedbot__row speedbot__row--wide'>
                        <div className='speedbot__field'>
                            <label htmlFor='sb-symbol'>{localize('Volatility')}</label>
                            <select
                                id='sb-symbol'
                                value={symbol}
                                onChange={e => {
                                    const v = e.target.value;
                                    setSymbol(v);
                                    startTicks(v);
                                }}
                            >
                                {symbols.map(s => (
                                    <option key={s.symbol} value={s.symbol}>
                                        {s.display_name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className='speedbot__field'>
                            <label htmlFor='sb-tradeType'>{localize('Trade type')}</label>
                            <select id='sb-tradeType' value={tradeType} onChange={e => setTradeType(e.target.value)}>
                                {TRADE_TYPES.map(t => (
                                    <option key={t.value} value={t.value}>
                                        {t.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className='speedbot__field'>
                            <label htmlFor='sb-ticks'>{localize('Ticks')}</label>
                            <input
                                id='sb-ticks'
                                type='number'
                                min={1}
                                max={10}
                                value={ticks}
                                onChange={e => {
                                    const value = e.target.value;
                                    setTicks(value);
                                }}
                                onFocus={e => e.target.select()}
                                onBlur={e => {
                                    const value = e.target.value;
                                    if (value === '' || value === '0' || value === '0.') {
                                        setTicks('1');
                                    } else {
                                        const numValue = Number(value);
                                        if (isNaN(numValue) || numValue < 1) {
                                            setTicks('1');
                                        } else if (numValue > 10) {
                                            setTicks('10');
                                        }
                                    }
                                }}
                            />
                        </div>
                        <div className='speedbot__field'>
                            <label htmlFor='sb-stake'>{localize('Stake')}</label>
                            <input
                                id='sb-stake'
                                type='number'
                                step='0.01'
                                min={0.35}
                                value={stake}
                                onChange={e => {
                                    const value = e.target.value;
                                    setStake(value);
                                }}
                                onFocus={e => e.target.select()}
                                onBlur={e => {
                                    const value = e.target.value;
                                    if (value === '' || value === '0' || value === '0.') {
                                        setStake('0.5');
                                    } else {
                                        const numValue = Number(value);
                                        if (isNaN(numValue) || numValue < 0.35) {
                                            setStake('0.5');
                                        }
                                    }
                                }}
                            />
                        </div>
                    </div>

                    <div className='speedbot__row speedbot__row--two speedbot__toggles'>
                        <div className='speedbot__toggle'>
                            <label>{localize('Alternate Even and Odd')}</label>
                            <label className='switch'>
                                <input
                                    type='checkbox'
                                    checked={altEvenOdd}
                                    onChange={e => setAltEvenOdd(e.target.checked)}
                                />
                                <span className='slider round'></span>
                            </label>
                        </div>
                        <div className='speedbot__toggle'>
                            <label>{localize('Alternate on Loss')}</label>
                            <label className='switch'>
                                <input
                                    type='checkbox'
                                    checked={altOnLoss}
                                    onChange={e => setAltOnLoss(e.target.checked)}
                                />
                                <span className='slider round'></span>
                            </label>
                        </div>
                    </div>

                    {/* Strategy controls */}
                    {tradeType === 'DIGITMATCH' || tradeType === 'DIGITDIFF' ? (
                        <div className='speedbot__row speedbot__row--wide'>
                            <div className='speedbot__field'>
                                <label htmlFor='sb-md-pred'>{localize('Match/Diff prediction digit')}</label>
                                <input
                                    id='sb-md-pred'
                                    type='number'
                                    min={0}
                                    max={9}
                                    value={mdPrediction}
                                    onChange={e => {
                                        const value = e.target.value;
                                        setMdPrediction(value);
                                    }}
                                    onFocus={e => e.target.select()}
                                    onBlur={e => {
                                        const value = e.target.value;
                                        if (value === '' || value === '0' || value === '0.') {
                                            setMdPrediction('5');
                                        } else {
                                            const numValue = Number(value);
                                            if (isNaN(numValue) || numValue < 0) {
                                                setMdPrediction('0');
                                            } else if (numValue > 9) {
                                                setMdPrediction('9');
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div className='speedbot__field'>
                                <label htmlFor='sb-martingale'>{localize('Martingale multiplier')}</label>
                                <input
                                    id='sb-martingale'
                                    type='number'
                                    min={1}
                                    step='0.1'
                                    value={martingaleMultiplier}
                                    onChange={e => {
                                        const value = e.target.value;
                                        setMartingaleMultiplier(value);
                                    }}
                                    onFocus={e => e.target.select()}
                                    onBlur={e => {
                                        const value = e.target.value;
                                        if (value === '' || value === '0' || value === '0.') {
                                            setMartingaleMultiplier('1.0');
                                        } else {
                                            const numValue = Number(value);
                                            if (isNaN(numValue) || numValue < 1) {
                                                setMartingaleMultiplier('1.0');
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div className='speedbot__field'></div>
                            <div className='speedbot__field'></div>
                        </div>
                    ) : (
                        <div className='speedbot__row speedbot__row--wide'>
                            <div className='speedbot__field'>
                                <label htmlFor='sb-ou-pred-pre'>{localize('Over/Under prediction (pre-loss)')}</label>
                                <input
                                    id='sb-ou-pred-pre'
                                    type='number'
                                    min={0}
                                    max={9}
                                    value={ouPredPreLoss}
                                    onChange={e => {
                                        const value = e.target.value;
                                        setOuPredPreLoss(value);
                                    }}
                                    onFocus={e => e.target.select()}
                                    onBlur={e => {
                                        const value = e.target.value;
                                        if (value === '' || value === '0' || value === '0.') {
                                            setOuPredPreLoss('5');
                                        } else {
                                            const numValue = Number(value);
                                            if (isNaN(numValue) || numValue < 0) {
                                                setOuPredPreLoss('0');
                                            } else if (numValue > 9) {
                                                setOuPredPreLoss('9');
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div className='speedbot__field'>
                                <label htmlFor='sb-ou-pred-post'>
                                    {localize('Over/Under prediction (after loss)')}
                                </label>
                                <input
                                    id='sb-ou-pred-post'
                                    type='number'
                                    min={0}
                                    max={9}
                                    value={ouPredPostLoss}
                                    onChange={e => {
                                        const value = e.target.value;
                                        setOuPredPostLoss(value);
                                    }}
                                    onFocus={e => e.target.select()}
                                    onBlur={e => {
                                        const value = e.target.value;
                                        if (value === '' || value === '0' || value === '0.') {
                                            setOuPredPostLoss('7');
                                        } else {
                                            const numValue = Number(value);
                                            if (isNaN(numValue) || numValue < 0) {
                                                setOuPredPostLoss('0');
                                            } else if (numValue > 9) {
                                                setOuPredPostLoss('9');
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div className='speedbot__field'>
                                <label htmlFor='sb-martingale'>{localize('Martingale multiplier')}</label>
                                <input
                                    id='sb-martingale'
                                    type='number'
                                    min={1}
                                    step='0.1'
                                    value={martingaleMultiplier}
                                    onChange={e => {
                                        const value = e.target.value;
                                        setMartingaleMultiplier(value);
                                    }}
                                    onFocus={e => e.target.select()}
                                    onBlur={e => {
                                        const value = e.target.value;
                                        if (value === '' || value === '0' || value === '0.') {
                                            setMartingaleMultiplier('1.0');
                                        } else {
                                            const numValue = Number(value);
                                            if (isNaN(numValue) || numValue < 1) {
                                                setMartingaleMultiplier('1.0');
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div className='speedbot__field'></div>
                        </div>
                    )}

                    <div className='speedbot__digits'>
                        {digits.map((d, idx) => (
                            <div
                                key={`${idx}-${d}`}
                                className={`speedbot__digit ${d === lastDigit ? 'is-current' : ''} ${getHintClass(d)}`}
                            >
                                {d}
                            </div>
                        ))}
                    </div>
                    {(tradeType === 'DIGITEVEN' || tradeType === 'DIGITODD') && (
                        <div className='speedbot__digits speedbot__digits--eo'>
                            {digits.map((d, idx) => {
                                const is_even = d % 2 === 0;
                                const label = is_even ? 'E' : 'O';
                                const cls = is_even ? 'is-green' : 'is-red';
                                const is_current = d === lastDigit;
                                return (
                                    <div
                                        key={`eo-${idx}-${d}`}
                                        className={`speedbot__digit ${is_current ? 'is-current' : ''} ${cls}`}
                                    >
                                        {label}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div className='speedbot__footer-bar'>
                        <div className='speedbot__footer-item'>
                            {localize('Total Profit/Loss:')} {Number(store?.summary_card?.profit || 0).toFixed(2)}
                        </div>
                        <div className='speedbot__footer-item'>
                            {localize('Last Digit:')} {lastDigit ?? '-'}
                        </div>
                        <div className='speedbot__footer-item'>
                            {localize('Consecutive Wins:')} {consecWins} {localize('Consecutive Losses:')}{' '}
                            {consecLosses}
                        </div>
                    </div>

                    <div className='speedbot__cta'>
                        <button className='speedbot__cta-once' onClick={() => onRun()} disabled={!symbol}>
                            {localize('Trade once')}
                        </button>
                        <button className='speedbot__cta-auto' onClick={is_running ? onStop : onRun} disabled={!symbol}>
                            {is_running ? localize('Stop') : localize('Start auto trading')}
                        </button>
                    </div>

                    {status && (
                        <div className='speedbot__status'>
                            <Text size='xs' color={/error|fail/i.test(status) ? 'loss-danger' : 'prominent'}>
                                {status}
                            </Text>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

export default SpeedBot;
