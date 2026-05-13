/*
 * New OTP-based Deriv WebSocket manager.
 *
 * Replaces the old pattern of:
 *   new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=101585")
 *   + { authorize: token } message
 *
 * New pattern:
 *   1. GET  /trading/v1/options/accounts              → list accounts
 *   2. POST /trading/v1/options/accounts/{id}/otp     → get wss:// URL with OTP
 *   3. new WebSocket(otpUrl)                           → already authenticated
 *
 * The WebSocket returned by getAuthenticatedWebSocket() / createConnection()
 * is already authenticated — do NOT send { authorize: token } over it.
 */

import { getAuthHeaders } from './auth';

const REST_BASE = 'https://api.derivws.com';
const MAX_RETRIES = 5;
const RECONNECT_DELAY_MS = 3000;

export type WsMessage  = (event: MessageEvent) => void;
export type WsStatus   = (status: 'open' | 'closed' | 'error', event?: Event) => void;

export interface DerivAccount {
    id:       string;
    currency: string;
    balance:  number;
    type:     'real' | 'demo';
    status:   string;
    [key: string]:  unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// getAccounts()
// Fetch all Options accounts for the logged-in user.
// ─────────────────────────────────────────────────────────────────────────────
export async function getAccounts(): Promise<DerivAccount[]> {
    const res = await fetch(`${REST_BASE}/trading/v1/options/accounts`, {
        method:  'GET',
        headers: getAuthHeaders(),
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`getAccounts failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
    }

    const json = await res.json() as { data: DerivAccount[] };
    return json.data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// getAuthenticatedWebSocket(accountId)
// Gets an OTP URL for accountId and connects a WebSocket to it.
// The returned WebSocket is already authenticated.
// ─────────────────────────────────────────────────────────────────────────────
export async function getAuthenticatedWebSocket(accountId: string): Promise<WebSocket> {
    const res = await fetch(
        `${REST_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
        { method: 'POST', headers: getAuthHeaders() }
    );

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`OTP request failed for ${accountId} (HTTP ${res.status}): ${txt.slice(0, 200)}`);
    }

    const json = await res.json() as { data: { url: string } };
    const wsUrl = json.data?.url;
    if (!wsUrl) throw new Error(`No WebSocket URL returned for account ${accountId}`);

    return new WebSocket(wsUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// createConnection(accountId, onMessage, onStatus?)
// High-level helper: creates an authenticated WebSocket for accountId with
// auto-reconnect (up to MAX_RETRIES, with 3-second delay).
// Returns the initial WebSocket instance.
// ─────────────────────────────────────────────────────────────────────────────
export function createConnection(
    accountId:   string,
    onMessage:   WsMessage,
    onStatus?:   WsStatus
): { close: () => void } {
    let ws:         WebSocket | null = null;
    let retries     = 0;
    let isClosed    = false;
    let retryHandle: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
        try {
            ws = await getAuthenticatedWebSocket(accountId);
        } catch (err) {
            console.error('[WS] Could not get OTP URL:', err);
            scheduleReconnect();
            return;
        }

        ws.onopen  = e => { retries = 0; onStatus?.('open', e); };
        ws.onmessage = onMessage;
        ws.onerror = e => onStatus?.('error', e);
        ws.onclose = e => {
            onStatus?.('closed', e);
            if (!isClosed) scheduleReconnect();
        };
    };

    const scheduleReconnect = () => {
        if (isClosed || retries >= MAX_RETRIES) return;
        retries++;
        console.warn(`[WS] Reconnecting (${retries}/${MAX_RETRIES}) in ${RECONNECT_DELAY_MS}ms…`);
        retryHandle = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    connect();

    return {
        close() {
            isClosed = true;
            if (retryHandle !== null) clearTimeout(retryHandle);
            ws?.close();
        },
    };
}
