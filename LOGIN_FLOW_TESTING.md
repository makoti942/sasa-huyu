# Login Flow Testing Guide

## Overview
This guide walks you through testing the new multi-scope OAuth2 login flow that was just implemented.

## What Was Built

### 1. Extended DerivAuth.js (src/auth/DerivAuth.js)
- **Multi-scope support**: Added `DERIV_CONFIG.scopes` with trade, admin, payments, trading_information
- **Separate OAuth flows**:
  - `startLoginFlow()` - Initiates OAuth2 with trade scope
  - `startAccountCreationFlow()` - Initiates OAuth2 with admin scope
  - `startLogin()` - Legacy backward-compatible wrapper
- **Token separation**: Stores trade tokens separately from admin tokens
- **Flow tracking**: SessionStorage tracks current flow type and scope

### 2. Auth State Manager (src/utils/auth-state.ts)
- Centralized auth state management
- Tracks authentication progress: `idle → login_pending → account_pending → completed`
- Methods:
  - `getAuthState()` - Get current auth progress
  - `setTradeToken()` - Store trade scope token
  - `setAdminToken()` - Store admin scope token
  - `advanceAuthFlow()` - Move to next step
  - `completeAuthFlow()` - Mark auth as complete
  - `isAuthFlowComplete()` - Check if user is fully authenticated

### 3. Login Page (src/pages/login/login-page.tsx)
- Clean, professional login UI
- Single button: "Login with Deriv"
- Triggers `startLoginFlow()` with trade scope
- Shows loading state while redirecting to Deriv auth

### 4. Account Creation Page (src/pages/account/account-creation-page.tsx)
- Form for account setup (ready for future Deriv admin API integration)
- Fields planned:
  - Personal information (name, email, phone)
  - Address details
  - Identity verification
  - Account preferences
- "Skip" button to proceed without account setup
- "Continue" button to process account creation via admin scope

### 5. Auth Flow Orchestrator (src/pages/auth-flow/auth-flow-page.tsx)
- Central hub for authentication flow
- Loading screen while initializing
- Routes users through appropriate steps:
  - If not logged in → Show Login Page
  - If logged in but account incomplete → Show Account Creation Page
  - If fully authenticated → Redirect to dashboard
- Tracks state transitions

### 6. Updated Callback Handler
- Detects which scope was used (trade vs admin)
- Stores tokens appropriately (trade vs admin storage)
- Routes based on flow type:
  - Login flow → complete and go to dashboard
  - Account creation flow → advance to account page

### 7. Updated AuthWrapper
- Checks authentication state on app load
- Shows auth flow if user hasn't completed authentication
- Falls back to main app if user is logged in

## Testing the Login Flow

### Step 1: Verify Environment Setup
```bash
cd /vercel/share/v0-project
npm install
npm run dev
```

The app should start on http://localhost:5173 (or similar)

### Step 2: Test Initial Load
1. Open your browser's DevTools (F12)
2. Go to Application → Session Storage
3. Load the app homepage
4. Expected behavior:
   - Should see `[v0]` console logs about auth state initialization
   - If not logged in, should redirect to auth-flow page
   - Loading screen should appear briefly

### Step 3: Test Login Flow
1. Click "Login with Deriv" button
2. Check console for `[v0] OAuth Flow: login Scope: trade`
3. You'll be redirected to Deriv's OAuth2 auth server
4. Login with your Deriv credentials
5. Deriv will redirect back to `/callback` on your app
6. Check Session Storage for:
   - `deriv_access_token` - Should be present (trade scope)
   - `deriv_token_expiry` - Should have future timestamp
   - `deriv_flow_type` - Should be "login"
   - `deriv_current_scope` - Should be "trade"

### Step 4: Verify Callback Processing
1. Check console for logs like:
   - `[v0] Token response status: 200`
   - `[v0] Callback: flow type = login`
   - `[v0] Token exchange params: {...}`
2. Should automatically redirect to dashboard (main app)

### Step 5: Verify Session Persistence
1. Hard refresh the page (Ctrl+Shift+R)
2. App should recognize you're logged in
3. Should load dashboard directly, not show auth flow
4. Token should still be in Session Storage

## Debug Logging

The implementation includes detailed `[v0]` console logs at each step:

```javascript
// In DerivAuth.js
console.log("[v0] Login URL:", ...)           // When starting login
console.log("[v0] OAuth Flow:", flowType, "Scope:", scope)  // Flow initialization
console.log("[v0] Token exchange params:", {...})  // Before token request
console.log("[v0] Token response status:", status)  // After token response

// In auth-state.ts
console.log("[v0] AuthState initialized:", state)  // State manager init
console.log("[v0] Advanced to:", nextPhase)        // Phase transitions

// In AuthWrapper
console.log('[v0] AuthWrapper init - auth state:', authState)  // Wrapper init
```

Filter your console for `[v0]` to see only app-specific logs.

## Troubleshooting

### Issue: "Missing required parameter client_id"
- **Cause**: Config values not matching between startLogin() and DERIV_CONFIG
- **Fix**: All code now uses DERIV_CONFIG as single source of truth
- **Check**: Verify VITE_DERIV_CLIENT_ID env var matches expected value

### Issue: Token not appearing in Session Storage
- **Cause**: OAuth callback failed or token endpoint error
- **Fix**: Check console logs for `[v0] Token response status`
- **Check**: Verify redirect_uri matches registered OAuth app setting

### Issue: Redirecting to wrong page after login
- **Cause**: Flow type not properly tracked
- **Fix**: Verify `deriv_flow_type` is set correctly in Session Storage
- **Check**: Session Storage should have `deriv_flow_type: "login"`

### Issue: Auth state not persisting across refresh
- **Cause**: Using localStorage instead of sessionStorage (or vice versa)
- **Fix**: Check auth-state.ts uses sessionStorage correctly
- **Check**: Open DevTools → Application → Session Storage (not Local Storage)

## Environment Variables (Optional)

Create a `.env` file to customize (or use defaults):

```
VITE_DERIV_CLIENT_ID=337DJLKi2OJ4VsyFSLIt9
VITE_DERIV_LEGACY_APP_ID=101585
VITE_DERIV_REDIRECT_URI=http://localhost:5173/callback
VITE_DERIV_AUTH_URL=https://auth.deriv.com/oauth2/auth
VITE_DERIV_TOKEN_URL=https://auth.deriv.com/oauth2/token
VITE_DERIV_REST_BASE=https://api.derivws.com/trading/v1
```

## Expected User Journey

### Login Path (Trade Scope)
1. User lands on app
2. Auth state is `idle`
3. Shown login page
4. Clicks "Login with Deriv"
5. Redirected to Deriv OAuth server
6. Completes Deriv login/consent
7. Redirected to `/callback`
8. Token exchanged and stored
9. Flow state advances to `login_pending`
10. Auth complete, redirected to dashboard
11. Dashboard shows trading interface

### Account Creation Path (Future - Admin Scope)
1. User already logged in with trade scope
2. Shown account creation page
3. Clicks "Create Account Details"
4. Second OAuth flow initiated with admin scope
5. User consents to admin scope
6. Account details collected and processed
7. Flow state advances to `completed`
8. User can access full platform features

## Next Steps

Once you verify the login flow works:

1. **Test the callback redirect**: Verify you get redirected to dashboard after login
2. **Check token storage**: Verify tokens appear in Session Storage
3. **Test page refresh**: Verify staying logged in after refresh
4. **Check console logs**: Verify `[v0]` debug messages appear

Once login flow is confirmed working, we'll:
1. Add account management scope (admin scope)
2. Implement account creation form submission
3. Add application insight scope
4. Test the complete multi-scope flow
