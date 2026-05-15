import React, { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { ToastContainer } from 'react-toastify';
import AuthLoadingWrapper from '@/components/auth-loading-wrapper';
import useLiveChat from '@/components/chat/useLiveChat';
import { BOT_RESTRICTED_COUNTRIES_LIST } from '@/components/layout/header/utils';
import ChunkLoader from '@/components/loader/chunk-loader';
import { getUrlBase } from '@/components/shared';
import TncStatusUpdateModal from '@/components/tnc-status-update-modal';
import TransactionDetailsModal from '@/components/transaction-details';
import { api_base, ApiHelpers, ServerTime } from '@/external/bot-skeleton';
import { V2GetActiveToken } from '@/external/bot-skeleton/services/api/appId';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { useApiBase } from '@/hooks/useApiBase';
import useIntercom from '@/hooks/useIntercom';
import { useStore } from '@/hooks/useStore';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import useTrackjs from '@/hooks/useTrackjs';
import initDatadog from '@/utils/datadog';
import initHotjar from '@/utils/hotjar';
import { setSmartChartsPublicPath } from '@deriv/deriv-charts';
import { ThemeProvider } from '@deriv-com/quill-ui';
import { localize } from '@deriv-com/translations';
import Audio from '../components/audio';
import BlocklyLoading from '../components/blockly-loading';
import BotStopped from '../components/bot-stopped';
import RiskDisclaimer from '../components/risk-disclaimer';
import RiskCalculatorButton from '../components/risk-calculator-button/risk-calculator-button';
import BotBuilder from '../pages/bot-builder';
import Main from '../pages/main';
import LoginScreen from '../pages/auth/LoginScreen'; // Import the new login screen
import { generateOAuthURL } from '@/components/shared'; // Import the function for the old login
import './app.scss';
import 'react-toastify/dist/ReactToastify.css';
import '../components/bot-notification/bot-notification.scss';

const AppContent = observer(() => {
    const [is_api_initialized, setIsApiInitialized] = React.useState(false);
    const [is_loading, setIsLoading] = React.useState(true);
    const store = useStore();
    const { app, transactions, common, client } = store;
    const { showDigitalOptionsMaltainvestError } = app;
    const { is_dark_mode_on } = useThemeSwitcher();

    const { recovered_transactions, recoverPendingContracts } = transactions;
    const is_subscribed_to_msg_listener = React.useRef(false);
    const msg_listener = React.useRef(null);
    const { connectionStatus } = useApiBase();
    const { initTrackJS } = useTrackjs();

    initTrackJS(client.loginid);

    useEffect(() => {
        if (connectionStatus === CONNECTION_STATUS.OPENED) {
            setIsApiInitialized(true);
            common.setSocketOpened(true);
        } else if (connectionStatus !== CONNECTION_STATUS.OPENED) {
            common.setSocketOpened(false);
        }
    }, [common, connectionStatus]);

    const handleMessage = React.useCallback(
        ({ data }) => {
            if (data?.msg_type === 'proposal_open_contract' && !data?.error) {
                const { proposal_open_contract } = data;
                if (
                    proposal_open_contract?.status !== 'open' &&
                    !recovered_transactions?.includes(proposal_open_contract?.contract_id)
                ) {
                    recoverPendingContracts(proposal_open_contract);
                }
            }
        },
        [recovered_transactions, recoverPendingContracts]
    );

    React.useEffect(() => {
        setSmartChartsPublicPath(getUrlBase('/js/smartcharts/'));
    }, []);

    React.useEffect(() => {
        if (!is_subscribed_to_msg_listener.current && client.is_logged_in && is_api_initialized && api_base?.api) {
            is_subscribed_to_msg_listener.current = true;
            msg_listener.current = api_base.api.onMessage()?.subscribe(handleMessage);
        }
        return () => {
            if (is_subscribed_to_msg_listener.current && msg_listener.current) {
                is_subscribed_to_msg_listener.current = false;
                msg_listener.current.unsubscribe?.();
            }
        };
    }, [is_api_initialized, client.is_logged_in, client.loginid, handleMessage, connectionStatus]);

    const init = () => {
        ServerTime.init(common);
        app.setDBotEngineStores();
        ApiHelpers.setInstance(app.api_helpers_store);
    };

    React.useEffect(() => {
        if (is_api_initialized) {
            init();
            if (!client.is_logged_in) {
                setIsLoading(false);
            }
        }
    }, [is_api_initialized, client.is_logged_in]);

    React.useEffect(() => {
        if (client.is_logged_in && client.is_landing_company_loaded && is_api_initialized) {
            const { active_symbols } = ApiHelpers.instance;
            active_symbols.retrieveActiveSymbols(true).then(() => {
                setIsLoading(false);
            });
        }
    }, [client.is_landing_company_loaded, is_api_initialized, client.loginid]);

    if (!client.is_logged_in && !is_loading) {
        const handleOldLogin = () => {
            // This replicates the logic from the old header button
            window.location.href = generateOAuthURL(false, 'home');
        };
        return <LoginScreen onOldLogin={handleOldLogin} />;
    }

    return is_loading ? (
        <ChunkLoader />
    ) : (
        <AuthLoadingWrapper>
            <ThemeProvider theme={is_dark_mode_on ? 'dark' : 'light'}>
                <BlocklyLoading />
                <div className='bot-dashboard bot' data-testid='dt_bot_dashboard'>
                    <Audio />
                    <Main />
                    <BotBuilder />
                    <BotStopped />
                    <TransactionDetailsModal />
                    <ToastContainer limit={3} draggable={false} />
                    <TncStatusUpdateModal />
                    <RiskDisclaimer />
                    <RiskCalculatorButton />
                </div>
            </ThemeProvider>
        </AuthLoadingWrapper>
    );
});

export default AppContent;
