import type { VercelRequest, VercelResponse } from '@vercel/node';

const DERIV_TOKEN_URL  = 'https://auth.deriv.com/oauth2/token';
const DERIV_LEGACY_URL = 'https://auth.deriv.com/oauth2/legacy/tokens';
const DERIV_REST_BASE  = 'https://api.derivws.com';
const CLIENT_ID        = '337DJLKi2OJ4VsyFSLIt9';
const DERIV_APP_ID     = '101585';
const AT_COOKIE        = 'deriv_at';
const ACCT_COOKIE      = 'deriv_account_id';

function cookieStr(name: string, value: string, maxAge: number, req: VercelRequest): string {
    const host = req.headers.host || '';
    let domainAttr = '';
    if (host.includes('.') && !host.startsWith('localhost')) {
        const baseDomain = '.' + host.split('.').slice(-2).join('.');
        domainAttr = `; Domain=${baseDomain}`;
    }
    return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure${domainAttr}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin',      req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods',     'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',     'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    const { code, codeVerifier, redirectUri } = (req.body ?? {}) as Record<string, string>;
    if (!code || !codeVerifier || !redirectUri) {
        return res.status(400).json({ error: 'Missing required parameters: code, codeVerifier, redirectUri' });
    }

    // ── Step 1: Exchange auth code → access_token ────────────────────────────
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

    // ── Step 2: Fetch legacy Deriv tokens (acct1/token1/cur1 …) ─────────────
    // These are the tokens the existing app stores in localStorage. We return
    // them to the client so the trading infrastructure can authorize normally.
    let legacyTokens: Record<string, string> | null = null;
    try {
        const legacyRes = await fetch(`${DERIV_LEGACY_URL}?app_id=${DERIV_APP_ID}`, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/x-www-form-urlencoded',
            },
            body: `app_id=${DERIV_APP_ID}`,
        });
        if (legacyRes.ok) {
            legacyTokens = await legacyRes.json() as Record<string, string>;
        } else {
            console.error('[exchange] legacy/tokens HTTP', legacyRes.status, await legacyRes.text());
        }
    } catch (legacyErr: any) {
        console.error('[exchange] legacy/tokens fetch error:', legacyErr?.message);
    }

    // ── Step 3: Auto-fetch or create options account ─────────────────────────
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
    } catch (_) { /* non-fatal */ }

    // ── Step 4: Set httpOnly cookies (access_token never exposed to browser JS)
    const cookies = [cookieStr(AT_COOKIE, accessToken, expiresIn, req)];
    if (accountId) cookies.push(cookieStr(ACCT_COOKIE, accountId, expiresIn, req));
    res.setHeader('Set-Cookie', cookies);

    // Return legacy tokens to the client so it can populate localStorage
    // for the existing trading infrastructure (authorize via WebSocket).
    return res.status(200).json({
        success:       true,
        expires_in:    expiresIn,
        account_id:    accountId,
        legacy_tokens: legacyTokens,
    });
}
