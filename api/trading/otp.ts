import type { VercelRequest, VercelResponse } from '@vercel/node';

const DERIV_REST_BASE = 'https://api.derivws.com';
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin',      req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',     'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers',     'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    const cookies     = parseCookies(req);
    const accessToken = cookies[AT_COOKIE];
    if (!accessToken) {
        return res.status(401).json({ error: 'Not authenticated — please log in first.' });
    }

    const bodyAccountId = (req.body as any)?.accountId as string | undefined;
    const accountId     = bodyAccountId ?? cookies[ACCT_COOKIE];
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

        const otpData = await otpRes.json() as { data?: { url: string } };
        const otpUrl  = otpData.data?.url;

        if (!otpUrl) {
            return res.status(500).json({ error: 'No OTP URL returned by Deriv' });
        }

        return res.status(200).json({ success: true, url: otpUrl });
    } catch (err: any) {
        return res.status(502).json({ error: err?.message ?? 'OTP creation failed' });
    }
}
