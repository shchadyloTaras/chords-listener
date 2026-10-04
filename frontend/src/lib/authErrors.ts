// Maps Firebase Auth error codes to i18n keys (src/i18n/account.ts).

const KEYS: Record<string, string> = {
  'auth/invalid-email': 'account.error.invalidEmail',
  'auth/missing-email': 'account.error.invalidEmail',
  'auth/missing-password': 'account.error.missingPassword',
  'auth/weak-password': 'account.error.weakPassword',
  'auth/password-does-not-meet-requirements': 'account.error.weakPassword',
  'auth/email-already-in-use': 'account.error.emailInUse',
  'auth/invalid-credential': 'account.error.invalidCredential',
  'auth/invalid-login-credentials': 'account.error.invalidCredential',
  'auth/wrong-password': 'account.error.invalidCredential',
  'auth/user-not-found': 'account.error.invalidCredential',
  'auth/too-many-requests': 'account.error.tooManyRequests',
  'auth/network-request-failed': 'account.error.network',
  'auth/user-disabled': 'account.error.userDisabled',
}

export function authErrorKey(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : null
  return (typeof code === 'string' && KEYS[code]) || 'account.error.generic'
}
