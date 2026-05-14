// DerivAuth.js
// Single source of truth for all Deriv authentication
// Every component in the app imports auth functions from here only

const DERIV_CONFIG = {
  clientId: "337DJLKi2OJ4VsyFSLIt9",
  redirectUri: "https://makotitraderss.vercel.app/callback",
  authUrl: "https://auth.deriv.com/oauth2/auth",
  tokenUrl: "https://auth.deriv.com/oauth2/token",
  apiBase: "https://api.derivws.com",
  scope: "trade",
  appId: "337DJLKi2OJ4VsyFSLIt9"
}

const STORAGE_KEYS = {
  accessToken: "deriv_access_token",
  tokenExpiry: "deriv_token_expiry",
  codeVerifier: "deriv_code_verifier",
  oauthState: "deriv_oauth_state"
}

// ─── PKCE HELPERS ───────────────────────────────────────────

function generateRandomString(length) {
  const chars = 
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array)
    .map(x => chars[x % chars.length])
    .join('')
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ─── LOGIN ───────────────────────────────────────────────────

export async function startLogin() {
  // Clear any leftover PKCE data from previous attempts
  Object.values(STORAGE_KEYS).forEach(k => sessionStorage.removeItem(k))

  const codeVerifier = generateRandomString(64)
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state = crypto.randomUUID()

  sessionStorage.setItem(STORAGE_KEYS.codeVerifier, codeVerifier)
  sessionStorage.setItem(STORAGE_KEYS.oauthState, state)

  const params = new URLSearchParams({
    response_type: "code",
    client_id: DERIV_CONFIG.clientId,
    redirect_uri: DERIV_CONFIG.redirectUri,
    scope: DERIV_CONFIG.scope,
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent"
  })

  // MUST be same tab. Never window.open() or new tab.
  // sessionStorage is tab-specific — new tab = lost code_verifier
  window.location.href = DERIV_CONFIG.authUrl + "?" + params.toString()
}

// ─── CALLBACK ────────────────────────────────────────────────

let _callbackHandled = false

export async function handleCallback() {
  // Guard: only run once even if React renders twice
  if (_callbackHandled) return null
  _callbackHandled = true

  const params = new URLSearchParams(window.location.search)
  const code = params.get("code")
  const returnedState = params.get("state")

  // Strip URL params immediately to prevent second attempt
  window.history.replaceState({}, document.title, '/callback')

  if (!code || !returnedState) {
    throw new Error(
      "Deriv did not return a valid response. Please try again."
    )
  }

  const savedState = sessionStorage.getItem(STORAGE_KEYS.oauthState)
  if (!savedState) {
    throw new Error(
      "Session expired during login. Please go back and try again."
    )
  }
  if (savedState !== returnedState) {
    throw new Error(
      "Security check failed. Please go back and try again."
    )
  }
  sessionStorage.removeItem(STORAGE_KEYS.oauthState)

  const codeVerifier = sessionStorage.getItem(STORAGE_KEYS.codeVerifier)
  if (!codeVerifier) {
    throw new Error(
      "Login data missing. Did you open login in a new tab? " +
      "Please go back and try again in the same tab."
    )
  }

  let response
  try {
    response = await fetch(DERIV_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: DERIV_CONFIG.redirectUri,
        client_id: DERIV_CONFIG.clientId,
        code_verifier: codeVerifier
      }).toString()
    })
  } catch (networkError) {
    throw new Error(
      "Network error during login. Please check your connection."
    )
  }

  const data = await response.json()

  if (!response.ok) {
    throw new Error(
      "Deriv login failed: " + 
      (data.error_description || data.error || "Unknown error")
    )
  }

  // Save token BEFORE any redirect
  sessionStorage.setItem(STORAGE_KEYS.accessToken, data.access_token)
  sessionStorage.setItem(
    STORAGE_KEYS.tokenExpiry,
    String(Date.now() + data.expires_in * 1000)
  )
  sessionStorage.removeItem(STORAGE_KEYS.codeVerifier)

  return data.access_token
}

// ─── TOKEN ACCESS ─────────────────────────────────────────────

export function getToken() {
  const token = sessionStorage.getItem(STORAGE_KEYS.accessToken)
  const expiry = sessionStorage.getItem(STORAGE_KEYS.tokenExpiry)
  if (token && expiry && Date.now() < Number(expiry)) return token
  return null
}

export function isLoggedIn() {
  return getToken() !== null
}

export function getAuthHeaders() {
  return {
    "Authorization": "Bearer " + getToken(),
    "Deriv-App-ID": DERIV_CONFIG.appId,
    "Content-Type": "application/json"
  }
}

// ─── LOGOUT ──────────────────────────────────────────────────

export function logout() {
  Object.values(STORAGE_KEYS).forEach(k => sessionStorage.removeItem(k))
  // Clear Deriv's own session so next login shows login screen
  window.location.href =
    "https://auth.deriv.com/oauth2/sessions/logout?redirect_uri=" +
    encodeURIComponent("https://makotitraderss.vercel.app")
}

// ─── WEBSOCKET ────────────────────────────────────────────────

export async function getAccounts() {
  const response = await fetch(
    DERIV_CONFIG.apiBase + "/trading/v1/options/accounts",
    { headers: getAuthHeaders() }
  )
  if (!response.ok) throw new Error("Failed to get accounts")
  return response.json()
}

export async function getAuthenticatedWSUrl(accountId) {
  const response = await fetch(
    DERIV_CONFIG.apiBase + "/trading/v1/options/accounts/" + accountId + "/otp",
    { method: "POST", headers: getAuthHeaders() }
  )
  if (!response.ok) throw new Error("Failed to get WebSocket URL")
  const data = await response.json()
  return data.websocket_url
}

export async function createAuthenticatedWebSocket(accountId) {
  const wsUrl = await getAuthenticatedWSUrl(accountId)
  return new WebSocket(wsUrl)
}

// ─── EXPORTS SUMMARY ─────────────────────────────────────────
// startLogin()              → call when login button clicked
// handleCallback()          → call on /callback page load
// getToken()                → get current Bearer token
// isLoggedIn()              → check if user is logged in
// getAuthHeaders()          → get headers for all API calls
// logout()                  → log user out completely
// getAccounts()             → get user's Deriv accounts
// createAuthenticatedWebSocket(accountId) → get WS connection
