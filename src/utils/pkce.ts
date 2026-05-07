
/*
 * This is a utility file for handling the OAuth2 PKCE flow with Deriv's new authentication system.
 *
 * The PKCE (Proof Key for Code Exchange) flow is a more secure way to handle OAuth2 for public clients
 * (like this web app) than the older implicit flow.
 *
 * For a detailed guide on the PKCE flow, see: https://www.oauth.com/oauth2-servers/pkce/
 *
 * The flow for this app is as follows:
 *
 *   1. GET https://auth.deriv.com/oauth2/authorize
 *        response_type=code
 *        client_id=337DJLKi2OJ4VsyFSLIt9
 *        code_challenge=<c>
 *        code_challenge_method=S256
 *
 *   2. POST https://auth.deriv.com/oauth2/token
 *        grant_type=authorization_code
 *        code=<code from URL>
 *        redirect_uri=https://makotitraderss.vercel.app/callback
 *        client_id=337DJLKi2OJ4VsyFSLIt9
 *        code_verifier=<v>
 *
 *   3. POST https://auth.deriv.com/oauth2/legacy/tokens
 *        Authorization: Bearer <access_token from step 2>
 *
 *   4. Store resulting acct1/token1/cur1 tokens and redirect to app
 *
 * Uses Web Crypto API — available in all modern browsers on HTTPS.
 */

const PKCE_LOCAL_STORAGE_KEY = 'pkce_verifier';

function sha256(plain: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return window.crypto.subtle.digest('SHA-256', data);
}

function base64url(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

async function getCodeChallenge(): Promise<{ verifier: string; challenge: string }> {
    const random = window.crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64url(random.buffer);
    const challenge = base64url(await sha256(verifier));
    return { verifier, challenge };
}

export async function redirectToNewAccountsLogin() {
    const { verifier, challenge } = await getCodeChallenge();

    localStorage.setItem(PKCE_LOCAL_STORAGE_KEY, verifier);

    const client_id = '337DJLKi2OJ4VsyFSLIt9';
    const redirect_uri = `${window.location.origin}/callback`;
    const state = Math.random().toString(36).substring(2, 15);

    const new_auth_url = new URL('https://auth.deriv.com/oauth2/auth');
    new_auth_url.searchParams.set('response_type', 'code');
    new_auth_url.searchParams.set('client_id', client_id);
    new_auth_url.searchParams.set('redirect_uri', redirect_uri);
    new_auth_url.searchParams.set('scope', 'trade account_manage');
    new_auth_url.searchParams.set('state', state);
    new_auth_url.searchParams.set('code_challenge', challenge);
    new_auth_url.searchParams.set('code_challenge_method', 'S256');
    new_auth_url.searchParams.set('prompt', 'consent');

    window.location.assign(new_auth_url.toString());
}
