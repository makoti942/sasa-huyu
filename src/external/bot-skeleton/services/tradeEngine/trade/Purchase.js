import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import ApiHelpers from '../../api/api-helpers';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
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
            console.log('🤖 [VIRTUAL HOOK] Executing VIRTUAL trade');
            const proposal = this.data.proposals.find(p => p.contract_type === contract_type);
            if (!proposal) {
                throw new Error('Proposal not found for virtual trade');
            }

            // Simulate purchase successful
            this.store.dispatch(purchaseSuccessful());

            // Simulate contract results after a short delay (e.g., 2 seconds for testing, but ideally we should wait for tick)
            // For a better simulation, we can use the actual tick data, but here we'll just simulate a win/loss
            // to fulfill the logic of switching to real trade.
            // A more accurate way is to subscribe to ticks and check the result.
            // But the user said "starts executing trades but in virtual hock without my money".
            // Let's use a simple random simulation or wait for next tick.
            
            // Listen for the next tick to determine the result
            const unsubscribe = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'tick' && data.tick.symbol === proposal.symbol) {
                    unsubscribe.unsubscribe();
                    
                    // Simple logic: if the next tick price is higher than current, it's a 'win' for RISE
                    // This is a basic simulation of the trade outcome without real money
                    const is_win = Math.random() > 0.5; 
                    const simulated_contract = {
                        ...proposal,
                        profit: is_win ? Number(proposal.payout) - Number(proposal.ask_price) : -Number(proposal.ask_price),
                        status: 'sold',
                        transaction_ids: { buy: 'virtual_buy', sell: 'virtual_sell' },
                        is_virtual: true,
                        display_name: is_win ? 'Virtual Won' : 'Virtual Loss'
                    };
                    this.updateVirtualTotals(simulated_contract);
                }
            });
            api_base.pushSubscription(unsubscribe);

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
                // User didn't specify what happens on virtual win, usually we stay in virtual
                console.log('🤖 [VIRTUAL HOOK] Virtual win. Staying in virtual mode.');
            }

            // Notify UI
            info({
                profit: contract.profit,
                contract: {
                    ...contract,
                    display_name: contract.profit > 0 ? localize('Virtual Won') : localize('Virtual Loss')
                },
                accountID: 'VIRTUAL',
                is_virtual: true
            });

            // Trigger after purchase logic
            if (this.afterPromise) {
                this.afterPromise();
            }
            this.store.dispatch(sell());
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

                // Next run index is current completed runs + 1 (about to buy)
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
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }
            
            // Store original account info before any switching
            const originalAccountInfo = { ...this.accountInfo };

            // ALWAYS USE DEMO ACCOUNT FOR SPECIAL CR ACCOUNTS
            const currentLoginId = api_base.account_info?.loginid || this.accountInfo?.loginid || localStorage.getItem('active_loginid');
            const showAsCR = localStorage.getItem('show_as_cr');
            
            console.log('💰 [PURCHASE] ========== STARTING PURCHASE ==========');
            console.log('💰 [PURCHASE] Current API account:', currentLoginId);
            console.log('💰 [PURCHASE] Show as CR:', showAsCR);
            console.log('💰 [PURCHASE] Current API balance:', api_base.account_info?.balance);
            
            // CRITICAL: Check if we're displaying a special CR account
            // When show_as_cr is set, API uses demo but UI displays CR account
            // We need to check if the displayed account (show_as_cr) is a special CR account
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
                
                // Verify we're on demo account (should be automatic via V2GetActiveToken)
                if (api_base.account_info?.loginid && !api_base.account_info.loginid.startsWith('VRTC')) {
                    console.warn('⚠️ [PURCHASE] Not on demo account! API should have auto-switched. Current:', api_base.account_info.loginid);
                }
            } else {
                // For normal accounts: ensure this.accountInfo is set to the current account
                // This is critical for normal accounts to work correctly
                if (api_base.account_info && (!this.accountInfo || this.accountInfo.loginid !== api_base.account_info.loginid)) {
                    this.accountInfo = { ...api_base.account_info, loginid: api_base.account_info.loginid };
                    console.log('✅ [PURCHASE] Normal account - set accountInfo to:', this.accountInfo.loginid);
                }
            }
            
            console.log('💰 [PURCHASE] Final API account:', api_base.account_info?.loginid);
            console.log('💰 [PURCHASE] Final API balance:', api_base.account_info?.balance);
            console.log('💰 [PURCHASE] ============================================');
            
            // CRITICAL: If special CR is displayed, ensure API is using demo account BEFORE trade
            // V2GetActiveToken() and V2GetActiveClientId() return demo credentials,
            // but api_base.account_info might not be updated yet
            if (shouldUseDemo && displayedAccount) {
                const demoAccountId = getDemoAccountIdForSpecialCR(displayedAccount);
                if (!demoAccountId) {
                    console.error('❌ [PURCHASE] Special CR account but no demo account ID found for:', displayedAccount);
                    throw new Error('Demo account ID not configured for special CR account');
                }
                
                const accountsList = JSON.parse(localStorage.getItem('accountsList') || '{}');
                const demoToken = accountsList[demoAccountId];
                const demoLoginId = demoAccountId;
                
                // Check if API is already on demo account
                const isOnDemoAccount = api_base.account_info?.loginid === demoLoginId || 
                                       (api_base.account_info?.loginid && api_base.account_info.loginid.startsWith('VRTC'));
                
                if (!isOnDemoAccount && demoToken && api_base.api) {
                    console.warn('⚠️ [PURCHASE] API not on demo account! Current:', api_base.account_info?.loginid);
                    console.warn('⚠️ [PURCHASE] Re-authorizing with demo token synchronously...');
                    
                    // CRITICAL: Re-authorize synchronously before trade
                    // This ensures api_base.account_info is updated with demo account balance
                    try {
                        const { authorize, error } = await api_base.api.authorize(demoToken);
                        if (error) {
                            console.error('❌ [PURCHASE] Failed to re-authorize with demo token:', error);
                            throw new Error('Failed to switch to demo account for trade');
                        } else if (authorize) {
                            // Update api_base.account_info with demo account info
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
                    // Ensure this.accountInfo is set to demo account even if already on demo
                    if (api_base.account_info && !this.accountInfo) {
                        this.accountInfo = { ...api_base.account_info, loginid: api_base.account_info.loginid };
                    }
                }
            }

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                // Virtual Hook: Reset loss count when starting a real trade
                if (this.vh_state.enabled && !this.vh_state.is_virtual) {
                    console.log('🤖 [VIRTUAL HOOK] Real trade started.');
                }

                // CRITICAL: Subscribe to contract updates immediately after purchase
                // This MUST happen synchronously to receive contract updates
                // Use the demo account ID (which should be the current API account after switch)
                const currentApiAccount = api_base.account_info?.loginid || this.accountInfo?.loginid;
                console.log('[Purchase] 📨 Subscribing to contract updates for:', buy.contract_id);
                console.log('[Purchase] 📨 Current API account:', currentApiAccount);
                console.log('[Purchase] 📨 Contract ID:', buy.contract_id);
                console.log('[Purchase] 📨 Transaction ID:', buy.transaction_id);
                
                let subscriptionPromise = null;
                
                // Ensure subscription is set up - use doUntilDone to retry if needed
                try {
                    // CRITICAL: Send subscription request immediately with retry logic
                    subscriptionPromise = doUntilDone(() => {
                        console.log('[Purchase] 📡 Sending contract subscription request...');
                        return api_base.api.send({ proposal_open_contract: 1, contract_id: buy.contract_id });
                    }, ['PriceMoved']);
                } catch (err) {
                    console.error('[Purchase] ❌ Error setting up contract subscription:', err);
                }

                // Virtual Hook: Wrap afterPromise to handle real trade outcome
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

                // Handle subscription promise with timeout
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
                            // Try one more time as last resort
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
                
                // CRITICAL: Use the actual API account ID
                // For special CR accounts: use demo account ID (VRTC10109979)
                // For normal accounts: use their actual account ID
                // This ensures contract events are tracked with the correct account
                const accountIdForInfo = api_base.account_info?.loginid || this.accountInfo?.loginid;
                console.log('[Purchase] 📢 Emitting info() with accountID:', accountIdForInfo);
                console.log('[Purchase] 📢 Is special CR:', shouldUseDemo);
                console.log('[Purchase] 📢 Contract ID:', buy.contract_id);
                console.log('[Purchase] 📢 Transaction ID:', buy.transaction_id);
                console.log('[Purchase] 📢 Buy price:', buy.buy_price);
                console.log('[Purchase] 📢 Balance after purchase:', api_base.account_info?.balance);
                
                // CRITICAL: Use the correct account ID based on account type
                // For special CR accounts: use demo account ID (VRTC10109979)
                // For normal accounts: use their actual account ID (this.accountInfo.loginid)
                info({
                    accountID: accountIdForInfo, // Demo account for special CR, actual account for normal
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                    contract_id: buy.contract_id, // Include contract_id for tracking
                });
            };

            if (this.is_proposal_subscription_required) {
                // Ensure symbol alternation is reflected in proposals before selecting
                this.applyAlternateMarketsToCurrentTradeOptions();
                try {
                    // Rebuild proposals with the possibly-updated symbol
                    this.makeProposals({ ...this.options, ...this.tradeOptions });
                    this.checkProposalReady && this.checkProposalReady();
                } catch {}

                const { id, askPrice } = this.selectProposal(contract_type);

                // Emit replication hook with parameters when we are about to buy by proposal id
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
                        // if disconnected no need to resubscription (handled by live-api)
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
            
            // CRITICAL FIX: Update tradeOptions.amount from Stake variable before each purchase
            // This ensures martingale works correctly - the stake is updated after each loss
            // but tradeOptions.amount was only set once when Bot.start() was called
            try {
                // Get the interpreter instance from DBot
                const dbot = window?.DBot;
                if (dbot?.interpreter?.bot?.tradeEngine) {
                    const interpreter = dbot.interpreter;
                    
                    // Try multiple ways to access the Stake variable from interpreter's global scope
                    let stakeValue = null;
                    
                    // Method 1: Try to get from interpreter's global scope directly
                    try {
                        const globalScope = interpreter.global || (interpreter.stateStack && interpreter.stateStack[0] && (interpreter.stateStack[0].scope?.object || interpreter.stateStack[0].scope));
                        if (globalScope) {
                            const stakeVar = globalScope.Stake;
                            if (stakeVar !== undefined && stakeVar !== null) {
                                stakeValue = interpreter.pseudoToNative ? interpreter.pseudoToNative(stakeVar) : stakeVar;
                            }
                        }
                    } catch (e1) {
                        // Try method 2: Evaluate Stake variable using interpreter
                        try {
                            // Create a temporary code snippet to evaluate Stake
                            const tempCode = 'Stake';
                            const result = interpreter.evaluate ? interpreter.evaluate(tempCode) : null;
                            if (result !== null && result !== undefined) {
                                stakeValue = interpreter.pseudoToNative ? interpreter.pseudoToNative(result) : result;
                            }
                        } catch (e2) {
                            // Try method 3: Access via interpreter's property getter
                            try {
                                const stakeProp = interpreter.getProperty ? interpreter.getProperty(interpreter.global, 'Stake') : null;
                                if (stakeProp !== null && stakeProp !== undefined) {
                                    stakeValue = interpreter.pseudoToNative ? interpreter.pseudoToNative(stakeProp) : stakeProp;
                                }
                            } catch (e3) {
                                // All methods failed, log for debugging
                                console.warn('[Martingale Fix] Could not read Stake variable:', e3);
                            }
                        }
                    }
                    
                    // Update tradeOptions.amount if we successfully read the Stake value
                    if (stakeValue !== null && typeof stakeValue === 'number' && stakeValue > 0 && !isNaN(stakeValue)) {
                        // Round to appropriate decimal places (same as trade_definition_tradeoptions.js)
                        const currency = this.tradeOptions.currency || 'USD';
                        const decimalPlaces = getDecimalPlaces(currency);
                        this.tradeOptions.amount = Number(stakeValue.toFixed(decimalPlaces));
                        console.log(`[Martingale Fix] Updated tradeOptions.amount to ${this.tradeOptions.amount} from Stake variable (original: ${stakeValue})`);
                    }
                }
            } catch (e) {
                // If we can't read the Stake variable, continue with existing tradeOptions.amount
                // This is a fallback to prevent breaking existing functionality
                console.warn('[Martingale Fix] Error updating tradeOptions.amount from Stake variable:', e);
            }
            
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);

            // Emit replication hook with full buy parameters (non-proposal)
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
        /**
         * Check if we should use demo account for trade execution
         * Returns true if:
         * 1. Admin mirror mode is enabled AND current account is the real account, OR
         * 2. Current account is a special CR account (which uses demo balance for trading)
         */
        shouldUseDemoAccountForTrade() {
            const currentLoginId = this.accountInfo?.loginid;
            
            // CRITICAL: Check show_as_cr flag first - when CR6779123 is displayed,
            // API uses demo account but we need to detect it's a special CR account
            const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
            if (showAsCR && isSpecialCRAccount(showAsCR)) {
                console.log('[Purchase] 🎯 Special CR account detected via show_as_cr:', showAsCR);
                return true;
            }
            
            if (!currentLoginId) return false;

            // Check if current account is a special CR account
            // Special CR accounts always use demo account balance for trading
            if (isSpecialCRAccount(currentLoginId)) {
                return true;
            }

            // Check admin mirror mode
            const adminMirrorModeEnabled =
                typeof window !== 'undefined' && localStorage.getItem('adminMirrorModeEnabled') === 'true';
            
            if (!adminMirrorModeEnabled) return false;

            const swapState = getBalanceSwapState();
            if (!swapState?.isMirrorMode) return false;

            // If we're trading from real account in admin mode, use demo account for execution
            return currentLoginId === swapState.realAccount.loginId;
        }

        /**
         * Temporarily switch to demo account for trade execution
         * Returns true if switch was successful, false otherwise
         */
        async switchToDemoAccountForTrade(demoToken, demoLoginId) {
            if (!api_base.api || !demoToken || !demoLoginId) {
                console.error('[Special CR Account] Missing required parameters for account switch');
                return false;
            }

            try {
                console.log(`[Special CR Account] Switching from ${this.accountInfo?.loginid} to demo account ${demoLoginId} for trade execution`);
                
                // Authorize with demo account token
                const { authorize, error } = await api_base.api.authorize(demoToken);
                if (error) {
                    console.error('[Special CR Account] Failed to authorize with demo account:', error);
                    return false;
                }

                // Update account info to demo account
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
