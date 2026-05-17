import { getAppId, getSocketURL } from '@/components/shared';
import { website_name } from '@/utils/site-config';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import { getInitialLanguage } from '@deriv-com/translations';
import APIMiddleware from './api-middleware';

// Track the app_id used for the current WebSocket connection
let currentConnectionAppId = null;

/**
 * Build the legacy WebSocket URL (used as fallback when OTP is unavailable).
 */
function buildLegacyWsUrl() {
    const cleanedServer = getSocketURL().replace(/[^a-zA-Z0-9.]/g, '');
    const appId         = getAppId();
    const cleanedAppId  = appId?.toString()?.replace?.(/[^a-zA-Z0-9]/g, '') ?? appId?.toString();
    return `wss://${cleanedServer}/websockets/v3?app_id=${cleanedAppId}&l=${getInitialLanguage()}&brand=${website_name.toLowerCase()}`;
}

/**
 * Generate a Deriv API instance using the legacy WebSocket URL.
 * @param {number} specificAppId - Optional specific app_id to use.
 */
export const generateDerivApiInstance = (specificAppId = null) => {
    const appId = specificAppId !== null ? specificAppId : getAppId();
    const cleanedAppId = appId?.toString()?.replace?.(/[^a-zA-Z0-9]/g, '') ?? appId?.toString();
    const cleanedServer = getSocketURL().replace(/[^a-zA-Z0-9.]/g, '');

    if (specificAppId === null) {
        const previousAppId = currentConnectionAppId;
        currentConnectionAppId = appId;
        if (previousAppId !== appId) {
            console.log(`🔗 [WEBSOCKET] Creating new connection with App ID ${appId}`);
        }
    } else {
        console.log(`🔗 [WEBSOCKET] Creating connection with specific App ID ${appId}`);
    }

    const socket_url  = `wss://${cleanedServer}/websockets/v3?app_id=${cleanedAppId}&l=${getInitialLanguage()}&brand=${website_name.toLowerCase()}`;
    const deriv_socket = new WebSocket(socket_url);
    const deriv_api    = new DerivAPIBasic({
        connection: deriv_socket,
        middleware: new APIMiddleware({}),
    });
    return deriv_api;
};

/**
 * Generate a Deriv API instance using the new OTP-based WebSocket URL.
 * Fetches a fresh OTP URL from the backend, then connects with it.
 * Falls back to the legacy URL if OTP is unavailable.
 *
 * @param {string} [accountId] - Override account_id (uses session cookie default if omitted).
 * @returns {Promise<import('@deriv/deriv-api/dist/DerivAPIBasic').default>}
 */
export const generateDerivApiInstanceWithOTP = async (accountId = null) => {
    try {
        const body = accountId ? JSON.stringify({ accountId }) : JSON.stringify({});
        const res  = await fetch('/api/trading/otp', {
            method:      'POST',
            headers:     { 'Content-Type': 'application/json' },
            credentials: 'include',
            body,
        });

        if (res.ok) {
            const data = await res.json();
            if (data.url) {
                console.log('🔗 [WEBSOCKET] Connecting via OTP URL');
                const ws      = new WebSocket(data.url);
                const api     = new DerivAPIBasic({
                    connection: ws,
                    middleware: new APIMiddleware({}),
                });
                return api;
            }
        }
    } catch (err) {
        console.warn('⚠️ [WEBSOCKET] OTP fetch failed, falling back to legacy URL:', err);
    }

    // Fallback to legacy connection
    return generateDerivApiInstance();
};

/**
 * Check if the current app_id in localStorage has changed.
 */
export const hasAppIdChanged = () => {
    const currentAppId = getAppId();
    return currentConnectionAppId !== null && currentAppId !== currentConnectionAppId;
};

export const getCurrentConnectionAppId = () => currentConnectionAppId;

export const shouldRecreateApiInstance = storedAppId => {
    const currentAppId = getAppId();
    return storedAppId !== currentAppId;
};

export const getLoginId = () => {
    const login_id = localStorage.getItem('active_loginid');
    if (login_id && login_id !== 'null') return login_id;
    return null;
};

export const V2GetActiveToken = () => {
    // If show_as_cr flag is set, always use demo account token
    const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
    if (showAsCR) {
        const accountsList = typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('accountsList') || '{}') : {};
        const demoToken = accountsList['VRTC10109979'];
        if (demoToken) {
            console.log('[V2GetActiveToken] 🎯 Using demo token (show_as_cr:', showAsCR, ')');
            return demoToken;
        }
    }
    const token = localStorage.getItem('authToken');
    if (token && token !== 'null') return token;
    return null;
};

export const V2GetActiveClientId = () => {
    const showAsCR = typeof window !== 'undefined' ? localStorage.getItem('show_as_cr') : null;
    if (showAsCR) {
        console.log('[V2GetActiveClientId] 🎯 Using demo account ID (show_as_cr:', showAsCR, ')');
        return 'VRTC10109979';
    }
    const token = V2GetActiveToken();
    if (!token) return null;
    const account_list = JSON.parse(localStorage.getItem('accountsList') || '{}');
    if (account_list && account_list !== 'null') {
        const active_clientId = Object.keys(account_list).find(key => account_list[key] === token);
        return active_clientId;
    }
    return null;
};

export const getToken = () => {
    const active_loginid  = getLoginId();
    const client_accounts = JSON.parse(localStorage.getItem('accountsList')) ?? undefined;
    const active_account  = (client_accounts && client_accounts[active_loginid]) || {};
    return {
        token:      active_account ?? undefined,
        account_id: active_loginid ?? undefined,
    };
};
