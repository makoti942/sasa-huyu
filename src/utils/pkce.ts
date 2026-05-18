/*
 * PKCE (Proof Key for Code Exchange) helper for Deriv's new auth system.
 *
 * Flow:
 *   1. Clear any stale PKCE data from previous attempts
 *   2. Generate code_verifier (64 random bytes from URL-safe alphabet)
 *   3. Derive code_challenge = BASE64URL(SHA-256(verifier))
 *   4. Store BOTH in sessionStorage (tab-specific, survives same-tab redirects)
 *   5. Redirect to https://auth.deriv.com/oauth2/auth
 *   6. On /callback: verify state, exchange code for token via direct POST
 */

import { OAUTH_AUTH_URL, OAUTH_CLIENT_ID, getCallbackURL } from '@/components/shared/utils/config/config';

export const PKCE_VERIFIER_KEY = 'deriv_code_verifier';
export const PKCE_STATE_KEY    = 'deriv_oauth_state';
/** @deprecated Import OAUTH_CLIENT_ID from @/components/shared instead. */
export const PKCE_CLIENT_ID    = OAUTH_CLIENT_ID;

// URL-safe alphabet for the code verifier (RFC 7636)
const VERIFIER_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Generate a 64-char URL-safe code verifier. */
function generateVerifier(): string {
    const array = new Uint8Array(64);
    window.crypto.getRandomValues(array);
    return Array.from(array)
        .map(b => VERIFIER_CHARS[b % VERIFIER_CHARS.length])
        .join('');
}

/** BASE64URL-encode an ArrayBuffer (no +, no /, no =). */
function base64url(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g,  '');
}

/** Derive code_challenge = BASE64URL(SHA-256(verifier)). */
async function deriveChallenge(verifier: string): Promise<string> {
    const hash = await window.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(verifier)
    );
    return base64url(hash);
}

/** Core PKCE launch — shared by startLogin and startSignup. */
async function startPkceFlow(prompt?: 'registration'): Promise<void> {
    // Step 1 — clear stale data so a previous abandoned login never poisons this one
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(PKCE_STATE_KEY);

    // Steps 4 & 5 — generate verifier → challenge → state
    const codeVerifier  = generateVerifier();
    const codeChallenge = await deriveChallenge(codeVerifier);
    const state         = window.crypto.randomUUID();

    // Step 7 — save to sessionStorage BEFORE redirecting
    sessionStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);
    sessionStorage.setItem(PKCE_STATE_KEY,    state);

    // Step 8 — build the authorization URL
    const redirectUri = getCallbackURL();
    const params = new URLSearchParams({
        response_type:         'code',
        client_id:             OAUTH_CLIENT_ID,
        redirect_uri:          redirectUri,
        scope:                 'trade account_manage',
        state,
        code_challenge:        codeChallenge,
        code_challenge_method: 'S256',
    });
    if (prompt) params.set('prompt', prompt);

    // Step 9 — same-tab redirect (sessionStorage is tab-specific; never use window.open)
    window.location.href = `${OAUTH_AUTH_URL}?${params.toString()}`;
}

/** Start OAuth2 PKCE login and redirect to Deriv. */
export async function startLogin(): Promise<void> {
    return startPkceFlow();
}

/** Start OAuth2 PKCE sign-up flow (opens Deriv registration screen). */
export async function startSignup(): Promise<void> {
    return startPkceFlow('registration');
}

/** @deprecated Use startLogin() instead. */
export async function redirectToNewAccountsLogin(): Promise<void> {
    return startLogin();
}
