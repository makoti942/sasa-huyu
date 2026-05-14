import React from 'react'
import { isLoggedIn } from '@/auth/DerivAuth'
import { getAuthState } from '@/utils/auth-state'
import { LoginPage } from '@/pages/login'
import { AccountCreationPage } from '@/pages/account'
import './auth-flow-page.scss'

type FlowPhase = 'loading' | 'login' | 'account_creation' | 'completed'

const AuthFlowPage: React.FC = () => {
  const [phase, setPhase] = React.useState<FlowPhase>('loading')
  const [showAccountCreation, setShowAccountCreation] = React.useState(false)

  React.useEffect(() => {
    // Check if already authenticated
    const checkAuthStatus = async () => {
      // Simulate loading delay for better UX
      await new Promise(resolve => setTimeout(resolve, 1500))

      // Check current auth state
      const authState = getAuthState()
      
      console.log('[v0] Auth flow check - current state:', authState)

      if (authState.authFlow === 'completed') {
        setPhase('completed')
        // Redirect to main app after short delay
        setTimeout(() => {
          window.location.href = '/'
        }, 500)
      } else if (authState.authFlow === 'account_creation' && isLoggedIn()) {
        setShowAccountCreation(true)
        setPhase('account_creation')
      } else {
        setPhase('login')
      }
    }

    checkAuthStatus()
  }, [])

  if (phase === 'loading') {
    return (
      <div className='auth-flow-page'>
        <div className='auth-flow-page__container'>
          <div className='auth-flow-page__loader'>
            <div className='auth-flow-page__spinner' />
            <p className='auth-flow-page__loading-text'>Initializing authentication...</p>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'account_creation' && showAccountCreation) {
    return <AccountCreationPage />
  }

  if (phase === 'completed') {
    return (
      <div className='auth-flow-page'>
        <div className='auth-flow-page__container'>
          <div className='auth-flow-page__loader'>
            <div className='auth-flow-page__success-icon'>✓</div>
            <p className='auth-flow-page__loading-text'>Authentication complete!</p>
          </div>
        </div>
      </div>
    )
  }

  return <LoginPage />
}

export default AuthFlowPage
