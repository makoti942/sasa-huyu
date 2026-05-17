'use strict';

const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const fetch        = require('node-fetch');

const app = express();
const PORT = 3001;

const DERIV_TOKEN_URL     = 'https://auth.deriv.com/oauth2/token';
const DERIV_REST_BASE     = 'https://api.derivws.com';
const CLIENT_ID           = '337DJLKi2OJ4VsyFSLIt9';
const DERIV_APP_ID        = '101585';
const ACCESS_TOKEN_COOKIE = 'deriv_at';
const ACCOUNT_ID_COOKIE   = 'deriv_account_id';

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/oauth/exchange
   Receives { code, codeVerifier, redirectUri } from the frontend.
   Exchanges for access_token, auto-fetches/creates an options account,
   and stores everything in httpOnly cookies — token never reaches the browser.
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/oauth/exchange', async (req, res) => {
    const { code, codeVerifier, redirectUri } = req.body;

    if (!code || !codeVerifier || !redirectUri) {
        return res.status(400).json({ error: 'Missing required parameters: code, codeVerifier, redirectUri' });
    }

    try {
        // Step 4: Exchange auth code for access_token
        const tokenRes = await fetch(DERIV_TOKEN_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type:    'authorization_code',
                client_id:     CLIENT_ID,
                code,
                code_verifier: codeVerifier,
                redirect_uri:  redirectUri,
            }).toString(),
        });

        const raw = await tokenRes.text();
        if (!tokenRes.ok) {
            return res.status(tokenRes.status).json({ error: raw });
        }

        let tokenData;
        try { tokenData = JSON.parse(raw); }
        catch { return res.status(500).json({ error: 'Unparseable token response' }); }

        if (tokenData.error) {
            return res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
        }

        const accessToken = tokenData.access_token;
        if (!accessToken) {
            return res.status(500).json({ error: 'No access_token in token response' });
        }

        const maxAge = (tokenData.expires_in || 3600) * 1000;

        // Store access_token in httpOnly cookie
        res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge,
            path:     '/',
        });

        // Step 5: Auto-fetch or create options account
        let accountId = null;
        try {
            const accountsRes = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Deriv-App-ID':  DERIV_APP_ID,
                },
            });

            if (accountsRes.ok) {
                const accountsData = await accountsRes.json();
                if (accountsData.data && accountsData.data.length > 0) {
                    const demo = accountsData.data.find(a => a.account_type === 'demo');
                    accountId  = (demo || accountsData.data[0]).id;
                } else {
                    // No accounts — create demo
                    const createRes = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
                        method:  'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Deriv-App-ID':  DERIV_APP_ID,
                            'Content-Type':  'application/json',
                        },
                        body: JSON.stringify({ currency: 'USD', group: 'row', account_type: 'demo' }),
                    });
                    if (createRes.ok) {
                        const createData = await createRes.json();
                        accountId = createData.data && createData.data.id ? createData.data.id : null;
                    }
                }
            }
        } catch (_) { /* non-fatal */ }

        if (accountId) {
            res.cookie(ACCOUNT_ID_COOKIE, accountId, {
                httpOnly: true,
                secure:   process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge,
                path:     '/',
            });
        }

        return res.json({ success: true, expires_in: tokenData.expires_in || 3600, account_id: accountId });
    } catch (err) {
        return res.status(500).json({ error: (err && err.message) || 'Token exchange failed' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/auth/token  (legacy — kept for backward compatibility)
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/auth/token', async (req, res) => {
    const { code, codeVerifier, redirectUri } = req.body;

    if (!code || !codeVerifier || !redirectUri) {
        return res.status(400).json({ error: 'Missing required parameters: code, codeVerifier, redirectUri' });
    }

    try {
        const tokenRes = await fetch(DERIV_TOKEN_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type:    'authorization_code',
                client_id:     CLIENT_ID,
                code,
                code_verifier: codeVerifier,
                redirect_uri:  redirectUri,
            }).toString(),
        });

        const raw = await tokenRes.text();
        if (!tokenRes.ok) return res.status(tokenRes.status).json({ error: raw });

        let tokenData;
        try { tokenData = JSON.parse(raw); }
        catch { return res.status(500).json({ error: 'Unparseable token response' }); }

        if (tokenData.error) {
            return res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
        }

        const accessToken = tokenData.access_token;
        if (!accessToken) return res.status(500).json({ error: 'No access_token in response' });

        const maxAge = (tokenData.expires_in || 3600) * 1000;
        res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
            httpOnly: true,
            secure:   process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge,
            path:     '/',
        });

        return res.json({ success: true, expires_in: tokenData.expires_in || 3600 });
    } catch (err) {
        return res.status(500).json({ error: (err && err.message) || 'Token exchange failed' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────────
   GET /api/auth/status
────────────────────────────────────────────────────────────────────────────── */
app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!req.cookies[ACCESS_TOKEN_COOKIE] });
});

/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/auth/logout
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(ACCOUNT_ID_COOKIE,   { path: '/' });
    res.json({ success: true });
});

/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/trading/otp
   Creates a one-time authenticated WebSocket URL for the active account.
   Returns { success, url } — the wss:// OTP URL for frontend WebSocket use.
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/trading/otp', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        return res.status(401).json({ error: 'Not authenticated — please log in first.' });
    }

    const bodyAccountId = req.body && req.body.accountId;
    const accountId     = bodyAccountId || req.cookies[ACCOUNT_ID_COOKIE];

    if (!accountId) {
        return res.status(400).json({ error: 'No account ID found. Please re-authenticate.' });
    }

    try {
        const otpRes = await fetch(
            `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`,
            {
                method:  'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Deriv-App-ID':  DERIV_APP_ID,
                },
            }
        );

        if (!otpRes.ok) {
            const errText = await otpRes.text();
            return res.status(otpRes.status).json({ error: errText });
        }

        const otpData = await otpRes.json();
        const otpUrl  = otpData.data && otpData.data.url;

        if (!otpUrl) {
            return res.status(500).json({ error: 'No OTP URL returned by Deriv' });
        }

        return res.json({ success: true, url: otpUrl });
    } catch (err) {
        return res.status(500).json({ error: (err && err.message) || 'OTP creation failed' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────────
   Specific trading account routes (listed before the wildcard proxy)
────────────────────────────────────────────────────────────────────────────── */
app.get('/api/trading/accounts', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const up = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Deriv-App-ID': DERIV_APP_ID },
        });
        return res.status(up.status).json(await up.json());
    } catch (err) {
        return res.status(502).json({ error: (err && err.message) || 'Upstream error' });
    }
});

app.post('/api/trading/accounts', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const up = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Deriv-App-ID':  DERIV_APP_ID,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify(req.body),
        });
        return res.status(up.status).json(await up.json());
    } catch (err) {
        return res.status(502).json({ error: (err && err.message) || 'Upstream error' });
    }
});

app.post('/api/trading/accounts/:accountId/reset-demo-balance', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) return res.status(401).json({ error: 'Not authenticated' });
    const { accountId } = req.params;
    try {
        const up = await fetch(
            `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/reset-demo-balance`,
            {
                method:  'POST',
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Deriv-App-ID': DERIV_APP_ID },
            }
        );
        return res.status(up.status).json(await up.json());
    } catch (err) {
        return res.status(502).json({ error: (err && err.message) || 'Upstream error' });
    }
});

/* ──────────────────────────────────────────────────────────────────────────────
   Generic REST proxy — all other /api/trading/* calls
   Adds Authorization + Deriv-App-ID headers automatically.
────────────────────────────────────────────────────────────────────────────── */
app.use('/api/trading', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        return res.status(401).json({ error: 'Not authenticated — please log in first.' });
    }

    const method   = req.method;
    const queryStr = Object.keys(req.query).length
        ? '?' + new URLSearchParams(req.query).toString()
        : '';
    const url = `${DERIV_REST_BASE}/trading${req.url.split('?')[0]}${queryStr}`;

    try {
        const upstream = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/json',
                'Deriv-App-ID':  DERIV_APP_ID,
            },
            body: ['POST', 'PUT', 'PATCH'].includes(method) ? JSON.stringify(req.body) : undefined,
        });

        let data;
        try   { data = await upstream.json(); }
        catch { data = { raw: await upstream.text() }; }

        return res.status(upstream.status).json(data);
    } catch (err) {
        return res.status(502).json({ error: (err && err.message) || 'Upstream request failed' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Deriv API backend ready on port ${PORT}`);
});
