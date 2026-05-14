
import { localize } from '@deriv-com/translations';
import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import ApiHelpers from '../../api/api-helpers';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { openContractReceived, purchaseSuccessful, sell, start } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';
import { observer as globalObserver } from '../../../utils/observer';
import { getBalanceSwapState } from '@/utils/balance-swap-utils';
import { isSpecialCRAccount, getDemoAccountIdForSpecialCR } from '@/utils/special-accounts-config';
import { getDecimalPlaces } from '@/components/shared';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        async purchase(contract_type) {
            if (this.vh_state.enabled && this.vh_state.is_virtual) {
                return this.virtualPurchase(contract_type);
            }
            return this.realPurchase(contract_type);
        }

        async virtualPurchase(contract_type) {
            // contract_type is the specific type being purchased (e.g. 'DIGITOVER', 'CALL').
            // Do NOT use this.tradeOptions.contract_type — that field is undefined on the
            // tradeOptions object (it stores contractTypes as a plural array instead).
            // Using the wrong source caused virtual_contract_type to always be undefined,
            // which made the win/loss switch fall to its default (is_win = false) every time.
            const { duration, duration_unit, symbol } = this.tradeOptions;

            let target_ticks = 0;
            if (duration_unit === 't') {
                target_ticks = duration;
            } else {
                const duration_seconds = duration * (duration_unit === 'm' ? 60 : 1);
                target_ticks = Math.ceil(duration_seconds);
            }

            // Prediction comes directly from the bot's Trade Definition block via tradeOptions.
            // The "set custom prediction" block writes to window.BinaryBotCustomPrediction —
            // read and immediately clear it so stale values don't leak into future trades.
            // No proposal lookup needed — virtual trades are fully self-contained.
            let resolved_prediction = this.tradeOptions.prediction;
            if (typeof window !== 'undefined' && window.BinaryBotCustomPrediction !== undefined) {
                resolved_prediction = Number(window.BinaryBotCustomPrediction);
                window.BinaryBotCustomPrediction = undefined;
            }

            console.log(
                `🤖 [VIRTUAL HOOK] Initiating trade: type=${contract_type}, prediction=${resolved_prediction}, duration=${target_ticks} ticks.`
            );

            // Sync stake from tradeOptions on every virtual purchase so the displayed
            // stake always matches what the user configured in the bot.
            // initial_stake is anchored on the very first trade (or after a win reset)
            // so martingale multiplications stay relative to the original stake.
            const configured_stake = Number(this.tradeOptions.amount) || 1;
            if (!this.vh_state.initial_stake || this.vh_state.initial_stake === 0) {
                this.vh_state.initial_stake = configured_stake;
            }
            if (!this.vh_state.current_stake || this.vh_state.current_stake === 0) {
                this.vh_state.current_stake = configured_stake;
            }

            this.vh_state.virtual_trade_active = true;
            this.vh_state.virtual_tick_count = 0;
            this.vh_state.virtual_target_duration = target_ticks;
            this.vh_state.virtual_contract_type = contract_type;
            this.vh_state.virtual_prediction = resolved_prediction;
            this.vh_state.virtual_entry_spot = 0;
            this.vh_state.entry_spot_captured = false;
            this.vh_state.last_tick_epoch = null;

            this.store.dispatch(purchaseSuccessful());
            this.store.dispatch(openContractReceived());

            this.vh_state.virtual_tick_subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'tick' && data.tick.symbol === symbol) {
                    this.processVirtualTick({
                        quote: data.tick.quote,
                        symbol: data.tick.symbol,
                        epoch: data.tick.epoch,
                    });
                }
            });
            api_base.pushSubscription(this.vh_state.virtual_tick_subscription);
            if (!api_base.api.sent_requests?.some(req => req.ticks === symbol)) {
                api_base.api.send({ ticks: symbol, subscribe: 1 });
            }

            return new Promise((resolve, reject) => {
                this.vh_state.virtual_resolve = resolve;
                this.vh_state.virtual_reject = reject;
                this.vh_state.virtual_timeout = setTimeout(() => {
                    if (this.vh_state.virtual_trade_active) {
                        console.error('🤖 [VIRTUAL HOOK] Virtual trade timed out (Incomplete Ticks).');
                        this.resetVirtualTrade();
                        reject(new Error('Virtual trade timed out'));
                    }
                }, 8000);
            });
        }

        processVirtualTick(tick_data) {
            if (!this.vh_state.virtual_trade_active) return;

            const { symbol } = this.tradeOptions;
            if (tick_data.symbol !== symbol) return;

            const tick_epoch = tick_data.epoch;
            if (tick_epoch && tick_epoch === this.vh_state.last_tick_epoch) return;
            this.vh_state.last_tick_epoch = tick_epoch;

            const { virtual_target_duration, virtual_contract_type } = this.vh_state;
            const isDigitTrade = !['CALL', 'PUT'].includes(virtual_contract_type);

            if (!this.vh_state.entry_spot_captured) {
                this.vh_state.virtual_entry_spot = tick_data.quote;
                this.vh_state.entry_spot_captured = true;

                console.log(
                    `🤖 [VIRTUAL HOOK] Entry spot captured: ${this.vh_state.virtual_entry_spot}. Waiting for ${virtual_target_duration} tick(s) to settle.`
                );

                if (isDigitTrade && virtual_target_duration === 1) {
                    this.settleVirtualTrade(tick_data);
                }
                return;
            }

            this.vh_state.virtual_tick_count++;
            const current_tick_count = this.vh_state.virtual_tick_count;

            // Digit contracts: entry spot IS the Nth tick itself (1-indexed).
            //   Duration 1 → settled on entry tick (handled above).
            //   Duration 2 → entry = tick 1, exit = tick 2 → 1 extra tick needed.
            //   Duration N → exit = tick N → (N-1) extra ticks needed.
            // CALL/PUT contracts: exit is N ticks AFTER the entry tick.
            //   Duration 1 → exit = tick 2 → 1 extra tick needed.
            //   Duration N → exit = tick (N+1) → N extra ticks needed.
            const settle_after = isDigitTrade ? virtual_target_duration - 1 : virtual_target_duration;

            console.log(`🤖 [VIRTUAL HOOK] Settlement progress: Tick ${current_tick_count}/${settle_after}`);

            if (current_tick_count >= settle_after) {
                this.settleVirtualTrade(tick_data);
            }
        }

        settleVirtualTrade(tick_data) {
            const raw_end_spot = tick_data.quote;
            const raw_entry_spot = this.vh_state.virtual_entry_spot;

            // Use pip_size to correctly format prices — JavaScript floats silently drop
            // trailing zeros (e.g. 1234.300 → 1234.3), so String().slice(-1) would read
            // the wrong digit. toFixed(pip_size) restores the full decimal representation.
            const pip_size = this.getPipSize() || 0;
            const end_spot_str = Number(raw_end_spot).toFixed(pip_size);
            const entry_spot_str = Number(raw_entry_spot).toFixed(pip_size);

            // Keep numeric versions for price comparison (CALL/PUT), string versions for
            // digit extraction and display.
            const end_spot = Number(end_spot_str);
            const entry_spot = Number(entry_spot_str);

            const trade_contract_type = this.vh_state.virtual_contract_type;
            const prediction_barrier = parseInt(this.vh_state.virtual_prediction, 10);

            // Extract last digit from the properly-formatted string so a trailing '0' is
            // never silently dropped (e.g. "1234.300" → last digit 0, not 3).
            const last_digit = Number(end_spot_str.slice(-1));
            let is_win;
            let result_details = '';

            switch (trade_contract_type) {
                case 'CALL':
                    is_win = end_spot > entry_spot;
                    result_details = `exit_spot (${end_spot}) > entry_spot (${entry_spot})`;
                    break;
                case 'PUT':
                    is_win = end_spot < entry_spot;
                    result_details = `exit_spot (${end_spot}) < entry_spot (${entry_spot})`;
                    break;
                case 'DIGITMATCH':
                    is_win = last_digit === prediction_barrier;
                    result_details = `exit_digit (${last_digit}) === barrier (${prediction_barrier})`;
                    break;
                case 'DIGITDIFF':
                    is_win = last_digit !== prediction_barrier;
                    result_details = `exit_digit (${last_digit}) !== barrier (${prediction_barrier})`;
                    break;
                case 'DIGITOVER':
                    is_win = last_digit > prediction_barrier;
                    result_details = `exit_digit (${last_digit}) > barrier (${prediction_barrier})`;
                    break;
                case 'DIGITUNDER':
                    is_win = last_digit < prediction_barrier;
                    result_details = `exit_digit (${last_digit}) < barrier (${prediction_barrier})`;
                    break;
                case 'DIGITODD':
                    is_win = last_digit % 2 !== 0;
                    result_details = `exit_digit (${last_digit}) is ODD`;
                    break;
                case 'DIGITEVEN':
                    is_win = last_digit % 2 === 0;
                    result_details = `exit_digit (${last_digit}) is EVEN`;
                    break;
                default:
                    is_win = false;
                    result_details = `UNKNOWN contract type: ${trade_contract_type}`;
                    break;
            }

            console.log(
                `🤖 [VIRTUAL HOOK] Virtual trade completed: ${
                    is_win ? 'WIN' : 'LOSS'
                }. Rationale: ${result_details}`
            );
            
            // Virtual trades no longer use proposals — calculate profit directly from stake.
            // Win:  net profit = ~95% of stake (you get back 1.95x, net gain is 0.95x)
            // Loss: net profit = -stake (you lose what you staked)
            // NOTE: The old code had `stake * 0.95 - stake = -0.05 * stake` for wins,
            // which is negative — causing updateVirtualTotals to count every win as a loss.
            const stake = this.vh_state.current_stake || this.tradeOptions.amount || 1;
            const simulated_contract = {
                ask_price: stake,
                payout: stake * 1.95,
                profit: is_win ? stake * 0.95 : -stake,
                status: 'sold',
                is_sold: true,
                // Store the formatted strings so the run log preserves trailing zeros
                // (e.g. 1234.300 is shown as "1234.300", not "1234.3").
                entry_spot: entry_spot_str,
                exit_spot: end_spot_str,
                is_virtual: true,
                contract_type: trade_contract_type,
                symbol: this.tradeOptions.symbol,
            };
            
            this.updateVirtualTotals(simulated_contract);
            this.store.dispatch(sell());
            
            setTimeout(() => {
                const resolve = this.vh_state.virtual_resolve;
                this.resetVirtualTrade();
                if (resolve) resolve();
            
                if (this.afterPromise) {
                    const currentAfterPromise = this.afterPromise;
                    this.afterPromise = null;
                    currentAfterPromise();
                }
            
                setTimeout(() => {
                    this.store.dispatch(start());
                }, 10);
            }, 0);
        }

        resetVirtualTrade() {
            if (this.vh_state.virtual_timeout) {
                clearTimeout(this.vh_state.virtual_timeout);
            }
            if (this.vh_state.virtual_tick_subscription) {
                this.vh_state.virtual_tick_subscription.unsubscribe();
            }
            this.vh_state.virtual_trade_active = false;
            this.vh_state.virtual_tick_count = 0;
            this.vh_state.virtual_resolve = null;
            this.vh_state.virtual_reject = null;
            this.vh_state.last_tick_epoch = null;
            this.vh_state.entry_spot_captured = false;
        }

        updateVirtualTotals(contract) {
            const win = contract.profit > 0;
            
            if (win) {
                this.vh_state.loss_count = 0;
                this.vh_state.current_stake = this.vh_state.initial_stake;
            } else {
                this.vh_state.loss_count++;
                if (this.vh_state.threshold > 0 && this.vh_state.loss_count >= this.vh_state.threshold) {
                    this.vh_state.is_virtual = false;
                    console.log('🤖 [VIRTUAL HOOK] THRESHOLD REACHED. Switching to REAL trades.');
                }
            }

            const now = Math.floor(Date.now() / 1000);
            const virtual_id = `virtual_${now}_${Math.random()}`;
            const virtual_contract = {
                ...contract,
                buy_price: Number(contract.ask_price),
                sell_price: contract.profit > 0 ? Number(contract.payout) : 0,
                profit: Number(contract.profit),
                transaction_ids: { buy: virtual_id },
                entry_tick: contract.entry_spot,
                exit_tick: contract.exit_spot,
                date_start: now,
                entry_tick_time: now,
                exit_tick_time: now + (this.vh_state.virtual_target_duration || 1),
                display_name: win ? localize('Virtual Win') : localize('Virtual Loss'),
                is_virtual: true,
                is_completed: true,
                underlying: this.tradeOptions.symbol,
                currency: this.tradeOptions.currency || 'USD',
                shortcode: `${contract.contract_type}_S0P_${this.tradeOptions.symbol.toUpperCase()}`,
            };

            globalObserver.emit('bot.contract', { ...virtual_contract, is_sold: true, is_virtual: true });
        }
        
        // ... (rest of the file remains the same)
        applyAlternateMarketsToCurrentTradeOptions() {
            try {
                // Highest priority: explicit force symbol set by active_symbol_changer
                const force_symbol = window?.DBot?.__force_symbol;
                if (force_symbol && force_symbol !== 'disable' && this.tradeOptions?.symbol !== force_symbol) {
                    this.tradeOptions = { ...this.tradeOptions, symbol: force_symbol };
                    return this.tradeOptions;
                }

                const settings = (window && window.DBot && window.DBot.__alt_markets) || {};
                const enabled = !!settings.enabled;
                const every = Number(settings.every || 0);
                if (!enabled || !every || !this.tradeOptions?.symbol) return this.tradeOptions;

                const next_run_index = (typeof this.getTotalRuns === 'function' ? this.getTotalRuns() : 0) + 1;
                if (next_run_index % every !== 0) return this.tradeOptions;

                const helper_instance = ApiHelpers?.instance;
                const list = helper_instance?.active_symbols?.getSymbolsForBot?.() || [];
                const cont = list.filter(s => (s?.group || '').startsWith('Continuous Indices'));
                if (!cont.length) return this.tradeOptions;

                const values = cont.map(s => s.value);
                const current = this.tradeOptions.symbol;
                const idx = Math.max(0, values.indexOf(current));
                const next_symbol = values[(idx + 1) % values.length];
                if (next_symbol && next_symbol !== current) {
                    this.tradeOptions = { ...this.tradeOptions, symbol: next_symbol };
                }
            } catch (e) {
                // noop
            }
            return this.tradeOptions;
        }
        async realPurchase(contract_type) {
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const originalAccountInfo = { ...this.accountInfo };

            const currentLoginId =
                api_base.account_info?.loginid || this.accountInfo?.loginid || localStorage.getItem('active_loginid');
            const showAsCR = localStorage.getItem('show_as_cr');

            console.log('💰 [PURCHASE] ========== STARTING PURCHASE ==========');
            console.log('💰 [PURCHASE] Current API account:', currentLoginId);
            console.log('💰 [PURCHASE] Show as CR:', showAsCR);
            console.log('💰 [PURCHASE] Current API balance:', api_base.account_info?.balance);

            const displayedAccount = showAsCR || currentLoginId;
            const isSpecialCR = displayedAccount && isSpecialCRAccount(displayedAccount);
            const shouldUseDemo = isSpecialCR;

            console.log('💰 [PURCHASE] Displayed account:', displayedAccount);
            console.log('💰 [PURCHASE] Is special CR:', isSpecialCR);
            console.log('💰 [PURCHASE] Should use demo:', shouldUseDemo);

            if (shouldUseDemo) {
                console.log('✅ [PURCHASE] Special CR account - API should already be on demo account');
                console.log('✅ [PURCHASE] Current API account:', api_base.account_info?.loginid);
                console.log('✅ [PURCHASE] Current API balance:', api_base.account_info?.balance);

                if (api_base.account_info?.loginid && !api_base.account_info.loginid.startsWith('VRTC')) {
                    console.warn(
                        '⚠️ [PURCHASE] Not on demo account! API should have auto-switched. Current:',
                        api_base.account_info.loginid
                    );
                }
            } else {
                if (
                    api_base.account_info &&
                    (!this.accountInfo || this.accountInfo.loginid !== api_base.account_info.loginid)
                ) {
                    this.accountInfo = { ...api_base.account_info, loginid: api_base.account_info.loginid };
                    console.log('✅ [PURCHASE] Normal account - set accountInfo to:', this.accountInfo.loginid);
                }
            }

            console.log('💰 [PURCHASE] Final API account:', api_base.account_info?.loginid);
            console.log('💰 [PURCHASE] Final API balance:', api_base.account_info?.balance);
            console.log('💰 [PURCHASE] ============================================');

            if (shouldUseDemo && displayedAccount) {
                const demoAccountId = getDemoAccountIdForSpecialCR(displayedAccount);
                if (!demoAccountId) {
                    console.error(
                        '❌ [PURCHASE] Special CR account but no demo account ID found for:',
                        displayedAccount
                    );
                    throw new Error('Demo account ID not configured for special CR account');
                }

                const accountsList = JSON.parse(localStorage.getItem('accountsList') || '{}');
                const demoToken = accountsList[demoAccountId];
                const demoLoginId = demoAccountId;

                const isOnDemoAccount =
                    api_base.account_info?.loginid === demoLoginId ||
                    (api_base.account_info?.loginid && api_base.account_info.loginid.startsWith('VRTC'));

                // DISABLED - replaced by DerivAuth.js
                // if (!isOnDemoAccount && demoToken && api_base.api) {
                //     console.warn('⚠️ [PURCHASE] API not on demo account! Current:', api_base.account_info?.loginid);
                //     console.warn('⚠️ [PURCHASE] Re-authorizing with demo token synchronously...');

                //     try {
                //         const { authorize, error } = await api_base.api.authorize(demoToken);
                //         if (error) {
                //             console.error('❌ [PURCHASE] Failed to re-authorize with demo token:', error);
                //             throw new Error('Failed to switch to demo account for trade');
                //         } else if (authorize) {
                //             api_base.account_info = { ...authorize, loginid: demoLoginId };
                //             api_base.token = demoToken;
                //             api_base.account_id = demoLoginId;
                //             this.accountInfo = { ...authorize, loginid: demoLoginId };

                //             console.log('✅ [PURCHASE] Re-authorized with demo account:', demoLoginId);
                //             console.log('✅ [PURCHASE] Demo account balance:', authorize?.balance);
                //         }
                //     } catch (authError) {
                //         console.error('❌ [PURCHASE] Error re-authorizing:', authError);
                //         throw authError;
                //     }
                // } else if (isOnDemoAccount) {
                    console.log('✅ [PURCHASE] API already on demo account:', api_base.account_info?.loginid);
                    if (api_base.account_info && !this.accountInfo) {
                        this.accountInfo = { ...api_base.account_info, loginid: api_base.account_info.loginid };
                    }
                }
            }

            const onSuccess = response => {
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.vh_state.enabled && !this.vh_state.is_virtual) {
                    console.log('🤖 [VIRTUAL HOOK] Real trade started.');
                }

                const currentApiAccount = api_base.account_info?.loginid || this.accountInfo?.loginid;
                console.log('[Purchase] 📨 Subscribing to contract updates for:', buy.contract_id);
                console.log('[Purchase] 📨 Current API account:', currentApiAccount);
                console.log('[Purchase] 📨 Contract ID:', buy.contract_id);
                console.log('[Purchase] 📨 Transaction ID:', buy.transaction_id);

                let subscriptionPromise = null;

                try {
                    subscriptionPromise = doUntilDone(() => {
                        console.log('[Purchase] 📡 Sending contract subscription request...');
                        return api_base.api.send({ proposal_open_contract: 1, contract_id: buy.contract_id });
                    }, ['PriceMoved']);
                } catch (err) {
                    console.error('[Purchase] ❌ Error setting up contract subscription:', err);
                }

                if (this.vh_state.enabled && !this.vh_state.is_virtual) {
                    const originalAfterPromise = this.afterPromise;
                    this.afterPromise = () => {
                        const contract = this.data.contract;
                        const win = contract.profit > 0;
                        console.log(`🤖 [VIRTUAL HOOK] REAL trade result: ${win ? 'WIN' : 'LOSS'}`);

                        this.vh_state.real_trade_count = (this.vh_state.real_trade_count || 0) + 1;
                        const minReal = this.vh_state.minTradesOnReal || 1;

                        if (win) {
                            console.log(`🤖 [VIRTUAL HOOK] REAL WIN. Going back to VIRTUAL mode.`);
                            this.vh_state.is_virtual = true;
                            this.vh_state.loss_count = 0;
                            this.vh_state.step_count = 0;
                            this.vh_state.current_stake = this.vh_state.initial_stake;
                        } else {
                            console.log('🤖 [VIRTUAL HOOK] REAL LOSS. Staying in REAL mode until win.');
                        }
                        if (originalAfterPromise) originalAfterPromise();
                    };
                }

                if (subscriptionPromise) {
                    Promise.all([
                        subscriptionPromise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Subscription timeout')), 5000)),
                    ])
                        .then(() => {
                            console.log('[Purchase] ✅ Contract subscription successful');
                        })
                        .catch(err => {
                            console.error('[Purchase] ❌ Contract subscription failed:', err);
                            setTimeout(() => {
                                try {
                                    console.log('[Purchase] 🔄 Retrying contract subscription...');
                                    api_base.api.send({ proposal_open_contract: 1, contract_id: buy.contract_id });
                                    console.log('[Purchase] ✅ Contract subscription sent (final attempt)');
                                } catch (finalErr) {
                                    console.error('[Purchase] ❌ Final subscription attempt failed:', finalErr);
                                }
                            }, 500);
                        });
                }

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });

                const accountIdForInfo = api_base.account_info?.loginid || this.accountInfo?.loginid;
                console.log('[Purchase] 📢 Emitting info() with accountID:', accountIdForInfo);
                console.log('[Purchase] 📢 Is special CR:', shouldUseDemo);
                console.log('[Purchase] 📢 Contract ID:', buy.contract_id);
                console.log('[Purchase] 📢 Transaction ID:', buy.transaction_id);
                console.log('[Purchase] 📢 Buy price:', buy.buy_price);
                console.log('[Purchase] 📢 Balance after purchase:', api_base.account_info?.balance);

                info({
                    accountID: accountIdForInfo,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                    contract_id: buy.contract_id,
                });
            };

            if (this.is_proposal_subscription_required) {
                this.applyAlternateMarketsToCurrentTradeOptions();
                try {
                    this.makeProposals({ ...this.options, ...this.tradeOptions });
                    this.checkProposalReady && this.checkProposalReady();
                } catch {}

                const { id, askPrice } = this.selectProposal(contract_type);

                try {
                    globalObserver.emit('replicator.purchase', {
                        mode: 'proposal_id',
                        request: { buy: id, price: askPrice },
                        tradeOptions: this.tradeOptions,
                        contract_type,
                        account_id: this.accountInfo?.loginid,
                    });
                } catch {}

                const action = () => {
                    console.log('💸 [PURCHASE] Sending buy request:');
                    console.log('   - Proposal ID:', id);
                    console.log('   - Price:', askPrice);
                    console.log('   - Account:', api_base.account_info?.loginid);
                    return api_base.api.send({ buy: id, price: askPrice });
                };

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            this.applyAlternateMarketsToCurrentTradeOptions();

            try {
                const dbot = window?.DBot;
                if (dbot?.interpreter?.bot?.tradeEngine) {
                    const interpreter = dbot.interpreter;

                    let stakeValue = null;

                    try {
                        const globalScope =
                            interpreter.global ||
                            (interpreter.stateStack &&
                                interpreter.stateStack[0] &&
                                (interpreter.stateStack[0].scope?.object || interpreter.stateStack[0].scope));
                        if (globalScope) {
                            const stakeVar = globalScope.Stake;
                            if (stakeVar !== undefined && stakeVar !== null) {
                                stakeValue = interpreter.pseudoToNative
                                    ? interpreter.pseudoToNative(stakeVar)
                                    : stakeVar;
                            }
                        }
                    } catch (e1) {
                        try {
                            const tempCode = 'Stake';
                            const result = interpreter.evaluate ? interpreter.evaluate(tempCode) : null;
                            if (result !== null && result !== undefined) {
                                stakeValue = interpreter.pseudoToNative ? interpreter.pseudoToNative(result) : result;
                            }
                        } catch (e2) {
                            try {
                                const stakeProp = interpreter.getProperty
                                    ? interpreter.getProperty(interpreter.global, 'Stake')
                                    : null;
                                if (stakeProp !== null && stakeProp !== undefined) {
                                    stakeValue = interpreter.pseudoToNative
                                        ? interpreter.pseudoToNative(stakeProp)
                                        : stakeProp;
                                }
                            } catch (e3) {
                                console.warn('[Martingale Fix] Could not read Stake variable:', e3);
                            }
                        }
                    }

                    if (stakeValue !== null && typeof stakeValue === 'number' && stakeValue > 0 && !isNaN(stakeValue)) {
                        const currency = this.tradeOptions.currency || 'USD';
                        const decimalPlaces = getDecimalPlaces(currency);
                        this.tradeOptions.amount = Number(stakeValue.toFixed(decimalPlaces));
                        console.log(
                            `[Martingale Fix] Updated tradeOptions.amount to ${this.tradeOptions.amount} from Stake variable (original: ${stakeValue})`
                        );
                    }
                }
            } catch (e) {
                console.warn('[Martingale Fix] Error updating tradeOptions.amount from Stake variable:', e);
            }

            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);

            try {
                globalObserver.emit('replicator.purchase', {
                    mode: 'parameters',
                    request: trade_option,
                    tradeOptions: this.tradeOptions,
                    contract_type,
                    account_id: shouldUseDemo ? 'VRTC10109979' : this.accountInfo?.loginid,
                });
            } catch {}

            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }

        shouldUseDemoAccountForTrade() {
            const currentLoginId = this.accountInfo?.loginid;

            const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
            if (showAsCR && isSpecialCRAccount(showAsCR)) {
                console.log('[Purchase] 🎯 Special CR account detected via show_as_cr:', showAsCR);
                return true;
            }

            if (!currentLoginId) return false;

            if (isSpecialCRAccount(currentLoginId)) {
                return true;
            }

            const adminMirrorModeEnabled =
                typeof window !== 'undefined' && localStorage.getItem('adminMirrorModeEnabled') === 'true';

            if (!adminMirrorModeEnabled) return false;

            const swapState = getBalanceSwapState();
            if (!swapState?.isMirrorMode) return false;

            return currentLoginId === swapState.realAccount.loginId;
        }

        // DISABLED - replaced by DerivAuth.js
        // async switchToDemoAccountForTrade(demoToken, demoLoginId) {
        //     if (!api_base.api || !demoToken || !demoLoginId) {
        //         console.error('[Special CR Account] Missing required parameters for account switch');
        //         return false;
        //     }

        //     try {
        //         console.log(
        //             `[Special CR Account] Switching from ${this.accountInfo?.loginid} to demo account ${demoLoginId} for trade execution`
        //         );

        //         const { authorize, error } = await api_base.api.authorize(demoToken);
        //         if (error) {
        //             console.error('[Special CR Account] Failed to authorize with demo account:', error);
        //             return false;
        //         }

        //         if (authorize) {
        //             this.accountInfo = { ...authorize, loginid: demoLoginId };
        //             api_base.account_info = { ...authorize, loginid: demoLoginId };
        //             api_base.token = demoToken;
        //             api_base.account_id = demoLoginId;

        //             console.log(`[Special CR Account] Successfully switched to demo account ${demoLoginId}`);
        //             console.log(`[Special CR Account] Demo account balance: ${authorize.balance || 'N/A'}`);
        //             return true;
        //         } else {
        //             console.error('[Special CR Account] Authorization returned no data');
        //             return false;
        //         }
        //     } catch (error) {
        //         console.error('[Special CR Account] Error switching to demo account:', error);
        //         return false;
        //     }
        // }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
