import { getAppId, getSocketURL, DERIV_CLIENT_ID } from '@/components/shared';
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
    const cleanedServer = getSocketURL().replace(/[^a-zA-Z0-9.]/g, '');
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

    const socket_url = `wss://${cleanedServer}/websockets/v3?app_id=${cleanedAppId}&l=${getInitialLanguage()}&brand=${website_name.toLowerCase()}`;

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

// DISABLED - replaced by DerivAuth.js
// Stub exports to prevent import crashes — always return null/empty
export const getLoginId = () => null;
export const V2GetActiveToken = () => null;
export const V2GetActiveClientId = () => null;
export const getToken = () => ({ token: undefined, account_id: undefined });
