import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, redirect_uri, client_id, code_verifier } = req.body as Record<string, string>;

    if (!code || !redirect_uri || !client_id || !code_verifier) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        const upstream = await fetch('https://auth.deriv.com/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri,
                client_id,
                code_verifier,
            }).toString(),
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
