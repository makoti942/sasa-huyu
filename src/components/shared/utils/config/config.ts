
import { LocalStorageConstants, LocalStorageUtils, URLUtils } from '@deriv-com/utils';
import { isStaging } from '../url/helpers';

// This is the single, correct App ID for this application.
const APP_ID = 101585;

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
    return window.location.host;
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

export const generateOAuthURL = () => {
    const { getOauthURL } = URLUtils;
    const oauth_url = getOauthURL();
    const original_url = new URL(oauth_url);
    const configured_server_url = (LocalStorageUtils.getValue(LocalStorageConstants.configServerURL) ||
        localStorage.getItem('config.server_url') ||
        original_url.hostname) as string;

    const valid_server_urls = ['green.derivws.com', 'red.derivws.com', 'blue.derivws.com'];
    if (
        typeof configured_server_url === 'string'
            ? !valid_server_urls.includes(configured_server_url)
            : !valid_server_urls.includes(JSON.stringify(configured_server_url))
    ) {
        original_url.hostname = configured_server_url;
    }
    return original_url.toString() || oauth_url;
};
