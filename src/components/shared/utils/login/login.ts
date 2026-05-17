/**
 * Login helpers — new PKCE flow only.
 *
 * The old OAuth URL builder (oauth.deriv.com / acct1/token1 URL params) has been
 * removed entirely.  All login/signup now goes through the PKCE flow in pkce.ts,
 * which redirects to /callback for the server-side token exchange.
 */
import { startLogin, startSignup } from '@/utils/pkce';
import { isStorageSupported } from '../storage/storage';

export { startLogin, startSignup };

/**
 * Redirect to Deriv login when the user is not logged in.
 * Stores the current URL so we can return after login.
 */
export const redirectToLogin = (is_logged_in: boolean, _language?: string) => {
    if (!is_logged_in && isStorageSupported(sessionStorage)) {
        sessionStorage.setItem('redirect_url', window.location.href);
        startLogin();
    }
};

/**
 * Redirect to Deriv sign-up.
 */
export const redirectToSignUp = () => {
    startSignup();
};

/**
 * @deprecated Use startLogin() instead.
 * Kept as a no-op shim so any remaining call-sites compile without error.
 */
export const loginUrl = (_opts?: { language?: string; is_new_account?: boolean }) => {
    return 'https://auth.deriv.com/oauth2/auth';
};
