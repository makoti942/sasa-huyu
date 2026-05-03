import { getAppId, getSocketURL } from '@/components/shared';
import { website_name } from '@/utils/site-config';
import DerivAPIBasic from '@deriv/deriv-api/dist/DerivAPIBasic';
import { getInitialLanguage } from '@deriv-com/translations';
import APIMiddleware from './api-middleware';

// Track the app_id used for the current WebSocket connection
let currentConnectionAppId = null;

/**
 * Generate a Deriv API instance with a specific app_id
 * @param {number} specificAppId - Optional specific app_id to use. If not provided, uses getAppId()
 */
export const generateDerivApiInstance = (specificAppId = null) => {
    const cleanedServer = getSocketURL().replace(/[^a-zA-Z0-9.:-]/g, '');
    const appId = specificAppId !== null ? specificAppId : getAppId(); // Use specific app_id or read from localStorage
    const cleanedAppId = appId?.toString()?.replace?.(/[^a-zA-Z0-9]/g, '') ?? appId?.toString();

    // Store the app_id used for this connection (only if not a specific app_id)
    if (specificAppId === null) {
        const previousAppId = currentConnectionAppId;
        currentConnectionAppId = appId;

        // Log connection creation
        if (previousAppId !== appId) {
            console.log(`🔗 [WEBSOCKET] Creating new connection with App ID ${appId}`);
        }
    } else {
        console.log(`🔗 [WEBSOCKET] Creating connection with specific App ID ${appId}`);
    }

    const socket_url = `wss://${cleanedServer}/api/v3?app_id=${cleanedAppId}&l=${getInitialLanguage()}&brand=${website_name.toLowerCase()}`;

    const deriv_socket = new WebSocket(socket_url);
    const deriv_api = new DerivAPIBasic({
        connection: deriv_socket,
        middleware: new APIMiddleware({}),
    });
    return deriv_api;
};

/**
 * Check if the current app_id in localStorage has changed from the one used for the WebSocket connection
 * Returns true if app_id has changed and reconnection is needed
 */
export const hasAppIdChanged = () => {
    const currentAppId = getAppId();
    return currentConnectionAppId !== null && currentAppId !== currentConnectionAppId;
};

/**
 * Get the app_id that was used for the current WebSocket connection
 */
export const getCurrentConnectionAppId = () => {
    return currentConnectionAppId;
};

/**
 * Ensure the API instance is using the current app_id from localStorage
 * If app_id has changed, returns true indicating a new instance should be created
 * This should be called before making trades to ensure correct app_id is used
 */
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
    // CRITICAL: If show_as_cr flag is set, always use demo account token
    // This ensures all trades are executed on demo account, even when CR account is displayed
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
    // CRITICAL: If show_as_cr flag is set, always return demo account ID
    // This ensures API always uses demo account for trading
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
    const active_loginid = getLoginId();
    const client_accounts = JSON.parse(localStorage.getItem('accountsList')) ?? undefined;
    const active_account = (client_accounts && client_accounts[active_loginid]) || {};
    return {
        token: active_account ?? undefined,
        account_id: active_loginid ?? undefined,
    };
};
