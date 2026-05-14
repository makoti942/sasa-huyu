import React from 'react';
import ChunkLoader from '@/components/loader/chunk-loader';
import { isLoggedIn } from '@/utils/auth';
import { isAuthFlowComplete, getAuthState } from '@/utils/auth-state';
import { localize } from '@deriv-com/translations';
import { AuthFlowPage } from '@/pages/auth-flow';
import App from './App';

export const AuthWrapper = () => {
    const [isAuthComplete, setIsAuthComplete] = React.useState(false);
    const [showAuthFlow, setShowAuthFlow] = React.useState(false);

    React.useEffect(() => {
        // New auth system: tokens live in sessionStorage.
        // The trading bot falls back to localStorage legacy tokens (acct1/token1)
        // that handleCallback() writes after a successful PKCE exchange.
        // Either token source is valid — no URL param parsing needed.
        
        // Check if auth flow is complete
        const authState = getAuthState();
        console.log('[v0] AuthWrapper init - auth state:', authState)
        
        // If not complete and user hasn't just arrived, show auth flow
        if (!isAuthFlowComplete() && !isLoggedIn()) {
            setShowAuthFlow(true);
        }
        
        setIsAuthComplete(true);
    }, []);

    if (!isAuthComplete) {
        return <ChunkLoader message={localize('Initializing...')} />;
    }

    // Show auth flow if user needs to complete authentication
    if (showAuthFlow && !isAuthFlowComplete()) {
        return <AuthFlowPage />;
    }

    return <App />;
};
