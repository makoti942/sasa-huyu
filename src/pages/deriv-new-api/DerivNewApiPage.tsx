import React, { useCallback, useEffect, useRef, useState } from 'react';
import { logout } from '../../auth/DerivAuth.js';
import {
    connectPublicWebSocket,
    connectTradingWebSocket,
    fetchDerivAccounts,
    getAccountOtp,
    isAuthenticated,
} from '@/utils/deriv-rest-client';
import { startLogin, startSignup } from '@/utils/pkce';
import './DerivNewApiPage.scss';

type WsStatus = 'disconnected' | 'connecting' | 'open' | 'error' | 'closed';

const DerivNewApiPage: React.FC = () => {
    const [authed, setAuthed]             = useState<boolean | null>(null);
    const [loginLoading, setLoginLoading] = useState(false);
    const [loginError, setLoginError]     = useState('');
    const [accounts, setAccounts]         = useState<object | null>(null);
    const [accountsError, setAccountsError] = useState<string>('');
    const [accountsLoading, setAccountsLoading] = useState(false);

    const [selectedAccount, setSelectedAccount] = useState('');
    const [otpResult, setOtpResult]     = useState<object | null>(null);
    const [otpError, setOtpError]       = useState('');
    const [otpLoading, setOtpLoading]   = useState(false);

    const [wsStatus, setWsStatus]     = useState<WsStatus>('disconnected');
    const [wsMessages, setWsMessages] = useState<string[]>([]);
    const [wsInput, setWsInput]       = useState('{"ping":1}');
    const closeWsRef = useRef<(() => void) | null>(null);

    const [pubWsStatus, setPubWsStatus]     = useState<WsStatus>('disconnected');
    const [pubWsMessages, setPubWsMessages] = useState<string[]>([]);
    const closePubWsRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        setAuthed(isAuthenticated());
    }, []);

    const handleLogout = () => logout()

    const handleFetchAccounts = useCallback(async () => {
        setAccountsLoading(true);
        setAccountsError('');
        setAccounts(null);
        try {
            const data = await fetchDerivAccounts();
            setAccounts(data);
        } catch (e: any) {
            setAccountsError(e?.message ?? 'Failed to fetch accounts');
        } finally {
            setAccountsLoading(false);
        }
    }, []);

    const handleGetOtp = useCallback(async () => {
        if (!selectedAccount.trim()) {
            setOtpError('Please enter an account ID');
            return;
        }
        setOtpLoading(true);
        setOtpError('');
        setOtpResult(null);
        try {
            const data = await getAccountOtp(selectedAccount.trim());
            setOtpResult(data);
        } catch (e: any) {
            setOtpError(e?.message ?? 'OTP request failed');
        } finally {
            setOtpLoading(false);
        }
    }, [selectedAccount]);

    const handleConnectAuthWs = useCallback(() => {
        const wssUrl = (otpResult as any)?.data?.url;
        if (!wssUrl) {
            alert('Get an OTP first — it contains the wss:// URL.');
            return;
        }
        setWsStatus('connecting');
        setWsMessages([]);
        closeWsRef.current?.();
        closeWsRef.current = connectTradingWebSocket(
            wssUrl,
            (evt) => setWsMessages(prev => [...prev.slice(-49), evt.data]),
            (status) => setWsStatus(status as WsStatus)
        );
    }, [otpResult]);

    const handleSendAuthWs = useCallback(() => {
        alert('Use connectTradingWebSocket() ref to send messages (see deriv-rest-client.ts).');
    }, []);

    const handleConnectPublicWs = useCallback(() => {
        setPubWsStatus('connecting');
        setPubWsMessages([]);
        closePubWsRef.current?.();
        closePubWsRef.current = connectPublicWebSocket(
            (evt) => setPubWsMessages(prev => [...prev.slice(-49), evt.data]),
            (status) => setPubWsStatus(status as WsStatus)
        );
    }, []);

    const statusBadge = (s: WsStatus) => (
        <span className={`dna-ws-badge dna-ws-badge--${s}`}>{s}</span>
    );

    return (
        <div className='dna-page'>
            <h2 className='dna-title'>Deriv New API — OAuth2 PKCE Demo</h2>
            <p className='dna-sub'>
                This panel demonstrates the full Deriv OAuth2 Authorization Code + PKCE flow.
                Token exchange runs on the backend; your access token is stored in an httpOnly cookie.
            </p>

            {/* ── Auth status ── */}
            <section className='dna-section'>
                <h3>Authentication</h3>
                <div className='dna-row'>
                    <span className='dna-label'>Status:</span>
                    {authed === null && <span>Checking…</span>}
                    {authed === true  && <span className='dna-ok'>Authenticated (access token cookie present)</span>}
                    {authed === false && <span className='dna-err'>Not authenticated</span>}
                </div>
                <div className='dna-btn-row'>
                    <button
                        className='dna-btn dna-btn--primary'
                        disabled={loginLoading}
                        onClick={async (e) => {
                            e.preventDefault();
                            if (loginLoading) return;
                            setLoginLoading(true);
                            setLoginError('');
                            try {
                                await startLogin();
                                setLoginLoading(false);
                            } catch (err: any) {
                                setLoginLoading(false);
                                setLoginError(err?.message ?? 'Login failed to start. Please try again.');
                            }
                        }}
                    >
                        {loginLoading ? 'Preparing login…' : 'Login (new accounts)'}
                    </button>
                    {loginError && (
                        <span style={{ color: '#ef4444', fontSize: '13px', display: 'block', marginTop: '6px' }}>
                            {loginError}
                        </span>
                    )}
                    <button className='dna-btn dna-btn--outline' onClick={() => startSignup()}>
                        Sign up (new accounts)
                    </button>
                    {authed && (
                        <button className='dna-btn dna-btn--danger' onClick={handleLogout}>
                            Logout
                        </button>
                    )}
                </div>
            </section>

            {/* ── REST: fetch accounts ── */}
            <section className='dna-section'>
                <h3>REST — Options Accounts</h3>
                <p className='dna-hint'>
                    Calls <code>GET /api/trading/v1/options/accounts</code> (proxied via backend with Bearer token)
                </p>
                <button
                    className='dna-btn dna-btn--primary'
                    onClick={handleFetchAccounts}
                    disabled={accountsLoading}
                >
                    {accountsLoading ? 'Fetching…' : 'Fetch Accounts'}
                </button>
                {accountsError && <p className='dna-err'>{accountsError}</p>}
                {accounts && (
                    <pre className='dna-json'>{JSON.stringify(accounts, null, 2)}</pre>
                )}
            </section>

            {/* ── REST: OTP for authenticated WebSocket ── */}
            <section className='dna-section'>
                <h3>REST — Get OTP for Authenticated WebSocket</h3>
                <p className='dna-hint'>
                    Calls <code>POST /api/trading/v1/options/accounts/:id/otp</code>.<br />
                    The response <code>data.url</code> is a <code>wss://</code> URL you can connect to.
                </p>
                <div className='dna-row'>
                    <input
                        className='dna-input'
                        placeholder='Account ID (e.g. ACC-0001)'
                        value={selectedAccount}
                        onChange={e => setSelectedAccount(e.target.value)}
                    />
                    <button className='dna-btn dna-btn--primary' onClick={handleGetOtp} disabled={otpLoading}>
                        {otpLoading ? 'Requesting…' : 'Get OTP / WSS URL'}
                    </button>
                </div>
                {otpError && <p className='dna-err'>{otpError}</p>}
                {otpResult && (
                    <pre className='dna-json'>{JSON.stringify(otpResult, null, 2)}</pre>
                )}
            </section>

            {/* ── Authenticated WebSocket ── */}
            <section className='dna-section'>
                <h3>Authenticated Trading WebSocket</h3>
                <p className='dna-hint'>
                    Connects to the <code>wss://</code> URL returned by the OTP endpoint above.
                </p>
                <div className='dna-row'>
                    {statusBadge(wsStatus)}
                    <button className='dna-btn dna-btn--primary' onClick={handleConnectAuthWs} disabled={wsStatus === 'connecting'}>
                        {wsStatus === 'open' ? 'Reconnect' : 'Connect'}
                    </button>
                    {wsStatus === 'open' && (
                        <button className='dna-btn dna-btn--danger' onClick={() => { closeWsRef.current?.(); setWsStatus('disconnected'); }}>
                            Disconnect
                        </button>
                    )}
                </div>
                {wsMessages.length > 0 && (
                    <div className='dna-ws-log'>
                        {wsMessages.map((m, i) => <div key={i} className='dna-ws-msg'>{m}</div>)}
                    </div>
                )}
            </section>

            {/* ── Public WebSocket ── */}
            <section className='dna-section'>
                <h3>Public WebSocket (no auth)</h3>
                <p className='dna-hint'>
                    Connects to <code>wss://api.derivws.com/trading/v1/options/ws/public</code>
                </p>
                <div className='dna-row'>
                    {statusBadge(pubWsStatus)}
                    <button className='dna-btn dna-btn--primary' onClick={handleConnectPublicWs} disabled={pubWsStatus === 'connecting'}>
                        {pubWsStatus === 'open' ? 'Reconnect' : 'Connect'}
                    </button>
                    {pubWsStatus === 'open' && (
                        <button className='dna-btn dna-btn--danger' onClick={() => { closePubWsRef.current?.(); setPubWsStatus('disconnected'); }}>
                            Disconnect
                        </button>
                    )}
                </div>
                {pubWsMessages.length > 0 && (
                    <div className='dna-ws-log'>
                        {pubWsMessages.map((m, i) => <div key={i} className='dna-ws-msg'>{m}</div>)}
                    </div>
                )}
            </section>
        </div>
    );
};

export default DerivNewApiPage;
