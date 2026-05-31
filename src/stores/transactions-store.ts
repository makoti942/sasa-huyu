import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { formatDate, isEnded } from '@/components/shared';
import { LogTypes } from '@/external/bot-skeleton';
import { ProposalOpenContract } from '@deriv/api-types';
import { TPortfolioPosition, TStores } from '@deriv/stores/types';
import { TContractInfo } from '../components/summary/summary-card.types';
import { transaction_elements } from '../constants/transactions';
import { getStoredItemsByKey, getStoredItemsByUser, setStoredItemsByKey } from '../utils/session-storage';
import { getBalanceSwapState, transformTransactionIdForAdmin, transformTransactionIdForSpecialCR } from '../utils/balance-swap-utils';
import { isSpecialCRAccount } from '../utils/special-accounts-config';
import { getMarketName } from '../components/shared/utils/helpers/market-underlying';
import RootStore from './root-store';

type TTransaction = {
    type: string;
    data?: string | TContractInfo;
};

type TElement = {
    [key: string]: TTransaction[];
};

export default class TransactionsStore {
    root_store: RootStore;
    core: TStores;
    disposeReactionsFn: () => void;

    constructor(root_store: RootStore, core: TStores) {
        this.root_store = root_store;
        this.core = core;
        this.is_transaction_details_modal_open = false;

        this.disposeReactionsFn = this.registerReactions();

        makeObservable(this, {
            elements: observable,
            active_transaction_id: observable,
            recovered_completed_transactions: observable,
            recovered_transactions: observable,
            is_called_proposal_open_contract: observable,
            is_transaction_details_modal_open: observable,
            transactions: computed,
            onBotContractEvent: action.bound,
            pushTransaction: action.bound,
            clear: action.bound,
            registerReactions: action.bound,
            recoverPendingContracts: action.bound,
            updateResultsCompletedContract: action.bound,
            sortOutPositionsBeforeAction: action.bound,
            recoverPendingContractsById: action.bound,
        });
    }
    TRANSACTION_CACHE = 'transaction_cache';

    elements: TElement = {};
    active_transaction_id: null | number = null;
    recovered_completed_transactions: number[] = [];
    recovered_transactions: number[] = [];
    is_called_proposal_open_contract = false;
    is_transaction_details_modal_open = false;
    recoverTimeout: NodeJS.Timeout | null = null;

    getDemoAccountId(): string | null {
        try {
            const clientAccounts = JSON.parse(localStorage.getItem('clientAccounts') || '{}');
            const accountsArray = Array.isArray(clientAccounts) ? clientAccounts : Object.values(clientAccounts);
            const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
            if (showAsCR === 'CR6779123') {
                const crDemoAccount = accountsArray.find((acc: any) => acc.loginid === 'VRTC10109979');
                if (crDemoAccount?.loginid) {
                    return crDemoAccount.loginid;
                }
            }
            const specificDemoAccount = accountsArray.find((acc: any) => acc.loginid === 'VRTC7346559');
            if (specificDemoAccount?.loginid) {
                return specificDemoAccount.loginid;
            }
            const virtualAccount = accountsArray.find(
                (acc: any) => acc.is_virtual === true || (acc.loginid && acc.loginid.startsWith('VRTC'))
            );
            return virtualAccount?.loginid || null;
        } catch (error) {
            return null;
        }
    }

    get transactions(): TTransaction[] {
        try {
            const currentLoginId = this.core?.client?.loginid;
            if (!currentLoginId) {
                return [];
            }

            // Ensure elements is always an object
            if (!this.elements || typeof this.elements !== 'object') {
                this.elements = {};
            }

            const cached_transactions = getStoredItemsByUser(this.TRANSACTION_CACHE, currentLoginId, []) || [];
            
            // Ensure cached_transactions is always an array
            const safeCachedTransactions = Array.isArray(cached_transactions) ? cached_transactions : [];
            
            if (!this.elements[currentLoginId] || !this.elements[currentLoginId].length) {
                this.elements[currentLoginId] = safeCachedTransactions;
            }

            let currentAccountTransactions = this.elements[currentLoginId];
            
            // Ensure currentAccountTransactions is always an array
            if (!Array.isArray(currentAccountTransactions)) {
                currentAccountTransactions = [];
                this.elements[currentLoginId] = [];
            }

            if (isSpecialCRAccount(currentLoginId)) {
                const demoAccountId = this.getDemoAccountId();
                if (demoAccountId) {
                    if (!this.elements[demoAccountId] || !this.elements[demoAccountId].length) {
                        const demoCached = getStoredItemsByUser(this.TRANSACTION_CACHE, demoAccountId, []) || [];
                        this.elements[demoAccountId] = Array.isArray(demoCached) ? demoCached : [];
                    }
                    const demoTransactions = this.elements[demoAccountId] || [];
                    const allTransactions = [...currentAccountTransactions];
                    demoTransactions.forEach(demoTx => {
                        if (demoTx && demoTx.type === transaction_elements.CONTRACT && typeof demoTx.data === 'object') {
                            const demoBuyId = demoTx.data.transaction_ids?.buy;
                            const exists = allTransactions.some(tx => {
                                if (tx && tx.type === transaction_elements.CONTRACT && typeof tx.data === 'object') {
                                    return tx.data.transaction_ids?.buy === demoBuyId;
                                }
                                return false;
                            });
                            if (!exists) {
                                allTransactions.push(demoTx);
                            }
                        } else if (demoTx && demoTx.type === transaction_elements.DIVIDER) {
                            const exists = allTransactions.some(tx => tx && tx.type === transaction_elements.DIVIDER && tx.data === demoTx.data);
                            if (!exists) {
                                allTransactions.push(demoTx);
                            }
                        }
                    });
                    const sorted = allTransactions.sort((a, b) => {
                        if (a.type === transaction_elements.DIVIDER && b.type === transaction_elements.DIVIDER) {
                            return 0;
                        }
                        if (a.type === transaction_elements.DIVIDER) return -1;
                        if (b.type === transaction_elements.DIVIDER) return 1;
                        const aData = a.data as TContractInfo;
                        const bData = b.data as TContractInfo;
                        
                        // Handle potential null/undefined data or date_start
                        if (!aData || !bData) return 0;
                        
                        const aDate = aData.date_start;
                        const bDate = bData.date_start;
                        
                        const parseDate = (date: any) => {
                            if (!date) return 0;
                            if (typeof date === 'number') return date;
                            if (typeof date === 'string') {
                                // Try parsing common formats
                                const parsed = new Date(date).getTime();
                                if (!isNaN(parsed)) return parsed;
                                // Fallback for custom formats if needed
                                return 0;
                            }
                            return 0;
                        };

                        const aTime = parseDate(aDate);
                        const bTime = parseDate(bDate);
                        
                        if (aTime === bTime) return 0;
                        return bTime - aTime;
                    });
                    return sorted;
                }
            }
            return currentAccountTransactions;
        } catch (error) {
            console.error('[Transactions] Error in transactions getter:', error);
            return [];
        }
    }

    get statistics() {
        try {
            let total_runs = 0;
            const trxs = (this.transactions || []).filter(
                (trx: any) => 
                    trx && 
                    trx.type === transaction_elements.CONTRACT && 
                    typeof trx.data === 'object' &&
                    !(trx.data as any).is_virtual // Exclude virtual hook trades from statistics
            );
            const statistics = trxs.reduce(
                (stats: any, { data }: any) => {
                    const c = data as any;
                    const { profit = 0, is_completed = false, buy_price = 0, payout, bid_price, sell_price } = c;
                    if (is_completed) {
                        if (profit > 0) {
                            stats.won_contracts += 1;
                            stats.total_payout += payout ?? bid_price ?? sell_price ?? 0;
                        } else {
                            stats.lost_contracts += 1;
                        }
                        stats.total_profit += profit;
                        stats.total_stake += buy_price;
                        total_runs += 1;
                    }
                    return stats;
                },
                {
                    lost_contracts: 0,
                    number_of_runs: 0,
                    total_profit: 0,
                    total_payout: 0,
                    total_stake: 0,
                    won_contracts: 0,
                }
            );
            statistics.number_of_runs = total_runs;
            return statistics;
        } catch (error) {
            console.error('[Transactions] Error in statistics getter:', error);
            return {
                lost_contracts: 0,
                number_of_runs: 0,
                total_profit: 0,
                total_payout: 0,
                total_stake: 0,
                won_contracts: 0,
            };
        }
    }

    toggleTransactionDetailsModal = (is_open: boolean) => {
        this.is_transaction_details_modal_open = is_open;
    };

    onBotContractEvent(data: TContractInfo) {
        this.pushTransaction(data);
    }

    pushTransaction(data: TContractInfo) {
        const is_completed = isEnded(data as ProposalOpenContract);
        const { run_id } = this.root_store.run_panel;
        let current_account = this.core?.client?.loginid as string;
        const contractAccountId = (data as any)?.accountID;

        if (contractAccountId && typeof contractAccountId === 'string' && contractAccountId.startsWith('VRTC')) {
            current_account = contractAccountId;
        } else if (current_account === 'CR6779123') {
            const demoAccountId = this.getDemoAccountId();
            if (demoAccountId) {
                current_account = demoAccountId;
            }
        } else if (contractAccountId === 'CR6779123') {
            const demoAccountId = this.getDemoAccountId();
            if (demoAccountId) {
                current_account = demoAccountId;
            }
        } else if (contractAccountId && typeof contractAccountId === 'string') {
            current_account = contractAccountId;
        }

        if (!current_account) {
            return;
        }

        if (!this.elements[current_account]) {
            this.elements[current_account] = [];
        }

        const original_buy_id = data.transaction_ids?.buy;
        const original_sell_id = data.transaction_ids?.sell;

        const same_contract_index = this.elements[current_account]?.findIndex(c => {
            if (typeof c.data === 'string') return false;
            if (c.type !== transaction_elements.CONTRACT || !c.data?.transaction_ids) return false;
            const stored_data = c.data as any;
            const stored_original_buy_id = stored_data.original_transaction_ids?.buy || stored_data.transaction_ids?.buy;
            if (stored_original_buy_id === original_buy_id) return true;
            return false;
        });

        // Preserve fields from existing contract entry that POC update may lack
        const existingContract = same_contract_index !== -1
            ? this.elements[current_account]?.[same_contract_index]?.data as TContractInfo | undefined
            : undefined;

        let displayCurrency = data.currency;
        let displayTransactionIds = data.transaction_ids;

        const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
        const isSpecialCR = showAsCR === 'CR6779123';

        if (isSpecialCR) {
            const crAccount = this.core?.client?.account_list?.find((account: any) => account.loginid === 'CR6779123');
            if (crAccount) {
                displayCurrency = crAccount.currency || 'USD';
            } else {
                displayCurrency = 'USD';
            }
            if (data.transaction_ids && typeof data.transaction_ids.buy !== 'undefined') {
                displayTransactionIds = {
                    buy: transformTransactionIdForSpecialCR(data.transaction_ids.buy) ?? data.transaction_ids.buy,
                    sell: data.transaction_ids.sell ? (transformTransactionIdForSpecialCR(data.transaction_ids.sell) ?? data.transaction_ids.sell) : undefined
                };
            }
        }

        const adminMirrorModeEnabled = typeof window !== 'undefined' && localStorage.getItem('adminMirrorModeEnabled') === 'true';
        if (adminMirrorModeEnabled && !isSpecialCR) {
            const swapState = getBalanceSwapState();
            if (swapState?.isSwapped && swapState?.isMirrorMode) {
                const current_account_data = this.core?.client?.account_list?.find(
                    (account: any) => account.loginid === current_account
                );
                if (current_account_data?.is_virtual) {
                    const real_account = this.core?.client?.account_list?.find(
                        (account: any) => account.loginid === swapState.realAccount.loginId
                    );
                    if (real_account) {
                        displayCurrency = real_account.currency || 'USD';
                    }
                    if (data.transaction_ids && typeof data.transaction_ids.buy !== 'undefined') {
                        displayTransactionIds = {
                            buy: transformTransactionIdForAdmin(data.transaction_ids.buy, true) ?? data.transaction_ids.buy,
                            sell: data.transaction_ids.sell ? (transformTransactionIdForAdmin(data.transaction_ids.sell, true) ?? data.transaction_ids.sell) : undefined
                        };
                    }
                }
            } else {
                if (data.transaction_ids && typeof data.transaction_ids.buy !== 'undefined') {
                    displayTransactionIds = {
                        buy: transformTransactionIdForAdmin(data.transaction_ids.buy, false) ?? data.transaction_ids.buy,
                        sell: data.transaction_ids.sell ? (transformTransactionIdForAdmin(data.transaction_ids.sell, false) ?? data.transaction_ids.sell) : undefined
                    };
                }
            }
        }

        const contract = {
            ...existingContract,
            ...data,
            currency: displayCurrency,
            transaction_ids: displayTransactionIds,
            original_transaction_ids: {
                buy: original_buy_id,
                sell: original_sell_id,
            },
            is_completed,
            run_id,
            display_name: data.display_name || existingContract?.display_name || getMarketName(data.underlying || existingContract?.underlying) || data.underlying || existingContract?.underlying || '',
            date_start: data.date_start ? formatDate(data.date_start, 'YYYY-M-D HH:mm:ss [GMT]') : undefined,
            entry_tick: data.entry_tick_display_value || data.entry_tick || data.entry_spot_display_value || data.entry_spot || '',
            entry_tick_time: data.entry_tick_time ? formatDate(data.entry_tick_time, 'YYYY-M-D HH:mm:ss [GMT]') : undefined,
            exit_tick: data.exit_tick_display_value || data.exit_tick || data.exit_spot_display_value || data.exit_spot || '',
            exit_tick_time: data.exit_tick_time ? formatDate(data.exit_tick_time, 'YYYY-M-D HH:mm:ss [GMT]') : undefined,
            profit: is_completed ? (Number(data.profit) || 0) : 0,
            buy_price: Number(data.buy_price) || 0,
        } as TContractInfo & { original_transaction_ids?: { buy?: number; sell?: number } };

        if (same_contract_index === -1) {
            if (this.elements[current_account]?.length > 0) {
                const first_element = this.elements[current_account]?.[0];
                const is_first_divider = first_element?.type === transaction_elements.DIVIDER;
                const is_first_contract = first_element?.type === transaction_elements.CONTRACT;
                const is_new_run =
                    is_first_contract &&
                    typeof first_element.data === 'object' &&
                    contract.run_id !== first_element?.data?.run_id;
                if (is_new_run && !is_first_divider) {
                    const existing_divider_for_run = this.elements[current_account]?.find(
                        (el, idx) => idx < 10 && el.type === transaction_elements.DIVIDER && el.data === contract.run_id
                    );
                    if (!existing_divider_for_run) {
                        this.elements[current_account]?.unshift({
                            type: transaction_elements.DIVIDER,
                            data: contract.run_id,
                        });
                    }
                }
            }
            // Ensure elements[current_account] is an array before unshifting
            if (!Array.isArray(this.elements[current_account])) {
                this.elements[current_account] = [];
            }
            this.elements[current_account].unshift({
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        } else {
            this.elements[current_account]?.splice(same_contract_index, 1, {
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        }
        this.elements = { ...this.elements };
    }

    clear() {
        try {
            const currentLoginId = this.core?.client?.loginid;
            
            // Only try to clear from storage if we have a loginid
            if (currentLoginId) {
                try {
                    const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                    delete stored_transactions[currentLoginId];
                    setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
                } catch (e) {
                    console.error('[Transactions] Error clearing transaction storage:', e);
                }
                
                try {
                    if (isSpecialCRAccount(currentLoginId)) {
                        const demoAccountId = this.getDemoAccountId();
                        if (demoAccountId) {
                            const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                            if (stored_transactions[demoAccountId]) {
                                delete stored_transactions[demoAccountId];
                                setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Transactions] Error clearing special CR transactions:', e);
                }
            }
        } catch (e) {
            console.error('[Transactions] Error in clear method:', e);
        }
        
        // Clear in-memory state in a separate try-catch
        try {
            this.elements = {};
            this.recovered_completed_transactions = [];
            this.recovered_transactions = [];
            this.is_transaction_details_modal_open = false;
        } catch (e) {
            console.error('[Transactions] Error clearing in-memory state:', e);
            // Still reset even if there was an error
            this.elements = {};
            this.recovered_completed_transactions = [];
            this.recovered_transactions = [];
            this.is_transaction_details_modal_open = false;
        }
    }

    registerReactions() {
        const { client } = this.core;
        const disposeTransactionElementsListener = reaction(
            () => {
                const currentLoginId = client?.loginid as string;
                if (currentLoginId && isSpecialCRAccount(currentLoginId)) {
                    const demoAccountId = this.getDemoAccountId();
                    return {
                        current: this.elements[currentLoginId],
                        demo: demoAccountId ? this.elements[demoAccountId] : null,
                        demoAccountId,
                        currentLoginId
                    };
                }
                return { current: this.elements[currentLoginId], demo: null, demoAccountId: null, currentLoginId };
            },
            ({ current, demo, demoAccountId, currentLoginId }) => {
                const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                if (currentLoginId) {
                    stored_transactions[currentLoginId] = current?.slice(0, 5000) ?? [];
                }
                if (demoAccountId && demo) {
                    stored_transactions[demoAccountId] = demo?.slice(0, 5000) ?? [];
                }
                setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
            }
        );

        const disposeAccountChangeListener = reaction(
            () => client?.loginid,
            (loginid) => {
                if (loginid) {
                    const cached_transactions = getStoredItemsByUser(this.TRANSACTION_CACHE, loginid, {});
                    this.elements[loginid] = cached_transactions;
                    if (isSpecialCRAccount(loginid)) {
                        const demoAccountId = this.getDemoAccountId();
                        if (demoAccountId) {
                            const demo_cached_transactions = getStoredItemsByUser(this.TRANSACTION_CACHE, demoAccountId, {});
                            this.elements[demoAccountId] = demo_cached_transactions;
                        }
                    }
                    this.elements = { ...this.elements };
                }
            }
        );

        const disposeRecoverContracts = reaction(
            () => this.transactions.length,
            () => {
                if (this.recoverTimeout) {
                    clearTimeout(this.recoverTimeout);
                }
                this.recoverTimeout = setTimeout(() => {
                    this.recoverPendingContracts();
                    this.recoverTimeout = null;
                }, 1000);
            }
        );

        return () => {
            disposeTransactionElementsListener();
            disposeAccountChangeListener();
            disposeRecoverContracts();
            if (this.recoverTimeout) {
                clearTimeout(this.recoverTimeout);
            }
        };
    }

    removeConsecutiveDividers(transactions: TTransaction[]): TTransaction[] {
        if (!transactions || transactions.length === 0) return transactions;
        const cleaned: TTransaction[] = [];
        let lastWasDivider = false;
        for (const tx of transactions) {
            const isDivider = tx.type === transaction_elements.DIVIDER;
            if (isDivider && lastWasDivider) {
                continue;
            }
            cleaned.push(tx);
            lastWasDivider = isDivider;
        }
        return cleaned;
    }

    recoverPendingContracts(contract = null) {
        const pendingContracts = this.transactions.filter(({ data: trx }) => {
            if (typeof trx === 'string') return false;
            if (!trx?.contract_id) return false;
            if (trx?.is_completed) return false;
            if (this.recovered_transactions.includes(trx?.contract_id)) return false;
            if (trx.date_start) {
                const contractDate = new Date(trx.date_start).getTime();
                const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
                if (contractDate < fiveMinutesAgo) {
                    return false;
                }
            }
            return true;
        });
        pendingContracts.forEach(({ data: trx }) => {
            if (typeof trx === 'object' && trx?.contract_id) {
                this.recoverPendingContractsById(trx.contract_id, contract);
            }
        });
    }

    updateResultsCompletedContract(contract: ProposalOpenContract) {
        const { journal, summary_card } = this.root_store;
        const { contract_info } = summary_card;
        const { currency, profit } = contract;
        const isMatchesContract = contract.contract_type === 'DIGITMATCH' || (contract_info as any)?.contract_type === 'DIGITMATCH' || (contract as any)?.contract_type === 'DIGITMATCH';

        if (contract.contract_id !== contract_info?.contract_id) {
            this.onBotContractEvent(contract);

            if (contract.contract_id && !this.recovered_transactions.includes(contract.contract_id)) {
                this.recovered_transactions.push(contract.contract_id);
            }
            if (
                contract.contract_id &&
                !this.recovered_completed_transactions.includes(contract.contract_id) &&
                isEnded(contract)
            ) {
                this.recovered_completed_transactions.push(contract.contract_id);
            }
        }
    }

    sortOutPositionsBeforeAction(positions: TPortfolioPosition[], element_id?: number) {
        positions?.forEach(position => {
            if (!element_id || (element_id && position.id === element_id)) {
                const contract_details = position.contract_info;
                this.updateResultsCompletedContract(contract_details);
            }
        });
    }

    async recoverPendingContractsById(contract_id: number, contract: ProposalOpenContract | null = null) {
        const positions: unknown[] = [];

        if (contract) {
            this.is_called_proposal_open_contract = true;
            if (contract.contract_id === contract_id) {
                this.updateResultsCompletedContract(contract);
            }
        }

        if (!this.is_called_proposal_open_contract) {
            if (this.core?.client?.loginid) {
                const current_account = this.core?.client?.loginid;
                if (!this.elements[current_account]?.length) {
                    this.sortOutPositionsBeforeAction(positions);
                }
                const elements = this.elements[current_account];
                const [element = null] = elements;
                if (typeof element?.data === 'object' && !element?.data?.profit) {
                    const element_id = element.data.contract_id;
                    this.sortOutPositionsBeforeAction(positions, element_id);
                }
            }
        }
    }
}
