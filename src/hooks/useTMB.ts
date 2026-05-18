/**
 * useTMB — auth state hook, new PKCE flow only.
 *
 * The old TMB cross-domain SSO (requestSessionActive from @deriv-com/auth-client)
 * and the old OAuth URL builder (generateOAuthURL) have been removed.
 * Login is now always initiated via startLogin() (PKCE) and session state is
 * checked via our /api/auth/status endpoint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Cookies from 'js-cookie';
import { removeCookies } from '@/components/shared/utils/storage/storage';
import { startLogin, startSignup } from '@/utils/pkce';

declare global {
    interface Window { is_tmb_enabled?: boolean; }
}

type UseTMBReturn = {
    handleLogout:      () => void;
    isOAuth2Enabled:   boolean;
    is_tmb_enabled:    boolean;
    onRenderTMBCheck:  (fromLoginButton?: boolean, setIsAuthenticating?: (v: boolean) => void, is_new_account?: boolean) => Promise<void>;
    isTmbEnabled:      () => Promise<boolean>;
    isInitialized:     boolean;
    isTmbCheckComplete: boolean;
};

// Module-level state — initialized once across all mounts
const TMBState = { isInitialized: false, checkInProgress: false };

const useTMB = (): UseTMBReturn => {
    const isCallbackPage = useMemo(() => window.location.pathname === '/callback', []);
    const domains = useMemo(
        () => ['deriv.com', 'deriv.dev', 'binary.sx', 'pages.dev', 'localhost', 'deriv.be', 'deriv.me'],
        []
    );
    const currentDomain = useMemo(() => window.location.hostname.split('.').slice(-2).join('.'), []);

    // Always treat TMB as enabled so the app routes through the new PKCE path
    const [is_tmb_enabled, setIsTmbEnabled] = useState(true);
    const [isInitialized, setIsInitialized] = useState(false);
    const [isTmbCheckComplete, setIsTmbCheckComplete] = useState(false);
    const isOAuth2Enabled = true;

    // Always returns true — we are permanently on the new PKCE flow
    const isTmbEnabled = useCallback(async (): Promise<boolean> => {
        window.is_tmb_enabled = true;
        setIsTmbEnabled(true);
        return true;
    }, []);

    useEffect(() => {
        if (TMBState.isInitialized) return;
        TMBState.isInitialized = true;

        window.is_tmb_enabled = true;
        localStorage.setItem('is_tmb_enabled', 'true');

        setIsInitialized(true);
        setIsTmbCheckComplete(true);
    }, []);

    const handleLogout = useCallback(async () => {
        try {
            localStorage.removeItem('authToken');
            localStorage.removeItem('active_loginid');
            localStorage.removeItem('clientAccounts');
            localStorage.removeItem('accountsList');
        } catch { /* ignore */ }

        removeCookies('affiliate_token', 'affiliate_tracking', 'utm_data', 'onfido_token', 'gclid');

        if (domains.includes(currentDomain)) {
            Cookies.set('logged_state', 'false', {
                domain:  currentDomain,
                expires: 30,
                path:    '/',
                secure:  true,
            });
        }

        // Clear server-side httpOnly cookie
        try {
            await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        } catch { /* non-fatal */ }
    }, [domains, currentDomain]);

    /**
     * Called when the user triggers login (e.g. from old header login buttons).
     * With the new PKCE flow this just kicks off startLogin() / startSignup().
     */
    const onRenderTMBCheck = useCallback(
        async (fromLoginButton?: boolean, setIsAuthenticating?: (v: boolean) => void, is_new_account = false) => {
            if (isCallbackPage) return;
            if (TMBState.checkInProgress) return;
            TMBState.checkInProgress = true;

            try {
                if (fromLoginButton) {
                    if (is_new_account) startSignup();
                    else               startLogin();
                }
            } finally {
                TMBState.checkInProgress = false;
                setIsAuthenticating?.(false);
            }
        },
        [isCallbackPage]
    );

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
        [handleLogout, is_tmb_enabled, onRenderTMBCheck, isTmbEnabled, isInitialized, isTmbCheckComplete]
    );
};

export default useTMB;
