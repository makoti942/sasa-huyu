import { localize } from '@deriv-com/translations';
import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import ApiHelpers from '../../api/api-helpers';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful, sell } from './state/actions';
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
            console.log('🤖 [VIRTUAL HOOK] Executing realistic virtual trade simulation.');
            
            let proposal;
            let retries = 0;
            const maxRetries = 10; // 5 seconds total wait

            while (retries < maxRetries) {
                try {
                    const { id } = this.selectProposal(contract_type);
                    proposal = this.data.proposals.find(p => p.id === id);
                    if (proposal) break;
                } catch (e) {
                    if (e.message === localize('Proposals are not ready') || e.message === 'Proposals are not ready') {
                        console.log(`⏳ [VIRTUAL HOOK] Proposals not ready, retrying... (${retries + 1}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        retries++;
                        continue;
                    }
                    console.error('🤖 [VIRTUAL HOOK] Error selecting proposal:', e.message);
                    throw new Error(`Virtual trade failed: ${e.message}. Please ensure your strategy blocks are correctly configured.`);
                }
                retries++;
            }

            if (!proposal) {
                throw new Error('Virtual trade failed: Proposals timed out. Please check your internet connection or strategy configuration.');
            }

            this.store.dispatch(purchaseSuccessful());

            const {
                duration,
                duration_unit,
                contract_type: trade_contract_type,
                symbol,
                prediction,
            } = this.tradeOptions;

            const entry_spot = proposal.spot;

            const onContractEnd = end_spot => {
                let is_win;
                const last_digit = Number(String(end_spot).slice(-1));

                switch (trade_contract_type) {
                    case 'CALL':
                        is_win = end_spot > entry_spot;
                        break;
                    case 'PUT':
                        is_win = end_spot < entry_spot;
                        break;
                    case 'DIGITMATCH':
                        is_win = last_digit === prediction;
                        break;
                    case 'DIGITDIFF':
                        is_win = last_digit !== prediction;
                        break;
                    case 'DIGITOVER':
                        is_win = last_digit > prediction;
                        break;
                    case 'DIGITUNDER':
                        is_win = last_digit < prediction;
                        break;
                    case 'DIGITODD':
                        is_win = last_digit % 2 !== 0;
                        break;
                    case 'DIGITEVEN':
                        is_win = last_digit % 2 === 0;
                        break;
                    default:
                        console.log(`[VIRTUAL HOOK] Using random simulation for ${trade_contract_type}.`);
                        is_win = Math.random() > 0.5;
                        break;
                }

                const simulated_contract = {
                    ...proposal,
                    profit: is_win ? Number(proposal.payout) - Number(proposal.ask_price) : -Number(proposal.ask_price),
                    status: 'sold',
                    entry_spot,
                    exit_spot: end_spot,
                    is_virtual: true,
                };

                this.updateVirtualTotals(simulated_contract);
            };

            if (duration_unit === 't') {
                let tick_count = 0;
                const tick_subscriber = api_base.api.onMessage().subscribe(({ data }) => {
                    if (data.msg_type === 'tick' && data.tick.symbol === symbol) {
                        tick_count++;
                        if (tick_count >= duration) {
                            tick_subscriber.unsubscribe();
                            onContractEnd(data.tick.quote);
                        }
                    }
                });
                api_base.pushSubscription(tick_subscriber);
                api_base.api.send({ ticks: symbol, subscribe: 1 });
            } else {
                let duration_ms = duration * 1000;
                if (duration_unit === 'm') {
                    duration_ms *= 60;
                }

                setTimeout(() => {
                    const tick_subscriber = api_base.api.onMessage().subscribe(({ data }) => {
                        if (data.msg_type === 'tick' && data.tick.symbol === symbol) {
                            tick_subscriber.unsubscribe();
                            onContractEnd(data.tick.quote);
                        }
                    });
                    api_base.pushSubscription(tick_subscriber);
                    api_base.api.send({ ticks: symbol, subscribe: 1 });
                }, duration_ms);
            }

            return Promise.resolve();
        }

        updateVirtualTotals(contract) {
            const win = contract.profit > 0;
            console.log(`🤖 [VIRTUAL HOOK] Virtual trade result: ${win ? 'WIN' : 'LOSS'}`);

            if (!win) {
                this.vh_state.loss_count++;
                console.log(`🤖 [VIRTUAL HOOK] Virtual loss count: ${this.vh_state.loss_count}/${this.vh_state.threshold}`);
                if (this.vh_state.loss_count >= this.vh_state.threshold) {
                    this.vh_state.is_virtual = false;
                    console.log('🤖 [VIRTUAL HOOK] THRESHOLD REACHED. Switching to REAL trades.');
                }
            } else {
                this.vh_state.loss_count = 0;
                console.log('🤖 [VIRTUAL HOOK] Virtual win. Staying in virtual mode.');
            }

            const virtual_contract = {
                ...contract,
                buy_price: contract.ask_price,
                sell_price: contract.profit > 0 ? contract.payout : 0,
                transaction_ids: { buy: 'VIRTUAL', sell: 'VIRTUAL' },
                entry_tick: contract.entry_spot,
                exit_tick: contract.exit_spot,
                entry_tick_time: Math.floor(Date.now() / 1000) - 1,
                exit_tick_time: Math.floor(Date.now() / 1000),
                display_name: win ? localize('Virtual Win') : localize('Virtual Loss'),
                is_virtual: true,
            };

            // Update internal statistics so martingale logic can see the virtual results
            this.updateTotals(virtual_contract);

            // Emit events to update the UI (Trade Summary, Transactions, etc.)
            globalObserver.emit('bot.contract', {
                ...virtual_contract,
                is_sold: true,
            });

            info({
                profit: contract.profit,
                contract: virtual_contract,
                accountID: 'VIRTUAL',
                is_virtual: true,
            });

            this.store.dispatch(sell());

            this.renewProposalsOnPurchase();

            const unsubscribe = this.store.subscribe(() => {
                const proposalsReady = this.store.getState().proposalsReady;
                if (proposalsReady) {
                    unsubscribe();
                    if (this.afterPromise) {
                        this.afterPromise();
                    }
                }
            });
        }

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

            const currentLoginId = api_base.account_info?.loginid || this.accountInfo?.loginid || localStorage.getItem('active_loginid');
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
                    console.warn('⚠️ [PURCHASE] Not on demo account! API should have auto-switched. Current:', api_base.account_info.loginid);
                }
            } else {
                if (api_base.account_info && (!this.accountInfo || this.accountInfo.loginid !== api_base.account_info.loginid)) {
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
                    console.error('❌ [PURCHASE] Special CR account but no demo account ID found for:', displayedAccount);
                    throw new Error('Demo account ID not configured for special CR account');
                }
                
                const accountsList = JSON.parse(localStorage.getItem('accountsList') || '{}');
                const demoToken = accountsList[demoAccountId];
                const demoLoginId = demoAccountId;
                
                const isOnDemoAccount = api_base.account_info?.loginid === demoLoginId || 
                                       (api_base.account_info?.loginid && api_base.account_info.loginid.startsWith('VRTC'));
                
                if (!isOnDemoAccount && demoToken && api_base.api) {
                    console.warn('⚠️ [PURCHASE] API not on demo account! Current:', api_base.account_info?.loginid);
                    console.warn('⚠️ [PURCHASE] Re-authorizing with demo token synchronously...');
                    
                    try {
                        const { authorize, error } = await api_base.api.authorize(demoToken);
                        if (error) {
                            console.error('❌ [PURCHASE] Failed to re-authorize with demo token:', error);
                            throw new Error('Failed to switch to demo account for trade');
                        } else if (authorize) {
                            api_base.account_info = { ...authorize, loginid: demoLoginId };
                            api_base.token = demoToken;
                            api_base.account_id = demoLoginId;
                            this.accountInfo = { ...authorize, loginid: demoLoginId };
                            
                            console.log('✅ [PURCHASE] Re-authorized with demo account:', demoLoginId);
                            console.log('✅ [PURCHASE] Demo account balance:', authorize?.balance);
                        }
                    } catch (authError) {
                        console.error('❌ [PURCHASE] Error re-authorizing:', authError);
                        throw authError;
                    }
                } else if (isOnDemoAccount) {
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
                        if (win) {
                            console.log('🤖 [VIRTUAL HOOK] REAL WIN. Going back to VIRTUAL mode.');
                            this.vh_state.is_virtual = true;
                            this.vh_state.loss_count = 0;
                        } else {
                            console.log('🤖 [VIRTUAL HOOK] REAL LOSS. Staying in REAL mode until win.');
                        }
                        if (originalAfterPromise) originalAfterPromise();
                    };
                }

                if (subscriptionPromise) {
                    Promise.all([
                        subscriptionPromise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Subscription timeout')), 5000))
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
                        const globalScope = interpreter.global || (interpreter.stateStack && interpreter.stateStack[0] && (interpreter.stateStack[0].scope?.object || interpreter.stateStack[0].scope));
                        if (globalScope) {
                            const stakeVar = globalScope.Stake;
                            if (stakeVar !== undefined && stakeVar !== null) {
                                stakeValue = interpreter.pseudoToNative ? interpreter.pseudoToNative(stakeVar) : stakeVar;
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
                                const stakeProp = interpreter.getProperty ? interpreter.getProperty(interpreter.global, 'Stake') : null;
                                if (stakeProp !== null && stakeProp !== undefined) {
                                    stakeValue = interpreter.pseudoToNative ? interpreter.pseudoToNative(stakeProp) : stakeProp;
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
                        console.log(`[Martingale Fix] Updated tradeOptions.amount to ${this.tradeOptions.amount} from Stake variable (original: ${stakeValue})`);
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

        async switchToDemoAccountForTrade(demoToken, demoLoginId) {
            if (!api_base.api || !demoToken || !demoLoginId) {
                console.error('[Special CR Account] Missing required parameters for account switch');
                return false;
            }

            try {
                console.log(`[Special CR Account] Switching from ${this.accountInfo?.loginid} to demo account ${demoLoginId} for trade execution`);
                
                const { authorize, error } = await api_base.api.authorize(demoToken);
                if (error) {
                    console.error('[Special CR Account] Failed to authorize with demo account:', error);
                    return false;
                }

                if (authorize) {
                    this.accountInfo = { ...authorize, loginid: demoLoginId };
                    api_base.account_info = { ...authorize, loginid: demoLoginId };
                    api_base.token = demoToken;
                    api_base.account_id = demoLoginId;
                    
                    console.log(`[Special CR Account] Successfully switched to demo account ${demoLoginId}`);
                    console.log(`[Special CR Account] Demo account balance: ${authorize.balance || 'N/A'}`);
                    return true;
                } else {
                    console.error('[Special CR Account] Authorization returned no data');
                    return false;
                }
            } catch (error) {
                console.error('[Special CR Account] Error switching to demo account:', error);
                return false;
            }
        }

        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
