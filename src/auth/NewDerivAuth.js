const CONFIG = {
  clientId: "337DJLKi2OJ4VsyFSLIt9",
  redirectUri: "https://makotitraderss.vercel.app/callback",
  authUrl: "https://auth.deriv.com/oauth2/auth",
  tokenUrl: "https://auth.deriv.com/oauth2/token",
  wsUrl: "wss://ws.derivws.com/websockets/v3?app_id=101585"
}

const S = {
  token:    "NEW_AUTH_token",
  expiry:   "NEW_AUTH_expiry",
  verifier: "NEW_AUTH_verifier",
  state:    "NEW_AUTH_state",
  active:   "NEW_AUTH_active"
}

function generateRandom(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const arr = new Uint8Array(length)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(x => chars[x % chars.length]).join('')
}

async function makeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
}

export async function startNewLogin() {
  // Clear only NEW_AUTH keys - never touch old system keys
  Object.values(S).forEach(k => sessionStorage.removeItem(k))

  const verifier = generateRandom(64)
  const challenge = await makeChallenge(verifier)
  const state = crypto.randomUUID()

  sessionStorage.setItem(S.verifier, verifier)
  sessionStorage.setItem(S.state, state)
  sessionStorage.setItem(S.active, "true")

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    scope: "trade",
    state: state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    app_id: "101585"
  })

  window.location.href = CONFIG.authUrl + "?" + params.toString()
}

let handled = false

export async function handleNewCallback() {
  if (handled) return null
  handled = true

  console.log("[NEW AUTH] Callback started")
  console.log("[NEW AUTH] URL params:", window.location.search)
  console.log("[NEW AUTH] NEW_AUTH_active:", 
    sessionStorage.getItem("NEW_AUTH_active"))
  console.log("[NEW AUTH] NEW_AUTH_verifier exists:", 
    !!sessionStorage.getItem("NEW_AUTH_verifier"))

  const p = new URLSearchParams(window.location.search)
  const code = p.get("code")
  const returnedState = p.get("state")

  // Only handle if new system started this login
  if (!code || sessionStorage.getItem(S.active) !== "true") {
    return null
  }

  window.history.replaceState({}, '', '/callback')

  const savedState = sessionStorage.getItem(S.state)
  if (!savedState || savedState !== returnedState) {
    sessionStorage.removeItem(S.active)
    throw new Error("Security check failed. Please try again.")
  }
  sessionStorage.removeItem(S.state)

  const verifier = sessionStorage.getItem(S.verifier)
  if (!verifier) {
    throw new Error("Session data missing. Please try again.")
  }

  let res
  try {
    res = await fetch(CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: CONFIG.redirectUri,
        client_id: CONFIG.clientId,
        code_verifier: verifier
      }).toString()
    })
  } catch (e) {
    throw new Error("Network error. Check your connection.")
  }

  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Login failed")
  }

  sessionStorage.setItem(S.token, data.access_token)
  sessionStorage.setItem(S.expiry, String(Date.now() + data.expires_in * 1000))
  sessionStorage.removeItem(S.verifier)

  return data.access_token
}

export function getNewToken() {
  const token = sessionStorage.getItem(S.token)
  const expiry = sessionStorage.getItem(S.expiry)
  if (token && expiry && Date.now() < Number(expiry)) return token
  return null
}

export function isNewLoggedIn() {
  return getNewToken() !== null
}

export function logoutNew() {
  Object.values(S).forEach(k => sessionStorage.removeItem(k))
  window.location.href =
    "https://auth.deriv.com/oauth2/sessions/logout?redirect_uri=" +
    encodeURIComponent("https://makotitraderss.vercel.app")
}

export async function createNewWebSocket() {
  const token = getNewToken()
  if (!token) return null

  // Step 1: Get accounts using Bearer token via REST
  let accountsRes
  try {
    accountsRes = await fetch(
      "https://api.derivws.com/trading/v1/options/accounts",
      {
        headers: {
          "Authorization": "Bearer " + token,
          "Deriv-App-ID": "337DJLKi2OJ4VsyFSLIt9",
          "Content-Type": "application/json"
        }
      }
    )
  } catch(e) {
    console.error("[NEW SYSTEM] Failed to fetch accounts:", e)
    return null
  }

  if (!accountsRes.ok) {
    const errText = await accountsRes.text()
    console.error("[NEW SYSTEM] Accounts error:", errText)
    return null
  }

  const accountsData = await accountsRes.json()
  console.log("[NEW SYSTEM] Accounts response:", accountsData)

  // Extract first account - handle different response formats
  let accountId = null
  if (Array.isArray(accountsData)) {
    accountId = accountsData[0]?.id
  } else if (accountsData.data && Array.isArray(accountsData.data)) {
    accountId = accountsData.data[0]?.id
  } else if (accountsData.id) {
    accountId = accountsData.id
  }

  if (!accountId) {
    console.error("[NEW SYSTEM] No account ID found in:", accountsData)
    return null
  }

  // Step 2: Get OTP authenticated WebSocket URL
  let otpRes
  try {
    otpRes = await fetch(
      "https://api.derivws.com/trading/v1/options/accounts/" +
      accountId + "/otp",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Deriv-App-ID": "337DJLKi2OJ4VsyFSLIt9",
          "Content-Type": "application/json"
        }
      }
    )
  } catch(e) {
    console.error("[NEW SYSTEM] Failed to get OTP:", e)
    return null
  }

  if (!otpRes.ok) {
    const errText = await otpRes.text()
    console.error("[NEW SYSTEM] OTP error:", errText)
    return null
  }

  const otpData = await otpRes.json()
  console.log("[NEW SYSTEM] OTP response:", otpData)

  // Extract WebSocket URL - handle different response formats
  const wsUrl =
    otpData?.data?.url ||
    otpData?.data?.websocket_url ||
    otpData?.url ||
    otpData?.websocket_url

  if (!wsUrl) {
    console.error("[NEW SYSTEM] No WS URL in OTP response:", otpData)
    return null
  }

  console.log("[NEW SYSTEM] Connecting to:", wsUrl)
  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log("[NEW SYSTEM] WebSocket connected via OTP")
    window._newSystemWS = ws
    window._newSystemWSReady = true
  }

  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data)
    console.log("[NEW SYSTEM] WS message:", data.msg_type)
  }

  ws.onerror = (e) => {
    console.error("[NEW SYSTEM] WS error:", e)
    window._newSystemWSReady = false
  }

  ws.onclose = () => {
    console.log("[NEW SYSTEM] WS closed")
    window._newSystemWSReady = false
    if (isNewLoggedIn()) {
      setTimeout(createNewWebSocket, 3000)
    }
  }

  return ws
}
