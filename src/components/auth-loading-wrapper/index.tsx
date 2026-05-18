import React from 'react';

type AuthLoadingWrapperProps = {
    children: React.ReactNode;
};

/**
 * AuthLoadingWrapper — since PKCE is always enabled (is_tmb_enabled is permanently true),
 * the single-logout loading screen is never triggered. This wrapper simply renders its
 * children directly without any auth-state checks.
 */
const AuthLoadingWrapper = ({ children }: AuthLoadingWrapperProps) => {
    return <>{children}</>;
};

export default AuthLoadingWrapper;
