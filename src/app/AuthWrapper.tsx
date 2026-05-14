import React from 'react';
import ChunkLoader from '@/components/loader/chunk-loader';
import { isLoggedIn } from '@/utils/auth';
import { isAuthFlowComplete, getAuthState } from '@/utils/auth-state';
import { localize } from '@deriv-com/translations';
import { AuthFlowPage } from '@/pages/auth-flow';
import App from './App';

export const AuthWrapper = () => {
    const [isInitialized, setIsInitialized] = React.useState(false);
    const [shouldShowAuthFlow, setShouldShowAuthFlow] = React.useState(false);

    React.useEffect(() => {
        // New auth system: tokens live in sessionStorage.
        // The trading bot falls back to localStorage legacy tokens (acct1/token1)
        // that handleCallback() writes after a successful PKCE exchange.
        // Either token source is valid — no URL param parsing needed.
        
        const checkAuth = () => {
            // First check: do we have a valid token?
            const hasToken = isLoggedIn();
            const authState = getAuthState();
            const isCompleted = isAuthFlowComplete();
            
            console.log('[v0] AuthWrapper init - hasToken:', hasToken, 'isCompleted:', isCompleted, 'authState:', authState)
            
            // Decision logic:
            // 1. If user has token AND auth is completed → show app
            // 2. If user has token but auth not completed → still show app (they logged in)
            // 3. If user has NO token AND has never started auth → show auth flow
            // 4. If user has NO token AND auth state is not idle → still show auth flow
            
            if (hasToken) {
                // User successfully logged in - show app regardless of completion state
                setShouldShowAuthFlow(false);
            } else if (authState.authFlow === 'login' && authState.tradeToken === null) {
                // Initial state, no auth attempted yet
                setShouldShowAuthFlow(true);
            } else {
                // Auth in progress or failed, show auth flow
                setShouldShowAuthFlow(true);
            }
            
            setIsInitialized(true);
        };
        
        checkAuth();
    }, []);

    if (!isInitialized) {
        return <ChunkLoader message={localize('Initializing...')} />;
    }

    // Show auth flow only if there's no token
    if (shouldShowAuthFlow && !isLoggedIn()) {
        return <AuthFlowPage />;
    }

    return <App />;
};
