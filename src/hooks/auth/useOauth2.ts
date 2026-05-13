import { useState, useEffect } from 'react';
import RootStore from '@/stores/root-store';
import { logout, isLoggedIn } from '@/utils/auth';
import { Analytics } from '@deriv-com/analytics';

/**
 * Provides oAuthLogout, retriggerOAuth2Login, isSingleLoggingIn.
 *
 * Backed by the new PKCE Bearer-token auth system (auth.ts).
 * No more OAuth2Logout from @deriv-com/auth-client, no more logged_state cookie.
 */
export const useOauth2 = ({
    handleLogout,
    client,
}: {
    handleLogout?: () => Promise<void>;
    client?: RootStore['client'];
} = {}) => {
    const [isSingleLoggingIn, setIsSingleLoggingIn] = useState(false);
    const isSilentLoginExcluded =
        window.location.pathname.includes('callback') ||
        window.location.pathname.includes('endpoint');

    useEffect(() => {
        window.addEventListener('unhandledrejection', event => {
            if (event?.reason?.error?.code === 'InvalidToken') {
                setIsSingleLoggingIn(false);
            }
        });
    }, []);

    useEffect(() => {
        const accountsList   = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
        const hasLegacyAccts = Object.keys(accountsList).length > 0;
        const loggedIn       = isLoggedIn();

        // If session token exists but no legacy accounts yet → SSO in progress
        const willEventuallySSO = loggedIn && !hasLegacyAccts;
        if (!isSilentLoginExcluded && willEventuallySSO) {
            setIsSingleLoggingIn(true);
        } else {
            setIsSingleLoggingIn(false);
        }
    }, [isSilentLoginExcluded]);

    const logoutHandler = async () => {
        client?.setIsLoggingOut?.(true);

        try {
            try { Analytics.reset(); } catch { /**/ }

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
            } catch { /**/ }

            if (handleLogout) {
                await handleLogout().catch(() => {});
            }
        } catch { /**/ }

        logout(); // clears sessionStorage + localStorage, redirects to /
    };

    const retriggerOAuth2Login = async () => {
        const { startLogin } = await import('@/utils/auth');
        await startLogin();
    };

    return { oAuthLogout: logoutHandler, retriggerOAuth2Login, isSingleLoggingIn };
};
