export const LOADER_CONFIG = {
    DURATION: 5000,

    ENABLED: true,

    BRANDING: {
        title: 'MAKOTI TRADERS',
        subtitle: 'TRADING PLATFORM',
    },

    ENVIRONMENT: {
        PRODUCTION_ONLY: false,
        DEVELOPMENT_DURATION: 3000,
        PRODUCTION_DURATION: 5000,
    },

    ANIMATION: {
        FADE_IN_DURATION: 500,
        FADE_OUT_DURATION: 300,
        PROGRESS_UPDATE_INTERVAL: 100,
    },
};

export const getLoaderDuration = (): number => {
    if (LOADER_CONFIG.ENVIRONMENT.PRODUCTION_ONLY && process.env.NODE_ENV !== 'production') {
        return 0;
    }

    if (process.env.NODE_ENV === 'development') {
        return LOADER_CONFIG.ENVIRONMENT.DEVELOPMENT_DURATION;
    }

    return LOADER_CONFIG.ENVIRONMENT.PRODUCTION_DURATION;
};

export const isLoaderEnabled = (): boolean => {
    if (LOADER_CONFIG.ENVIRONMENT.PRODUCTION_ONLY && process.env.NODE_ENV !== 'production') {
        return false;
    }

    return LOADER_CONFIG.ENABLED;
};
