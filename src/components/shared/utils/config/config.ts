
import { LocalStorageConstants, LocalStorageUtils, URLUtils } from '@deriv-com/utils';
import { isStaging } from '../url/helpers';

// ─── SINGLE SOURCE OF TRUTH ───────────────────────────────────────────────────
// Change any value here and it propagates to every tool, tab, and widget.

/** The app ID registered with Deriv for this application. */
const APP_ID = 101585;

/** OAuth client ID for PKCE flows (matches the registered app). */
export const OAUTH_CLIENT_ID = '337DJLKi2OJ4VsyFSLIt9';

/** The Deriv OAuth2 authorization endpoint (redirects the user to login). */
export const OAUTH_AUTH_URL = 'https://auth.deriv.com/oauth2/auth';

/** The Deriv OAuth2 token endpoint (exchanges auth code for access token). */
export const OAUTH_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';

/** The public Deriv trading WebSocket (no auth required). */
export const PUBLIC_TRADING_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

/** Returns the full OAuth2 callback URL for the current origin. */
export const getCallbackURL = () => `${window.location.origin}/callback`;

// ─────────────────────────────────────────────────────────────────────────────

export const livechat_license_id = 12049137;
export const livechat_client_id = '66aa088aad5a414484c1fd1fa8a5ace7';

// All other App ID and domain-switching logic has been removed to ensure consistency.

export const isProduction = () => {
    // This can be simplified as we no longer rely on domain for App ID.
    return !/localhost|binary\.sx|pages\.dev/i.test(window.location.hostname);
};

export const isTestLink = () => {
    return (
        window.location.origin?.includes('.binary.sx') ||
        window.location.origin?.includes('bot-65f.pages.dev') ||
        isLocal()
    );
};

export const isLocal = () => /localhost(:\d+)?$/i.test(window.location.hostname);

const getDefaultServerURL = () => {
    const server = 'ws';
    const server_url = `${server}.derivws.com`;
    return server_url;
};

/**
 * Returns the App ID for the application.
 * This function is now simplified to always return the single, correct App ID.
 */
export const getAppId = () => {
    // Set the app_id in localStorage for other parts of the app that might read it.
    window.localStorage.setItem('config.app_id', String(APP_ID));
    return APP_ID;
};

/**
 * All App ID switching logic has been disabled and removed.
 * This function is now a no-op for backward compatibility.
 */
export const switchAppIdAfterTrade = () => {
    // No-op. The App ID is now constant.
    return null;
};

/**
 * This function is a no-op as the App ID is now constant.
 */
export const forceUpdateAppId = () => {
    return getAppId();
};

export const getSocketURL = () => {
    const local_storage_server_url = window.localStorage.getItem('config.server_url');
    if (local_storage_server_url) return local_storage_server_url;

    const server_url = getDefaultServerURL();
    return server_url;
};

export const checkAndSetEndpointFromUrl = () => {
    if (isTestLink()) {
        const url_params = new URLSearchParams(location.search.slice(1));

        if (url_params.has('qa_server') && url_params.has('app_id')) {
            const qa_server = url_params.get('qa_server') || '';
            const app_id = url_params.get('app_id') || '';

            url_params.delete('qa_server');
            url_params.delete('app_id');

            if (/^(^(www\.)?qa[0-9]{1,4}\.deriv.dev|(.*)\.derivws\.com)$/.test(qa_server) && /^[0-9]+$/.test(app_id)) {
                localStorage.setItem('config.app_id', app_id);
                localStorage.setItem('config.server_url', qa_server.replace(/"/g, ''));
            }

            const params = url_params.toString();
            const hash = location.hash;

            location.href = `${location.protocol}//${location.hostname}${location.pathname}${
                params ? `?${params}` : ''
            }${hash || ''}`;

            return true;
        }
    }

    return false;
};

export const getDebugServiceWorker = () => {
    const debug_service_worker_flag = window.localStorage.getItem('debug_service_worker');
    if (debug_service_worker_flag) return !!parseInt(debug_service_worker_flag);

    return false;
};

export const generateOAuthURL = (is_new_account = false, state = '') => {
    const language = 'EN';
    const server_url = localStorage.getItem('config.server_url');
    const redirect_uri = `${window.location.origin}/callback`;
    const app_id = getAppId();
    const state_param = state ? `&state=${state}` : '';

    if (server_url && /qa/.test(server_url)) {
        return `https://${server_url}/oauth2/authorize?app_id=${app_id}&l=${language}&redirect_uri=${redirect_uri}&brand=deriv&redirect=home${state_param}`;
    }

    // Note: App ID 101585 is currently only registered on the old API (oauth.deriv.com).
    // The new endpoint (auth.deriv.com) will return 'invalid_client' until the App ID is registered there.
    const endpoint = is_new_account ? 'auth.deriv.com' : 'oauth.deriv.com';

    return `https://${endpoint}/oauth2/authorize?app_id=${app_id}&l=${language}&redirect_uri=${redirect_uri}&brand=deriv&redirect=home${state_param}`;
};
