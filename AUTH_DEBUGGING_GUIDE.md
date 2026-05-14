# Deriv OAuth2 Authentication Debugging Guide

## The Error You're Seeing

**"Missing required parameter client_id"** typically occurs when:

1. The OAuth authorization request doesn't include the `client_id` parameter
2. The token exchange request (step 2) is missing `client_id`
3. There's a mismatch between the client_id you're using and what's registered in your Deriv account

**"No account found in response"** occurs after redirect when:
- The access token was successfully obtained
- But fetching accounts list failed or returned unexpected format

## Root Cause Analysis

Your code had two issues:

### Issue 1: Hardcoded Values vs Config Object
- `DERIV_CONFIG.clientId` = "337DJLKi2OJ4VsyFSLIt9" ✅
- But `startLogin()` had hardcoded `client_id: "337DJLKi2OJ4VsyFSLIt9"` (was correct, but inconsistent)
- **FIX**: Now all functions reference `DERIV_CONFIG` as the single source of truth

### Issue 2: Missing Debug Information
- No logging to see what parameters are actually being sent
- No visibility into API responses
- **FIX**: Added console.log() statements to trace the exact request

## How OAuth2 with PKCE Works (Your Flow)

```
1. User clicks "Login"
   ↓
2. startLogin()
   - Generates: code_verifier (64 chars), code_challenge (SHA256 hash of verifier)
   - Creates random state (CSRF protection)
   - Stores both in sessionStorage (tab-specific)
   - Redirects to: auth.deriv.com/oauth2/auth?client_id=...&code_challenge=...&state=...
   ↓
3. User logs in at Deriv
   ↓
4. Deriv redirects back to: yourapp.com/callback?code=AUTH_CODE&state=STATE
   ↓
5. handleCallback() in CallbackPage
   - Retrieves code from URL
   - Validates state matches saved state
   - Exchanges code for access_token using code_verifier (POST to token endpoint)
   - Stores access_token in sessionStorage
   ↓
6. Access token is ready for API calls
```

## Step-by-Step Debugging

### Step 1: Check Browser Console
When you click "Login", look for this log:
```
[v0] Login URL: https://auth.deriv.com/oauth2/auth?client_id=337DJLKi2OJ4VsyFSLIt9&...
```

**What to verify:**
- `client_id=337DJLKi2OJ4VsyFSLIt9` ✅
- `redirect_uri=https://makotitraderss.vercel.app/callback` ✅
- `code_challenge=` (should be a base64url string) ✅
- `scope=trade` ✅

### Step 2: After Deriv Login (Redirect)
You're now at `yourapp.com/callback?code=AUTH_CODE&state=STATE`

Look for these logs:
```
[v0] Token exchange params: { grant_type: "authorization_code", code: "***", ... }
[v0] Token response status: 200 data keys: [ "access_token", "expires_in", "token_type" ]
```

**If you see status 400 or 401:**
- The token exchange failed
- Check that `client_id`, `code_verifier`, and `redirect_uri` are EXACTLY the same as in step 1

### Step 3: sessionStorage Check
In browser DevTools → Application → Session Storage, verify:
- ✅ `deriv_access_token` exists and has a value
- ✅ `deriv_token_expiry` has a future timestamp
- ❌ `deriv_code_verifier` should be REMOVED after token exchange (cleanup)
- ❌ `deriv_oauth_state` should be REMOVED after validation (cleanup)

## Common Issues & Fixes

### Issue: "Deriv login failed: error_description..."
**Solution**: The error message from Deriv tells you what's wrong. Common ones:
- `invalid_client` → Your client_id is wrong or not registered
- `redirect_uri_mismatch` → Your redirect_uri doesn't match what's registered
- `invalid_scope` → Deriv requires different scopes for your account type
- `invalid_code` → Code expired (happens if you wait >10 minutes before exchanging)

### Issue: Token exchange succeeds but "No account found in response"
**Solution**: The WebSocket connection is failing. This means:
1. Access token is valid (token exchange succeeded)
2. But the REST API call to get accounts is failing

**Debug this by checking:**
```javascript
// In browser console, if logged in:
const token = sessionStorage.getItem('deriv_access_token')
console.log('Token exists:', !!token)

// Then test the accounts call manually:
fetch('https://api.derivws.com/trading/v1/options/accounts', {
  headers: {
    'Authorization': 'Bearer ' + token,
    'Deriv-App-ID': '337DJLKi2OJ4VsyFSLIt9',
    'Content-Type': 'application/json'
  }
}).then(r => r.json()).then(console.log)
```

### Issue: Opening Login in a New Tab
**Problem**: New tab has its own sessionStorage → code_verifier is lost
**Solution**: NEVER use `window.open()` for login. Always use `window.location.href = `

## Configuration

### Environment Variables
Create `.env.local` (don't commit) and set:
```bash
VITE_DERIV_CLIENT_ID=337DJLKi2OJ4VsyFSLIt9
VITE_DERIV_LEGACY_APP_ID=101585
VITE_DERIV_REDIRECT_URI=http://localhost:5173/callback  # for local dev
VITE_DERIV_AUTH_URL=https://auth.deriv.com/oauth2/auth
VITE_DERIV_TOKEN_URL=https://auth.deriv.com/oauth2/token
VITE_DERIV_REST_BASE=https://api.derivws.com/trading/v1
```

### Vercel Deployment
Set these in Vercel Dashboard → Settings → Environment Variables:
```
VITE_DERIV_CLIENT_ID=337DJLKi2OJ4VsyFSLIt9
VITE_DERIV_LEGACY_APP_ID=101585
VITE_DERIV_REDIRECT_URI=https://makotitraderss.vercel.app/callback
```

## What Was Fixed

1. ✅ **Unified Configuration**: All hardcoded values now come from `DERIV_CONFIG`
2. ✅ **Environment Variable Support**: Can override values via `.env` files
3. ✅ **Debug Logging**: Added `console.log("[v0] ...")` statements to trace execution
4. ✅ **Redirect URI Fix**: Now dynamically uses `window.location.origin` for better portability
5. ✅ **Error Messages**: Enhanced error details (HTTP status codes, full error responses)

## Next Steps

1. **Test locally**: 
   ```bash
   npm start
   # Click Login → should log [v0] Login URL
   # After Deriv login → should log [v0] Token response status: 200
   ```

2. **Check DevTools** (F12):
   - Console → Look for [v0] logs
   - Application → Session Storage → Verify tokens exist
   - Network → Check actual requests to auth.deriv.com

3. **If still failing**:
   - Share the exact error message from the console
   - Share the [v0] logs that appeared
   - Check if your client_id is registered in https://app.deriv.com/account/api-token

## API Reference

All auth functions are in `src/auth/DerivAuth.js`:

```javascript
// Start OAuth flow
import { startLogin } from '@/utils/auth'
await startLogin()

// Handle callback after redirect
import { handleCallback } from '@/utils/auth'
const token = await handleCallback()

// Check if logged in
import { isLoggedIn } from '@/utils/auth'
if (isLoggedIn()) { /* logged in */ }

// Get current token
import { getToken } from '@/utils/auth'
const token = getToken()

// Get auth headers for API calls
import { getAuthHeaders } from '@/utils/auth'
const headers = getAuthHeaders()

// Logout and clear session
import { logout } from '@/utils/auth'
logout() // redirects to Deriv logout, then back to your app

// Create WebSocket connection
import { createDerivWebSocket } from '@/utils/auth'
const ws = await createDerivWebSocket()
```
