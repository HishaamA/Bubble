import { useClerk, useSignIn, useSignUp } from '@clerk/react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'

type EmailCodeAuthFlowProps = {
  onClose: () => void
  onStart: () => void
}

type VerificationMode = 'primary' | 'second-factor'

type ClerkErrorLike = {
  errors?: Array<{
    code?: string
    longMessage?: string
    message?: string
  }>
}

function firstClerkError(error: unknown) {
  if (!error || typeof error !== 'object') return undefined
  return (error as ClerkErrorLike).errors?.[0]
}

function clerkErrorCode(error: unknown) {
  return firstClerkError(error)?.code
}

function isExistingSessionError(error: unknown) {
  const code = clerkErrorCode(error)
  return code === 'session_exists' || code === 'identifier_already_signed_in'
}

function authErrorMessage(error: unknown) {
  const clerkError = firstClerkError(error)
  switch (clerkError?.code) {
    case 'form_identifier_invalid':
    case 'form_param_format_invalid':
      return 'Enter a valid email address.'
    case 'form_code_incorrect':
    case 'verification_failed':
      return 'That code did not work. Check your email and try again.'
    case 'verification_expired':
      return 'That code has expired. Send a new one and try again.'
    case 'too_many_requests':
    case 'rate_limit_exceeded':
      return 'Too many attempts. Wait a moment before trying again.'
    case 'session_exists':
      return 'You are already signed in. Opening your family space now.'
    default:
      return (
        clerkError?.longMessage ||
        clerkError?.message ||
        'We could not complete that request. Check your connection and try again.'
      )
  }
}

export function EmailCodeAuthFlow({
  onClose,
  onStart,
}: EmailCodeAuthFlowProps) {
  const { client, setActive } = useClerk()
  const {
    errors: signInErrors,
    fetchStatus: signInFetchStatus,
    signIn,
  } = useSignIn()
  const {
    errors: signUpErrors,
    fetchStatus: signUpFetchStatus,
    signUp,
  } = useSignUp()
  const [emailAddress, setEmailAddress] = useState('')
  const [code, setCode] = useState('')
  const [verificationMode, setVerificationMode] =
    useState<VerificationMode | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)
  const busy =
    finishing ||
    signInFetchStatus === 'fetching' ||
    signUpFetchStatus === 'fetching'

  useEffect(() => {
    const input = verificationMode ? codeInputRef.current : emailInputRef.current
    input?.focus({ preventScroll: true })
  }, [verificationMode])

  const finishSignIn = async () => {
    setFinishing(true)
    let hasPendingTask = false
    try {
      const { error } = await signIn.finalize({
        navigate: ({ decorateUrl, session }) => {
          if (session?.currentTask) {
            hasPendingTask = true
            return
          }
          const destination = decorateUrl('/#/login')
          if (/^https?:\/\//i.test(destination)) {
            window.location.assign(destination)
          }
        },
      })
      if (error) {
        setErrorMessage(authErrorMessage(error))
        return
      }
      if (hasPendingTask) {
        setErrorMessage(
          'Your account needs one more security step. Please try again shortly.',
        )
        return
      }
      onClose()
    } catch (error) {
      setErrorMessage(authErrorMessage(error))
    } finally {
      setFinishing(false)
    }
  }

  const finishSignUp = async () => {
    setFinishing(true)
    let hasPendingTask = false
    try {
      const { error } = await signUp.finalize({
        navigate: ({ decorateUrl, session }) => {
          if (session?.currentTask) {
            hasPendingTask = true
            return
          }
          const destination = decorateUrl('/#/login')
          if (/^https?:\/\//i.test(destination)) {
            window.location.assign(destination)
          }
        },
      })
      if (error) {
        setErrorMessage(authErrorMessage(error))
        return
      }
      if (hasPendingTask) {
        setErrorMessage(
          'Your account needs one more security step. Please try again shortly.',
        )
        return
      }
      onClose()
    } catch (error) {
      setErrorMessage(authErrorMessage(error))
    } finally {
      setFinishing(false)
    }
  }

  const recoverExistingSession = async (
    normalizedEmail: string,
    preferredSessionId?: string,
  ) => {
    setFinishing(true)
    let hasPendingTask = false
    try {
      let sessionId = preferredSessionId

      if (!sessionId) {
        const refreshedClient = await client.reload()
        const matchingSession = refreshedClient.signedInSessions.find(
          (session) =>
            session.user?.emailAddresses.some(
              (email) =>
                email.emailAddress.trim().toLowerCase() === normalizedEmail,
            ),
        )
        sessionId = matchingSession?.id
      }

      if (!sessionId) {
        setErrorMessage(
          'Another account is already open on this device. Close sign in and use that account, or sign it out before using this email.',
        )
        return false
      }

      await setActive({
        session: sessionId,
        navigate: ({ decorateUrl, session }) => {
          if (session?.currentTask) {
            hasPendingTask = true
            return
          }
          const destination = decorateUrl('/#/login')
          if (/^https?:\/\//i.test(destination)) {
            window.location.assign(destination)
          }
        },
      })

      if (hasPendingTask) {
        setErrorMessage(
          'Your account needs one more security step. Please try again shortly.',
        )
        return false
      }

      onClose()
      return true
    } catch (error) {
      setErrorMessage(authErrorMessage(error))
      return false
    } finally {
      setFinishing(false)
    }
  }

  const prepareSecondFactor = async () => {
    const emailFactorAvailable = signIn.supportedSecondFactors.some(
      (factor) => factor.strategy === 'email_code',
    )
    if (!emailFactorAvailable) {
      setErrorMessage(
        'This account needs an additional verification method. Contact your family organizer for help.',
      )
      return
    }

    const { error } = await signIn.mfa.sendEmailCode()
    if (error) {
      setErrorMessage(authErrorMessage(error))
      return
    }
    setCode('')
    setVerificationMode('second-factor')
    setErrorMessage(null)
  }

  const handleCompletedSignInStep = async () => {
    if (signIn.status === 'complete') {
      await finishSignIn()
      return
    }
    if (
      signIn.status === 'needs_second_factor' ||
      signIn.status === 'needs_client_trust'
    ) {
      await prepareSecondFactor()
      return
    }

    setErrorMessage(
      'Your account needs one more security step that Bubble cannot show yet. Please try again shortly.',
    )
  }

  const startEmailFlow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedEmail = emailAddress.trim().toLowerCase()
    if (!normalizedEmail || busy) return

    setErrorMessage(null)
    onStart()

    try {
      await Promise.all([signIn.reset(), signUp.reset()])
      const { error: createError } = await signIn.create({
        identifier: normalizedEmail,
        signUpIfMissing: true,
      })
      if (createError) {
        if (isExistingSessionError(createError)) {
          await recoverExistingSession(
            normalizedEmail,
            signIn.existingSession?.sessionId,
          )
          return
        }
        setErrorMessage(authErrorMessage(createError))
        return
      }

      const { error: sendError } = await signIn.emailCode.sendCode()
      if (sendError) {
        setErrorMessage(authErrorMessage(sendError))
        return
      }

      setEmailAddress(normalizedEmail)
      setCode('')
      setVerificationMode('primary')
    } catch (error) {
      setErrorMessage(authErrorMessage(error))
    }
  }

  const transferVerifiedEmailToSignUp = async () => {
    const { error } = await signUp.create({ transfer: true })
    if (error) {
      if (isExistingSessionError(error)) {
        await recoverExistingSession(
          emailAddress,
          signUp.existingSession?.sessionId,
        )
        return
      }
      setErrorMessage(authErrorMessage(error))
      return
    }

    if (signUp.status === 'complete') {
      await finishSignUp()
      return
    }

    setErrorMessage(
      signUp.missingFields.length > 0
        ? 'Email-only account creation is not fully enabled yet. Please try again shortly.'
        : 'We verified your email but could not finish the account. Please try again.',
    )
  }

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (code.length !== 6 || busy || !verificationMode) return
    setErrorMessage(null)

    try {
      if (verificationMode === 'second-factor') {
        const { error } = await signIn.mfa.verifyEmailCode({ code })
        if (error) {
          setErrorMessage(authErrorMessage(error))
          return
        }
        await handleCompletedSignInStep()
        return
      }

      const { error } = await signIn.emailCode.verifyCode({ code })
      if (clerkErrorCode(error) === 'sign_up_if_missing_transfer') {
        await transferVerifiedEmailToSignUp()
        return
      }
      if (error) {
        setErrorMessage(authErrorMessage(error))
        return
      }
      await handleCompletedSignInStep()
    } catch (error) {
      setErrorMessage(authErrorMessage(error))
    }
  }

  const resendCode = async () => {
    if (busy || !verificationMode) return
    setErrorMessage(null)
    const { error } =
      verificationMode === 'second-factor'
        ? await signIn.mfa.sendEmailCode()
        : await signIn.emailCode.sendCode()
    setErrorMessage(
      error ? authErrorMessage(error) : 'A fresh code is on its way.',
    )
  }

  const startOver = async () => {
    if (busy) return
    await Promise.all([signIn.reset(), signUp.reset()])
    setCode('')
    setVerificationMode(null)
    setErrorMessage(null)
  }

  const close = async () => {
    if (busy) return
    await Promise.all([signIn.reset(), signUp.reset()])
    onClose()
  }

  const visibleError =
    errorMessage ||
    signInErrors.fields?.identifier?.message ||
    signInErrors.fields?.code?.message ||
    signUpErrors.fields?.code?.message ||
    null

  return (
    <div className="email-auth" role="presentation">
      <button
        className="email-auth__backdrop"
        type="button"
        aria-label="Close sign in"
        onClick={() => void close()}
        disabled={busy}
      />
      <section
        className="email-auth__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-auth-title"
      >
        <button
          className="email-auth__close"
          type="button"
          aria-label="Close sign in"
          onClick={() => void close()}
          disabled={busy}
        >
          <span aria-hidden="true">×</span>
        </button>

        {verificationMode ? (
          <form className="email-auth__form" onSubmit={verifyCode}>
            <div className="email-auth__heading">
              <p>Check your inbox</p>
              <h2 id="email-auth-title">Enter your code</h2>
              <span>
                {verificationMode === 'second-factor'
                  ? 'One more security code was sent to'
                  : 'We sent a six-digit code to'}{' '}
                <strong>{emailAddress}</strong>
              </span>
            </div>
            <label className="email-auth__field" htmlFor="bubble-email-code">
              <span>Verification code</span>
              <input
                ref={codeInputRef}
                id="bubble-email-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                enterKeyHint="done"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                }
                aria-invalid={visibleError ? 'true' : undefined}
                aria-describedby={visibleError ? 'email-auth-error' : undefined}
                placeholder="000000"
              />
            </label>
            {visibleError ? (
              <p className="email-auth__message" id="email-auth-error" role="status">
                {visibleError}
              </p>
            ) : null}
            <button
              className="email-auth__primary"
              type="submit"
              disabled={busy || code.length !== 6}
            >
              {finishing ? 'Opening Bubble…' : busy ? 'Checking…' : 'Continue'}
            </button>
            <div className="email-auth__secondary-actions">
              <button type="button" onClick={() => void resendCode()} disabled={busy}>
                Send a new code
              </button>
              <button type="button" onClick={() => void startOver()} disabled={busy}>
                Change email
              </button>
            </div>
          </form>
        ) : (
          <form className="email-auth__form" onSubmit={startEmailFlow}>
            <div className="email-auth__heading">
              <p>Welcome to Bubble</p>
              <h2 id="email-auth-title">Continue with email</h2>
              <span>
                Sign in or create an account with one private verification code.
              </span>
            </div>
            <label className="email-auth__field" htmlFor="bubble-email-address">
              <span>Email address</span>
              <input
                ref={emailInputRef}
                id="bubble-email-address"
                name="emailAddress"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                enterKeyHint="send"
                value={emailAddress}
                onChange={(event) => setEmailAddress(event.target.value)}
                aria-invalid={visibleError ? 'true' : undefined}
                aria-describedby={visibleError ? 'email-auth-error' : undefined}
                placeholder="you@example.com"
                required
              />
            </label>
            {visibleError ? (
              <p className="email-auth__message" id="email-auth-error" role="status">
                {visibleError}
              </p>
            ) : null}
            <button
              className="email-auth__primary"
              type="submit"
              disabled={busy || !emailAddress.trim()}
            >
              {busy ? 'Sending code…' : 'Send me a code'}
            </button>
            <p className="email-auth__privacy">
              No phone number or password needed.
            </p>
            <div id="clerk-captcha" className="email-auth__captcha" />
          </form>
        )}
      </section>
    </div>
  )
}
