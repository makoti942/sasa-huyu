import React from 'react'
import { startAccountCreationFlow } from '@/auth/DerivAuth'
import { advanceAuthFlow, updateUserProfile } from '@/utils/auth-state'
import './account-creation-page.scss'

interface FormData {
  fullName: string
  email: string
  dateOfBirth: string
  country: string
  currency: string
  phoneNumber: string
}

const AccountCreationPage: React.FC = () => {
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [formData, setFormData] = React.useState<FormData>({
    fullName: '',
    email: '',
    dateOfBirth: '',
    country: '',
    currency: 'USD',
    phoneNumber: '',
  })

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }))
  }

  const validateForm = (): boolean => {
    if (!formData.fullName.trim()) {
      setError('Full name is required')
      return false
    }
    if (!formData.email.trim()) {
      setError('Email is required')
      return false
    }
    if (!formData.email.includes('@')) {
      setError('Invalid email address')
      return false
    }
    if (!formData.dateOfBirth) {
      setError('Date of birth is required')
      return false
    }
    if (!formData.country) {
      setError('Country is required')
      return false
    }
    if (!formData.phoneNumber.trim()) {
      setError('Phone number is required')
      return false
    }
    return true
  }

  const handleCreateAccount = async () => {
    try {
      if (!validateForm()) return

      setIsLoading(true)
      setError(null)

      // Store profile data before redirecting to OAuth
      updateUserProfile({
        fullName: formData.fullName,
        email: formData.email,
        dateOfBirth: formData.dateOfBirth,
        country: formData.country,
        currency: formData.currency,
        phoneNumber: formData.phoneNumber,
      })

      advanceAuthFlow('account_creation')
      await startAccountCreationFlow()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Account creation failed'
      setError(message)
      setIsLoading(false)
      console.error('[v0] Account creation error:', err)
    }
  }

  const handleSkip = () => {
    // Skip account creation and go to dashboard
    window.location.href = '/'
  }

  return (
    <div className='account-creation-page'>
      <div className='account-creation-page__container'>
        <div className='account-creation-page__card'>
          <h1 className='account-creation-page__title'>Create Your Account</h1>
          <p className='account-creation-page__subtitle'>
            Set up your trading account details
          </p>

          <form className='account-creation-page__form'>
            <div className='account-creation-page__form-group'>
              <label className='account-creation-page__label'>Full Name *</label>
              <input
                type='text'
                name='fullName'
                value={formData.fullName}
                onChange={handleInputChange}
                placeholder='Enter your full name'
                className='account-creation-page__input'
                disabled={isLoading}
              />
            </div>

            <div className='account-creation-page__form-group'>
              <label className='account-creation-page__label'>Email *</label>
              <input
                type='email'
                name='email'
                value={formData.email}
                onChange={handleInputChange}
                placeholder='Enter your email'
                className='account-creation-page__input'
                disabled={isLoading}
              />
            </div>

            <div className='account-creation-page__form-row'>
              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Date of Birth *</label>
                <input
                  type='date'
                  name='dateOfBirth'
                  value={formData.dateOfBirth}
                  onChange={handleInputChange}
                  className='account-creation-page__input'
                  disabled={isLoading}
                />
              </div>

              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Country *</label>
                <select
                  name='country'
                  value={formData.country}
                  onChange={handleInputChange}
                  className='account-creation-page__input'
                  disabled={isLoading}
                >
                  <option value=''>Select country</option>
                  <option value='US'>United States</option>
                  <option value='GB'>United Kingdom</option>
                  <option value='CA'>Canada</option>
                  <option value='AU'>Australia</option>
                  <option value='SG'>Singapore</option>
                  <option value='AE'>UAE</option>
                </select>
              </div>
            </div>

            <div className='account-creation-page__form-row'>
              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Currency *</label>
                <select
                  name='currency'
                  value={formData.currency}
                  onChange={handleInputChange}
                  className='account-creation-page__input'
                  disabled={isLoading}
                >
                  <option value='USD'>USD</option>
                  <option value='EUR'>EUR</option>
                  <option value='GBP'>GBP</option>
                  <option value='AUD'>AUD</option>
                  <option value='SGD'>SGD</option>
                </select>
              </div>

              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Phone Number *</label>
                <input
                  type='tel'
                  name='phoneNumber'
                  value={formData.phoneNumber}
                  onChange={handleInputChange}
                  placeholder='e.g. +1234567890'
                  className='account-creation-page__input'
                  disabled={isLoading}
                />
              </div>
            </div>

            {error && (
              <div className='account-creation-page__error'>
                <p>{error}</p>
              </div>
            )}

            <div className='account-creation-page__button-group'>
              <button
                type='button'
                className='account-creation-page__button account-creation-page__button--primary'
                onClick={handleCreateAccount}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <span className='account-creation-page__spinner' />
                    Creating Account...
                  </>
                ) : (
                  'Create Account'
                )}
              </button>

              <button
                type='button'
                className='account-creation-page__button account-creation-page__button--secondary'
                onClick={handleSkip}
                disabled={isLoading}
              >
                Skip for Now
              </button>
            </div>

            <p className='account-creation-page__disclaimer'>
              Your account details will be verified with our KYC process.
            </p>
          </form>
        </div>
      </div>
    </div>
  )
}

export default AccountCreationPage
