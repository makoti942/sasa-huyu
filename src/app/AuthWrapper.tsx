import React from 'react';
import ChunkLoader from '@/components/loader/chunk-loader';
import { isLoggedIn } from '@/utils/auth';
import { localize } from '@deriv-com/translations';
import { AuthFlowPage } from '@/pages/auth-flow';
import App from './App';

export const AuthWrapper = () => {
    const [isInitialized, setIsInitialized] = React.useState(false);
    const [isUserLoggedIn, setIsUserLoggedIn] = React.useState(false);

    React.useEffect(() => {
        // Check authentication state
        // isLoggedIn() now checks BOTH sessionStorage tokens AND auth-state
        const loggedIn = isLoggedIn();
        console.log('[v0] AuthWrapper: checking auth - isLoggedIn()=', loggedIn)
        
        setIsUserLoggedIn(loggedIn);
        setIsInitialized(true);
    }, []);

    if (!isInitialized) {
        return <ChunkLoader message={localize('Initializing...')} />;
    }

    // Simple rule: 
    // - If user has a valid token → show app
    // - If user has no token → show auth flow
    if (isUserLoggedIn) {
        return <App />;
    } else {
        return <AuthFlowPage />;
    }
};
