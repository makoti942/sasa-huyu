/**
 * Auth utility helpers.
 * Clears all token state from both the new sessionStorage system
 * and the legacy localStorage system, then reloads.
 */

export const clearAuthData = (): void => {
    // New system (sessionStorage)
    sessionStorage.removeItem('deriv_access_token');
    sessionStorage.removeItem('deriv_token_expiry');
    sessionStorage.removeItem('deriv_code_verifier');
    sessionStorage.removeItem('deriv_oauth_state');

    // Legacy system (localStorage)
    const legacyKeys = [
        'accountsList', 'clientAccounts', 'callback_token',
        'authToken', 'active_loginid', 'client.accounts', 'client.country',
    ];
    legacyKeys.forEach(k => { try { localStorage.removeItem(k); } catch { /**/ } });

    location.reload();
};

export const handleOidcAuthFailure = (error: unknown): void => {
    console.error('Auth failure:', error);
    clearAuthData();
};
