import { isLoggedIn } from '@/utils/auth';
import CommonStore from '@/stores/common-store';
import { TAuthData } from '@/types/api-types';
import { clearAuthData } from '@/utils/auth-utils';
import { observer as globalObserver } from '../../utils/observer';
import { doUntilDone, socket_state } from '../tradeEngine/utils/helpers';
import {
    CONNECTION_STATUS,
    setAccountList,
    setAuthData,
    setConnectionStatus,
    setIsAuthorized,
    setIsAuthorizing,
} from './observables/connection-status-stream';
import ApiHelpers from './api-helpers';
import {
    generateDerivApiInstance,
    getCurrentConnectionAppId,
    hasAppIdChanged,
    V2GetActiveClientId,
    V2GetActiveToken,
} from './appId';
import { getAppId } from '@/components/shared';
import chart_api from './chart-api';
import { createDerivWebSocket } from '@/auth/DerivAuth';

type CurrentSubscription = {
    id: string;
    unsubscribe: () => void;
};

type SubscriptionPromise = Promise<{
    subscription: CurrentSubscription;
}>;

type TApiBaseApi = {
    connection: {
        readyState: keyof typeof socket_state;
        addEventListener: (event: string, callback: () => void) => void;
        removeEventListener: (event: string, callback: () => void) => void;
    };
    send: (data: unknown) => void;
    disconnect: () => void;
    authorize: (token: string) => Promise<{ authorize: TAuthData; error: unknown }>;
    getSelfExclusion: () => Promise<unknown>;
    onMessage: () => {
        subscribe: (callback: (message: unknown) => void) => {
            unsubscribe: () => void;
        };
    };
} & ReturnType<typeof generateDerivApiInstance>;

class APIBase {
    api: TApiBaseApi | null = null;
    token: string = '';
    account_id: string = '';
    pip_sizes = {};
    account_info = {};
    is_running = false;
    subscriptions: CurrentSubscription[] = [];
    time_interval: ReturnType<typeof setInterval> | null = null;
    has_active_symbols = false;
    is_stopping = false;
    active_symbols = [];
    current_auth_subscriptions: SubscriptionPromise[] = [];
    is_authorized = false;
    active_symbols_promise: Promise<void> | null = null;
    common_store: CommonStore | undefined;
    landing_company: string | null = null;

    unsubscribeAllSubscriptions = () => {
        this.current_auth_subscriptions?.forEach(subscription_promise => {
            subscription_promise.then(({ subscription }) => {
                if (subscription?.id) {
                    this.api?.send({
                        forget: subscription.id,
                    });
                }
            });
        });
        this.current_auth_subscriptions = [];
    };

    onsocketopen() {
        setConnectionStatus(CONNECTION_STATUS.OPENED);
    }

    onsocketclose() {
        setConnectionStatus(CONNECTION_STATUS.CLOSED);
        this.reconnectIfNotConnected();
    }

    async init(force_create_connection = false) {
        this.toggleRunButton(true);

        if (this.api) {
            this.unsubscribeAllSubscriptions();
        }

        if (!this.api || this.api?.connection.readyState !== 1 || force_create_connection) {
            if (this.api?.connection) {
                ApiHelpers.disposeInstance();
                setConnectionStatus(CONNECTION_STATUS.CLOSED);
                this.api.disconnect();
                this.api.connection.removeEventListener('open', this.onsocketopen.bind(this));
                this.api.connection.removeEventListener('close', this.onsocketclose.bind(this));
            }
            const ws = await createDerivWebSocket();
            if (ws) {
                this.api = generateDerivApiInstance(ws);
                this.api?.connection.addEventListener('open', this.onsocketopen.bind(this));
                this.api?.connection.addEventListener('close', this.onsocketclose.bind(this));
            }
        }

        if (!this.has_active_symbols && !V2GetActiveToken()) {
            this.active_symbols_promise = this.getActiveSymbols();
        }

        this.initEventListeners();

        if (this.time_interval) clearInterval(this.time_interval);
        this.time_interval = null;

        if (V2GetActiveToken()) {
            setIsAuthorizing(true);
            await this.authorizeAndSubscribe();
        }

        chart_api.init(force_create_connection);
    }

    getConnectionStatus() {
        if (this.api?.connection) {
            const ready_state = this.api.connection.readyState;
            return socket_state[ready_state as keyof typeof socket_state] || 'Unknown';
        }
        return 'Socket not initialized';
    }

    async ensureCurrentAppId() {
        if (!this.api || this.api?.connection.readyState !== 1) {
            return;
        }

        if (hasAppIdChanged()) {
            const oldAppId = getCurrentConnectionAppId();
            const newAppId = getAppId();

            console.log(`🔌 [APP ID] App ID changed: ${oldAppId} → ${newAppId}`);

            if (this.is_running) {
                console.log(
                    `⚠️ [APP ID] Bot is running, cannot reconnect. New app_id ${newAppId} will be used on next connection.`
                );
                return;
            }

            console.log(`🔄 [APP ID] Reconnecting with new app_id ${newAppId} (safe - no active trades)...`);
            const token = V2GetActiveToken();
            const savedAccountId = this.account_id;

            if (!token) {
                console.warn('⚠️ [APP ID] No token found, cannot reconnect');
                return;
            }

            try {
                this.token = token;
                await this.init(true);

                if (this.api && this.api.connection) {
                    await new Promise<void>(resolve => {
                        if (this.api?.connection.readyState === 1) {
                            resolve();
                        } else {
                            const onOpen = () => {
                                this.api?.connection?.removeEventListener('open', onOpen);
                                resolve();
                            };
                            this.api?.connection?.addEventListener('open', onOpen);
                            setTimeout(() => resolve(), 5000); 
                        }
                    });
                }

                if (this.api && this.api.connection.readyState === 1) {
                    const { authorize, error } = await this.api.authorize(token);
                    if (error) {
                        console.error('❌ [APP ID] Re-authorization failed:', error);
                        throw error;
                    } else {
                        console.log(`✅ [APP ID] Reconnected and re-authorized with App ID ${newAppId}`);
                        this.account_id = savedAccountId;
                        this.account_info = authorize;
                        setAccountList(authorize?.account_list || []);
                        setAuthData(authorize);
                        setIsAuthorized(true);
                        this.is_authorized = true;
                    }
                }
            } catch (err) {
                console.error('❌ [APP ID] Reconnection error:', err);
            }
        }
    }

    async reconnectWithNewAppId() {
        if (!hasAppIdChanged()) {
            return; 
        }

        const oldAppId = getCurrentConnectionAppId();
        const newAppId = getAppId();
        const token = V2GetActiveToken();

        if (!token) {
            console.warn('⚠️ [WEBSOCKET] No token found, cannot reconnect');
            return;
        }

        console.log(`🔄 [WEBSOCKET] Reconnecting: ${oldAppId} → ${newAppId} (after trade completion)`);

        const savedToken = token;
        const savedAccountId = this.account_id;

        await this.init(true);

        if (this.api?.connection) {
            await new Promise<void>(resolve => {
                if (this.api?.connection.readyState === 1) {
                    resolve();
                } else {
                    const onOpen = () => {
                        this.api?.connection?.removeEventListener('open', onOpen);
                        resolve();
                    };
                    this.api?.connection?.addEventListener('open', onOpen);
                    setTimeout(() => resolve(), 5000); 
                }
            });
        }

        if (savedToken && this.api && this.api.connection.readyState === 1) {
            try {
                const { authorize, error } = await this.api.authorize(savedToken);
                if (error) {
                    console.error('❌ [WEBSOCKET] Re-authorization failed:', error);
                } else {
                    console.log(`✅ [WEBSOCKET] Reconnected and re-authorized with App ID ${newAppId}`);
                    this.account_id = savedAccountId;
                    this.account_info = authorize;
                    setAccountList(authorize?.account_list || []);
                    setAuthData(authorize);
                    setIsAuthorized(true);
                    this.is_authorized = true;
                }
            } catch (err) {
                console.error('❌ [WEBSOCKET] Re-authorization error:', err);
            }
        }
    }

    terminate() {
        if (this.api) this.api.disconnect();
    }

    initEventListeners() {
        if (window) {
            window.addEventListener('online', this.reconnectIfNotConnected);
            window.addEventListener('focus', this.reconnectIfNotConnected);
        }
    }

    async createNewInstance(account_id: string) {
        if (this.account_id !== account_id) {
            await this.init();
        }
    }

    reconnectIfNotConnected = () => {
        console.log('connection state: ', this.api?.connection?.readyState);
        if (this.api?.connection?.readyState && this.api?.connection?.readyState > 1) {
            console.log('Info: Connection to the server was closed, trying to reconnect.');
            this.init(true);
        }
    };

    async authorizeAndSubscribe() {
        const token = V2GetActiveToken();
        if (!token || !this.api) return;

        this.token = token;
        this.account_id = V2GetActiveClientId() ?? '';
        setIsAuthorizing(true);

        try {
            const { authorize, error } = await this.api.authorize(this.token);
            if (error) {
                if (error.code === 'InvalidToken') {
                    const is_tmb_enabled = window.is_tmb_enabled === true;
                    if (isLoggedIn() && !is_tmb_enabled) {
                        globalObserver.emit('InvalidToken', { error });
                    } else {
                        clearAuthData();
                    }
                } else {
                    console.error('Authorization error:', error);
                }
                return error;
            }

            this.account_info = authorize;
            setAccountList(authorize?.account_list || []);
            setAuthData(authorize);
            setIsAuthorized(true);
            this.is_authorized = true;
            localStorage.setItem('client_account_details', JSON.stringify(authorize?.account_list));
            localStorage.setItem('client.country', authorize?.country);

            if (this.has_active_symbols) {
                this.toggleRunButton(false);
            } else {
                this.active_symbols_promise = this.getActiveSymbols();
            }
            this.subscribe();
            this.getSelfExclusion();
        } catch (e) {
            console.error('Authorization failed:', e);
            this.is_authorized = false;
            clearAuthData();
            setIsAuthorized(false);
            globalObserver.emit('Error', e);
        } finally {
            setIsAuthorizing(false);
        }
    }

    async getSelfExclusion() {
        if (!this.api || !this.is_authorized) return;
        await this.api.getSelfExclusion();
    }

    async subscribe() {
        const subscribeToStream = (streamName: string) => {
            return doUntilDone(
                () => {
                    const subscription = this.api?.send({
                        [streamName]: 1,
                        subscribe: 1,
                        ...(streamName === 'balance' ? { account: 'all' } : {}),
                    });
                    if (subscription) {
                        this.current_auth_subscriptions.push(subscription);
                    }
                    return subscription;
                },
                [],
                this
            );
        };

        const streamsToSubscribe = ['balance', 'transaction', 'proposal_open_contract'];

        await Promise.all(streamsToSubscribe.map(subscribeToStream));
    }

    getActiveSymbols = async () => {
        await doUntilDone(() => this.api?.send({ active_symbols: 'brief' }), [], this).then(
            ({ active_symbols = [], error = {} }) => {
                const pip_sizes = {};
                if (active_symbols.length) this.has_active_symbols = true;
                active_symbols.forEach(({ symbol, pip }: { symbol: string; pip: string }) => {
                    (pip_sizes as Record<string, number>)[symbol] = +(+pip).toExponential().substring(3);
                });
                this.pip_sizes = pip_sizes as Record<string, number>;
                this.toggleRunButton(false);
                this.active_symbols = active_symbols;
                return active_symbols || error;
            }
        );
    };

    toggleRunButton = (toggle: boolean) => {
        const run_button = document.querySelector('#db-animation__run-button');
        if (!run_button) return;
        (run_button as HTMLButtonElement).disabled = toggle;
    };

    setIsRunning(toggle = false) {
        this.is_running = toggle;
    }

    pushSubscription(subscription: CurrentSubscription) {
        this.subscriptions.push(subscription);
    }

    clearSubscriptions() {
        this.subscriptions.forEach(s => s.unsubscribe());
        this.subscriptions = [];

        const global_timeouts = globalObserver.getState('global_timeouts') ?? [];

        global_timeouts.forEach((_: unknown, i: number) => {
            clearTimeout(i);
        });
    }
}

export const api_base = new APIBase();
