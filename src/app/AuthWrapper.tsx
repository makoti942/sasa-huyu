import App from './App';

/**
 * AuthWrapper — thin shell kept for import compatibility.
 * All auth is handled by AuthenticatedRoot inside App via the new PKCE flow.
 * The old URL-param token parser (acct1/token1 from OAuth redirect) is removed;
 * tokens now arrive via the /callback PKCE handler.
 */
export const AuthWrapper = () => <App />;
