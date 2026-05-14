// Re-exports from the single auth source of truth
export {
    startLogin,
} from '@/auth/DerivAuth';

// startSignup uses the same PKCE login flow
export const startSignup = startLogin;
