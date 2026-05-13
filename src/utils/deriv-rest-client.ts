/*
 * Deriv REST + WebSocket client utility.
 *
 * All REST calls use Authorization: Bearer {access_token} from sessionStorage.
 * No cookies, no credentials:'include'.
 *
 * Public WebSocket (no auth):
 *   wss://api.derivws.com/trading/v1/options/ws/public
 *
 * Authenticated WebSocket (OTP-based):
 *   Use websocket-manager.ts → createConnection(accountId, ...)
 */

import { getAuthHeaders, isLoggedIn } from './auth';

const REST_BASE = 'https://api.derivws.com';

export type DerivOptionsAccount = {
    id:       string;
    currency: string;
    balance:  number;
    status:   string;
    [key: string]: unknown;
};

export type DerivAccountsResponse = {
    data: DerivOptionsAccount[];
    [key: string]: unknown;
};

export type DerivOtpResponse = {
    data: { url: string; [key: string]: unknown };
    [key: string]: unknown;
};

async function restRequest<T = unknown>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    const res = await fetch(`${REST_BASE}${path}`, {
        method,
        headers: getAuthHeaders(),
        body:    body ? JSON.stringify(body) : undefined,
    });

    const ct   = res.headers.get('content-type') ?? '';
    const data = ct.includes('application/json') ? await res.json() as T & { error?: string } : null;

    if (!res.ok) {
        const errMsg = (data as any)?.error ?? `HTTP ${res.status}`;
        throw new Error(errMsg);
    }

    return data as T;
}

/** Check whether the user has a valid access_token in sessionStorage. */
export function isAuthenticated(): boolean {
    return isLoggedIn();
}

/** Fetch all Options accounts for the logged-in user. */
export async function fetchDerivAccounts(): Promise<DerivAccountsResponse> {
    return restRequest<DerivAccountsResponse>('GET', '/trading/v1/options/accounts');
}

/**
 * Request a one-time password for an Options account.
 * Returns the authenticated wss:// URL to connect for trading.
 */
export async function getAccountOtp(accountId: string): Promise<DerivOtpResponse> {
    return restRequest<DerivOtpResponse>(
        'POST',
        `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`
    );
}

export type WsMessageHandler = (event: MessageEvent) => void;
export type WsStatusHandler  = (status: 'open' | 'closed' | 'error', event?: Event) => void;

/**
 * Connect to an authenticated Deriv trading WebSocket.
 * @param wssUrl  The wss:// URL returned by getAccountOtp()
 */
export function connectTradingWebSocket(
    wssUrl:     string,
    onMessage:  WsMessageHandler,
    onStatus?:  WsStatusHandler
): () => void {
    const ws     = new WebSocket(wssUrl);
    ws.onopen    = e => onStatus?.('open',   e);
    ws.onmessage = onMessage;
    ws.onerror   = e => onStatus?.('error',  e);
    ws.onclose   = e => onStatus?.('closed', e);
    return () => ws.close();
}

/** Connect to the Deriv public WebSocket (no auth required). */
export function connectPublicWebSocket(
    onMessage: WsMessageHandler,
    onStatus?:  WsStatusHandler
): () => void {
    return connectTradingWebSocket(
        'wss://api.derivws.com/trading/v1/options/ws/public',
        onMessage,
        onStatus
    );
}
