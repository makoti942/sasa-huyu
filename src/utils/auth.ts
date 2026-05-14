// Re-exports from the single auth source of truth
export {
    startLogin,
    startLoginFlow,
    startAccountCreationFlow,
    handleCallback,
    getToken,
    getAdminToken,
    getFlowType,
    getCurrentScope,
    isLoggedIn,
    logout,
    getAuthHeaders,
} from '@/auth/DerivAuth';
