import type { VercelRequest, VercelResponse } from '@vercel/node';

const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const DERIV_REST_BASE = 'https://api.derivws.com';
const CLIENT_ID       = '337DJLKi2OJ4VsyFSLIt9';
const DERIV_APP_ID    = '101585';
const AT_COOKIE       = 'deriv_at';
const ACCT_COOKIE     = 'deriv_account_id';

function parseCookies(req: VercelRequest): Record<string, string> {
    return Object.fromEntries(
        (req.headers.cookie ?? '')
            .split(';')
            .map(c => c.trim().split('='))
            .filter(p => p.length >= 2)
            .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
    );
}

function cookieStr(name: string, value: string, maxAge: number): string {
    return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin',  req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    const { code, codeVerifier, redirectUri } = (req.body ?? {}) as Record<string, string>;

    if (!code || !codeVerifier || !redirectUri) {
        return res.status(400).json({ error: 'Missing required parameters: code, codeVerifier, redirectUri' });
    }

    // ── Step 1: Exchange auth code for access_token ─────────────────────────
    let tokenRes: Response;
    try {
        tokenRes = await fetch(DERIV_TOKEN_URL, {
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
    } catch (err: any) {
        return res.status(502).json({ error: 'Network error reaching Deriv auth server', detail: err?.message });
    }

    const rawText = await tokenRes.text();
    if (!tokenRes.ok) {
        return res.status(tokenRes.status).json({ error: rawText });
    }

    let tokenData: Record<string, any>;
    try { tokenData = JSON.parse(rawText); }
    catch { return res.status(500).json({ error: 'Unparseable token response', raw: rawText }); }

    if (tokenData.error) {
        return res.status(400).json({ error: tokenData.error, description: tokenData.error_description });
    }

    const accessToken: string = tokenData.access_token;
    if (!accessToken) {
        return res.status(500).json({ error: 'No access_token in token response' });
    }

    const expiresIn: number = tokenData.expires_in ?? 3600;

    // ── Step 2: Auto-fetch or create options account ─────────────────────────
    let accountId: string | null = null;
    try {
        const listRes = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Deriv-App-ID':  DERIV_APP_ID,
            },
        });

        if (listRes.ok) {
            const listData = await listRes.json() as { data?: Array<{ id: string; account_type?: string }> };
            if (listData.data && listData.data.length > 0) {
                const demo = listData.data.find(a => a.account_type === 'demo');
                accountId  = (demo ?? listData.data[0]).id;
            } else {
                // No accounts yet — create a demo account
                const createRes = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
                    method:  'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Deriv-App-ID':  DERIV_APP_ID,
                        'Content-Type':  'application/json',
                    },
                    body: JSON.stringify({ currency: 'USD', group: 'row', account_type: 'demo' }),
                });
                if (createRes.ok || createRes.status === 201) {
                    const createData = await createRes.json() as { data?: { id: string } };
                    accountId = createData.data?.id ?? null;
                }
            }
        }
    } catch (_) { /* non-fatal — account_id can be fetched lazily */ }

    // ── Step 3: Set httpOnly cookies (token never reaches browser JS) ────────
    const cookies = [cookieStr(AT_COOKIE, accessToken, expiresIn)];
    if (accountId) cookies.push(cookieStr(ACCT_COOKIE, accountId, expiresIn));
    res.setHeader('Set-Cookie', cookies);

    return res.status(200).json({ success: true, expires_in: expiresIn, account_id: accountId });
}
