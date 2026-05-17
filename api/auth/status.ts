import type { VercelRequest, VercelResponse } from '@vercel/node';

const AT_COOKIE = 'deriv_at';

function parseCookies(req: VercelRequest): Record<string, string> {
    return Object.fromEntries(
        (req.headers.cookie ?? '')
            .split(';')
            .map(c => c.trim().split('='))
            .filter(p => p.length >= 2)
            .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
    );
}

export default function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Access-Control-Allow-Origin',      req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods',     'GET, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const cookies = parseCookies(req);
    return res.status(200).json({ authenticated: !!cookies[AT_COOKIE] });
}
