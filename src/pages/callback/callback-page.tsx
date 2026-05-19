/**
 * /callback — PKCE OAuth2 callback handler.
 *
 * Handles the redirect from Deriv after the user logs in.
 * Reads ?code=&state= from the URL, verifies the state against
 * sessionStorage, then sends the code + verifier to the backend
 * (/api/oauth/exchange) for a secure server-side token exchange.
 *
 * The old Callback component from @deriv-com/auth-client (acct1/token1 URL
 * params) has been removed — all logins now go through this PKCE handler.
 */
import React, { useEffect, useState } from 'react';
import Cookies from 'js-cookie';
import { Button } from '@deriv-com/ui';
import { PKCE_VERIFIER_KEY, PKCE_STATE_KEY } from '@/utils/pkce';
import { getCallbackURL } from '@/components/shared/utils/config/config';

const CallbackPage = () => {
    const [status, setStatus]     = useState<'processing' | 'success' | 'error'>('processing');
    const [errorMsg, setErrorMsg] = useState('');

    useEffect(() => {
        let started = false;

        const run = async () => {
            if (started) return;
            started = true;

            const params = new URLSearchParams(window.location.search);

            // Surface any error Deriv sent back
            const derivError = params.get('error');
            if (derivError) {
                setErrorMsg(`Deriv error: ${params.get('error_description') ?? derivError}. Please go back and try again.`);
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
                setErrorMsg('Security check failed (state mismatch). Please go back and try again.');
                setStatus('error');
                return;
            }
            sessionStorage.removeItem(PKCE_STATE_KEY);

            // Retrieve code_verifier
            const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
            if (!codeVerifier) {
                setErrorMsg(
                    'Login session data is missing. This happens if you opened the login in a new tab ' +
                    'or if your browser blocks sessionStorage. Please go back and try again in the same tab.'
                );
                setStatus('error');
                return;
            }

            // Send code + verifier to backend for secure token exchange
            const redirectUri = getCallbackURL();
            let response: Response;
            try {
                response = await fetch('/api/oauth/exchange', {
                    method:      'POST',
                    headers:     { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body:        JSON.stringify({ code, codeVerifier, redirectUri }),
                });
            } catch {
                setErrorMsg('Network error during login. Please check your connection and try again.');
                setStatus('error');
                return;
            }

            if (!response.ok) {
                let errData: any = {};
                try { errData = await response.json(); } catch {}
                setErrorMsg(`Login failed: ${errData.error_description ?? errData.error ?? `HTTP ${response.status}`}`);
                setStatus('error');
                return;
            }

            const data = await response.json() as {
                success:        boolean;
                expires_in?:    number;
                account_id?:    string | null;
                legacy_tokens?: Record<string, string> | null;
            };

            // Clean up PKCE data
            sessionStorage.removeItem(PKCE_VERIFIER_KEY);

            // Set logged_state cookie for UI state tracking
            // Determine the base domain for cookie accessibility across subdomains.
            // For example, for 'app.deriv.com', this will be '.deriv.com'.
            // For 'localhost', it will be 'localhost'.
            let cookieDomain = window.location.hostname;
            if (window.location.hostname.includes('.') && !window.location.hostname.startsWith('localhost')) {
                cookieDomain = '.' + window.location.hostname.split('.').slice(-2).join('.');
            }
            Cookies.set('logged_state', 'true', {
                domain:  cookieDomain,
                expires: 30,
                path:    '/',
                secure:  window.location.protocol === 'https:',
                sameSite: 'lax'
            });

            // Ensure we have at least a placeholder loginid so AuthenticatedRoot doesn't bounce us
            if (!localStorage.getItem('active_loginid') && data.account_id) {
                localStorage.setItem('active_loginid', data.account_id);
            }

            // ── Populate localStorage from legacy tokens ──────────────────────────
            // The trading infrastructure needs authToken + accountsList in localStorage
            // to authorize the Deriv WebSocket connection (authorize: <token>).
            console.log('[callback] legacy_tokens received:', JSON.stringify(data.legacy_tokens));

            const lt = data.legacy_tokens;
            const hasTokens = lt && typeof lt === 'object' && (
                Object.keys(lt).some(k => k.startsWith('acct')) ||
                Array.isArray((lt as any).tokens)
            );

            if (hasTokens) {
                const accountsList:   Record<string, string>                                               = {};
                const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

                // Handle array format: { tokens: [{loginid, token, currency}] }
                if (Array.isArray((lt as any).tokens)) {
                    for (const entry of (lt as any).tokens as Array<{ loginid: string; token: string; currency?: string }>) {
                        if (entry.loginid && entry.token) {
                            accountsList[entry.loginid]   = entry.token;
                            clientAccounts[entry.loginid] = { loginid: entry.loginid, token: entry.token, currency: entry.currency ?? '' };
                        }
                    }
                } else {
                    // Handle flat format: { acct1, token1, cur1, acct2, token2, cur2, ... }
                    for (const [key, value] of Object.entries(lt as Record<string, string>)) {
                        if (key.startsWith('acct') && typeof value === 'string') {
                            const num      = key.replace('acct', '');
                            const tok      = (lt as any)[`token${num}`];
                            const currency = (lt as any)[`cur${num}`] ?? '';
                            if (tok) {
                                accountsList[value]   = tok;
                                clientAccounts[value] = { loginid: value, token: tok, currency };
                            }
                        }
                    }
                }

                const allIds      = Object.keys(accountsList);
                const demoId      = allIds.find(id => id.startsWith('VR'));
                const activeId    = demoId ?? allIds[0] ?? null;
                const activeToken = activeId ? accountsList[activeId] : null;

                console.log('[callback] parsed accounts:', allIds, '→ active:', activeId);

                if (activeId && activeToken) {
                    localStorage.setItem('accountsList',   JSON.stringify(accountsList));
                    localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
                    localStorage.setItem('authToken',      activeToken);
                    localStorage.setItem('active_loginid', activeId);
                } else {
                    console.warn('[callback] ⚠️ legacy_tokens present but no valid account parsed:', lt);
                }
            } else {
                // Legacy tokens unavailable — the api-base init() will recover them
                // from the httpOnly cookie via GET /api/auth/tokens on first load.
                console.warn('[callback] ⚠️ legacy_tokens null/empty — will recover via cookie on next load');
                if (data.account_id) {
                    localStorage.setItem('active_loginid', data.account_id);
                }
            }

            // Store Options REST account_id for OTP WebSocket flow
            if (data.account_id) {
                sessionStorage.setItem('deriv_account_id', data.account_id);
            }

            // Mark TMB as enabled so the app stays on the new auth path
            localStorage.setItem('is_tmb_enabled', 'true');

            setStatus('success');
            await new Promise(resolve => setTimeout(resolve, 800));
            window.location.href = '/';
        };

        run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (status === 'error') {
        return (
            <div style={{
                padding:    '40px',
                textAlign:  'center',
                maxWidth:   '520px',
                margin:     '80px auto',
                fontFamily: 'sans-serif',
            }}>
                <h2 style={{ color: '#e74c3c', marginBottom: '16px' }}>Login Failed</h2>
                <p style={{
                    color:      '#ccc',
                    margin:     '16px 0',
                    whiteSpace: 'pre-wrap',
                    textAlign:  'left',
                    background: '#1a1a1a',
                    padding:    '12px',
                    borderRadius: '8px',
                    fontSize:   '13px',
                }}>
                    {errorMsg}
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '16px' }}>
                    <Button onClick={() => window.location.href = '/'}>Try Again</Button>
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

export default CallbackPage;
