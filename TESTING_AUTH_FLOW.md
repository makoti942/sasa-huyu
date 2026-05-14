# Testing the Fixed Authentication Flow

This guide walks through testing the critical fixes made to the login and authentication system.

## What Was Fixed

1. **Auth Persistence Bug** - Users were logged out after OAuth redirect
   - Changed AuthWrapper to properly check `isLoggedIn()` instead of `isAuthFlowComplete()`
   - Simplified logic: if user has token → show app, else → show auth flow
   - Callback now immediately completes auth flow

2. **Branding Update** - Changed from "Sasa Huyu" to "Makoti Traders"

3. **Create Account Option** - Added "Create Account" button to login page
   - Separate flow for account creation with admin scope
   - Toggle between login and create account views

## Pre-Testing Setup

### Check Environment Variables
```bash
# Make sure VITE_DERIV_CLIENT_ID is set to your Deriv app ID
echo $VITE_DERIV_CLIENT_ID  # Should show: 337DJLKi2OJ4VsyFSLIt9
```

### Start Dev Server
```bash
cd /vercel/share/v0-project
npm run dev
# Server should start on http://localhost:5173 (or similar)
```

## Test 1: Login Flow (Trade Scope)

### Steps:
1. Navigate to `http://localhost:5173/` (or your dev server URL)
2. **Verify Page Elements:**
   - Title should say "Welcome to Makoti Traders" (NOT "Sasa Huyu")
   - Should see login benefits list
   - "Login with Deriv" button (green)
   - "Create New Account" button (outlined)
   - Disclaimer text about Deriv

3. **Click "Login with Deriv"**
   - Should be redirected to https://auth.deriv.com/oauth2/auth?...
   - Open browser DevTools → Console → Look for `[v0]` logs showing:
     ```
     [v0] Login URL: https://auth.deriv.com/oauth2/auth?...
     [v0] OAuth Flow: login Scope: trade
     ```

4. **At Deriv Login Page:**
   - Use your test Deriv account credentials
   - OR create a demo account if you don't have one
   - Complete login

5. **After Login (Critical Test):**
   - Should redirect to `https://yourdomain.com/callback`
   - Should see "Login successful - redirecting..."
   - DevTools Console should show:
     ```
     [v0] Callback: received token = present flowType = login
     [v0] Stored trade token
     [v0] Auth flow marked as completed
     ```
   - After ~1.2 seconds, should redirect to home page `/`
   - **CRITICAL:** You should NOW be logged in and see the main app
   - NOT logged out/redirected to login again

### Expected Result ✓
- User is logged in and can access the dashboard
- Token is stored in Session Storage (check DevTools → Application → Session Storage)
  - Should see `deriv_access_token` with a value
  - Should see `deriv_flow_type` = "login"

---

## Test 2: Create Account Flow (Admin Scope)

### Steps:
1. Navigate back to `http://localhost:5173/`
2. **Click "Create New Account"**
   - Page should change to show account creation view
   - Should see "Create Account" header
   - "Create Account with Deriv" button
   - "← Back to Login" link

3. **Click "Create Account with Deriv"**
   - Should be redirected to https://auth.deriv.com/oauth2/auth?...
   - DevTools Console should show:
     ```
     [v0] OAuth Flow: account_creation Scope: admin
     ```
   - Note the scope is now "admin" instead of "trade"

4. **At Deriv Login Page:**
   - Log in with your Deriv account
   - May prompt for additional information for admin scope

5. **After Login:**
   - Should follow same flow as Test 1
   - Console should show:
     ```
     [v0] Callback: received token = present flowType = account_creation
     [v0] Stored admin token
     ```
   - Token stored as `deriv_admin_token` in Session Storage
   - User should be logged in

### Expected Result ✓
- Admin token stored successfully
- User is logged in
- Can access account management features (future)

---

## Test 3: Session Persistence

### Steps:
1. Complete Test 1 (Login Flow) successfully
2. **Hard refresh the page** (Ctrl+F5 or Cmd+Shift+R)
   - Should NOT redirect to login
   - Should stay logged in
   - Should see the main app
3. **Close and reopen browser tab**
   - Note: Session Storage is tab-specific, so new tab = new session
   - Same tab refresh should preserve session

### Expected Result ✓
- After hard refresh, user stays logged in
- Token persists in Session Storage
- App loads without login redirect

---

## Test 4: Debug Logging

### Check Session Storage
1. Open DevTools (F12)
2. Go to Application tab
3. Click Session Storage → Your domain
4. Should see:
   ```
   deriv_access_token: eyJhbGciOiJIUzI1NiIs... (long string)
   deriv_token_expiry: 1715851234567
   deriv_flow_type: login
   deriv_current_scope: trade
   deriv_auth_state: {"authFlow":"login","isComplete":true,...}
   ```

### Check Browser Console
1. Open DevTools Console
2. Filter by `[v0]` to see authentication logs
3. Should see sequence like:
   ```
   [v0] Login URL: https://auth.deriv.com/oauth2/auth?...
   [v0] OAuth Flow: login Scope: trade
   [v0] Callback: received token = present flowType = login
   [v0] Stored trade token
   [v0] Auth flow marked as completed
   [v0] AuthWrapper init - hasToken: true isCompleted: true
   ```

---

## Troubleshooting

### Issue: Still logged out after redirect
**Check:**
- Is token in Session Storage? Look for `deriv_access_token`
- Check console for `[v0]` logs - see where flow stops
- Verify `isLoggedIn()` check works: Console → `sessionStorage.getItem('deriv_access_token')`

### Issue: "Create Account" button doesn't show
**Check:**
- Refresh page (hard refresh with Ctrl+F5)
- Check browser console for errors
- Verify login-page.tsx was updated (search for "Makoti Traders")

### Issue: Redirect loop (keeps going back to login)
**Check:**
- AuthWrapper logic - should check `isLoggedIn()` first
- Token might be expired - check `deriv_token_expiry` timestamp
- Clear Session Storage and try login again

### Issue: Can't authenticate with Deriv
**Check:**
- VITE_DERIV_CLIENT_ID is correct: `337DJLKi2OJ4VsyFSLIt9`
- Deriv API URL is accessible
- Check network requests in DevTools → Network tab
- Look for failed OAuth requests and error messages

---

## Testing Checklist

- [ ] Login page says "Welcome to Makoti Traders"
- [ ] "Create New Account" button appears and works
- [ ] OAuth redirects to Deriv auth page correctly
- [ ] Login completes and redirects to home page
- [ ] User is logged in (not logged out after redirect)
- [ ] Token stored in Session Storage
- [ ] Page hard refresh preserves login
- [ ] Create Account flow uses admin scope
- [ ] Console shows `[v0]` debug logs
- [ ] No JavaScript errors in console

---

## Next Steps

Once all tests pass:
1. Merge `deriv-api-login` branch to main
2. Implement account creation form with KYC fields
3. Add account management API integration
4. Test multi-scope sequential flow (login → account creation)
