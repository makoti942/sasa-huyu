"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const app = (0, express_1.default)();
const PORT = 3001;
const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const DERIV_REST_BASE = 'https://api.derivws.com';
const CLIENT_ID = '337DJLKi2OJ4VsyFSLIt9';
const DERIV_APP_ID = '101585';
const ACCESS_TOKEN_COOKIE = 'deriv_at';
const ACCOUNT_ID_COOKIE = 'deriv_account_id';
app.use((0, cors_1.default)({ origin: true, credentials: true }));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/oauth/exchange
   Receives { code, codeVerifier, redirectUri } from the frontend callback page.
   Exchanges for access_token with Deriv, then auto-fetches (or creates) an
   options account and stores everything in httpOnly cookies.
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/oauth/exchange', async (req, res) => {
    const { code, codeVerifier, redirectUri } = req.body;
    if (!code || !codeVerifier || !redirectUri) {
        res.status(400).json({ error: 'Missing required parameters: code, codeVerifier, redirectUri' });
        return;
    }
    try {
        // Step 4: Exchange auth code for access_token
        const tokenRes = await (0, node_fetch_1.default)(DERIV_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                code,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
            }).toString(),
        });
        const raw = await tokenRes.text();
        if (!tokenRes.ok) {
            res.status(tokenRes.status).json({ error: raw });
            return;
        }
        const tokenData = JSON.parse(raw);
        if (tokenData.error) {
            res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
            return;
        }
        const accessToken = tokenData.access_token;
        if (!accessToken) {
            res.status(500).json({ error: 'No access_token in token response' });
            return;
        }
        const maxAge = (tokenData.expires_in ?? 3600) * 1000;
        // Store access_token in httpOnly cookie (never sent to browser JS)
        res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge,
            path: '/',
        });
        // Step 5: Auto-fetch or create options account
        let accountId = null;
        try {
            const accountsRes = await (0, node_fetch_1.default)(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Deriv-App-ID': DERIV_APP_ID,
                },
            });
            if (accountsRes.ok) {
                const accountsData = await accountsRes.json();
                if (accountsData.data && accountsData.data.length > 0) {
                    // Prefer demo account, otherwise use first account
                    const demoAccount = accountsData.data.find(a => a.account_type === 'demo');
                    accountId = (demoAccount ?? accountsData.data[0]).id;
                }
                else {
                    // No accounts yet — create a demo account
                    const createRes = await (0, node_fetch_1.default)(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Deriv-App-ID': DERIV_APP_ID,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ currency: 'USD', group: 'row', account_type: 'demo' }),
                    });
                    if (createRes.ok) {
                        const createData = await createRes.json();
                        accountId = createData.data?.id ?? null;
                    }
                }
            }
        }
        catch {
            // Non-fatal: account_id will be fetched lazily later
        }
        // Store account_id in httpOnly cookie
        if (accountId) {
            res.cookie(ACCOUNT_ID_COOKIE, accountId, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge,
                path: '/',
            });
        }
        res.json({
            success: true,
            expires_in: tokenData.expires_in ?? 3600,
            account_id: accountId,
        });
    }
    catch (err) {
        res.status(500).json({ error: err?.message ?? 'Token exchange failed' });
    }
});
/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/auth/token  (legacy — kept for backward compatibility)
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/auth/token', async (req, res) => {
    const { code, codeVerifier, redirectUri } = req.body;
    if (!code || !codeVerifier || !redirectUri) {
        res.status(400).json({ error: 'Missing required parameters: code, codeVerifier, redirectUri' });
        return;
    }
    try {
        const tokenRes = await (0, node_fetch_1.default)(DERIV_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                code,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
            }).toString(),
        });
        const raw = await tokenRes.text();
        if (!tokenRes.ok) {
            res.status(tokenRes.status).json({ error: raw });
            return;
        }
        const tokenData = JSON.parse(raw);
        if (tokenData.error) {
            res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
            return;
        }
        const accessToken = tokenData.access_token;
        if (!accessToken) {
            res.status(500).json({ error: 'No access_token in token response' });
            return;
        }
        const maxAge = (tokenData.expires_in ?? 3600) * 1000;
        res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge,
            path: '/',
        });
        res.json({ success: true, expires_in: tokenData.expires_in ?? 3600 });
    }
    catch (err) {
        res.status(500).json({ error: err?.message ?? 'Token exchange failed' });
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
    res.clearCookie(ACCOUNT_ID_COOKIE, { path: '/' });
    res.json({ success: true });
});
/* ──────────────────────────────────────────────────────────────────────────────
   POST /api/trading/otp
   Creates a one-time-use authenticated WebSocket URL for the active account.
   Returns { success, url } where url is the wss:// OTP URL for trading.
────────────────────────────────────────────────────────────────────────────── */
app.post('/api/trading/otp', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        res.status(401).json({ error: 'Not authenticated — please log in first.' });
        return;
    }
    const { accountId: bodyAccountId } = req.body;
    const accountId = bodyAccountId || req.cookies[ACCOUNT_ID_COOKIE];
    if (!accountId) {
        res.status(400).json({ error: 'No account ID found. Please re-authenticate.' });
        return;
    }
    try {
        const otpRes = await (0, node_fetch_1.default)(`${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Deriv-App-ID': DERIV_APP_ID,
            },
        });
        if (!otpRes.ok) {
            const errText = await otpRes.text();
            res.status(otpRes.status).json({ error: errText });
            return;
        }
        const otpData = await otpRes.json();
        const otpUrl = otpData.data?.url;
        if (!otpUrl) {
            res.status(500).json({ error: 'No OTP URL returned by Deriv' });
            return;
        }
        res.json({ success: true, url: otpUrl });
    }
    catch (err) {
        res.status(500).json({ error: err?.message ?? 'OTP creation failed' });
    }
});
/* ──────────────────────────────────────────────────────────────────────────────
   GET /api/trading/accounts  — list options accounts
   POST /api/trading/accounts — create options account
   POST /api/trading/accounts/:accountId/reset-demo-balance
────────────────────────────────────────────────────────────────────────────── */
app.get('/api/trading/accounts', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    try {
        const upstream = await (0, node_fetch_1.default)(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Deriv-App-ID': DERIV_APP_ID,
            },
        });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    }
    catch (err) {
        res.status(502).json({ error: err?.message ?? 'Upstream request failed' });
    }
});
app.post('/api/trading/accounts', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    try {
        const upstream = await (0, node_fetch_1.default)(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Deriv-App-ID': DERIV_APP_ID,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(req.body),
        });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    }
    catch (err) {
        res.status(502).json({ error: err?.message ?? 'Upstream request failed' });
    }
});
app.post('/api/trading/accounts/:accountId/reset-demo-balance', async (req, res) => {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    const { accountId } = req.params;
    try {
        const upstream = await (0, node_fetch_1.default)(`${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/reset-demo-balance`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Deriv-App-ID': DERIV_APP_ID,
            },
        });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    }
    catch (err) {
        res.status(502).json({ error: err?.message ?? 'Upstream request failed' });
    }
});
/* ──────────────────────────────────────────────────────────────────────────────
   Generic REST proxy — all other /api/trading/* calls
   Adds Authorization + Deriv-App-ID headers automatically.
────────────────────────────────────────────────────────────────────────────── */
async function proxyToRest(req, res, method) {
    const accessToken = req.cookies[ACCESS_TOKEN_COOKIE];
    if (!accessToken) {
        res.status(401).json({ error: 'Not authenticated — please log in first.' });
        return;
    }
    const subPath = req.path.replace(/^\/api\/trading/, '');
    const queryStr = method === 'GET' && Object.keys(req.query).length
        ? '?' + new URLSearchParams(req.query).toString()
        : '';
    const url = `${DERIV_REST_BASE}/trading${subPath}${queryStr}`;
    try {
        const upstream = await (0, node_fetch_1.default)(url, {
            method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Deriv-App-ID': DERIV_APP_ID,
            },
            body: method === 'POST' ? JSON.stringify(req.body) : undefined,
        });
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    }
    catch (err) {
        res.status(502).json({ error: err?.message ?? 'Upstream request failed' });
    }
}
app.get('/api/trading/*', (req, res) => proxyToRest(req, res, 'GET'));
app.post('/api/trading/*', (req, res) => proxyToRest(req, res, 'POST'));
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Deriv API backend ready on port ${PORT}`);
});
