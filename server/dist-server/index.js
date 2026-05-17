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
const ACCESS_TOKEN_COOKIE = 'deriv_at';
app.use((0, cors_1.default)({ origin: true, credentials: true }));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, cookie_parser_1.default)());
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
app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!req.cookies[ACCESS_TOKEN_COOKIE] });
});
app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.json({ success: true });
});
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
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
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
