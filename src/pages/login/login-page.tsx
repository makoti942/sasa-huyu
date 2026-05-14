import React from 'react'
import { startLoginFlow, startAccountCreationFlow } from '@/auth/DerivAuth'
import { advanceAuthFlow } from '@/utils/auth-state'
import './login-page.scss'

const LoginPage: React.FC = () => {
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [showCreateAccount, setShowCreateAccount] = React.useState(false)

  const handleLoginClick = async () => {
    try {
      setIsLoading(true)
      setError(null)
      advanceAuthFlow('login')
      await startLoginFlow()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed'
      setError(message)
      setIsLoading(false)
      console.error('[v0] Login error:', err)
    }
  }

  const handleCreateAccountClick = async () => {
    try {
      setIsLoading(true)
      setError(null)
      advanceAuthFlow('account_creation')
      await startAccountCreationFlow()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Account creation failed'
      setError(message)
      setIsLoading(false)
      console.error('[v0] Account creation error:', err)
    }
  }

  if (showCreateAccount) {
    return (
      <div className='login-page'>
        <div className='login-page__container'>
          <div className='login-page__card'>
            <button 
              className='login-page__back-button'
              onClick={() => setShowCreateAccount(false)}
            >
              ← Back to Login
            </button>
            <h1 className='login-page__title'>Create Account</h1>
            <p className='login-page__subtitle'>
              Complete your profile to get started with Makoti Traders
            </p>

            <div className='login-page__content'>
              <div className='login-page__info-box'>
                <h2 className='login-page__section-title'>Account Creation</h2>
                <p>You will be guided through the account creation process with Deriv.</p>
                <p style={{ marginTop: '12px', fontSize: '0.9em', color: '#aaa' }}>
                  This requires the admin scope to manage your account details, KYC information, and profile settings.
                </p>
              </div>

              {error && (
                <div className='login-page__error'>
                  <p>{error}</p>
                </div>
              )}

              <button
                className='login-page__button'
                onClick={handleCreateAccountClick}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <span className='login-page__spinner' />
                    Starting...
                  </>
                ) : (
                  'Create Account with Deriv'
                )}
              </button>

              <p className='login-page__disclaimer'>
                You&apos;ll be redirected to Deriv for account setup.
                We never store your password.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='login-page'>
      <div className='login-page__container'>
        <div className='login-page__card'>
          <h1 className='login-page__title'>Welcome to Makoti Traders</h1>
          <p className='login-page__subtitle'>
            Connect your Deriv account to start trading
          </p>

          <div className='login-page__content'>
            <div className='login-page__info-box'>
              <h2 className='login-page__section-title'>Login with Deriv</h2>
              <ul className='login-page__benefits'>
                <li>Access your trading accounts</li>
                <li>Trade multiple assets</li>
                <li>Real-time market data</li>
                <li>Secure authentication</li>
              </ul>
            </div>

            {error && (
              <div className='login-page__error'>
                <p>{error}</p>
              </div>
            )}

            <button
              className='login-page__button'
              onClick={handleLoginClick}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className='login-page__spinner' />
                  Connecting...
                </>
              ) : (
                'Login with Deriv'
              )}
            </button>

            <p className='login-page__divider'>or</p>

            <button
              className='login-page__button login-page__button--secondary'
              onClick={() => setShowCreateAccount(true)}
              disabled={isLoading}
            >
              Create New Account
            </button>

            <p className='login-page__disclaimer'>
              You&apos;ll be redirected to Deriv&apos;s secure login page.
              We never store your password.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default LoginPage
