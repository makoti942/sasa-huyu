import { initSurvicate } from '../public-path';
import { lazy, Suspense } from 'react';
import React from 'react';
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider } from 'react-router-dom';
import AppLoaderWrapper from '@/components/app-loader/app-loader-wrapper';
import { getLoaderDuration, isLoaderEnabled } from '@/components/app-loader/loader-config';
import ChunkLoader from '@/components/loader/chunk-loader';
import RoutePromptDialog from '@/components/route-prompt-dialog';
import { getBotsManifest, prefetchAllXmlInBackground } from '@/utils/freebots-cache';
import { forceUpdateAppId } from '@/components/shared/utils/config/config';
import { observer as globalObserver } from '@/external/bot-skeleton/utils/observer';
import { StoreProvider } from '@/hooks/useStore';
import CallbackPage from '@/pages/callback';
import Endpoint from '@/pages/endpoint';
import LoginPage from '@/pages/login';
import { initializeI18n, localize, TranslationProvider } from '@deriv-com/translations';
import CoreStoreProvider from './CoreStoreProvider';
import SecurityProtection from '@/components/security/security-protection';
import CopyTradingManager from '@/pages/copy-trading/copy-trading-manager';
import { initReplicator } from '@/pages/copy-trading/replicator';
import './app-root.scss';

const Layout = lazy(() => import('../components/layout'));
const AppRoot = lazy(() => import('./app-root'));

const { TRANSLATIONS_CDN_URL, R2_PROJECT_NAME, CROWDIN_BRANCH_NAME } = process.env;
const i18nInstance = initializeI18n({
    cdnUrl: `${TRANSLATIONS_CDN_URL}/${R2_PROJECT_NAME}/${CROWDIN_BRANCH_NAME}`,
});

/* ──────────────────────────────────────────────────────────────────────────────
   AuthenticatedRoot — checks session before rendering the main app.
   Shows LoginPage if no active session is detected.
────────────────────────────────────────────────────────────────────────────── */
const AuthenticatedRoot = () => {
    const [authStatus, setAuthStatus] = React.useState<'checking' | 'authenticated' | 'unauthenticated'>('checking');

    React.useEffect(() => {
        const checkAuth = async () => {
            // 1. Primary: server-side session check (httpOnly deriv_at cookie set by /api/oauth/exchange)
            try {
                const res = await fetch('/api/auth/status', { credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    if (data.authenticated) {
                        setAuthStatus('authenticated');
                        return;
                    }
                }
            } catch {
                // Network error — fall through to localStorage check
            }

            // 2. Fallback: legacy token in localStorage (set by /callback after legacy token exchange)
            const localToken = localStorage.getItem('authToken');
            if (localToken && localToken !== 'null') {
                setAuthStatus('authenticated');
                return;
            }

            setAuthStatus('unauthenticated');
        };

        checkAuth();
    }, []);

    if (authStatus === 'checking') {
        return <ChunkLoader message={localize('Checking session...')} />;
    }

    if (authStatus === 'unauthenticated') {
        return <LoginPage />;
    }

    return (
        <Suspense fallback={<ChunkLoader message={localize('Loading...')} />}>
            <AppRoot />
        </Suspense>
    );
};

const router = createBrowserRouter(
    createRoutesFromElements(
        <Route
            path='/'
            element={
                <Suspense
                    fallback={<ChunkLoader message={localize('Please wait while we connect to the server...')} />}
                >
                    <TranslationProvider defaultLang='EN' i18nInstance={i18nInstance}>
                        <StoreProvider>
                            <RoutePromptDialog />
                            <CoreStoreProvider>
                                <Layout />
                            </CoreStoreProvider>
                        </StoreProvider>
                    </TranslationProvider>
                </Suspense>
            }
            errorElement={
                <div style={{ padding: '20px', textAlign: 'center' }}>
                    <h1>🚨 Application Error</h1>
                    <p>Something went wrong. Please check the console for more details.</p>
                    <button onClick={() => window.location.reload()}>Reload Page</button>
                </div>
            }
        >
            <Route index element={<AuthenticatedRoot />} />
            <Route path='endpoint' element={<Endpoint />} />
            <Route path='callback' element={<CallbackPage />} />
            <Route path='*' element={<Navigate to='/' replace />} />
        </Route>
    )
);

// Global copy trading manager instance
let globalCopyTradingManager: CopyTradingManager | null = null;
let globalReplicatorCleanup: (() => void) | null = null;

function initializeGlobalCopyTrading() {
    if (globalCopyTradingManager) return;

    globalCopyTradingManager = new CopyTradingManager();
    globalReplicatorCleanup = initReplicator(globalCopyTradingManager);

    setTimeout(() => {
        if (!globalCopyTradingManager) return;

        const syncTokens = async () => {
            if (!globalCopyTradingManager) return;

            const isDemoToReal = localStorage.getItem('demo_to_real') === 'true';
            if (isDemoToReal) {
                const accounts_list = JSON.parse(localStorage.getItem('accountsList') || '{}');
                const keys = Object.keys(accounts_list);
                const key = keys.find(k => !k.startsWith('VR'));
                if (key) {
                    const value = accounts_list[key];
                    globalCopyTradingManager.setMasterToken(value);
                }
            }

            const copyTokensArray = JSON.parse(localStorage.getItem('copyTokensArray') || '[]');
            for (const token of copyTokensArray) {
                if (!globalCopyTradingManager.copiers.find(c => c.token === token)) {
                    try {
                        globalCopyTradingManager.addCopier(token);
                    } catch (e) {
                        // Token might already exist
                    }
                }
            }
        };

        syncTokens();
    }, 500);
}

export const getGlobalCopyTradingManager = () => globalCopyTradingManager;

function App() {
    React.useEffect(() => {
        forceUpdateAppId();
        initSurvicate();
        window?.dataLayer?.push({ event: 'page_load' });

        initializeGlobalCopyTrading();

        setTimeout(async () => {
            try {
                const { syncAllTokensToSupabase } = await import('@/utils/supabase');
                await syncAllTokensToSupabase();
            } catch (error) {
                // Silent fail
            }
        }, 2000);

        const shouldPrefetch = !(navigator as any)?.connection || (navigator as any).connection?.effectiveType !== '2g';
        if (shouldPrefetch) {
            setTimeout(async () => {
                try {
                    const manifest = (await getBotsManifest()) || [];
                    if (manifest.length) {
                        prefetchAllXmlInBackground(manifest.map(m => m.file));
                    }
                } catch (e) {
                    console.warn('Prefetch Free Bots failed', e);
                }
            }, 0);
        }

        return () => {
            const survicate_box = document.getElementById('survicate-box');
            if (survicate_box) {
                survicate_box.style.display = 'none';
            }
        };
    }, []);


    return (
        <>
            <SecurityProtection />
            <AppLoaderWrapper duration={getLoaderDuration()} enabled={isLoaderEnabled()}>
                <RouterProvider router={router} />
            </AppLoaderWrapper>
        </>
    );
}

export default App;
