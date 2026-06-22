import { ComponentProps, ReactNode, useMemo } from 'react';
import Livechat from '@/components/chat/Livechat';
import useIsLiveChatWidgetAvailable from '@/components/chat/useIsLiveChatWidgetAvailable';
import { generateOAuthURL, standalone_routes } from '@/components/shared';
import { useOauth2 } from '@/hooks/auth/useOauth2';
import { useFirebaseCountriesConfig } from '@/hooks/firebase/useFirebaseCountriesConfig';
import useRemoteConfig from '@/hooks/growthbook/useRemoteConfig';
import { useIsIntercomAvailable } from '@/hooks/useIntercom';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import useTMB from '@/hooks/useTMB';
import RootStore from '@/stores/root-store';
import {
    LegacyAccountLimitsIcon,
    LegacyCashierIcon,
    LegacyChartsIcon,
    LegacyHelpCentreIcon,
    LegacyHomeOldIcon,
    LegacyLogout1pxIcon,
    LegacyProfileSmIcon,
    LegacyReportsIcon,
    LegacyResponsibleTradingIcon,
    LegacyTheme1pxIcon,
    LegacyWhatsappIcon,
} from '@deriv/quill-icons/Legacy';
import { BrandDerivLogoCoralIcon } from '@deriv/quill-icons/Logo';
import { useTranslations } from '@deriv-com/translations';
import { ToggleSwitch } from '@deriv-com/ui';
import { URLConstants } from '@deriv-com/utils';

export type TSubmenuSection = 'accountSettings' | 'cashier' | 'reports';

//IconTypes
type TMenuConfig = {
    LeftComponent: React.ElementType;
    RightComponent?: ReactNode;
    as: 'a' | 'button';
    href?: string;
    label: ReactNode;
    onClick?: () => void;
    removeBorderBottom?: boolean;
    submenu?: TSubmenuSection;
    target?: ComponentProps<'a'>['target'];
    isActive?: boolean;
}[];

const useMobileMenuConfig = (client?: RootStore['client']) => {
    const { localize } = useTranslations();
    const { is_dark_mode_on, toggleTheme } = useThemeSwitcher();

    const { oAuthLogout } = useOauth2({ handleLogout: async () => client?.logout(), client });

    const { data } = useRemoteConfig(true);
    const { cs_chat_whatsapp } = data;

    const { is_livechat_available } = useIsLiveChatWidgetAvailable();
    const icAvailable = useIsIntercomAvailable();

    // Get current account information for dependency tracking
    const is_virtual = client?.is_virtual;
    const currency = client?.getCurrency?.();
    const is_logged_in = client?.is_logged_in;
    const client_residence = client?.residence;
    const accounts = client?.accounts || {};
    const { isTmbEnabled, onRenderTMBCheck } = useTMB();
    const is_tmb_enabled = window.is_tmb_enabled === true;

    const { hubEnabledCountryList } = useFirebaseCountriesConfig();

    // Function to add account parameter to URLs
    const getAccountUrl = (url: string) => {
        try {
            const redirect_url = new URL(url);
            // Check if the account is a demo account
            // Use the URL parameter to determine if it's a demo account, as this will update when the account changes
            const urlParams = new URLSearchParams(window.location.search);
            const account_param = urlParams.get('account');
            const is_virtual = client?.is_virtual || account_param === 'demo';
            const currency = client?.getCurrency?.();

            if (is_virtual) {
                // For demo accounts, set the account parameter to 'demo'
                redirect_url.searchParams.set('account', 'demo');
            } else if (currency) {
                // For real accounts, set the account parameter to the currency
                redirect_url.searchParams.set('account', currency);
            }

            return redirect_url.toString();
        } catch (error) {
            return url;
        }
    };

    const has_wallet = Object.keys(accounts).some(id => accounts[id].account_category === 'wallet');
    const is_hub_enabled_country = hubEnabledCountryList.includes(client?.residence || '');
    // Determine the appropriate redirect URL based on user's country
    const getRedirectUrl = () => {
        // Check if the user's country is in the hub-enabled country list
        if (has_wallet && is_hub_enabled_country) {
            return getAccountUrl(standalone_routes.account_settings);
        }
        return getAccountUrl(standalone_routes.personal_details);
    };

    const menuConfig = useMemo(
        (): TMenuConfig[] => [
            [
                !is_logged_in && {
                    as: 'button',
                    label: localize('Log in'),
                    LeftComponent: LegacyProfileSmIcon,
                    onClick: async () => {
                        const tmbEnabled = await isTmbEnabled();
                        if (tmbEnabled) {
                            await onRenderTMBCheck(true, undefined, false);
                        } else {
                            window.location.href = generateOAuthURL(false, 'home');
                        }
                    },
                },
                {
                    as: 'button',
                    label: localize('Deposit or withdraw'),
                    LeftComponent: LegacyCashierIcon,
                    onClick: () => {
                        const pkg = 'com.binary.mpesaservices';
                        const fallback = 'https://play.google.com/store/search?q=Binary+Mpesa+Services&c=apps';
                        const isAndroid = /android/i.test(navigator.userAgent);
                        if (isAndroid) {
                            window.location.href = `intent://#Intent;package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
                        } else {
                            window.open(fallback, '_blank');
                        }
                    },
                },
                {
                    as: 'button',
                    label: localize('Dark theme'),
                    LeftComponent: LegacyTheme1pxIcon,
                    RightComponent: <ToggleSwitch value={is_dark_mode_on} onChange={toggleTheme} />,
                    removeBorderBottom: true,
                },
            ].filter(Boolean) as TMenuConfig,
        ],
        [is_dark_mode_on, toggleTheme, is_logged_in, localize]
    );

    return {
        config: menuConfig,
    };
};

export default useMobileMenuConfig;
