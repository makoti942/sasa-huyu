// DerivAuth.js
// Single source of truth for all Deriv authentication
// Every component in the app imports auth functions from here only

// Support both env vars and defaults
const getEnv = (key, fallback) => {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    return import.meta.env[key] || fallback
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || fallback
  }
  return fallback
}

const DERIV_CONFIG = {
  clientId: getEnv('VITE_DERIV_CLIENT_ID', "337DJLKi2OJ4VsyFSLIt9"),
  legacyAppId: getEnv('VITE_DERIV_LEGACY_APP_ID', "101585"),
  redirectUri: getEnv('VITE_DERIV_REDIRECT_URI', 
    typeof window !== 'undefined' ? window.location.origin + "/callback" : "https://makotitraderss.vercel.app/callback"
  ),
  authUrl: getEnv('VITE_DERIV_AUTH_URL', "https://auth.deriv.com/oauth2/auth"),
  tokenUrl: getEnv('VITE_DERIV_TOKEN_URL', "https://auth.deriv.com/oauth2/token"),
  restBase: getEnv('VITE_DERIV_REST_BASE', "https://api.derivws.com/trading/v1"),
  scope: "trade"
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
    prompt: "login consent",
    app_id: DERIV_CONFIG.legacyAppId
  })

  console.log("[v0] Login URL:", DERIV_CONFIG.authUrl + "?" + params.toString())
  
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
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: DERIV_CONFIG.redirectUri,
      client_id: DERIV_CONFIG.clientId,
      code_verifier: codeVerifier
    })
    console.log("[v0] Token exchange params:", {
      grant_type: "authorization_code",
      code: "***",
      redirect_uri: DERIV_CONFIG.redirectUri,
      client_id: DERIV_CONFIG.clientId,
      code_verifier: "***"
    })
    response = await fetch(DERIV_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString()
    })
  } catch (networkError) {
    throw new Error(
      "Network error during login. Please check your connection: " + 
      (networkError instanceof Error ? networkError.message : String(networkError))
    )
  }

  const data = await response.json()
  console.log("[v0] Token response status:", response.status, "data keys:", Object.keys(data))

  if (!response.ok) {
    throw new Error(
      "Deriv login failed (HTTP " + response.status + "): " + 
      (data.error_description || data.error || JSON.stringify(data))
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
  const token = getToken()
  if (!token) {
    // Handle case where user is not logged in - maybe return empty headers
    // or headers for public endpoints. For now, returning without auth.
    return {
      "Deriv-App-ID": DERIV_CONFIG.clientId,
      "Content-Type": "application/json"
    }
  }
  return {
    "Authorization": "Bearer " + token,
    "Deriv-App-ID": DERIV_CONFIG.clientId,
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

// This function will now be responsible for the entire new connection flow.
// It will be called from our application logic after login.
export async function createDerivWebSocket() {
  const token = sessionStorage.getItem("deriv_access_token")
  if (!token) {
    console.log("No token - cannot create WebSocket")
    return null
  }

  try {
    // Step 1: Get accounts list
    const accountsRes = await fetch(
      DERIV_CONFIG.restBase + "/options/accounts",
      {
        headers: {
          "Authorization": "Bearer " + token,
          "Deriv-App-ID": DERIV_CONFIG.clientId,
          "Content-Type": "application/json"
        }
      }
    )

    if (!accountsRes.ok) {
      console.error("Failed to get accounts:", await accountsRes.text())
      return null
    }

    const accountsData = await accountsRes.json()
    const accounts = accountsData.data || accountsData
    const firstAccount = Array.isArray(accounts) ? accounts[0] : accounts

    if (!firstAccount || !firstAccount.id) {
      console.error("No account found in response:", accountsData)
      return null
    }

    // Step 2: Get OTP authenticated WebSocket URL
    const otpRes = await fetch(
      DERIV_CONFIG.restBase + "/options/accounts/" + 
      firstAccount.id + "/otp",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Deriv-App-ID": DERIV_CONFIG.clientId,
          "Content-Type": "application/json"
        }
      }
    )

    if (!otpRes.ok) {
      console.error("Failed to get OTP:", await otpRes.text())
      return null
    }

    const otpData = await otpRes.json()
    const wsUrl = otpData.data?.url || otpData.url || otpData.websocket_url

    if (!wsUrl) {
      console.error("No WebSocket URL in OTP response:", otpData)
      return null
    }

    // Step 3: Connect to authenticated WebSocket
    console.log("Attempting to connect to WebSocket at:", wsUrl)
    const ws = new WebSocket(wsUrl)
    
    ws.onopen = () => {
      console.log("Deriv WebSocket connected successfully")
    }
    
    ws.onerror = (err) => {
      console.error("WebSocket error:", err)
    }
    
    ws.onclose = (event) => {
      console.log("WebSocket closed. Code:", event.code, "Reason:", event.reason)
      // Optional: implement a reconnect strategy here if needed
    }

    return ws
  } catch (error) {
    console.error("Error creating Deriv WebSocket connection:", error)
    return null
  }
}
