import React, { useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { crypto_currencies_display_order, fiat_currencies_display_order } from '@/components/shared';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';
import { clearAuthData } from '@/utils/auth-utils';
import { Callback } from '@deriv-com/auth-client';
import { Button } from '@deriv-com/ui';
import { PKCE_VERIFIER_KEY, PKCE_STATE_KEY } from '@/utils/pkce';
import { getCallbackURL } from '@/components/shared/utils/config/config';

const getSelectedCurrency = (
    tokens: Record<string, string>,
    clientAccounts: Record<string, any>,
    state: any
): string => {
    const getQueryParams = new URLSearchParams(window.location.search);
    const currency =
        (state && state?.account) ||
        getQueryParams.get('account') ||
        sessionStorage.getItem('query_param_currency') ||
        '';
    const firstAccountKey = tokens.acct1;
    const firstAccountCurrency = clientAccounts[firstAccountKey]?.currency;

    const validCurrencies = [...fiat_currencies_display_order, ...crypto_currencies_display_order];
    if (tokens.acct1?.startsWith('VR') || currency === 'demo') return 'demo';
    if (currency && validCurrencies.includes(currency.toUpperCase())) return currency;
    return firstAccountCurrency || 'USD';
};

/* ─────────────────────────────────────────────────────────
   PKCE callback — handles ?code=... redirects from Deriv.
   Sends code + verifier to the backend for secure exchange.
   Backend stores access_token in httpOnly cookie.
───────────────────────────────────────────────────────── */
const PkceCallbackHandler = () => {
    const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        let started = false;

        const run = async () => {
            if (started) return;
            started = true;

            // Surface any error Deriv sent back
            const params = new URLSearchParams(window.location.search);
            const derivError = params.get('error');
            if (derivError) {
                const desc = params.get('error_description') ?? derivError;
                setErrorMsg(`Deriv error: ${desc}. Please go back and try again.`);
                setStatus('error');
                return;
            }

            // Parse code + state
            const code          = params.get('code');
            const returnedState = params.get('state');
            if (!code || !returnedState) {
                setErrorMsg('Login failed: Deriv did not return a valid response. Please go back and try again.');
                setStatus('error');
                return;
            }

            // CSRF / state check
            const savedState = sessionStorage.getItem(PKCE_STATE_KEY);
            if (!savedState) {
                setErrorMsg(
                    'Your session expired or the page was refreshed during login. ' +
                    'Please go back and try again.'
                );
                setStatus('error');
                return;
            }
            if (savedState !== returnedState) {
                setErrorMsg('Security check failed. Please go back and try again.');
                setStatus('error');
                return;
            }
            sessionStorage.removeItem(PKCE_STATE_KEY);

            // Retrieve code_verifier
            const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
            if (!codeVerifier) {
                setErrorMsg(
                    'Login session data is missing. This happens if you opened the login in a new ' +
                    'tab, or if your browser blocks sessionStorage. Please go back and try again in the same tab.'
                );
                setStatus('error');
                return;
            }

            // Send to backend for secure token exchange
            const redirectUri = getCallbackURL();
            let response: Response;
            try {
                response = await fetch('/api/oauth/exchange', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ code, codeVerifier, redirectUri }),
                });
            } catch (netErr: any) {
                setErrorMsg('Network error during login. Please check your connection and try again.');
                setStatus('error');
                return;
            }

            if (!response.ok) {
                let errData: any = {};
                try { errData = await response.json(); } catch {}
                const desc = errData.error_description || errData.error || `HTTP ${response.status}`;
                setErrorMsg(`Login failed: ${desc}`);
                setStatus('error');
                return;
            }

            const data = await response.json() as {
                success: boolean;
                expires_in?: number;
                account_id?: string | null;
            };

            // Clean up PKCE data
            sessionStorage.removeItem(PKCE_VERIFIER_KEY);

            // Set logged_state cookie for UI state tracking
            Cookies.set('logged_state', 'true', {
                domain:  window.location.hostname,
                expires: 30,
                path:    '/',
                secure:  window.location.protocol === 'https:',
            });

            // Store account_id for client-side use (non-sensitive)
            if (data.account_id) {
                sessionStorage.setItem('deriv_account_id', data.account_id);
                // Set active_loginid so legacy MobX stores (Journal, Balance, etc.) can find it
                localStorage.setItem('active_loginid', data.account_id);
                // Sentinel authToken so AuthenticatedRoot's localStorage fallback works
                localStorage.setItem('authToken', 'pkce_session');
            }

            setStatus('success');
            await new Promise(resolve => setTimeout(resolve, 1500));
            window.location.href = '/';
        };

        run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (status === 'error') {
        return (
            <div style={{
                padding: '40px',
                textAlign: 'center',
                maxWidth: '520px',
                margin: '0 auto',
                fontFamily: 'sans-serif',
            }}>
                <h2 style={{ color: '#e74c3c', marginBottom: '16px' }}>Login Failed</h2>
                <p style={{
                    color: '#ccc',
                    margin: '16px 0',
                    whiteSpace: 'pre-wrap',
                    textAlign: 'left',
                    background: '#1a1a1a',
                    padding: '12px',
                    borderRadius: '8px',
                    fontSize: '13px',
                }}>
                    {errorMsg}
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '16px' }}>
                    <Button onClick={() => { window.location.reload(); }}>Retry</Button>
                    <Button onClick={() => { window.location.href = '/'; }}>Return to App</Button>
                </div>
            </div>
        );
    }

    if (status === 'success') {
        return (
            <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'sans-serif' }}>
                <p style={{ color: '#10b981', fontSize: '16px' }}>✓ Login successful! Redirecting…</p>
            </div>
        );
    }

    return (
        <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'sans-serif' }}>
            <p style={{ color: '#aaa' }}>Completing login, please wait…</p>
        </div>
    );
};

/* ─────────────────────────────────────────────────────────
   Legacy callback — handles old Deriv OAuth redirects.
───────────────────────────────────────────────────────── */
const CallbackPage = () => {
    const isPkceFlow = new URLSearchParams(window.location.search).has('code') ||
                       new URLSearchParams(window.location.search).has('error');

    if (isPkceFlow) {
        return <PkceCallbackHandler />;
    }

    return (
        <Callback
            onSignInSuccess={async (tokens: Record<string, string>, rawState: unknown) => {
                const state = rawState as { account?: string } | null;
                const accountsList: Record<string, string> = {};
                const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

                for (const [key, value] of Object.entries(tokens)) {
                    if (key.startsWith('acct')) {
                        const tokenKey = key.replace('acct', 'token');
                        if (tokens[tokenKey]) {
                            accountsList[value] = tokens[tokenKey];
                            clientAccounts[value] = {
                                loginid: value,
                                token: tokens[tokenKey],
                                currency: '',
                            };
                        }
                    } else if (key.startsWith('cur')) {
                        const accKey = key.replace('cur', 'acct');
                        if (tokens[accKey]) {
                            clientAccounts[tokens[accKey]].currency = value;
                        }
                    }
                }

                localStorage.setItem('accountsList', JSON.stringify(accountsList));
                localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));

                let is_token_set = false;
                const api = await generateDerivApiInstance();
                if (api) {
                    const { authorize, error } = await api.authorize(tokens.token1);
                    api.disconnect();
                    if (error) {
                        if (error.code === 'InvalidToken') {
                            is_token_set = true;
                            const is_tmb_enabled = window.is_tmb_enabled === true;
                            if (Cookies.get('logged_state') === 'true' && !is_tmb_enabled) {
                                globalObserver.emit('InvalidToken', { error });
                            }
                            if (Cookies.get('logged_state') === 'false') {
                                clearAuthData();
                            }
                        }
                    } else {
                        localStorage.setItem('callback_token', authorize.toString());
                        const clientAccountsArray = Object.values(clientAccounts);
                        const firstId = authorize?.account_list[0]?.loginid;
                        const filteredTokens = clientAccountsArray.filter(account => account.loginid === firstId);
                        if (filteredTokens.length) {
                            localStorage.setItem('authToken', filteredTokens[0].token);
                            localStorage.setItem('active_loginid', filteredTokens[0].loginid);
                            is_token_set = true;
                        }
                    }
                }
                if (!is_token_set) {
                    localStorage.setItem('authToken', tokens.token1);
                    localStorage.setItem('active_loginid', tokens.acct1);
                }

                Cookies.set('logged_state', 'true', {
                    domain: window.location.hostname,
                    expires: 30,
                    path: '/',
                    secure: window.location.protocol === 'https:',
                });

                const selected_currency = getSelectedCurrency(tokens, clientAccounts, state);
                await new Promise(resolve => setTimeout(resolve, 100));
                window.location.replace(window.location.origin + `/?account=${selected_currency}`);
            }}
            renderReturnButton={() => {
                return (
                    <Button
                        className='callback-return-button'
                        onClick={() => { window.location.href = '/'; }}
                    >
                        {'Return to Bot'}
                    </Button>
                );
            }}
        />
    );
};

export default CallbackPage;
