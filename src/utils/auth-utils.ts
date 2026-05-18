/**
 * Authentication utility functions — PKCE flow.
 *
 * clearAuthData: wipes all client-side auth state AND the server-side httpOnly
 * deriv_at cookie, then reloads the page.
 *
 * handleOidcAuthFailure: logs and clears auth state when the OIDC/PKCE
 * exchange fails, returning the user to the login screen.
 */
import Cookies from 'js-cookie';

const AUTH_LS_KEYS = [
    'authToken',
    'active_loginid',
    'clientAccounts',
    'accountsList',
    'callback_token',
    'client.accounts',
    'client.country',
    'is_tmb_enabled',
];

/**
 * Clears all authentication data (local storage, session storage, cookies)
 * and the server-side httpOnly cookie, then reloads the page.
 */
export const clearAuthData = async (): Promise<void> => {
    // Clear local storage auth keys
    AUTH_LS_KEYS.forEach(k => {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
    });

    // Clear session storage
    try { sessionStorage.clear(); } catch { /* ignore */ }

    // Set logged_state to false
    try {
        const domain = window.location.hostname.split('.').slice(-2).join('.');
        Cookies.set('logged_state', 'false', { domain, expires: 0, path: '/', secure: window.location.protocol === 'https:' });
        Cookies.remove('logged_state', { domain, path: '/' });
    } catch { /* ignore */ }

    // Clear server-side httpOnly deriv_at cookie
    try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch { /* non-fatal — server might be unavailable */ }

    window.location.reload();
};

/**
 * Handles PKCE/OIDC auth failures: clears local auth state and reloads
 * so the user sees the login screen.
 */
export const handleOidcAuthFailure = (error: unknown): void => {
    console.error('OIDC authentication failed:', error);

    AUTH_LS_KEYS.forEach(k => {
        try { localStorage.removeItem(k); } catch { /* ignore */ }
    });

    try {
        const domain = window.location.hostname.split('.').slice(-2).join('.');
        Cookies.set('logged_state', 'false', { domain, expires: 0, path: '/', secure: window.location.protocol === 'https:' });
    } catch { /* ignore */ }

    window.location.reload();
};
