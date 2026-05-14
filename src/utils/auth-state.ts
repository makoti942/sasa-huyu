/**
 * Auth State Manager
 * Tracks authentication progress through multi-scope OAuth flows
 * Handles: login → optional account creation → dashboard
 */

export type AuthFlowState = 'login' | 'account_creation' | 'completed'

export interface AuthStateData {
  authFlow: AuthFlowState
  tradeToken: string | null
  adminToken: string | null
  userProfile: UserProfileData | null
  completedAt: number | null
}

export interface UserProfileData {
  email?: string
  fullName?: string
  dateOfBirth?: string
  country?: string
  currency?: string
  phoneNumber?: string
  kycStatus?: 'pending' | 'approved' | 'rejected'
  accountId?: string
}

const STORAGE_KEY = 'deriv_auth_state'

/**
 * Initialize auth state with defaults
 */
export function initAuthState(): AuthStateData {
  return {
    authFlow: 'login',
    tradeToken: null,
    adminToken: null,
    userProfile: null,
    completedAt: null,
  }
}

/**
 * Get current auth state from sessionStorage
 */
export function getAuthState(): AuthStateData {
  if (typeof window === 'undefined') {
    return initAuthState()
  }

  const stored = sessionStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      return JSON.parse(stored)
    } catch (e) {
      console.error('[v0] Failed to parse auth state:', e)
      return initAuthState()
    }
  }
  return initAuthState()
}

/**
 * Update auth state
 */
export function setAuthState(state: Partial<AuthStateData>): void {
  if (typeof window === 'undefined') return

  const current = getAuthState()
  const updated = { ...current, ...state }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  console.log('[v0] Auth state updated:', updated)
}

/**
 * Advance to next flow step
 */
export function advanceAuthFlow(nextFlow: AuthFlowState): void {
  const current = getAuthState()
  setAuthState({ authFlow: nextFlow })
  console.log('[v0] Auth flow advanced from', current.authFlow, 'to', nextFlow)
}

/**
 * Mark authentication as completed
 */
export function completeAuthFlow(): void {
  setAuthState({
    authFlow: 'completed',
    completedAt: Date.now(),
  })
  console.log('[v0] Authentication flow completed')
}

/**
 * Check if auth flow is complete
 */
export function isAuthFlowComplete(): boolean {
  return getAuthState().authFlow === 'completed'
}

/**
 * Update user profile data
 */
export function updateUserProfile(profile: Partial<UserProfileData>): void {
  const current = getAuthState()
  const updated = { ...current.userProfile, ...profile }
  setAuthState({ userProfile: updated })
}

/**
 * Get user profile
 */
export function getUserProfile(): UserProfileData | null {
  return getAuthState().userProfile
}

/**
 * Store trade token in auth state
 */
export function setTradeToken(token: string): void {
  setAuthState({ tradeToken: token })
}

/**
 * Store admin token in auth state
 */
export function setAdminToken(token: string): void {
  setAuthState({ adminToken: token })
}

/**
 * Clear all auth state (logout)
 */
export function clearAuthState(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(STORAGE_KEY)
  console.log('[v0] Auth state cleared')
}
