# Multi-Scope OAuth2 Implementation Guide

## Overview

This document outlines the new multi-scope OAuth2 authentication system with sequential login and account creation flows.

## Architecture

### Single Source of Truth: DerivAuth.js

All authentication logic is centralized in `/src/auth/DerivAuth.js`. Key configuration:

```javascript
const DERIV_CONFIG = {
  clientId: "337DJLKi2OJ4VsyFSLIt9",
  legacyAppId: "101585",
  redirectUri: "window.location.origin/callback",
  scopes: {
    trade: "trade",           // Trading operations
    admin: "admin",           // Account management, KYC
    payments: "payments",     // Payment operations
    trading_information: "trading_information"
  }
}
```

### Session Storage Keys

- `deriv_access_token` - Trade scope token
- `deriv_admin_token` - Admin scope token
- `deriv_flow_type` - Current flow: 'login' | 'account_creation'
- `deriv_current_scope` - Current OAuth scope being used

## Flow Architecture

### Step 1: Auth Flow Page (Loading Screen)
**Route:** `/auth-flow`
**File:** `/src/pages/auth-flow/auth-flow-page.tsx`

Initial landing page that:
- Shows loading spinner
- Checks current authentication state
- Routes to appropriate next step:
  - If not logged in → Login Page
  - If logged in but needs account creation → Account Creation Page
  - If complete → Redirect to dashboard

### Step 2: Login Page (Trade Scope)
**Route:** `/login` (shown within auth-flow page)
**File:** `/src/pages/login/login-page.tsx`

Initiates OAuth2 flow with `trade` scope:
- Shows login interface
- Button calls `startLoginFlow()` from DerivAuth.js
- Redirects to Deriv auth server
- Returns to `/callback`

**What it does:**
- Generates PKCE challenge/verifier
- Stores state in sessionStorage
- Redirects user to `https://auth.deriv.com/oauth2/auth?scope=trade&...`

### Step 3: Callback Handler
**Route:** `/callback`
**File:** `/src/pages/callback/callback-page.tsx`

Handles OAuth2 callback:
- Extracts authorization code from URL
- Exchanges code for access token
- Stores tokens in sessionStorage (split by scope)
- Updates auth state
- Determines next action:
  - If login only → Redirect to dashboard `/`
  - If needs account creation → Redirect to `/auth-flow` to show account form

### Step 4: Account Creation Page (Admin Scope)
**Route:** Shown within auth-flow page after login
**File:** `/src/pages/account/account-creation-page.tsx`

Collects KYC and account information with admin scope:
- Personal information (name, DOB, email, phone)
- Address details
- Employment information
- Account preferences
- Initiates admin scope OAuth if needed

**Admin Scope Requirements:**
Required fields for account creation via admin scope:
- First Name & Last Name
- Date of Birth (YYYY-MM-DD)
- Email
- Phone Number
- Address (Street, City, State/Province, Country, ZIP)
- Employment Status
- Employment Industry
- Account Currency
- Risk Assessment (if required)

### Auth State Manager
**File:** `/src/utils/auth-state.ts`

Tracks authentication progress:
```typescript
type AuthFlow = 'login' | 'account_creation' | 'completed'

interface AuthState {
  authFlow: AuthFlow
  tradeToken: string | null
  adminToken: string | null
  timestamp: number
}
```

Functions:
- `getAuthState()` - Get current auth state
- `setTradeToken(token)` - Store trade scope token
- `setAdminToken(token)` - Store admin scope token
- `advanceAuthFlow()` - Move to next auth phase
- `completeAuthFlow()` - Mark auth complete
- `isAuthFlowComplete()` - Check if auth done
- `resetAuthFlow()` - Clear all auth state

## Credential Requirements by Scope

### Trade Scope (startLoginFlow)
**Used for:** Trading operations, market data access
**Required during:**
- Login phase
- Initial authentication

**Data collected:**
- Username
- Password
- 2FA code (if enabled)

### Admin Scope (startAccountCreationFlow)
**Used for:** Account management, KYC, profile updates, settings
**Required during:**
- Account creation/management
- Regulatory compliance
- Profile updates

**Credentials needed:**
1. **Personal Information**
   - First Name (required)
   - Last Name (required)
   - Middle Name (optional)
   - Date of Birth (YYYY-MM-DD, required)

2. **Contact Information**
   - Email (required)
   - Phone Number (required, E.164 format: +1234567890)

3. **Address**
   - Address Line 1 (required)
   - Address Line 2 (optional)
   - City (required)
   - State/Province (required for some countries)
   - Postal/ZIP Code (required)
   - Country (required, ISO-3166-1 alpha-2)

4. **Employment**
   - Employment Status (required: employed, self-employed, student, retired, unemployed, other)
   - Industry (optional, required if employed)
   - Job Title (optional, required if employed)
   - Years in Industry (optional)

5. **Account Preferences**
   - Preferred Currency (required)
   - Trading Experience (optional: beginner, intermediate, advanced)
   - Investment Purpose (optional)

6. **Risk Assessment** (if required)
   - Risk tolerance (low, medium, high)
   - Annual income (optional)
   - Net worth (optional)

## Testing the Login Flow

### Test Scenario 1: Basic Login Only
1. Visit the app at `/` or `/auth-flow`
2. Click "Login with Deriv"
3. Complete Deriv OAuth login
4. Should redirect to dashboard with trade token in sessionStorage

**Verify:**
```javascript
sessionStorage.getItem('deriv_access_token') // Should contain token
sessionStorage.getItem('deriv_flow_type') // Should be 'login'
```

### Test Scenario 2: Login + Account Creation
1. Visit `/auth-flow`
2. Complete login
3. Should show account creation form
4. Fill out all required fields
5. Should complete and redirect to dashboard with both tokens

**Verify:**
```javascript
sessionStorage.getItem('deriv_access_token') // Trade token
sessionStorage.getItem('deriv_admin_token') // Admin token
sessionStorage.getItem('deriv_flow_type') // 'account_creation'
```

### Test Scenario 3: Skip Account Creation
1. After login, click "Skip for now"
2. Should redirect to dashboard immediately
3. Can complete account creation later

## Token Management

### Trade Scope Token
- Used for: Trading operations, WebSocket connections
- Storage: `sessionStorage.deriv_access_token`
- Expiry: `sessionStorage.deriv_token_expiry`

### Admin Scope Token
- Used for: Account management operations
- Storage: `sessionStorage.deriv_admin_token`
- Expiry: `sessionStorage.deriv_admin_token_expiry`

Both tokens are PKCE-protected and exchanged via secure callback.

## Debug Logging

The system includes debug logging at key points. Check browser console for `[v0]` prefixed messages:

```javascript
// Login initiation
[v0] OAuth Flow: login Scope: trade

// Token exchange
[v0] Token response status: 200 data keys: [...keys]

// Callback handling
[v0] Callback: flow type = login token = present

// Auth state
[v0] AuthWrapper init - auth state: {...}
```

## Environment Variables

Optional environment variables in `.env`:
```
VITE_DERIV_CLIENT_ID=337DJLKi2OJ4VsyFSLIt9
VITE_DERIV_LEGACY_APP_ID=101585
VITE_DERIV_REDIRECT_URI=https://makotitraderss.vercel.app/callback
VITE_DERIV_AUTH_URL=https://auth.deriv.com/oauth2/auth
VITE_DERIV_TOKEN_URL=https://auth.deriv.com/oauth2/token
VITE_DERIV_REST_BASE=https://api.derivws.com/trading/v1
```

## Files Modified/Created

### Modified
- `src/auth/DerivAuth.js` - Multi-scope support, separate flow functions
- `src/utils/auth.ts` - Re-exports new functions
- `src/pages/callback/callback-page.tsx` - Multi-scope callback handling
- `src/app/AuthWrapper.tsx` - Auth state checking
- `src/app/App.tsx` - Added /auth-flow route

### Created
- `src/utils/auth-state.ts` - Auth state management
- `src/pages/login/login-page.tsx` - Login UI
- `src/pages/login/login-page.scss` - Login styles
- `src/pages/account/account-creation-page.tsx` - Account creation form
- `src/pages/account/account-creation-page.scss` - Account styles
- `src/pages/auth-flow/auth-flow-page.tsx` - Auth orchestrator
- `src/pages/auth-flow/auth-flow-page.scss` - Auth flow styles

## Next Steps

1. Test login flow in preview
2. Verify tokens are stored correctly
3. Complete account creation form with all required fields
4. Test skipping account creation
5. Verify dashboard loads with both token types
6. Test refresh behavior and session persistence
