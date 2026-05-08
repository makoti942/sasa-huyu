import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authorization = req.headers['authorization'];
    if (!authorization) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    try {
        const upstream = await fetch('https://auth.deriv.com/oauth2/legacy/tokens', {
            method: 'POST',
            headers: { Authorization: authorization },
        });

        const body = await upstream.text();

        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(body);
    } catch (err: any) {
        return res.status(502).json({ error: 'Upstream fetch failed', detail: err?.message });
    }
}
