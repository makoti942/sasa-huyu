
import { LocalStorageConstants, LocalStorageUtils, URLUtils } from '@deriv-com/utils';
import { isStaging } from '../url/helpers';

// OAuth2 client_id for the new PKCE auth system
export const DERIV_CLIENT_ID = '337DJLKi2OJ4VsyFSLIt9';

// WebSocket app_id — used only for the legacy binary WebSocket API (ws.derivws.com).
// This is a numeric ID separate from the OAuth client_id.
const WS_APP_ID = 337;

export const livechat_license_id = 12049137;
export const livechat_client_id  = '66aa088aad5a414484c1fd1fa8a5ace7';

export const isProduction = () => {
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
    return 'ws.derivws.com';
};

/**
 * Returns the numeric WebSocket app_id.
 * Used only for the legacy binary WebSocket connection (not for OAuth/REST).
 */
export const getAppId = () => {
    window.localStorage.setItem('config.app_id', String(WS_APP_ID));
    return WS_APP_ID;
};

export const switchAppIdAfterTrade = () => null;

export const forceUpdateAppId = () => getAppId();

export const getSocketURL = () => {
    const local_storage_server_url = window.localStorage.getItem('config.server_url');
    if (local_storage_server_url) return local_storage_server_url;
    return getDefaultServerURL();
};

export const checkAndSetEndpointFromUrl = () => {
    if (isTestLink()) {
        const url_params = new URLSearchParams(location.search.slice(1));

        if (url_params.has('qa_server') && url_params.has('app_id')) {
            const qa_server = url_params.get('qa_server') || '';
            const app_id    = url_params.get('app_id')    || '';

            url_params.delete('qa_server');
            url_params.delete('app_id');

            if (
                /^(^(www\.)?qa[0-9]{1,4}\.deriv.dev|(.*)\.derivws\.com)$/.test(qa_server) &&
                /^[0-9]+$/.test(app_id)
            ) {
                localStorage.setItem('config.app_id',    app_id);
                localStorage.setItem('config.server_url', qa_server.replace(/"/g, ''));
            }

            const params = url_params.toString();
            const hash   = location.hash;
            location.href = `${location.protocol}//${location.hostname}${location.pathname}${
                params ? `?${params}` : ''
            }${hash || ''}`;
            return true;
        }
    }
    return false;
};

export const getDebugServiceWorker = () => {
    const flag = window.localStorage.getItem('debug_service_worker');
    if (flag) return !!parseInt(flag);
    return false;
};

/**
 * generateOAuthURL — shim kept for call-sites not yet migrated to startLogin().
 * Triggers PKCE login to auth.deriv.com and returns ''.
 * @deprecated Use startLogin() from @/utils/auth directly.
 */
export const generateOAuthURL = (_is_new_account = false, _state = '') => {
    // Trigger PKCE login asynchronously — caller must not rely on the return value.
    import('@/utils/auth').then(({ startLogin }) => startLogin()).catch(console.error);
    return '';
};
