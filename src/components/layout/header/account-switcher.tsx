import React, { useEffect } from 'react';
import { lazy, Suspense, useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { CurrencyIcon } from '@/components/currency/currency-icon';
import { addComma, getDecimalPlaces } from '@/components/shared';
import Popover from '@/components/shared_ui/popover';
import { api_base } from '@/external/bot-skeleton';
import { useOauth2 } from '@/hooks/auth/useOauth2';
import { useApiBase } from '@/hooks/useApiBase';
import { useStore } from '@/hooks/useStore';
import { isCustomDemoIconActive } from '@/utils/custom-demo-icon-utils';
import { localize } from '@deriv-com/translations';
import { AccountSwitcher as UIAccountSwitcher, Loader, useDevice } from '@deriv-com/ui';
import CustomDemoIcon from './common/custom-demo-icon';
import DemoAccounts from './common/demo-accounts';
import RealAccounts from './common/real-accounts';
import { TAccountSwitcher, TAccountSwitcherProps, TModifiedAccount } from './common/types';
import { LOW_RISK_COUNTRIES } from './utils';
import './account-switcher.scss';

const AccountInfoWallets = lazy(() => import('./wallets/account-info-wallets'));

const tabs_labels = {
    demo: localize('Demo'),
    real: localize('Real'),
};

const RenderAccountItems = ({
    isVirtual,
    modifiedCRAccountList,
    modifiedMFAccountList,
    modifiedVRTCRAccountList,
    switchAccount,
    activeLoginId,
    client,
}: TAccountSwitcherProps) => {
    const { oAuthLogout } = useOauth2({ handleLogout: async () => client.logout(), client });
    const is_low_risk_country = LOW_RISK_COUNTRIES().includes(client.account_settings?.country_code ?? '');
    const is_virtual = !!isVirtual;
    const residence = client.residence;

    if (is_virtual) {
        return (
            <DemoAccounts
                modifiedVRTCRAccountList={modifiedVRTCRAccountList as TModifiedAccount[]}
                switchAccount={switchAccount}
                activeLoginId={activeLoginId}
                isVirtual={is_virtual}
                tabs_labels={tabs_labels}
                oAuthLogout={oAuthLogout}
                is_logging_out={client.is_logging_out}
            />
        );
    }
    return (
        <RealAccounts
            modifiedCRAccountList={modifiedCRAccountList as TModifiedAccount[]}
            modifiedMFAccountList={modifiedMFAccountList as TModifiedAccount[]}
            switchAccount={switchAccount}
            isVirtual={is_virtual}
            tabs_labels={tabs_labels}
            is_low_risk_country={is_low_risk_country}
            oAuthLogout={oAuthLogout}
            loginid={activeLoginId}
            is_logging_out={client.is_logging_out}
            upgradeable_landing_companies={client?.landing_companies?.all_company ?? null}
            residence={residence}
        />
    );
};

const AccountSwitcher = observer(({ activeAccount }: TAccountSwitcher) => {
    const [showAsReal, setShowAsReal] = React.useState(false);
    React.useEffect(() => {
        const handleIconChange = () => {
            setShowAsReal(isCustomDemoIconActive());
        };
        window.addEventListener('custom_demo_icon_changed', handleIconChange);
        handleIconChange();
        return () => window.removeEventListener('custom_demo_icon_changed', handleIconChange);
    }, []);

    const { isDesktop } = useDevice();
    const { accountList } = useApiBase();
    const { ui, run_panel, client } = useStore();
    const { accounts, all_accounts_balance, website_status } = client;
    const { toggleAccountsDialog, is_accounts_switcher_on, account_switcher_disabled_message } = ui;
    const { is_stop_button_visible } = run_panel;
    const has_wallet = Object.keys(accounts).some(id => accounts[id].account_category === 'wallet');

    const modifiedAccountList = useMemo(() => {
        const demoAccount = accountList?.find(acc => acc.is_virtual);
        const demoBalance = demoAccount ? all_accounts_balance?.accounts?.[demoAccount.loginid]?.balance ?? 0 : 0;

        return accountList?.map(account => {
            const balanceData = all_accounts_balance?.accounts?.[account.loginid];
            const originalBalanceNum = balanceData?.balance ?? 0;
            const isOriginalVirtual = !!account.is_virtual;

            const finalBalance = showAsReal && !isOriginalVirtual && account.currency === 'USD' ? demoBalance : originalBalanceNum;

            const icon = isOriginalVirtual && showAsReal ? <CustomDemoIcon /> : <CurrencyIcon currency={account?.currency?.toLowerCase()} isVirtual={isOriginalVirtual} />;

            return {
                ...account,
                balance: addComma(finalBalance?.toFixed(getDecimalPlaces(account.currency)) ?? '0'),
                currencyLabel: isOriginalVirtual
                    ? tabs_labels.demo
                    : website_status?.currencies_config?.[account?.currency]?.name ?? account?.currency,
                icon: icon,
                isVirtual: isOriginalVirtual,
                isActive: account?.loginid === activeAccount?.loginid,
            };
        });
    }, [accountList, all_accounts_balance, website_status?.currencies_config, activeAccount?.loginid, showAsReal]);

    const activeModifiedAccount = useMemo(() => {
        const activeFromList = modifiedAccountList?.find(account => account.isActive);
        if (!activeFromList) return { ...activeAccount, isVirtual: !!activeAccount.is_virtual };

        const isOriginalVirtual = !!accountList?.find(acc => acc.loginid === activeFromList.loginid)?.is_virtual;

        if (showAsReal && isOriginalVirtual) {
            return {
                ...activeFromList,
                isVirtual: false, // To show real icon in header
                icon: <CurrencyIcon currency={activeFromList?.currency?.toLowerCase()} isVirtual={false} />,
            };
        }
        return activeFromList;
    }, [modifiedAccountList, accountList, activeAccount, showAsReal]);

    const modifiedCRAccountList = useMemo(() => {
        return modifiedAccountList?.filter(account => !account.is_virtual && account?.loginid?.includes('CR')) ?? [];
    }, [modifiedAccountList]);

    const modifiedMFAccountList = useMemo(() => {
        return modifiedAccountList?.filter(account => account?.loginid?.includes('MF')) ?? [];
    }, [modifiedAccountList]);

    const modifiedVRTCRAccountList = useMemo(() => {
        return modifiedAccountList?.filter(account => account.is_virtual) ?? [];
    }, [modifiedAccountList]);

    const switchAccount = async (loginId: number) => {
        const loginIdStr = loginId.toString();
        if (loginIdStr === activeAccount?.loginid) return;

        if (api_base?.api?.connection) {
            api_base.api.connection.close();
        }

        const account_list = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
        const token = account_list[loginIdStr];
        if (!token) {
            console.error('❌ [ACCOUNT SWITCH] Token not found for:', loginIdStr);
            return;
        }

        localStorage.setItem('authToken', token);
        localStorage.setItem('active_loginid', loginIdStr);

        await api_base?.init(true);
        window.location.reload();
    };

    return (
        activeModifiedAccount &&
        (has_wallet ? (
            <Suspense fallback={<Loader />}>
                <AccountInfoWallets is_dialog_on={is_accounts_switcher_on} toggleDialog={toggleAccountsDialog} />
            </Suspense>
        ) : (
            <Popover
                className='run-panel__info'
                classNameBubble='run-panel__info--bubble'
                alignment='bottom'
                message={account_switcher_disabled_message}
                zIndex='5'
            >
                <UIAccountSwitcher
                    activeAccount={activeModifiedAccount}
                    isDisabled={is_stop_button_visible}
                    tabsLabels={tabs_labels}
                    defaultTab={showAsReal && activeAccount?.is_virtual ? tabs_labels.real : undefined}
                    modalContentStyle={{
                        content: {
                            top: isDesktop ? '30%' : '50%',
                            borderRadius: '10px',
                        },
                    }}
                >
                    <UIAccountSwitcher.Tab title={tabs_labels.real}>
                        <RenderAccountItems
                            modifiedCRAccountList={modifiedCRAccountList as TModifiedAccount[]}
                            modifiedMFAccountList={modifiedMFAccountList as TModifiedAccount[]}
                            switchAccount={switchAccount}
                            activeLoginId={activeAccount?.loginid}
                            client={client}
                            isVirtual={false}
                        />
                    </UIAccountSwitcher.Tab>
                    <UIAccountSwitcher.Tab title={tabs_labels.demo}>
                        <RenderAccountItems
                            modifiedVRTCRAccountList={modifiedVRTCRAccountList as TModifiedAccount[]}
                            switchAccount={switchAccount}
                            isVirtual
                            activeLoginId={activeAccount?.loginid}
                            client={client}
                        />
                    </UIAccountSwitcher.Tab>
                </UIAccountSwitcher>
            </Popover>
        ))
    );
});

export default AccountSwitcher;
