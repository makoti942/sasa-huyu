import React from 'react'
import { startAccountCreationFlow } from '@/auth/DerivAuth'
import { advanceAuthFlow, updateUserProfile } from '@/utils/auth-state'
import './account-creation-page.scss'

interface FormData {
  firstName: string
  lastName: string
  email: string
  dateOfBirth: string
  country: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
  phoneNumber: string
  employmentStatus: string
  occupation: string
  annualIncome: string
  yearsOfExperience: string
  currency: string
}

const AccountCreationPage: React.FC = () => {
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [formData, setFormData] = React.useState<FormData>({
    firstName: '',
    lastName: '',
    email: '',
    dateOfBirth: '',
    country: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    phoneNumber: '',
    employmentStatus: 'Employed',
    occupation: '',
    annualIncome: '',
    yearsOfExperience: '',
    currency: 'USD',
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
    const required = ['firstName', 'lastName', 'email', 'dateOfBirth', 'country', 
                     'addressLine1', 'city', 'postalCode', 'phoneNumber', 'occupation',
                     'annualIncome', 'yearsOfExperience'] as const
    
    for (const field of required) {
      if (!formData[field]?.toString().trim()) {
        setError(`${field.replace(/([A-Z])/g, ' $1').trim()} is required`)
        return false
      }
    }

    if (!formData.email.includes('@')) {
      setError('Invalid email address')
      return false
    }

    const dobDate = new Date(formData.dateOfBirth)
    const age = new Date().getFullYear() - dobDate.getFullYear()
    if (age < 18) {
      setError('You must be at least 18 years old')
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
        fullName: `${formData.firstName} ${formData.lastName}`,
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
          <h1 className='account-creation-page__title'>Complete Your Account Setup</h1>
          <p className='account-creation-page__subtitle'>
            Provide your information for KYC verification
          </p>

          <form className='account-creation-page__form'>
            {/* Personal Information Section */}
            <div className='account-creation-page__section'>
              <h3 className='account-creation-page__section-title'>Personal Information</h3>
              
              <div className='account-creation-page__form-row'>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>First Name *</label>
                  <input
                    type='text'
                    name='firstName'
                    value={formData.firstName}
                    onChange={handleInputChange}
                    placeholder='First name'
                    className='account-creation-page__input'
                    disabled={isLoading}
                  />
                </div>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>Last Name *</label>
                  <input
                    type='text'
                    name='lastName'
                    value={formData.lastName}
                    onChange={handleInputChange}
                    placeholder='Last name'
                    className='account-creation-page__input'
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Email *</label>
                <input
                  type='email'
                  name='email'
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder='your.email@example.com'
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
                  <label className='account-creation-page__label'>Phone Number *</label>
                  <input
                    type='tel'
                    name='phoneNumber'
                    value={formData.phoneNumber}
                    onChange={handleInputChange}
                    placeholder='+1234567890'
                    className='account-creation-page__input'
                    disabled={isLoading}
                  />
                </div>
              </div>
            </div>

            {/* Address Section */}
            <div className='account-creation-page__section'>
              <h3 className='account-creation-page__section-title'>Address</h3>
              
              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Address Line 1 *</label>
                <input
                  type='text'
                  name='addressLine1'
                  value={formData.addressLine1}
                  onChange={handleInputChange}
                  placeholder='Street address'
                  className='account-creation-page__input'
                  disabled={isLoading}
                />
              </div>

              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Address Line 2</label>
                <input
                  type='text'
                  name='addressLine2'
                  value={formData.addressLine2}
                  onChange={handleInputChange}
                  placeholder='Apartment, suite, etc. (optional)'
                  className='account-creation-page__input'
                  disabled={isLoading}
                />
              </div>

              <div className='account-creation-page__form-row'>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>City *</label>
                  <input
                    type='text'
                    name='city'
                    value={formData.city}
                    onChange={handleInputChange}
                    placeholder='City'
                    className='account-creation-page__input'
                    disabled={isLoading}
                  />
                </div>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>State/Province</label>
                  <input
                    type='text'
                    name='state'
                    value={formData.state}
                    onChange={handleInputChange}
                    placeholder='State or province'
                    className='account-creation-page__input'
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className='account-creation-page__form-row'>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>Postal Code *</label>
                  <input
                    type='text'
                    name='postalCode'
                    value={formData.postalCode}
                    onChange={handleInputChange}
                    placeholder='ZIP or postal code'
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
            </div>

            {/* Employment Section */}
            <div className='account-creation-page__section'>
              <h3 className='account-creation-page__section-title'>Employment & Trading Experience</h3>
              
              <div className='account-creation-page__form-row'>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>Employment Status *</label>
                  <select
                    name='employmentStatus'
                    value={formData.employmentStatus}
                    onChange={handleInputChange}
                    className='account-creation-page__input'
                    disabled={isLoading}
                  >
                    <option value='Employed'>Employed</option>
                    <option value='Self-employed'>Self-employed</option>
                    <option value='Unemployed'>Unemployed</option>
                    <option value='Retired'>Retired</option>
                    <option value='Student'>Student</option>
                  </select>
                </div>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>Occupation *</label>
                  <input
                    type='text'
                    name='occupation'
                    value={formData.occupation}
                    onChange={handleInputChange}
                    placeholder='Your occupation'
                    className='account-creation-page__input'
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className='account-creation-page__form-row'>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>Annual Income *</label>
                  <select
                    name='annualIncome'
                    value={formData.annualIncome}
                    onChange={handleInputChange}
                    className='account-creation-page__input'
                    disabled={isLoading}
                  >
                    <option value=''>Select income range</option>
                    <option value='0-50k'>Less than $50,000</option>
                    <option value='50k-100k'>$50,000 - $100,000</option>
                    <option value='100k-250k'>$100,000 - $250,000</option>
                    <option value='250k-500k'>$250,000 - $500,000</option>
                    <option value='500k+'>Over $500,000</option>
                  </select>
                </div>
                <div className='account-creation-page__form-group'>
                  <label className='account-creation-page__label'>Years of Trading Experience *</label>
                  <select
                    name='yearsOfExperience'
                    value={formData.yearsOfExperience}
                    onChange={handleInputChange}
                    className='account-creation-page__input'
                    disabled={isLoading}
                  >
                    <option value=''>Select experience level</option>
                    <option value='0'>Less than 1 year</option>
                    <option value='1-3'>1 - 3 years</option>
                    <option value='3-5'>3 - 5 years</option>
                    <option value='5+'>More than 5 years</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Currency & Error */}
            <div className='account-creation-page__section'>
              <div className='account-creation-page__form-group'>
                <label className='account-creation-page__label'>Preferred Currency *</label>
                <select
                  name='currency'
                  value={formData.currency}
                  onChange={handleInputChange}
                  className='account-creation-page__input'
                  disabled={isLoading}
                >
                  <option value='USD'>USD - US Dollar</option>
                  <option value='EUR'>EUR - Euro</option>
                  <option value='GBP'>GBP - British Pound</option>
                  <option value='AUD'>AUD - Australian Dollar</option>
                  <option value='SGD'>SGD - Singapore Dollar</option>
                </select>
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
                    Submitting...
                  </>
                ) : (
                  'Create Account & Continue'
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
              All fields marked with * are required. Your information will be verified through our KYC process.
            </p>
          </form>
        </div>
      </div>
    </div>
  )
}

export default AccountCreationPage
