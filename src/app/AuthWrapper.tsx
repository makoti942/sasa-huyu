import React from 'react';
import ChunkLoader from '@/components/loader/chunk-loader';
import { isLoggedIn } from '@/utils/auth';
import { localize } from '@deriv-com/translations';
import App from './App';

export const AuthWrapper = () => {
    const [isAuthComplete, setIsAuthComplete] = React.useState(false);

    React.useEffect(() => {
        // New auth system: tokens live in sessionStorage.
        // The trading bot falls back to localStorage legacy tokens (acct1/token1)
        // that handleCallback() writes after a successful PKCE exchange.
        // Either token source is valid — no URL param parsing needed.
        setIsAuthComplete(true);
    }, []);

    if (!isAuthComplete) {
        return <ChunkLoader message={localize('Initializing...')} />;
    }

    return <App />;
};
