
import { website_name } from '@/utils/site-config';
import { getAppId } from '../config/config';
import { CookieStorage, isStorageSupported, LocalStore } from '../storage/storage';
import { getStaticUrl, urlForCurrentDomain } from '../url';
import { deriv_urls } from '../url/constants';

export const redirectToLogin = (is_logged_in: boolean, language: string, has_params = true, redirect_delay = 0) => {
    if (!is_logged_in && isStorageSupported(sessionStorage)) {
        const l = window.location;
        const redirect_url = has_params ? window.location.href : `${l.protocol}//${l.host}${l.pathname}`;
        sessionStorage.setItem('redirect_url', redirect_url);
        setTimeout(() => {
            const new_href = loginUrl({ language });
            window.location.href = new_href;
        }, redirect_delay);
    }
};

export const redirectToSignUp = () => {
    window.open(getStaticUrl('/signup/'));
};

type TLoginUrl = {
    language: string;
};

export const loginUrl = ({ language, is_new_account = false }: TLoginUrl & { is_new_account?: boolean }) => {
    const server_url = LocalStore.get('config.server_url');
    const getOAuthUrl = () => {
        const redirect_uri = `${window.location.origin}/callback`;
        const endpoint = is_new_account ? 'auth.deriv.com/oauth2/authorize' : 'oauth.deriv.com/oauth2/authorize';
        return `https://${endpoint}?app_id=${getAppId()}&l=${language}&redirect_uri=${redirect_uri}&brand=deriv&redirect=home`;
    };

    if (server_url && /qa/.test(server_url)) {
        const redirect_uri = `${window.location.origin}/callback`;
        return `https://${server_url}/oauth2/authorize?app_id=${getAppId()}&l=${language}&redirect_uri=${redirect_uri}&brand=deriv&redirect=home`;
    }

    return getOAuthUrl();
};
