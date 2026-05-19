# Authentication Flow Debugging Guide

## Problem Summary
User successfully logs in at callback page (shows "✓ Login successful! Redirecting…"), but after redirect to `/`, the app still shows the login page.

## Root Cause Analysis

The issue occurs because the authentication state check in `AuthenticatedRoot` (in `src/app/App.tsx`) fails. This happens in this order:

1. ✅ User is redirected from Deriv to `/callback?code=...&state=...`
2. ✅ Callback exchanges the code at `/api/oauth/exchange` endpoint
3. ✅ Backend sets `deriv_at` httpOnly cookie
4. ✅ Callback stores tokens in localStorage
5. ✅ Callback displays "Login successful!" message
6. ✅ Callback redirects to `/`
7. ❌ **AuthenticatedRoot checks `/api/auth/status` - this may fail**
8. ❌ **AuthenticatedRoot falls back to localStorage check - this may fail**
9. ❌ App shows login page instead of main app

## Debug Checklist

### Step 1: Check Browser Console Logs

Open your browser DevTools (F12) → Console tab and look for logs starting with:
- `[callback]` - logs from the callback page
- `[AuthenticatedRoot]` - logs from the auth check

Look specifically for:

**In Callback Logs:**
```
[callback] Sending to /api/oauth/exchange: {code, codeVerifier, redirectUri}
[callback] Exchange response status: 200
[callback] Exchange response: {success, account_id, hasLegacyTokens}
[callback] parsed accounts: [...] → active: CR123456
[callback] ✅ Stored to localStorage - activeId: CR123456 token length: 50
[callback] Verifying localStorage before redirect: {...}
```

**In AuthenticatedRoot Logs:**
```
[AuthenticatedRoot] 🔍 Checking authentication status...
[AuthenticatedRoot] 🍪 Cookie check result: {authenticated: true/false}
[AuthenticatedRoot] 📦 localStorage check: {...}
[AuthenticatedRoot] ✅ Authenticated via cookie/localStorage
```

### Step 2: Check Network Tab

1. Find the `/api/oauth/exchange` POST request
   - Status should be **200 OK**
   - Response should contain `legacy_tokens` and `account_id`
   - Response headers should include `Set-Cookie: deriv_at=...`

2. Find the `/api/auth/status` GET request (after redirect)
   - Status should be **200 OK**
   - Response should be `{authenticated: true}`
   - Should include `Cookie: deriv_at=...`

### Step 3: Check Storage Tab

1. **Cookies:**
   - Should have `deriv_at` cookie (httpOnly, so invisible in JS, but visible in DevTools)
   - Should have `logged_state` cookie
   - Check the Domain matches your current domain

2. **Local Storage:**
   - `authToken` - should be a long string (50+ chars)
   - `active_loginid` - should match pattern like `CR123456` or `VR123456`
   - `accountsList` - should be a JSON object
   - `is_tmb_enabled` - should be `'true'`

### Step 4: Check API Responses

Add temporary logging to see what `/api/oauth/exchange` returns:

In browser console:
```javascript
// Check if cookie was set
document.cookie  // Should include "deriv_at"

// Check localStorage
console.log({
  authToken: localStorage.getItem('authToken'),
  active_loginid: localStorage.getItem('active_loginid'),
  accountsList: localStorage.getItem('accountsList'),
})
```

## Common Issues & Solutions

### Issue 1: `/api/oauth/exchange` returns 200 but no legacy_tokens

**Symptom:** Exchange succeeds but `legacy_tokens: null` in response

**Cause:** The `/oauth2/legacy/tokens` endpoint on Deriv's server is failing or not returning tokens

**Check:** Look at server console logs for errors like:
```
[exchange] Legacy tokens response status: 401/403/500
```

**Solution:**
- Verify `DERIV_OAUTH_CLIENT_ID` is correct
- Check if the access_token is valid
- The token might have wrong scope

### Issue 2: localStorage data exists but not being read

**Symptom:** Console shows data stored, but AuthenticatedRoot says "Not authenticated"

**Cause:** The regex validation for `active_loginid` might be failing

**Check:** 
```javascript
const activeLogin = localStorage.getItem('active_loginid');
const hasValidLogin = /^(VR|CR|MF|MLT|MX|VRTC)\w+/.test(activeLogin);
console.log({activeLogin, hasValidLogin})
```

**Solution:** If `hasValidLogin` is false, the loginid format is wrong. Check what Deriv returns.

### Issue 3: Cookie not being set

**Symptom:** `/api/auth/status` returns `{authenticated: false}`

**Cause:** 
- Cookie domain mismatch (localhost vs actual domain)
- Cookie not being set in the response header
- CORS/credentials issue

**Check:**
- In Network tab, verify `Set-Cookie` header exists in `/api/oauth/exchange` response
- Check if domains match: callback sets for `.example.com` but app checks on `example.com`

**Solution:** Look at the `cookieStr()` function in `/api/oauth/exchange.ts` - it calculates domain from `req.headers.host`. Verify it matches.

### Issue 4: Timing issue (data not persisted before redirect)

**Symptom:** Logs show data stored, but immediately after redirect it's gone

**Cause:** Browser tab closed or localStorage cleared before app loads

**Solution:** Already increased timeout from 800ms to 1200ms in callback-page.tsx. If still failing, increase further or wait for network idle.

## Server-Side Debugging

Check server logs for errors:

```bash
# Watch server logs
# Look for these patterns:
[exchange] Sending to Deriv token endpoint
[exchange] Token exchange response: 200
[exchange] Legacy tokens response status: 200
[exchange] Setting cookies for domain: localhost:3000
[auth/status] Valid deriv_at cookie found
```

## Testing Steps

1. **Clear all data:**
   - Close browser tabs
   - Clear localStorage/sessionStorage/cookies
   - Restart dev server

2. **Fresh login attempt:**
   - Go to `/` (should see login page)
   - Click "Login to Account"
   - Complete Deriv login in the popup
   - Watch console logs carefully

3. **Check each step:**
   - After step 1 redirect, check callback logs
   - After `/api/oauth/exchange` response, check Network tab
   - After redirect to `/`, check AuthenticatedRoot logs

## If Still Not Working

1. **Add more logging:** Check both client (browser DevTools) and server (terminal) logs
2. **Test individual endpoints:**
   ```bash
   # Test auth/status directly
   curl -b "deriv_at=test_value" http://localhost:3000/api/auth/status
   # Should return {authenticated: true}
   ```
3. **Check Deriv OAuth configuration:** Verify OAUTH_CLIENT_ID matches registered app
4. **Check network connectivity:** Ensure backend can reach Deriv's OAuth servers

## Files Involved

- `/src/pages/callback/callback-page.tsx` - Initial callback handling
- `/src/app/App.tsx` - AuthenticatedRoot component (auth check)
- `/api/oauth/exchange.ts` - Token exchange endpoint
- `/api/auth/status.ts` - Session check endpoint
- `/api/auth/logout.ts` - Logout endpoint
- `/src/utils/pkce.ts` - PKCE flow initialization
