import { describe, expect, it } from 'vitest'
import { account } from '../i18n/account'
import { authErrorKey } from './authErrors'

const err = (code: unknown) => Object.assign(new Error('firebase'), { code })

describe('authErrorKey', () => {
  it('maps known Firebase Auth codes', () => {
    expect(authErrorKey(err('auth/invalid-email'))).toBe('account.error.invalidEmail')
    expect(authErrorKey(err('auth/missing-password'))).toBe('account.error.missingPassword')
    expect(authErrorKey(err('auth/weak-password'))).toBe('account.error.weakPassword')
    expect(authErrorKey(err('auth/email-already-in-use'))).toBe('account.error.emailInUse')
    expect(authErrorKey(err('auth/invalid-credential'))).toBe('account.error.invalidCredential')
    expect(authErrorKey(err('auth/wrong-password'))).toBe('account.error.invalidCredential')
    expect(authErrorKey(err('auth/user-not-found'))).toBe('account.error.invalidCredential')
    expect(authErrorKey(err('auth/too-many-requests'))).toBe('account.error.tooManyRequests')
    expect(authErrorKey(err('auth/network-request-failed'))).toBe('account.error.network')
    expect(authErrorKey(err('auth/user-disabled'))).toBe('account.error.userDisabled')
  })

  it('falls back to the generic message', () => {
    expect(authErrorKey(err('auth/something-new'))).toBe('account.error.generic')
    expect(authErrorKey(err(42))).toBe('account.error.generic')
    expect(authErrorKey(new Error('boom'))).toBe('account.error.generic')
    expect(authErrorKey('auth/invalid-email')).toBe('account.error.generic')
    expect(authErrorKey(null)).toBe('account.error.generic')
    expect(authErrorKey(undefined)).toBe('account.error.generic')
  })

  it('account strings exist in both languages', () => {
    expect(Object.keys(account.en).sort()).toEqual(Object.keys(account.uk).sort())
  })

  it('never resolves to a missing translation', () => {
    const codes = [
      'auth/invalid-email',
      'auth/missing-email',
      'auth/missing-password',
      'auth/weak-password',
      'auth/password-does-not-meet-requirements',
      'auth/email-already-in-use',
      'auth/invalid-credential',
      'auth/invalid-login-credentials',
      'auth/too-many-requests',
      'auth/network-request-failed',
      'auth/user-disabled',
      'unknown',
    ]
    for (const code of codes) {
      const key = authErrorKey(err(code))
      expect(account.uk[key], key).toBeTruthy()
      expect(account.en[key], key).toBeTruthy()
    }
  })
})
