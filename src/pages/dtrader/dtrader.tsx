import React, { useEffect, useState, useCallback } from 'react';
import { observer } from 'mobx-react-lite';
import IframeWrapper from '@/components/iframe-wrapper';
import { getAppId } from '@/components/shared/utils/config/config';
import { V2GetActiveToken, V2GetActiveClientId } from '@/external/bot-skeleton/services/api/appId';
import { redirectToLogin } from '@/components/shared/utils/login/login';
import { LocalStore } from '@/components/shared/utils/storage/storage';

const Dtrader = observer(() => {
    const [iframeSrc, setIframeSrc] = useState<string>('');
    const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

    const handleLogin = () => {
        const language = LocalStore.get('i18n_language') || 'EN';
        redirectToLogin(false, language);
    };

    const buildIframeUrl = useCallback((token: string, loginId: string) => {
        const clientAccountsStr = localStorage.getItem('clientAccounts') || '{}';
        const accountsListStr = localStorage.getItem('accountsList') || '{}';
        let currency = 'USD';

        try {
            const clientAccounts = JSON.parse(clientAccountsStr);
            const account = clientAccounts[loginId];
            if (account?.currency) {
                currency = account.currency;
            } else {
                const accountsList = JSON.parse(accountsListStr);
                const accountInfo = Object.keys(accountsList).find(key => key === loginId);
                if (accountInfo) {
                    const accountData = JSON.parse(localStorage.getItem('accountList') || '[]');
                    const acc = accountData.find((a: any) => a.loginid === loginId);
                    if (acc?.currency) {
                        currency = acc.currency;
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing clientAccounts:', error);
        }

        const appId = getAppId() || 337;
        const params = new URLSearchParams({
            acct1: loginId,
            token1: token,
            cur1: currency,
            lang: 'EN',
            app_id: appId.toString(),
            chart_type: 'area',
            interval: '1t',
            symbol: '1HZ100V',
            trade_type: 'over_under',
            hide_bot: '1',
            bot_disabled: 'true',
            disable_bot: '1',
            no_bot: '1',
            manual_only: '1',
            hide_bot_controls: 'true',
            hide_account_switcher: 'true',
            hide_trade_panel: 'true',
        });

        const url = `https://deriv-dtrader.vercel.app/dtrader?${params.toString()}`;
        setIframeSrc(url);
    }, []);

    useEffect(() => {
        const token = V2GetActiveToken();
        const activeLoginId = V2GetActiveClientId();

        if (token && activeLoginId) {
            setIsAuthenticated(true);
            buildIframeUrl(token, activeLoginId);
        } else {
            setIsAuthenticated(false);
            setIframeSrc('');
        }
    }, [buildIframeUrl]);

    useEffect(() => {
        const checkAuthAndUpdate = () => {
            const token = V2GetActiveToken();
            const activeLoginId = V2GetActiveClientId();

            if (token && activeLoginId) {
                if (!isAuthenticated) {
                    setIsAuthenticated(true);
                }
                buildIframeUrl(token, activeLoginId);
            } else if (isAuthenticated) {
                setIsAuthenticated(false);
                setIframeSrc('');
            }
        };

        const handleStorageChange = (e: StorageEvent) => {
            if (e.key === 'authToken' || e.key === 'active_loginid' || e.key === 'clientAccounts' || e.key === 'accountsList' || e.key === 'show_as_cr') {
                checkAuthAndUpdate();
            }
        };

        window.addEventListener('storage', handleStorageChange);

        const interval = setInterval(checkAuthAndUpdate, 2000);

        return () => {
            window.removeEventListener('storage', handleStorageChange);
            clearInterval(interval);
        };
    }, [isAuthenticated, buildIframeUrl]);

    if (!isAuthenticated) {
        return (
            <div style={{ padding: '20px', textAlign: 'center' }}>
                <p>Please log in to use DTrader.</p>
                <button onClick={handleLogin}>Log In</button>
            </div>
        );
    }

    if (!iframeSrc) {
        return (
            <div style={{ padding: '20px', textAlign: 'center' }}>
                <p>Loading DTrader...</p>
            </div>
        );
    }

    return (
        <IframeWrapper
            src={iframeSrc}
            title='DTrader'
            className='dtrader-container'
        />
    );
});

export default Dtrader;
