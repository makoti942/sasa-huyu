/*
 * New Deriv OAuth2 PKCE auth module.
 *
 * All tokens live exclusively in sessionStorage — never cookies, never localStorage.
 * SessionStorage is tab-scoped, which keeps login state off disk and isolated per tab.
 *
 * Exports:
 *   startLogin()       — generate PKCE codes → redirect to auth.deriv.com (SAME TAB)
 *   handleCallback()   — exchange code → store access_token → return it
 *   getToken()         — return token if valid, null if missing/expired
 *   isLoggedIn()       — boolean convenience wrapper around getToken()
 *   logout()           — clear all auth state → redirect to /
 *   getAuthHeaders()   — {Authorization, Deriv-App-ID, Content-Type} for API calls
 */

// ── Constants ────────────────────────────────────────────────────────────────
export const CLIENT_ID   = '337DJLKi2OJ4VsyFSLIt9';
export const REDIRECT_URI = 'https://makotitraderss.vercel.app/callback';

const AUTH_URL    = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL   = 'https://auth.deriv.com/oauth2/token';
const LEGACY_URL  = 'https://auth.deriv.com/oauth2/legacy/tokens';

// ── sessionStorage keys ──────────────────────────────────────────────────────
const K_ACCESS_TOKEN = 'deriv_access_token';
const K_TOKEN_EXPIRY = 'deriv_token_expiry';
const K_CODE_VERIFIER = 'deriv_code_verifier';
const K_OAUTH_STATE   = 'deriv_oauth_state';

// ── PKCE helpers ─────────────────────────────────────────────────────────────
const VERIFIER_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function generateVerifier(): string {
    const buf = new Uint8Array(64);
    window.crypto.getRandomValues(buf);
    return Array.from(buf).map(b => VERIFIER_CHARS[b % VERIFIER_CHARS.length]).join('');
}

function base64url(buffer: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function deriveChallenge(verifier: string): Promise<string> {
    const hash = await window.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(verifier)
    );
    return base64url(hash);
}

// ── callbackHandled guard — prevents double-exchange of single-use codes ─────
let callbackHandled = false;

// ─────────────────────────────────────────────────────────────────────────────
// startLogin()
// Clears stale PKCE state, generates verifier/challenge/state,
// saves to sessionStorage, then redirects (same tab) to auth.deriv.com.
// ─────────────────────────────────────────────────────────────────────────────
export async function startLogin(): Promise<void> {
    // Clear any stale PKCE data from a previous abandoned attempt
    sessionStorage.removeItem(K_CODE_VERIFIER);
    sessionStorage.removeItem(K_OAUTH_STATE);

    const codeVerifier  = generateVerifier();
    const codeChallenge = await deriveChallenge(codeVerifier);
    const state         = window.crypto.randomUUID();

    // Save BEFORE redirecting — sessionStorage is tab-specific
    sessionStorage.setItem(K_CODE_VERIFIER, codeVerifier);
    sessionStorage.setItem(K_OAUTH_STATE,   state);

    const params = new URLSearchParams({
        response_type:         'code',
        client_id:             CLIENT_ID,
        redirect_uri:          REDIRECT_URI,
        scope:                 'trade',
        state,
        code_challenge:        codeChallenge,
        code_challenge_method: 'S256',
    });

    // SAME TAB redirect — window.open() would lose sessionStorage
    window.location.href = `${AUTH_URL}?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// handleCallback()
// Called on the /callback page after Deriv redirects back with ?code=&state=
// Returns the access_token string on success, throws on any error.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleCallback(): Promise<string> {
    if (callbackHandled) throw new Error('Callback already handled — please log in again.');
    callbackHandled = true;

    const params = new URLSearchParams(window.location.search);

    // Surface Deriv-side errors immediately
    const derivError = params.get('error');
    if (derivError) {
        const desc = params.get('error_description') ?? derivError;
        if (derivError === 'redirect_uri_mismatch') {
            throw new Error(
                `redirect_uri mismatch. The app must be registered with exactly:\n${REDIRECT_URI}`
            );
        }
        if (derivError === 'invalid_client') {
            throw new Error(`Invalid client_id (${CLIENT_ID}). Please contact support.`);
        }
        throw new Error(`Deriv authorization error: ${desc}`);
    }

    const code  = params.get('code');
    const state = params.get('state');

    if (!code || !state) {
        throw new Error('Missing code or state from Deriv. Please log in again.');
    }

    const savedState = sessionStorage.getItem(K_OAUTH_STATE);
    if (savedState === null) {
        throw new Error('Session expired. Please log in again.');
    }
    if (savedState !== state) {
        throw new Error('Security check failed (state mismatch). Please log in again.');
    }
    // Delete state immediately — it's single-use
    sessionStorage.removeItem(K_OAUTH_STATE);

    const codeVerifier = sessionStorage.getItem(K_CODE_VERIFIER);
    if (!codeVerifier) {
        throw new Error(
            'Login data missing. Did you open the login page in a new tab?\n' +
            'SessionStorage is tab-specific — please log in from the same tab.'
        );
    }

    // ── Token exchange: POST to auth.deriv.com (application/x-www-form-urlencoded) ──
    const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type:    'authorization_code',
            code,
            redirect_uri:  REDIRECT_URI,
            client_id:     CLIENT_ID,
            code_verifier: codeVerifier,
        }).toString(),
    });

    let tokenData: Record<string, any>;
    if (tokenRes.headers.get('content-type')?.includes('application/json')) {
        tokenData = await tokenRes.json();
    } else {
        // Fallback: try via local backend proxy (handles CORS if browser blocks direct call)
        const proxyRes = await fetch('/api/auth/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ code, codeVerifier }),
        });
        const ct = proxyRes.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) {
            const txt = await proxyRes.text().catch(() => '');
            throw new Error(
                `Token endpoint returned non-JSON (HTTP ${proxyRes.status}). ` +
                `Preview: "${txt.slice(0, 120)}"`
            );
        }
        tokenData = await proxyRes.json();
        if (!proxyRes.ok) {
            throw new Error(
                tokenData.error_description ?? tokenData.error ?? `Token exchange failed (HTTP ${proxyRes.status})`
            );
        }
    }

    if (!tokenRes.ok || tokenData.error) {
        if (tokenData?.error === 'invalid_grant') {
            throw new Error(
                'Authorization code expired or already used.\n' +
                'Codes are single-use — please click Log in to start a fresh session.'
            );
        }
        throw new Error(
            tokenData.error_description ?? tokenData.error ?? `Token exchange failed (HTTP ${tokenRes.status})`
        );
    }

    const access_token = tokenData.access_token as string;
    if (!access_token) throw new Error('No access_token in Deriv response.');

    // ── Store in sessionStorage ──────────────────────────────────────────────
    const expiresIn = Number(tokenData.expires_in) || 3600;
    sessionStorage.setItem(K_ACCESS_TOKEN, access_token);
    sessionStorage.setItem(K_TOKEN_EXPIRY, String(Date.now() + expiresIn * 1000));
    sessionStorage.removeItem(K_CODE_VERIFIER); // consumed

    // ── Fetch legacy account tokens (best-effort) ───────────────────────────
    // The legacy tokens (acct1/token1/cur1) are Deriv account tokens that the
    // trading bot WebSocket layer still needs for authentication.
    try {
        const legacyRes = await fetch(LEGACY_URL, {
            method:  'POST',
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (legacyRes.ok && legacyRes.headers.get('content-type')?.includes('application/json')) {
            const legacy = await legacyRes.json() as Record<string, string>;
            _storeLegacyTokens(legacy);
        }
    } catch {
        // Non-fatal — legacy tokens are best-effort
    }

    return access_token;
}

/** Persist legacy Deriv account tokens to localStorage so the trading WebSocket can use them. */
function _storeLegacyTokens(legacy: Record<string, string>) {
    const accountsList:   Record<string, string> = {};
    const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

    for (const [key, value] of Object.entries(legacy)) {
        if (key.startsWith('acct') && typeof value === 'string') {
            const idx      = key.replace('acct', '');
            const token    = legacy[`token${idx}`];
            const currency = legacy[`cur${idx}`] ?? '';
            if (token) {
                accountsList[value]   = token;
                clientAccounts[value] = { loginid: value, token, currency };
            }
        }
    }

    if (Object.keys(accountsList).length) {
        localStorage.setItem('accountsList',   JSON.stringify(accountsList));
        localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
    }
    if (legacy.token1) localStorage.setItem('authToken',      legacy.token1);
    if (legacy.acct1)  localStorage.setItem('active_loginid', legacy.acct1);
}

// ─────────────────────────────────────────────────────────────────────────────
// getToken()
// Returns the access_token from sessionStorage if it exists and is not expired.
// Returns null otherwise.
// ─────────────────────────────────────────────────────────────────────────────
export function getToken(): string | null {
    const token  = sessionStorage.getItem(K_ACCESS_TOKEN);
    const expiry = sessionStorage.getItem(K_TOKEN_EXPIRY);
    if (token && expiry && Date.now() < Number(expiry)) return token;
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// isLoggedIn()
// ─────────────────────────────────────────────────────────────────────────────
export function isLoggedIn(): boolean {
    return getToken() !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// logout()
// Clears all auth state from both sessionStorage and localStorage, then
// redirects to home.
// ─────────────────────────────────────────────────────────────────────────────
export function logout(): void {
    // New system
    sessionStorage.removeItem(K_ACCESS_TOKEN);
    sessionStorage.removeItem(K_TOKEN_EXPIRY);
    sessionStorage.removeItem(K_CODE_VERIFIER);
    sessionStorage.removeItem(K_OAUTH_STATE);

    // Legacy system — clear so the app shows the logged-out state
    const legacyKeys = [
        'authToken', 'active_loginid', 'accountsList', 'clientAccounts',
        'client.accounts', 'client.country', 'callback_token',
        'show_as_cr', 'cr_loginid', 'fullAccountsList',
        'adminMirrorModeEnabled', 'adminRealAccountUsingDemo',
        'adminRealAccountDisplayLoginId', 'adminSwitchingFromRealTab',
    ];
    legacyKeys.forEach(k => { try { localStorage.removeItem(k); } catch { /**/ } });

    window.location.href = '/';
}

// ─────────────────────────────────────────────────────────────────────────────
// getAuthHeaders()
// Returns the Authorization + Deriv-App-ID headers for all API calls.
// ─────────────────────────────────────────────────────────────────────────────
export function getAuthHeaders(): Record<string, string> {
    return {
        Authorization:   `Bearer ${getToken() ?? ''}`,
        'Deriv-App-ID':  CLIENT_ID,
        'Content-Type':  'application/json',
    };
}
