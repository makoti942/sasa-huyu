# Login Redirect Issue - Root Cause Analysis

## Problem Statement
The app shows "Login successful! Redirecting…" on the callback page but after redirect to `/`, the user is logged out. The session is not persisted.

## Code Flow Analysis

### 1. OAuth Flow (PKCE)
**File:** `src/utils/pkce.ts`
- Generates `code_verifier` and `code_challenge` (SHA-256)
- Stores both in `sessionStorage` (tab-specific)
- Redirects to `https://auth.deriv.com/oauth2/auth`
- User logs in at Deriv
- Deriv redirects back to `/callback?code=...&state=...`

### 2. Callback Handler
**File:** `src/pages/callback/callback-page.tsx`
- Receives `code` and `state` from URL
- Verifies `state` against `sessionStorage` (CSRF protection)
- Retrieves `code_verifier` from `sessionStorage`
- **Sends POST to `/api/oauth/exchange`** with `{ code, codeVerifier, redirectUri }`

### 3. Backend Token Exchange
**File:** `api/oauth/exchange.ts`
- Exchanges `code` + `code_verifier` for `access_token` at Deriv
- Fetches legacy tokens via `POST /oauth2/legacy/tokens`
- Creates/fetches options account
- **Sets httpOnly cookies:** `deriv_at` (access token) and `deriv_account_id`
- Returns `{ success: true, legacy_tokens, account_id }`

### 4. Frontend After Exchange
**File:** `src/pages/callback/callback-page.tsx` (lines 100-204)
- Receives `legacy_tokens` from backend
- Parses tokens into `accountsList` and `clientAccounts`
- **Stores in localStorage:**
  - `accountsList` (map of loginid → token)
  - `clientAccounts` (detailed account info)
  - `authToken` (active token)
  - `active_loginid` (active account ID)
  - `is_tmb_enabled` (true)
- **Sets cookies:** `logged_state=true`
- Shows "Login successful! Redirecting…"
- **Redirects to `/` after 800ms**

### 5. Auth Check on Root
**File:** `src/app/App.tsx` (lines 35-84, `AuthenticatedRoot`)
- On mount, checks session:
  1. **Primary:** `GET /api/auth/status` (checks for `deriv_at` httpOnly cookie)
  2. **Fallback:** Checks localStorage for `authToken` + valid `active_loginid`
- If either passes, shows app; otherwise shows login page

### 6. API Initialization
**File:** `src/external/bot-skeleton/services/api/api-base.ts` (lines 92-132)
- Called by `AppRoot` on mount
- If `V2GetActiveToken()` exists in localStorage → authorize
- Else → `tryRecoverAuthFromCookie()` (calls `/api/auth/tokens`)

## 🔴 ROOT CAUSES IDENTIFIED

### Issue 1: Cookie Domain Mismatch (CRITICAL)
**Location:** `api/oauth/exchange.ts` (lines 11-16) and `src/pages/callback/callback-page.tsx` (lines 111-125)

**Backend sets cookies:**
```typescript
const domain = host.split('.').slice(-2).join('.');
const domainAttr = domain ? `; Domain=.${domain}` : '';
// Example: Domain=.example.com
```

**Frontend sets cookies:**
```typescript
const domain = window.location.hostname.split('.').slice(-2).join('.');
Cookies.set('logged_state', 'true', {
    domain: '.' + domain,  // .example.com
    // ...
});
Cookies.set('logged_state', 'true', {
    domain: window.location.hostname,  // app.example.com
    // ...
});
```

**Problem:** If the backend extracts domain differently (e.g., missing the leading dot), the cookies won't be accessible by the browser. The httpOnly `deriv_at` cookie might not be sent on subsequent requests.

### Issue 2: Missing Secure Flag Consistency
**Location:** `api/oauth/exchange.ts` (line 15)

```typescript
return `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure${domainAttr}`;
```

The backend **always** sets `Secure` flag, but if the app is on `http://` (dev), the cookie won't be set. The callback page checks `window.location.protocol === 'https:'` but the backend doesn't.

### Issue 3: Cookie Sent But Not Received on Redirect
**Location:** `src/app/App.tsx` (line 42)

```typescript
const res = await fetch('/api/auth/status', { credentials: 'include' });
```

The fetch includes `credentials: 'include'`, but if the cookie was set with the wrong domain, it won't be sent.

**Possible reasons:**
1. Domain mismatch (backend vs frontend)
2. SameSite=Lax may block cross-site requests
3. Secure flag on http:// connection
4. Cookie was never set due to domain extraction error

### Issue 4: No Fallback to Token Recovery on First Load
**Location:** `src/app/App.tsx` (lines 54-63)

The fallback check requires BOTH:
- `authToken` in localStorage
- Valid `active_loginid` (regex: `/^(VR|CR|MF|MLT|MX|VRTC)\w+/`)

But if the callback page failed to populate localStorage correctly, this check will fail.

### Issue 5: Session Recovery Not Triggered on App Root
**Location:** `src/external/bot-skeleton/services/api/api-base.ts` (lines 319-357)

The `tryRecoverAuthFromCookie()` method exists but is only called if:
1. `api-base.init()` is called
2. `V2GetActiveToken()` returns null (no localStorage token)

But if the callback page populated localStorage with an **invalid or expired token**, the app will try to authorize with that token instead of recovering from the cookie.

## 🟡 SECONDARY ISSUES

### Issue 6: No Timeout or Error Handling on Callback Redirect
**Location:** `src/pages/callback/callback-page.tsx` (line 204)

```typescript
window.location.href = '/';
```

If the redirect happens but the session is not ready on the backend, the app will show the login page. There's no retry mechanism.

### Issue 7: Inconsistent Domain Extraction
**Locations:** Multiple files
- `api/oauth/exchange.ts`: `host.split('.').slice(-2).join('.')`
- `src/pages/callback/callback-page.tsx`: `window.location.hostname.split('.').slice(-2).join('.')`
- `src/hooks/auth/useOauth2.ts`: Same as callback

This works for `example.com` and `app.example.com`, but fails for:
- `localhost` (no domain)
- `localhost:3000` (port included)
- Subdomains like `api.staging.example.com`

## 🟢 RECOMMENDED FIXES

### Fix 1: Ensure Cookie Domain Consistency
Normalize domain extraction in both backend and frontend to handle edge cases.

### Fix 2: Add Secure Flag Check
Backend should check if the request is HTTPS before setting Secure flag.

### Fix 3: Validate Cookie Receipt
Add logging to verify cookies are being set and sent.

### Fix 4: Force Token Recovery on Callback
After callback redirect, always attempt cookie recovery before checking localStorage.

### Fix 5: Add Retry Logic
If initial auth check fails, retry with exponential backoff.

### Fix 6: Validate Legacy Tokens
Ensure `legacy_tokens` from backend are valid before storing in localStorage.

## 🔧 IMPLEMENTATION PRIORITY

1. **CRITICAL:** Fix cookie domain mismatch (Fix 1, 2)
2. **HIGH:** Add token validation (Fix 6)
3. **HIGH:** Force cookie recovery on app init (Fix 4)
4. **MEDIUM:** Add retry logic (Fix 5)
5. **LOW:** Improve logging (Fix 3)
