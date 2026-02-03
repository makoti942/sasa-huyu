import React, { lazy, Suspense, useEffect } from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { useLocation, useNavigate } from 'react-router-dom';
import ChunkLoader from '@/components/loader/chunk-loader';
import DesktopWrapper from '@/components/shared_ui/desktop-wrapper';
import MobileWrapper from '@/components/shared_ui/mobile-wrapper';
import Tabs from '@/components/shared_ui/tabs/tabs';
import TradingViewModal from '@/components/trading-view-chart/trading-view-modal';
import { DBOT_TABS } from '@/constants/bot-contents';
import { api_base } from '@/external/bot-skeleton';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import useTMB from '@/hooks/useTMB';
import {
    LabelPairedChartLineCaptionRegularIcon,
    LabelPairedObjectsColumnCaptionRegularIcon,
    LabelPairedPuzzlePieceTwoCaptionBoldIcon,
    LabelPairedPlayCaptionBoldIcon,
} from '@deriv/quill-icons/LabelPaired';
import { LegacyChartsIcon, LegacyIndicatorsIcon } from '@deriv/quill-icons/Legacy';
import { requestOidcAuthentication } from '@deriv-com/auth-client';
import { Localize, localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import RunPanel from '../../components/run-panel';
import SpeedBotFloatingStop from '../../components/speedbot-floating-stop';
import ChartModal from '../chart/chart-modal';
import Dashboard from '../dashboard';
import RunStrategy from '../dashboard/run-strategy';
import OverUnder from '../OverUnder'; 
import MakotiMagic from './MakotiMagic'; // Adjusted to relative path
import './main.scss';

const ChartWrapper = lazy(() => import('../chart/chart-wrapper'));
const TradingView = lazy(() => import('../tradingview'));
const AnalysisTools = lazy(() => import('../analysis-tool'));
const CopyTrading = lazy(() => import('../copy-trading'));
const Strategies = lazy(() => import('../free-bots/strategies'));
const Dtrader = lazy(() => import('../dtrader'));
import TradingBots from '../free-bots/trading-bots';

const AppWrapper = observer(() => {
    const { connectionStatus } = useApiBase();
    const { dashboard, run_panel, quick_strategy, summary_card } = useStore();
    const {
        active_tab,
        active_tour,
        setActiveTab,
        setWebSocketState,
        setTourDialogVisibility,
    } = dashboard;
    const { stopBot } = run_panel;
    const { is_open } = quick_strategy;
    const { clear } = summary_card;
    const { DASHBOARD } = DBOT_TABS;
    const init_render = React.useRef(true);

    const hash = [
        'dashboard',
        'bot_builder',
        'chart',
        'trading_bots',
        'over_under',
        'analysis_tool',
        'strategies',
        'copy_trading',
        'dtrader',
        'tradingview',
        'makoti_magic', 
    ];
    
    const { isDesktop } = useDevice();
    const location = useLocation();
    const navigate = useNavigate();

    const GetHashedValue = (tab: number) => {
        const tab_val = location.hash?.split('#')[1];
        if (!tab_val) return tab;
        return Number(hash.indexOf(String(tab_val)));
    };
    const active_hash_tab = GetHashedValue(active_tab);
    const { onRenderTMBCheck, isTmbEnabled } = useTMB();

    useEffect(() => {
        if (connectionStatus !== CONNECTION_STATUS.OPENED) {
            const is_bot_running = document.getElementById('db-animation__stop-button') !== null;
            if (is_bot_running) {
                clear();
                stopBot();
                api_base.setIsRunning(false);
                setWebSocketState(false);
            }
        }
    }, [clear, connectionStatus, setWebSocketState, stopBot]);

    useEffect(() => {
        if (is_open) setTourDialogVisibility(false);

        if (init_render.current) {
            const tabToSet = location.hash ? Number(active_hash_tab) : 1;
            setActiveTab(tabToSet);
            init_render.current = false;
        } else {
            navigate(`#${hash[active_tab] || 'bot_builder'}`);
        }
    }, [active_tab]);

    const handleTabChange = (tab_index: number) => {
        setActiveTab(tab_index);
    };

    return (
        <React.Fragment>
            <div className='main'>
                <div className={classNames('main__container', { 'main__container--active': active_tour && active_tab === DASHBOARD && !isDesktop })}>
                    <Tabs active_index={active_tab} className='main__tabs' onTabItemClick={handleTabChange} top>
                        <div label={<><LabelPairedObjectsColumnCaptionRegularIcon height='24px' width='24px' /><Localize i18n_default_text='Dashboard' /></>} id='id-dbot-dashboard'>
                            <Dashboard handleTabChange={handleTabChange} />
                        </div>
                        <div label={<><LabelPairedPuzzlePieceTwoCaptionBoldIcon height='24px' width='24px' /><Localize i18n_default_text='Bot Builder' /></>} id='id-bot-builder' />
                        <div label={<><LabelPairedChartLineCaptionRegularIcon height='24px' width='24px' /><Localize i18n_default_text='Charts' /></>} id='id-charts'>
                            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading chart...')} />}><ChartWrapper show_digits_stats={false} /></Suspense>
                        </div>
                        <div label={<><LabelPairedPuzzlePieceTwoCaptionBoldIcon height='24px' width='24px' /><Localize i18n_default_text='Trading Bots' /></>} id='id-trading-bots'>
                            <TradingBots />
                        </div>
                        
                        <div label={<><LabelPairedPlayCaptionBoldIcon height='24px' width='24px' /><Localize i18n_default_text='Over/Under Tool' /></>} id='over_under'>
                            <OverUnder />
                        </div>

                        {/* MAKOTI MAGIC TAB */}
                        <div label={<><LabelPairedPlayCaptionBoldIcon height='24px' width='24px' /><Localize i18n_default_text='Makoti Magic' /></>} id='makoti_magic'>
                            <MakotiMagic />
                        </div>

                        <div label={<><LegacyIndicatorsIcon height='16px' width='16px' /><Localize i18n_default_text='Analysis Tool' /></>} id='id-analysis-tool'>
                            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading Analysis Tool...')} />}><AnalysisTools /></Suspense>
                        </div>
                        <div label={<><LabelPairedPuzzlePieceTwoCaptionBoldIcon height='24px' width='24px' /><Localize i18n_default_text='Strategies' /></>} id='id-strategies'>
                            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading Strategies...')} />}><Strategies /></Suspense>
                        </div>
                        <div label={<><LabelPairedObjectsColumnCaptionRegularIcon height='24px' width='24px' /><Localize i18n_default_text='Copy Trading' /></>} id='id-copy-trading'>
                            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading Copy Trading...')} />}><AnalysisTools /></Suspense>
                        </div>
                        <div label={<><LabelPairedChartLineCaptionRegularIcon height='24px' width='24px' /><Localize i18n_default_text='DTrader' /></>} id='id-dtrader'>
                            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading DTrader...')} />}><Dtrader /></Suspense>
                        </div>
                        <div label={<><LegacyChartsIcon height='16px' width='16px' /><Localize i18n_default_text='TradingView' /></>} id='id-tradingview'>
                            <Suspense fallback={<ChunkLoader message={localize('Please wait, loading TradingView...')} />}><TradingView /></Suspense>
                        </div>
                    </Tabs>
                </div>
            </div>
            <DesktopWrapper>
                {active_tab !== 8 && hash[active_tab] !== 'over_under' && hash[active_tab] !== 'makoti_magic' && (
                    <div className='main__run-strategy-wrapper'>
                        {active_tab !== 3 && <RunStrategy />}
                        <RunPanel />
                    </div>
                )}
                <ChartModal /><TradingViewModal />
            </DesktopWrapper>
            <MobileWrapper>{!is_open && active_tab !== 6 && <RunPanel />}</MobileWrapper>
            <SpeedBotFloatingStop />
        </React.Fragment>
    );
});

export default AppWrapper;
