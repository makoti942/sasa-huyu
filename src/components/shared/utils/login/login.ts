
import { startLogin } from '@/utils/auth';

/**
 * redirectToLogin — redirects to Deriv login via PKCE.
 * @deprecated Use startLogin() from @/utils/auth directly.
 */
export const redirectToLogin = (_is_logged_in: boolean, _language: string) => {
    if (!_is_logged_in) {
        startLogin().catch(console.error);
    }
};

export const redirectToSignUp = () => {
    // Sign-up goes through the same auth.deriv.com PKCE flow
    startLogin().catch(console.error);
};

type TLoginUrl = {
    language: string;
    is_new_account?: boolean;
};

/**
 * loginUrl — returns the PKCE auth URL (auth.deriv.com).
 * @deprecated Use startLogin() from @/utils/auth instead.
 */
export const loginUrl = (_opts: TLoginUrl): string => {
    return 'https://auth.deriv.com/oauth2/auth';
};

/**
 * redirectToNewAccountsLogin — starts PKCE login flow.
 * @deprecated Use startLogin() from @/utils/auth directly.
 */
export const redirectToNewAccountsLogin = async (): Promise<void> => {
    return startLogin();
};
