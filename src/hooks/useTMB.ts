import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Cookies from 'js-cookie';
import { removeCookies } from '@/components/shared/utils/storage/storage';
import { api_base } from '@/external/bot-skeleton';
import { setAuthData } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { TAuthData } from '@/types/api-types';
import { requestSessionActive } from '@deriv-com/auth-client';

// Extend Window interface to include is_tmb_enabled property
declare global {
    interface Window {
        is_tmb_enabled?: boolean;
    }
}

type UseTMBReturn = {
    handleLogout: () => void;
    isOAuth2Enabled: boolean;
    is_tmb_enabled: boolean;
    onRenderTMBCheck: (fromLoginButton?: boolean, setIsAuthenticating?: (value: boolean) => void, is_new_account?: boolean) => Promise<void>;
    isTmbEnabled: () => Promise<boolean>;
    isInitialized: boolean;
    isTmbCheckComplete: boolean;
};

interface TokenItem {
    loginid?: string;
    token?: string;
    cur?: string;
}

interface TMBWebsocketTokens {
    active: boolean;
    tokens: TokenItem[];
    [key: string]: any;
}

const TMBState = {
    isInitialized: false,
    checkInProgress: false,
};

const useTMB = (): UseTMBReturn => {
    const hasLoggedRef = useRef(false);

    if (!hasLoggedRef.current) {
        hasLoggedRef.current = true;
    }

    // const isEndpointPage = useMemo(() => window.location.pathname.includes('endpoint'), []);
    const isCallbackPage = useMemo(() => window.location.pathname === '/callback', []);
    const domains = useMemo(
        () => ['deriv.com', 'deriv.dev', 'binary.sx', 'pages.dev', 'localhost', 'deriv.be', 'deriv.me'],
        []
    );
    const currentDomain = useMemo(() => window.location.hostname.split('.').slice(-2).join('.'), []);

    const is_staging = useMemo(() => window.location.hostname.includes('staging'), []);
    const is_production = useMemo(() => !is_staging, [is_staging]);
    const isOAuth2Enabled = useMemo(() => is_production || is_staging, [is_production, is_staging]);
    const [is_tmb_enabled, setIsTmbEnabled] = useState(false);
    const [, setIsApiInitialized] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);
    const [isTmbCheckComplete, setIsTmbCheckComplete] = useState(false);
    const authTokenRef = useRef(localStorage.getItem('authToken'));
    const activeSessionsRef = useRef<TMBWebsocketTokens | undefined>(undefined);

    // DISABLED - replaced by DerivAuth.js
    // const getActiveSessions = useCallback(async (): Promise<TMBWebsocketTokens | undefined> => {
    //     try {
    //         return (await requestSessionActive()) as TMBWebsocketTokens;
    //     } catch (error) {
    //         console.error('Failed to get active sessions', error);
    //         return undefined;
    //     }
    // }, []);

    // DISABLED - replaced by DerivAuth.js
    // const processTokens = useCallback((tokens: TokenItem[]) => {
    //     const accountsList: Record<string, string> = {};
    //     const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

    //     tokens.forEach((token: TokenItem) => {
    //         if (token.loginid && token.token) {
    //             accountsList[token.loginid] = token.token;
    //             clientAccounts[token.loginid] = {
    //                 loginid: token.loginid,
    //                 token: token.token,
    //                 currency: token.cur || '',
    //             };
    //         }
    //     });

    //     return { accountsList, clientAccounts };
    // }, []);

    // Use a ref to track if we've already determined TMB status
    const tmbStatusDeterminedRef = useRef(false);
    const tmbStatusPromiseRef = useRef<Promise<boolean> | null>(null);

    const isTmbEnabled = useCallback(async () => {
        // If we've already determined the status, return the cached value
        if (tmbStatusDeterminedRef.current) {
            return window.is_tmb_enabled === true;
        }

        // If we're already in the process of determining the status, wait for that promise
        if (tmbStatusPromiseRef.current) {
            return tmbStatusPromiseRef.current;
        }

        // Create a new promise to determine the status
        tmbStatusPromiseRef.current = (async () => {
            try {
                // Check if we have a manually set value in localStorage
                const storedValue = localStorage.getItem('is_tmb_enabled');

                // If localStorage value is explicitly set, use that value
                if (storedValue === 'true') {
                    window.is_tmb_enabled = true;
                    setIsTmbEnabled(true);
                    tmbStatusDeterminedRef.current = true;
                    return true;
                } else if (storedValue === 'false') {
                    window.is_tmb_enabled = false;
                    setIsTmbEnabled(false);
                    tmbStatusDeterminedRef.current = true;
                    return false;
                }

                // Otherwise, use the API value
                const url = is_staging
                    ? 'https://app-config-staging.firebaseio.com/remote_config/oauth/is_tmb_enabled.json'
                    : 'https://app-config-prod.firebaseio.com/remote_config/oauth/is_tmb_enabled.json';
                const response = await fetch(url);
                const result = await response.json();

                const isEnabled = !!result.dbot;

                // Update window property with API value and mark as determined
                window.is_tmb_enabled = isEnabled;
                setIsTmbEnabled(isEnabled);
                tmbStatusDeterminedRef.current = true;
                return isEnabled;
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error(e);

                // Check if we have a manually set value in localStorage
                const storedValue = localStorage.getItem('is_tmb_enabled');

                // If localStorage value is explicitly set, use that value
                if (storedValue === 'true') {
                    window.is_tmb_enabled = true;
                    setIsTmbEnabled(true);
                    tmbStatusDeterminedRef.current = true;
                    return true;
                } else if (storedValue === 'false') {
                    window.is_tmb_enabled = false;
                    setIsTmbEnabled(false);
                    tmbStatusDeterminedRef.current = true;
                    return false;
                }

                // By default it will fallback to false if firebase error happens
                window.is_tmb_enabled = false;
                setIsTmbEnabled(false);
                tmbStatusDeterminedRef.current = true;
                return false;
            }
        })();

        return tmbStatusPromiseRef.current;
    }, [is_staging]);

    // DISABLED - replaced by DerivAuth.js
    // useEffect(() => {
    //     if (TMBState.isInitialized) {
    //         return;
    //     }

    //     TMBState.isInitialized = true;

    //     setIsInitialized(false);
    //     setIsTmbCheckComplete(false);

    //     const safetyTimeout = setTimeout(() => {
    //         setIsInitialized(true);
    //         setIsTmbCheckComplete(true);
    //     }, 2500);

    //     const initializeHook = async () => {
    //         try {
    //             if (!isCallbackPage && window.is_tmb_enabled) {
    //                 try {
    //                     const activeSessions = await getActiveSessions();
    //                     activeSessionsRef.current = activeSessions;

    //                     if (
    //                         activeSessions?.active &&
    //                         Array.isArray(activeSessions.tokens) &&
    //                         activeSessions.tokens.length > 0
    //                     ) {
    //                         const { accountsList, clientAccounts } = processTokens(activeSessions.tokens);
    //                         localStorage.setItem('accountsList', JSON.stringify(accountsList));
    //                         localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
    //                     }
    //                 } catch (error) {
    //                     console.error('Failed to pre-fetch active sessions:', error);
    //                 } finally {
    //                     setIsApiInitialized(true);
    //                 }
    //             } else {
    //                 setIsApiInitialized(true);
    //             }

    //             setIsInitialized(true);
    //             setIsTmbCheckComplete(true);

    //             clearTimeout(safetyTimeout);
    //         } catch (error) {
    //             console.error('Failed to initialize TMB hook:', error);
    //             setIsInitialized(true);
    //             setIsTmbCheckComplete(true);

    //             clearTimeout(safetyTimeout);
    //         }
    //     };

    //     initializeHook();

    //     return () => {
    //         clearTimeout(safetyTimeout);
    //     };
    // }, [isTmbEnabled, isCallbackPage, processTokens, getActiveSessions]);

    // DISABLED - replaced by DerivAuth.js
    // const logout = useCallback(async () => {
    //     try {
    //         localStorage.removeItem('authToken');
    //         localStorage.removeItem('active_loginid');
    //         localStorage.removeItem('clientAccounts');
    //         localStorage.removeItem('accountsList');
    //         window.location.reload();
    //     } catch (error) {
    //         console.error('Failed to logout:', error);
    //         return handleLogout();
    //     }
    // }, []);

    // DISABLED - replaced by DerivAuth.js
    // const handleLogout = useCallback(async () => {
    //     try {
    //         if (authTokenRef.current) await logout();
    //     } catch (error) {
    //         console.error('Failed to logout', error);
    //     }
    //     removeCookies('affiliate_token', 'affiliate_tracking', 'utm_data', 'onfido_token', 'gclid');
    //     if (domains.includes(currentDomain)) {
    //         Cookies.set('logged_state', 'false', {
    //             domain: currentDomain,
    //             expires: 30,
    //             path: '/',
    //             secure: true,
    //         });
    //     }
    // }, [logout, domains, currentDomain]);

    // Get account from URL query parameter
    const getAccountFromURL = useCallback(() => {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('account');
    }, []);

    // DISABLED - replaced by DerivAuth.js
    // const onRenderTMBCheck = useCallback(
    //     async (fromLoginButton?: boolean, setIsAuthenticating?: (value: boolean) => void, is_new_account = false) => {
    //         if (isCallbackPage) return;
    //         if (TMBState.checkInProgress) return;

    //         TMBState.checkInProgress = true;

    //         try {
    //             if (!window.is_tmb_enabled) {
    //                 console.warn('TMB is not enabled, skipping TMB check');
    //                 return;
    //             }
    //             let activeSessions = activeSessionsRef.current;

    //             if (!activeSessions && window.is_tmb_enabled) {
    //                 activeSessions = await getActiveSessions();
    //                 activeSessionsRef.current = activeSessions;
    //             }

    //             if (!activeSessions?.active && fromLoginButton) {
    //                 console.log('[TMB]: Failed to get active sessions: No data returned');
    //                 TMBState.checkInProgress = false;
    //                 if (setIsAuthenticating) {
    //                     setIsAuthenticating(false);
    //                 }
    //                 try {
    //                     window.location.replace(generateOAuthURL(is_new_account, 'home'));
    //                 } catch (error) {
    //                     console.error('Failed to redirect to OAuth:', error);
    //                     if (setIsAuthenticating) {
    //                         setIsAuthenticating(false);
    //                     }
    //                     return handleLogout();
    //                 }
    //                 return;
    //             } else if (activeSessions?.active) {
    //                 if (Array.isArray(activeSessions.tokens) && activeSessions.tokens.length > 0) {
    //                     const { accountsList, clientAccounts } = processTokens(activeSessions.tokens);

    //                     localStorage.setItem('accountsList', JSON.stringify(accountsList));
    //                     localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));

    //                     const accountParam = getAccountFromURL();

    //                     let selectedToken = activeSessions.tokens[0];
    //                     if (accountParam) {
    //                         if (accountParam === 'demo') {
    //                             const demoToken = activeSessions.tokens.find(
    //                                 (token: TokenItem) => token.loginid && token.loginid.includes('VR')
    //                             );
    //                             if (demoToken) {
    //                                 selectedToken = demoToken;
    //                             }
    //                         } else {
    //                             const matchingToken = activeSessions.tokens.find(
    //                                 (token: TokenItem) => token.cur === accountParam
    //                             );
    //                             if (matchingToken) {
    //                                 selectedToken = matchingToken;
    //                             }
    //                         }
    //                     }

    //                     if (selectedToken.loginid && selectedToken.token) {
    //                         localStorage.setItem('authToken', selectedToken.token);
    //                         localStorage.setItem('active_loginid', selectedToken.loginid);

    //                         authTokenRef.current = selectedToken.token;

    //                         if (api_base) {
    //                             api_base.init(true).then(() => {
    //                                 if (selectedToken.loginid) {
    //                                     setAuthData({
    //                                         loginid: selectedToken.loginid,
    //                                         currency: selectedToken.cur || '',
    //                                         token: selectedToken.token,
    //                                     } as TAuthData & { token: string });
    //                                 }
    //                             });
    //                         }
    //                     }
    //                 }

    //                 if (domains.includes(currentDomain)) {
    //                     Cookies.set('logged_state', 'true', {
    //                         domain: currentDomain,
    //                         expires: 30,
    //                         path: '/',
    //                         secure: true,
    //                     });
    //                 }
    //             }
    //         } finally {
    //             TMBState.checkInProgress = false;
    //             if (setIsAuthenticating) {
    //                 setIsAuthenticating(false);
    //             }
    //         }
    //     },
    //     [isCallbackPage, getActiveSessions, handleLogout, processTokens, domains, currentDomain]
    // );

    return useMemo(
        () => ({
            handleLogout,
            isOAuth2Enabled,
            is_tmb_enabled,
            onRenderTMBCheck,
            isTmbEnabled,
            isInitialized,
            isTmbCheckComplete,
        }),
        [
            handleLogout,
            isOAuth2Enabled,
            is_tmb_enabled,
            onRenderTMBCheck,
            isTmbEnabled,
            isInitialized,
            isTmbCheckComplete,
        ]
    );
};

export default useTMB;
