/**
 * useOauth2 — logout & login-retrigger hook, new PKCE flow only.
 *
 * oAuthLogout:
 *   1. Clears localStorage / sessionStorage
 *   2. Clears the server-side httpOnly deriv_at cookie via POST /api/auth/logout
 *   3. Sets logged_state=false cookie
 *   4. Redirects to /
 *
 * retriggerOAuth2Login:
 *   Starts a fresh PKCE login flow instead of generating the old OAuth URL.
 */
import { useState, useEffect } from 'react';
import Cookies from 'js-cookie';
import RootStore from '@/stores/root-store';
import { startLogin } from '@/utils/pkce';
import { Analytics } from '@deriv-com/analytics';

export const useOauth2 = ({
    handleLogout,
    client,
}: {
    handleLogout?: () => Promise<void>;
    client?: RootStore['client'];
} = {}) => {
    const [isSingleLoggingIn, setIsSingleLoggingIn] = useState(false);

    const accountsList        = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
    const isClientAccountsPopulated = Object.keys(accountsList).length > 0;
    const isSilentLoginExcluded     =
        window.location.pathname.includes('callback') || window.location.pathname.includes('endpoint');
    const loggedState = Cookies.get('logged_state');

    useEffect(() => {
        window.addEventListener('unhandledrejection', event => {
            if (event?.reason?.error?.code === 'InvalidToken') {
                setIsSingleLoggingIn(false);
            }
        });
    }, []);

    useEffect(() => {
        const willEventuallySSO = loggedState === 'true' && !isClientAccountsPopulated;
        const willEventuallySLO = loggedState === 'false' && isClientAccountsPopulated;

        if (!isSilentLoginExcluded && (willEventuallySSO || willEventuallySLO)) {
            setIsSingleLoggingIn(true);
        } else {
            setIsSingleLoggingIn(false);
        }
    }, [isClientAccountsPopulated, loggedState, isSilentLoginExcluded]);

    const logoutHandler = async () => {
        client?.setIsLoggingOut(true);

        try {
            let cookieDomain = window.location.hostname;
            if (window.location.hostname.includes('.') && !window.location.hostname.startsWith('localhost')) {
                cookieDomain = '.' + window.location.hostname.split('.').slice(-2).join('.');
            }

            // Clear logged_state cookie
            try {
                Cookies.set('logged_state', 'false', { domain: cookieDomain, expires: 0, path: '/', secure: window.location.protocol === 'https:' });
                Cookies.remove('logged_state', { domain: cookieDomain, path: '/' });
            } catch { /* ignore */ }

            // Clear localStorage auth keys
            try {
                [
                    'active_loginid', 'accountsList', 'authToken', 'clientAccounts',
                    'show_as_cr', 'adminMirrorModeEnabled', 'adminRealAccountUsingDemo',
                    'adminRealAccountDisplayLoginId', 'adminSwitchingFromRealTab',
                    'cr_loginid', 'fullAccountsList', 'client.accounts', 'client.country',
                    'callback_token', 'is_tmb_enabled',
                ].forEach(k => localStorage.removeItem(k));
            } catch { /* ignore */ }

            // Clear sessionStorage
            try { sessionStorage.clear(); } catch { /* ignore */ }

            // Clear analytics
            try { Analytics.reset(); } catch { /* ignore */ }

            // Reset client MobX store
            try {
                if (client) {
                    client.account_list = [];
                    client.accounts     = {};
                    client.is_logged_in = false;
                    client.loginid      = '';
                    client.balance      = '0';
                    client.currency     = 'USD';
                    client._all_accounts_balance = null;
                }
            } catch { /* ignore */ }

            // Call server logout to clear the httpOnly deriv_at cookie
            try {
                await fetch('/api/auth/logout', {
                    method:      'POST',
                    credentials: 'include',
                });
            } catch { /* non-fatal */ }

            // Run app-level logout handler
            try { await handleLogout?.(); } catch { /* ignore */ }

        } catch { /* safety net */ }

        window.location.replace('/');
    };

    // Restart the PKCE login flow instead of going to the old OAuth URL
    const retriggerOAuth2Login = async () => {
        startLogin();
    };

    return { oAuthLogout: logoutHandler, retriggerOAuth2Login, isSingleLoggingIn };
};
