import type { VercelRequest, VercelResponse } from '@vercel/node';

const DERIV_LEGACY_URL = 'https://auth.deriv.com/oauth2/legacy/tokens';
const DERIV_APP_ID     = '101585';
const AT_COOKIE        = 'deriv_at';

function parseLegacyTokens(lt: Record<string, string>) {
    const accountsList:   Record<string, string>                                        = {};
    const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

    if (Array.isArray((lt as any).tokens)) {
        for (const entry of (lt as any).tokens as Array<{ loginid: string; token: string; currency?: string }>) {
            if (entry.loginid && entry.token) {
                accountsList[entry.loginid]   = entry.token;
                clientAccounts[entry.loginid] = { loginid: entry.loginid, token: entry.token, currency: entry.currency ?? '' };
            }
        }
    } else {
        for (const [key, value] of Object.entries(lt)) {
            if (key.startsWith('acct') && typeof value === 'string') {
                const num      = key.replace('acct', '');
                const token    = lt[`token${num}`];
                const currency = lt[`cur${num}`] ?? '';
                if (token) {
                    accountsList[value]   = token;
                    clientAccounts[value] = { loginid: value, token, currency };
                }
            }
        }
    }

    const allIds   = Object.keys(accountsList);
    const demoId   = allIds.find(id => id.startsWith('VR'));
    const activeId = demoId ?? allIds[0] ?? null;

    return {
        accountsList,
        clientAccounts,
        authToken:     activeId ? accountsList[activeId] : null,
        activeLoginId: activeId,
    };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin',      req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const cookieHeader = req.headers.cookie ?? '';
    const match        = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AT_COOKIE}=([^;]+)`));
    const accessToken  = match ? decodeURIComponent(match[1]) : null;

    if (!accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const legacyRes = await fetch(`${DERIV_LEGACY_URL}?app_id=${DERIV_APP_ID}`, {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type':  'application/x-www-form-urlencoded',
            },
            body: `app_id=${DERIV_APP_ID}`,
        });

        if (!legacyRes.ok) {
            const text = await legacyRes.text();
            return res.status(legacyRes.status).json({ error: 'Legacy tokens fetch failed', detail: text });
        }

        const lt = await legacyRes.json() as Record<string, string>;
        const parsed = parseLegacyTokens(lt);

        if (!parsed.authToken) {
            return res.status(502).json({ error: 'Legacy tokens returned but could not be parsed', raw: lt });
        }

        return res.status(200).json(parsed);
    } catch (err: any) {
        return res.status(502).json({ error: 'Network error fetching legacy tokens', detail: err?.message });
    }
}
