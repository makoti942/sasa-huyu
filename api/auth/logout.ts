import type { VercelRequest, VercelResponse } from '@vercel/node';

const AT_COOKIE   = 'deriv_at';
const ACCT_COOKIE = 'deriv_account_id';

function clearCookie(name: string, req: VercelRequest): string {
    const host = req.headers.host || '';
    let domainAttr = '';
    if (host.includes('.') && !host.startsWith('localhost')) {
        const baseDomain = '.' + host.split('.').slice(-2).join('.');
        domainAttr = `; Domain=${baseDomain}`;
    }
    return `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure${domainAttr}`;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin',      req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',     'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    res.setHeader('Set-Cookie', [clearCookie(AT_COOKIE, req), clearCookie(ACCT_COOKIE, req)]);
    return res.status(200).json({ success: true });
}
