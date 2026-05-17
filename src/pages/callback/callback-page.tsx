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
            Cookies.set('logged_state', 'true', {
                domain:  window.location.hostname,
                expires: 30,
                path:    '/',
                secure:  window.location.protocol === 'https:',
            });

            // ── Populate localStorage from legacy tokens ──────────────────────────
            // The trading infrastructure needs authToken + accountsList in localStorage
            // to authorize the Deriv WebSocket connection (authorize: <token>).
            if (data.legacy_tokens && Object.keys(data.legacy_tokens).length > 0) {
                const lt = data.legacy_tokens;
                const accountsList:   Record<string, string>                                                         = {};
                const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

                for (const [key, value] of Object.entries(lt)) {
                    if (key.startsWith('acct')) {
                        const tokenKey = key.replace('acct', 'token');
                        if (lt[tokenKey]) {
                            accountsList[value]   = lt[tokenKey];
                            clientAccounts[value] = { loginid: value, token: lt[tokenKey], currency: '' };
                        }
                    } else if (key.startsWith('cur')) {
                        const loginId = lt[key.replace('cur', 'acct')];
                        if (loginId && clientAccounts[loginId]) {
                            clientAccounts[loginId].currency = value;
                        }
                    }
                }

                localStorage.setItem('accountsList',   JSON.stringify(accountsList));
                localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));

                // Prefer demo (VRTC) account as default active account
                const allIds      = Object.keys(accountsList);
                const demoId      = allIds.find(id => id.startsWith('VR'));
                const activeId    = demoId ?? allIds[0];
                const activeToken = activeId ? accountsList[activeId] : lt.token1;
                const loginId     = activeId ?? lt.acct1;

                if (loginId && activeToken) {
                    localStorage.setItem('authToken',      activeToken);
                    localStorage.setItem('active_loginid', loginId);
                }
            } else if (data.account_id) {
                // Fallback if legacy tokens are unavailable
                localStorage.setItem('active_loginid', data.account_id);
                localStorage.setItem('authToken',      'pkce_session');
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
