import React, { useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { crypto_currencies_display_order, fiat_currencies_display_order } from '@/components/shared';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';
import { clearAuthData } from '@/utils/auth-utils';
import { Callback } from '@deriv-com/auth-client';
import { Button } from '@deriv-com/ui';

const PKCE_LOCAL_STORAGE_KEY = 'pkce_verifier';
const PKCE_CLIENT_ID = '337DJLKi2OJ4VsyFSLIt9';
const PKCE_REDIRECT_URI = 'https://makotitraderss.vercel.app/callback';

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

const PkceCallbackHandler = () => {
    const [status, setStatus] = useState<'processing' | 'error'>('processing');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        const run = async () => {
            try {
                const params = new URLSearchParams(window.location.search);
                const code = params.get('code');
                const verifier = localStorage.getItem(PKCE_LOCAL_STORAGE_KEY);

                if (!code) throw new Error('No authorization code found in URL.');
                if (!verifier) throw new Error('PKCE verifier missing. Please try logging in again.');

                const tokenRes = await fetch('/api/token-exchange', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        code,
                        redirect_uri: PKCE_REDIRECT_URI,
                        client_id: PKCE_CLIENT_ID,
                        code_verifier: verifier,
                    }),
                });

                if (!tokenRes.ok) {
                    let errBody = '';
                    try { errBody = await tokenRes.text(); } catch (_) {}
                    throw new Error(`Token exchange failed (HTTP ${tokenRes.status}): ${errBody}`);
                }

                const tokenData = await tokenRes.json();
                const access_token = tokenData.access_token;
                if (!access_token) throw new Error('No access_token in token response.');

                localStorage.removeItem(PKCE_LOCAL_STORAGE_KEY);

                const legacyRes = await fetch('/api/legacy-tokens', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${access_token}` },
                });

                if (!legacyRes.ok) {
                    let errBody = '';
                    try { errBody = await legacyRes.text(); } catch (_) {}
                    throw new Error(`Legacy token fetch failed (HTTP ${legacyRes.status}): ${errBody}`);
                }

                const legacyData = await legacyRes.json();
                const tokens: Record<string, string> = legacyData.tokens ?? legacyData;

                const accountsList: Record<string, string> = {};
                const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

                for (const [key, value] of Object.entries(tokens)) {
                    if (key.startsWith('acct')) {
                        const tokenKey = key.replace('acct', 'token');
                        if (tokens[tokenKey]) {
                            accountsList[value] = tokens[tokenKey];
                            clientAccounts[value] = { loginid: value, token: tokens[tokenKey], currency: '' };
                        }
                    } else if (key.startsWith('cur')) {
                        const accKey = key.replace('cur', 'acct');
                        if (tokens[accKey] && clientAccounts[tokens[accKey]]) {
                            clientAccounts[tokens[accKey]].currency = value;
                        }
                    }
                }

                localStorage.setItem('accountsList', JSON.stringify(accountsList));
                localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
                localStorage.setItem('authToken', tokens.token1);
                localStorage.setItem('active_loginid', tokens.acct1);

                Cookies.set('logged_state', 'true', {
                    domain: window.location.hostname,
                    expires: 30,
                    path: '/',
                    secure: window.location.protocol === 'https:',
                });

                const selected_currency = getSelectedCurrency(tokens, clientAccounts, null);
                await new Promise(resolve => setTimeout(resolve, 100));
                window.location.replace(`${window.location.origin}/?account=${selected_currency}`);
            } catch (e: any) {
                console.error('[PKCE Callback]', e);
                const msg = e?.message ?? 'An unexpected error occurred.';
                setErrorMsg(msg + (e?.stack ? `\n\n${e.stack}` : ''));
                setStatus('error');
            }
        };

        run();
    }, []);

    if (status === 'error') {
        return (
            <div style={{ padding: '40px', textAlign: 'center' }}>
                <h2>Login failed</h2>
                <p style={{ color: '#e74c3c', margin: '16px 0' }}>{errorMsg}</p>
                <Button onClick={() => { window.location.href = '/'; }}>Return to App</Button>
            </div>
        );
    }

    return (
        <div style={{ padding: '40px', textAlign: 'center' }}>
            <p>Completing login, please wait…</p>
        </div>
    );
};

const CallbackPage = () => {
    const isPkceFlow = new URLSearchParams(window.location.search).has('code');

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
                        onClick={() => {
                            window.location.href = '/';
                        }}
                    >
                        {'Return to Bot'}
                    </Button>
                );
            }}
        />
    );
};

export default CallbackPage;
