import { useCallback, useEffect, useMemo, useRef } from 'react';
import Cookies from 'js-cookie';
import { observer } from 'mobx-react-lite';
import { getDecimalPlaces, toMoment } from '@/components/shared';
import { FORM_ERROR_MESSAGES } from '@/components/shared/constants/form-error-messages';
import { initFormErrorMessages } from '@/components/shared/utils/validation/declarative-validation-rules';
import { api_base } from '@/external/bot-skeleton';
import { useOauth2 } from '@/hooks/auth/useOauth2';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import useTMB from '@/hooks/useTMB';
import { getBalanceSwapState, getAccountDisplayInfo } from '@/utils/balance-swap-utils';
import { SPECIAL_CR_ACCOUNTS } from '@/utils/special-accounts-config';
import { TLandingCompany, TSocketResponseData } from '@/types/api-types';
import { useTranslations } from '@deriv-com/translations';

type TClientInformation = {
    loginid?: string;
    email?: string;
    currency?: string;
    residence?: string | null;
    first_name?: string;
    last_name?: string;
    preferred_language?: string | null;
    user_id?: number | string;
    landing_company_shortcode?: string;
};
const CoreStoreProvider: React.FC<{ children: React.ReactNode }> = observer(({ children }) => {
    const currentDomain = useMemo(() => '.' + window.location.hostname.split('.').slice(-2).join('.'), []);
    const { isAuthorizing, isAuthorized, connectionStatus, accountList, activeLoginid } = useApiBase();

    const appInitialization = useRef(false);
    const accountInitialization = useRef(false);
    const timeInterval = useRef<NodeJS.Timeout | null>(null);
    const msg_listener = useRef<{ unsubscribe: () => void } | null>(null);
    const { client, common } = useStore() ?? {};

    const { currentLang } = useTranslations();

    const { oAuthLogout } = useOauth2({ handleLogout: async () => client.logout(), client });

    const { is_tmb_enabled: tmb_enabled_from_hook } = useTMB();

    const is_tmb_enabled = useMemo(
        () => window.is_tmb_enabled === true || tmb_enabled_from_hook,
        [tmb_enabled_from_hook]
    );

    const isLoggedOutCookie = Cookies.get('logged_state') === 'false' && !is_tmb_enabled;

    useEffect(() => {
        if (isLoggedOutCookie && client?.is_logged_in) {
            oAuthLogout();
        }
    }, [isLoggedOutCookie, oAuthLogout, client?.is_logged_in]);

    const activeAccount = useMemo(
        () => accountList?.find(account => account.loginid === activeLoginid),
        [activeLoginid, accountList]
    );

    useEffect(() => {
        // Check if show_as_cr is set - if so, use CR6779123 for balance lookup
        const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
        const balanceLookupLoginId = showAsCR || activeAccount?.loginid;
        
        const currentBalanceData = client?.all_accounts_balance?.accounts?.[balanceLookupLoginId ?? ''];
        if (currentBalanceData) {
            const balance = currentBalanceData.balance.toFixed(getDecimalPlaces(currentBalanceData.currency));
            client?.setBalance(balance);
            client?.setCurrency(currentBalanceData.currency);
            
            // Cache balance for faster loading on refresh
            if (typeof window !== 'undefined' && balanceLookupLoginId) {
                try {
                    const cachedBalances = JSON.parse(sessionStorage.getItem('cached_balances') || '{}');
                    cachedBalances[balanceLookupLoginId] = {
                        balance,
                        currency: currentBalanceData.currency,
                        timestamp: Date.now()
                    };
                    sessionStorage.setItem('cached_balances', JSON.stringify(cachedBalances));
                } catch (e) {
                    // Ignore storage errors
                }
            }
        } else if (activeAccount) {
            // Try to load cached balance for immediate display
            if (typeof window !== 'undefined' && balanceLookupLoginId) {
                try {
                    const cachedBalances = JSON.parse(sessionStorage.getItem('cached_balances') || '{}');
                    const cached = cachedBalances[balanceLookupLoginId];
                    // Use cached balance if it's less than 5 minutes old
                    if (cached && (Date.now() - cached.timestamp) < 5 * 60 * 1000) {
                        client?.setBalance(cached.balance);
                        client?.setCurrency(cached.currency || activeAccount.currency || 'USD');
                    } else {
                        // Fallback: use account currency even if balance not available yet
                        client?.setCurrency(activeAccount.currency || 'USD');
                    }
                } catch (e) {
                    // Fallback: use account currency even if balance not available yet
                    client?.setCurrency(activeAccount.currency || 'USD');
                }
            } else {
                // Fallback: use account currency even if balance not available yet
                client?.setCurrency(activeAccount.currency || 'USD');
            }
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeAccount?.loginid, client?.all_accounts_balance]);

    useEffect(() => {
        if (client && activeAccount) {
            // Check if show_as_cr is set - if so, use CR6779123 for display
            const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
            const displayLoginId = showAsCR || activeLoginid;
            
            client?.setLoginId(displayLoginId);
            client?.setAccountList(accountList);
            client?.setIsLoggedIn(true);
            
            // DISABLED - replaced by DerivAuth.js
            // // CRITICAL: If show_as_cr is set and API is already initialized, ensure it's authorized with demo account
            // // This ensures the API is ready for trading immediately when the page loads
            // if (showAsCR === 'CR6779123' && api_base?.api && isAuthorized) {
            //     const currentApiAccount = api_base.account_info?.loginid;
            //     const expectedDemoAccount = 'VRTC10109979';
                
            //     // Only re-authorize if not already on demo account
            //     if (currentApiAccount !== expectedDemoAccount) {
            //         console.log('[CoreStoreProvider] 🔄 show_as_cr is set but API is not on demo account - re-authorizing...');
            //         const accountsList = JSON.parse(localStorage.getItem('accountsList') || '{}');
            //         const demoToken = accountsList[expectedDemoAccount];
                    
            //         if (demoToken) {
            //             // Re-authorize with demo token in background (don't block UI)
            //             api_base.api.authorize(demoToken).then(({ authorize, error }) => {
            //                 if (error) {
            //                     console.error('[CoreStoreProvider] ❌ Failed to re-authorize with demo token:', error);
            //                 } else if (authorize) {
            //                     api_base.account_info = { ...authorize, loginid: expectedDemoAccount };
            //                     api_base.token = demoToken;
            //                     api_base.account_id = expectedDemoAccount;
            //                     console.log('[CoreStoreProvider] ✅ Re-authorized API with demo account:', expectedDemoAccount);
            //                 }
            //             }).catch(err => {
            //                 console.error('[CoreStoreProvider] ❌ Error re-authorizing:', err);
            //             });
            //         }
            //     }
            // }
            
            // Load cached balance immediately on mount for faster display on refresh
            if (typeof window !== 'undefined' && displayLoginId && !client?.all_accounts_balance?.accounts?.[displayLoginId]) {
                try {
                    const cachedBalances = JSON.parse(sessionStorage.getItem('cached_balances') || '{}');
                    const cached = cachedBalances[displayLoginId];
                    // Use cached balance if it's less than 5 minutes old
                    if (cached && (Date.now() - cached.timestamp) < 5 * 60 * 1000) {
                        client?.setBalance(cached.balance);
                        client?.setCurrency(cached.currency || activeAccount.currency || 'USD');
                    }
                } catch (e) {
                    // Ignore storage errors
                }
            }

            // Auto-enable mirror mode if admin enabled it previously
            const mirrorModeEnabled = localStorage.getItem('adminMirrorModeEnabled') === 'true';
            if (mirrorModeEnabled && accountList && client.all_accounts_balance?.accounts) {
                const swapState = getBalanceSwapState();

                // Only activate if not already active
                if (!swapState?.isSwapped) {
                    // Find demo and real accounts
                    const demoAccount = accountList.find(acc => acc.loginid.startsWith('VR'));
                    const realAccounts = accountList.filter(acc => !acc.loginid.startsWith('VR'));

                    // Find US Dollar account
                    const usdAccount = realAccounts.find(acc => {
                        const currency = acc.currency;
                        return currency === 'USD' && currency !== 'USDC';
                    });

                    if (demoAccount && usdAccount) {
                        const demoBalanceData = client.all_accounts_balance.accounts[demoAccount.loginid];
                        const realBalanceData = client.all_accounts_balance.accounts[usdAccount.loginid];

                        const demoBalance = demoBalanceData?.balance?.toString() || '0';
                        const realBalance = realBalanceData?.balance?.toString() || '0';

                        // Activate mirror mode
                        localStorage.setItem(
                            'balanceSwapState',
                            JSON.stringify({
                                isSwapped: true,
                                isMirrorMode: true,
                                demoAccount: {
                                    loginId: demoAccount.loginid,
                                    originalBalance: demoBalance,
                                    swappedBalance: demoBalance,
                                    flag: 'demo',
                                },
                                realAccount: {
                                    loginId: usdAccount.loginid,
                                    originalBalance: realBalance,
                                    swappedBalance: demoBalance, // Real mirrors demo
                                    flag: 'real',
                                },
                                swapTimestamp: Date.now(),
                            })
                        );
                    }
                }
            }
        }
    }, [accountList, activeAccount, activeLoginid, client]);

    useEffect(() => {
        initFormErrorMessages(FORM_ERROR_MESSAGES());

        return () => {
            if (timeInterval.current) {
                clearInterval(timeInterval.current);
            }
        };
    }, []);

    useEffect(() => {
        if (common && currentLang) {
            common.setCurrentLanguage(currentLang);
        }
    }, [currentLang, common]);

    useEffect(() => {
        if (client && !isAuthorizing && !appInitialization.current) {
            if (!api_base?.api) return;
            appInitialization.current = true;

            api_base.api?.websiteStatus().then((res: TSocketResponseData<'website_status'>) => {
                client.setWebsiteStatus(res.website_status);
            });

            // Update server time every 10 seconds
            timeInterval.current = setInterval(() => {
                api_base.api
                    ?.time()
                    .then((res: TSocketResponseData<'time'>) => {
                        common.setServerTime(toMoment(res.time), false);
                    })
                    .catch(() => {
                        common.setServerTime(toMoment(Date.now()), true);
                    });
            }, 10000);
        }
    }, [client, common, isAuthorizing, is_tmb_enabled]);

    const handleMessages = useCallback(
        async (res: Record<string, unknown>) => {
            if (!res) return;
            const data = res.data as TSocketResponseData<'balance'>;
            const { msg_type, error } = data;

            if (
                error?.code === 'AuthorizationRequired' ||
                error?.code === 'DisabledClient' ||
                error?.code === 'InvalidToken'
            ) {
                await oAuthLogout();
            }

            if (msg_type === 'balance' && data && !error) {
                const balance = data.balance;
                // Get balance swap state
                const swapState = getBalanceSwapState();
                // Only apply mirror/swap if admin has enabled it
                const adminMirrorModeEnabled = localStorage.getItem('adminMirrorModeEnabled') === 'true';

                // TEMPORARILY DISABLED: Admin mirror mode - showing real balances for now
                // TODO: Re-enable admin mirror mode later
                const ADMIN_MIRROR_MODE_DISABLED = true;

                if (balance?.accounts) {
                    // Apply mirror/swap logic to all accounts if swap is active and admin enabled it
                    if (swapState?.isSwapped && adminMirrorModeEnabled && !ADMIN_MIRROR_MODE_DISABLED) {
                        const swappedAccounts = { ...balance.accounts };

                        if (swapState.isMirrorMode) {
                            // Mirror mode: Real shows shared amount (15% of demo), demo shows its own
                            if (swappedAccounts[swapState.demoAccount.loginId]) {
                                // Demo shows its own balance (no change needed)
                                // Update swap state with current demo balance
                                const currentDemoBalance = swappedAccounts[swapState.demoAccount.loginId].balance;
                                const updatedSwapState = {
                                    ...swapState,
                                    demoAccount: {
                                        ...swapState.demoAccount,
                                        originalBalance: currentDemoBalance.toString(),
                                        swappedBalance: currentDemoBalance.toString(),
                                    },
                                    realAccount: {
                                        ...swapState.realAccount,
                                        swappedBalance: currentDemoBalance.toString(), // Kept for backward compatibility
                                    },
                                };
                                localStorage.setItem('balanceSwapState', JSON.stringify(updatedSwapState));
                            }
                            if (swappedAccounts[swapState.realAccount.loginId]) {
                                // Real shows shared amount (15% of demo balance)
                                const demoBalance =
                                    swappedAccounts[swapState.demoAccount.loginId]?.balance ||
                                    parseFloat(swapState.demoAccount.originalBalance) ||
                                    0;
                                
                                // Get shared amount from localStorage (15% of demo balance)
                                const sharedAmountKey = `sharedAmount_${swapState.demoAccount.loginId}`;
                                let sharedAmount = parseFloat(localStorage.getItem(sharedAmountKey) || '0');
                                
                                // If shared amount not found, calculate it (15% of current demo balance)
                                if (!sharedAmount || sharedAmount === 0) {
                                    sharedAmount = demoBalance * 0.15;
                                    localStorage.setItem(sharedAmountKey, sharedAmount.toFixed(2));
                                }
                                
                                swappedAccounts[swapState.realAccount.loginId] = {
                                    ...swappedAccounts[swapState.realAccount.loginId],
                                    balance: sharedAmount, // Real shows shared amount (15% of demo)
                                };
                            }
                        } else {
                            // Legacy swap mode
                            if (swappedAccounts[swapState.demoAccount.loginId]) {
                                swappedAccounts[swapState.demoAccount.loginId] = {
                                    ...swappedAccounts[swapState.demoAccount.loginId],
                                    balance: parseFloat(swapState.demoAccount.swappedBalance) || 0,
                                };
                            }
                            if (swappedAccounts[swapState.realAccount.loginId]) {
                                swappedAccounts[swapState.realAccount.loginId] = {
                                    ...swappedAccounts[swapState.realAccount.loginId],
                                    balance: parseFloat(swapState.realAccount.swappedBalance) || 0,
                                };
                            }
                        }

                        client.setAllAccountsBalance({
                            ...balance,
                            accounts: swappedAccounts,
                        });
                    } else {
                        client.setAllAccountsBalance(balance);
                    }
                } else if (balance?.loginid) {
                    if (!client?.all_accounts_balance?.accounts || !balance?.loginid) return;
                    const accounts = { ...client.all_accounts_balance.accounts };
                    const currentLoggedInBalance = { ...accounts[balance.loginid] };

                    // Only apply mirror/swap if admin has enabled it
                    const adminMirrorModeEnabled = localStorage.getItem('adminMirrorModeEnabled') === 'true';

                    // Apply mirror/swap logic if this account is involved
                    let updatedBalance = balance.balance;
                    if (swapState?.isSwapped && adminMirrorModeEnabled) {
                        if (swapState.isMirrorMode) {
                            if (balance.loginid === swapState.demoAccount.loginId) {
                                // Demo shows its own balance
                                updatedBalance = balance.balance;
                                // Update swap state with current demo balance
                                const updatedSwapState = {
                                    ...swapState,
                                    demoAccount: {
                                        ...swapState.demoAccount,
                                        originalBalance: balance.balance.toString(),
                                        swappedBalance: balance.balance.toString(),
                                    },
                                    realAccount: {
                                        ...swapState.realAccount,
                                        swappedBalance: balance.balance.toString(), // Real mirrors demo
                                    },
                                };
                                localStorage.setItem('balanceSwapState', JSON.stringify(updatedSwapState));
                            } else if (balance.loginid === swapState.realAccount.loginId) {
                                // Real mirrors demo balance
                                const demoBalance =
                                    accounts[swapState.demoAccount.loginId]?.balance ||
                                    parseFloat(swapState.demoAccount.originalBalance) ||
                                    0;
                                updatedBalance = demoBalance;
                            }
                        } else {
                            // Legacy swap mode
                            if (balance.loginid === swapState.demoAccount.loginId) {
                                updatedBalance = parseFloat(swapState.demoAccount.swappedBalance) || 0;
                            } else if (balance.loginid === swapState.realAccount.loginId) {
                                updatedBalance = parseFloat(swapState.realAccount.swappedBalance) || 0;
                            }
                        }
                    }

                    currentLoggedInBalance.balance = updatedBalance;

                    const updatedAccounts = {
                        ...client.all_accounts_balance,
                        accounts: {
                            ...client.all_accounts_balance.accounts,
                            [balance.loginid]: currentLoggedInBalance,
                        },
                    };
                    
                    // CRITICAL: If demo account balance updated, recalculate special CR account balances
                    // Check if this is the demo account used by special CR accounts
                    const isDemoAccountForSpecialCR = SPECIAL_CR_ACCOUNTS.some(
                        acc => acc.demoAccountId === balance.loginid
                    );
                    
                    if (isDemoAccountForSpecialCR) {
                        // Recalculate special CR account balances based on updated demo balance
                        const demoBalance = updatedBalance;
                        SPECIAL_CR_ACCOUNTS.forEach((specialAccount) => {
                            const { loginid, subtract } = specialAccount;
                            if (specialAccount.demoAccountId === balance.loginid) {
                                // Ensure account entry exists
                                if (!updatedAccounts.accounts[loginid]) {
                                    const accountInfo = client.account_list?.find(acc => acc.loginid === loginid);
                                    updatedAccounts.accounts[loginid] = {
                                        balance: 0,
                                        currency: accountInfo?.currency || 'USD',
                                        loginid: loginid,
                                    };
                                }
                                // Recalculate CR balance: demo_balance - subtract_amount
                                const calculatedBalance = demoBalance - subtract;
                                updatedAccounts.accounts[loginid].balance = calculatedBalance;
                                console.log(`[Balance Update] 💰 ${loginid} balance recalculated: ${demoBalance} - ${subtract} = ${calculatedBalance}`);
                            }
                        });
                    }
                    
                    client.setAllAccountsBalance(updatedAccounts);
                }
            }
        },
        [client, oAuthLogout]
    );

    useEffect(() => {
        if (!isAuthorizing && client) {
            const subscription = api_base?.api?.onMessage().subscribe(handleMessages);
            msg_listener.current = { unsubscribe: subscription?.unsubscribe };
        }

        return () => {
            if (msg_listener.current) {
                msg_listener.current.unsubscribe?.();
            }
        };
    }, [connectionStatus, handleMessages, isAuthorizing, isAuthorized, client]);

    useEffect(() => {
        if (!isAuthorizing && isAuthorized && !accountInitialization.current && client) {
            accountInitialization.current = true;
            api_base.api.getSettings().then((settingRes: TSocketResponseData<'get_settings'>) => {
                client?.setAccountSettings(settingRes.get_settings);
                const client_information: TClientInformation = {
                    loginid: activeAccount?.loginid,
                    email: settingRes.get_settings?.email,
                    currency: client?.currency,
                    residence: settingRes.get_settings?.residence,
                    first_name: settingRes.get_settings?.first_name,
                    last_name: settingRes.get_settings?.last_name,
                    preferred_language: settingRes.get_settings?.preferred_language,
                    user_id: ((api_base.account_info as any)?.user_id as number) || activeLoginid,
                    landing_company_shortcode: activeAccount?.landing_company_name,
                };

                Cookies.set('client_information', JSON.stringify(client_information), {
                    domain: currentDomain,
                });

                api_base.api
                    .landingCompany({
                        landing_company: settingRes.get_settings?.country_code,
                    })
                    .then((res: TSocketResponseData<'landing_company'>) => {
                        client?.setLandingCompany(res.landing_company as unknown as TLandingCompany);
                    });
            });

            api_base.api.getAccountStatus().then((res: TSocketResponseData<'get_account_status'>) => {
                client?.setAccountStatus(res.get_account_status);
            });
        }
    }, [isAuthorizing, isAuthorized, client]);

    return <>{children}</>;
});

export default CoreStoreProvider;
