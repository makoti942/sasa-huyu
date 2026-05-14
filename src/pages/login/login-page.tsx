import React from 'react'
import { startLoginFlow } from '@/auth/DerivAuth'
import { advanceAuthFlow } from '@/utils/auth-state'
import './login-page.scss'

const LoginPage: React.FC = () => {
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

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

  return (
    <div className='login-page'>
      <div className='login-page__container'>
        <div className='login-page__card'>
          <h1 className='login-page__title'>Welcome to Sasa Huyu</h1>
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
