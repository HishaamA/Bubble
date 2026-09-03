import { useClerk, useSignIn, useSignUp } from '@clerk/react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  isNativeOAuthPlatform,
  NATIVE_OAUTH_CALLBACK_URL,
} from './nativeOAuthTransport'

type EmailCodeAuthFlowProps = {
  onClose: () => void
  onStart: () => void
}

type VerificationMode = 'primary' | 'second-factor'
type MaintenanceAction = 'close' | 'resend' | 'start-over'

const dialogFocusSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

type ClerkErrorLike = {
  errors?: Array<{
    code?: string
    longMessage?: string
    message?: string
  }>
}

/** Extracts Clerk's primary structured error without trusting thrown values. */
function firstClerkError(errorReason: unknown) {
  if (!errorReason || typeof errorReason !== 'object') return undefined
  return (errorReason as ClerkErrorLike).errors?.[0]
}

/** Reads Clerk's nested error code when the SDK returned its standard envelope. */
function clerkErrorCode(errorReason: unknown) {
  return firstClerkError(errorReason)?.code
}

/** Reads cancellation codes thrown directly by native transports. */
function directErrorCode(errorReason: unknown) {
  if (
    !errorReason ||
    typeof errorReason !== 'object' ||
    !('code' in errorReason)
  ) {
    return undefined
  }
  return typeof errorReason.code === 'string' ? errorReason.code : undefined
}

/** Treats both native and Clerk popup dismissal codes as deliberate cancellation. */
function isOAuthCancellation(errorReason: unknown) {
  const errorCode =
    directErrorCode(errorReason) ?? clerkErrorCode(errorReason)
  return errorCode === 'AUTH_CANCELLED' || errorCode === 'oauth_access_denied'
}

/** Represents a user closing the Google popup, not an authentication failure. */
class PopupClosedError extends Error {
  readonly code = 'AUTH_CANCELLED'

  constructor() {
    super('Google sign-in was cancelled.')
    this.name = 'PopupClosedError'
  }
}

/** Builds Clerk's absolute completion URL while preserving the hash-router entry. */
function getAppLoginUrl() {
  return new URL('/#/login', window.location.href).toString()
}

/** Detects Clerk attempts that should attach to an already-open device session. */
function isExistingSessionError(errorReason: unknown) {
  const errorCode = clerkErrorCode(errorReason)
  return (
    errorCode === 'session_exists' ||
    errorCode === 'identifier_already_signed_in'
  )
}

/** Maps Clerk errors to concise copy while retaining safe SDK messages. */
function authErrorMessage(errorReason: unknown) {
  const clerkError = firstClerkError(errorReason)
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

/**
 * Runs Bubble's email-code and Google sign-in flows inside an accessible modal.
 * Clerk owns authentication state; this component coordinates transitions,
 * cancellation, focus restoration, and user-facing errors.
 */
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
  const [verificationCode, setVerificationCode] = useState('')
  const [verificationMode, setVerificationMode] =
    useState<VerificationMode | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [googlePending, setGooglePending] = useState(false)
  const [maintenanceAction, setMaintenanceAction] =
    useState<MaintenanceAction | null>(null)
  const [verificationDestination, setVerificationDestination] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null)
  const requestPending =
    finishing ||
    googlePending ||
    maintenanceAction !== null ||
    signInFetchStatus === 'fetching' ||
    signUpFetchStatus === 'fetching'

  useEffect(() => {
    // The sheet is conditionally mounted over a still-interactive page. Remembering
    // the opener keeps keyboard users in the same place after every dismissal path,
    // including Escape and a Clerk reset failure.
    previouslyFocusedElementRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    return () => {
      const previouslyFocusedElement = previouslyFocusedElementRef.current
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true })
      }
    }
  }, [])

  // Each verification transition moves focus to the newly actionable field;
  // this also prevents focus from remaining on controls removed from the DOM.
  useEffect(() => {
    const input = verificationMode ? codeInputRef.current : emailInputRef.current
    input?.focus({ preventScroll: true })
  }, [verificationMode])

  /** Finalizes a verified sign-in unless Clerk reports an unsupported pending task. */
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

  /** Finalizes a verified sign-up under the same pending-task guard as sign-in. */
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

  /** Reuses an existing device session instead of starting a conflicting attempt. */
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

  /** Requests Clerk's supported email factor and advances the modal to MFA entry. */
  const prepareSecondFactor = async () => {
    const emailFactor = signIn.supportedSecondFactors.find(
      (factor) => factor.strategy === 'email_code',
    )
    if (!emailFactor) {
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
    setVerificationCode('')
    // OAuth can reach MFA without ever populating our email input. Clerk's masked
    // factor identifier is therefore the authoritative, privacy-safe destination;
    // the literal fallback prevents an empty sentence if an older SDK omits it.
    setVerificationDestination(
      ('safeIdentifier' in emailFactor &&
      typeof emailFactor.safeIdentifier === 'string'
        ? emailFactor.safeIdentifier.trim()
        : '') ||
        emailAddress.trim() ||
        'your email address',
    )
    setVerificationMode('second-factor')
    setErrorMessage(null)
  }

  /** Routes a successful first factor to completion, MFA, or an actionable error. */
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

  /** Converts a transferable Google sign-in into the corresponding sign-up attempt. */
  const transferGoogleToSignUp = async () => {
    const { error } = await signUp.create({ transfer: true })
    if (error) {
      setErrorMessage(authErrorMessage(error))
      return
    }

    if (signUp.status === 'complete') {
      await finishSignUp()
      return
    }

    setErrorMessage(
      signUp.missingFields.length > 0
        ? 'Google sign-in needs account details that Bubble cannot collect yet. Please continue with email.'
        : 'Google verified your account but Bubble could not finish signing you in. Please try again.',
    )
  }

  /** Interprets Clerk's post-OAuth state rather than assuming OAuth completed login. */
  const handleGoogleResult = async () => {
    const activeSession = client.signedInSessions.find(
      (session) =>
        session.id === client.lastActiveSessionId && session.status === 'active',
    )
    if (activeSession) {
      onClose()
      return
    }
    if (signIn.status === 'complete') {
      await finishSignIn()
      return
    }
    if (signIn.isTransferable) {
      await transferGoogleToSignUp()
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
      'Google verified your account but Bubble could not finish signing you in. Please try again or continue with email.',
    )
  }

  /** Starts Google OAuth through the registered native callback transport. */
  const startNativeGoogleFlow = async () => {
    const returnUrl = getAppLoginUrl()
    const stayInApp = async () => undefined

    await client.signIn.authenticateWithRedirect({
      strategy: 'oauth_google',
      redirectUrl: NATIVE_OAUTH_CALLBACK_URL,
      redirectUrlComplete: returnUrl,
      __internal_callbackParams: {
        signInUrl: returnUrl,
        signUpUrl: returnUrl,
        firstFactorUrl: returnUrl,
        secondFactorUrl: returnUrl,
        continueSignUpUrl: returnUrl,
        signInForceRedirectUrl: returnUrl,
        signUpForceRedirectUrl: returnUrl,
        __internal_navigate: stayInApp,
        __internal_navigateOnSetActive: stayInApp,
      },
    })

    await handleGoogleResult()
  }

  /** Runs Google OAuth in a popup and rejects promptly when the user closes it. */
  const startWebGoogleFlow = async () => {
    const googlePopup = window.open(
      'about:blank',
      'bubble-google-sign-in',
      'popup=yes,width=520,height=720',
    )
    if (!googlePopup) {
      setErrorMessage(
        'Google sign-in could not open. Allow pop-ups for Bubble and try again.',
      )
      return
    }

    let popupClosedTimer: number | undefined
    const popupClosedPromise = new Promise<never>((_, reject) => {
      popupClosedTimer = window.setInterval(() => {
        if (!googlePopup.closed) return
        window.clearInterval(popupClosedTimer)
        reject(new PopupClosedError())
      }, 250)
    })

    try {
      const returnUrl = getAppLoginUrl()
      const authenticationResult = await Promise.race([
        signIn.sso({
          strategy: 'oauth_google',
          redirectCallbackUrl: returnUrl,
          redirectUrl: returnUrl,
          popup: googlePopup,
        }),
        popupClosedPromise,
      ])
      if (authenticationResult.error) {
        setErrorMessage(authErrorMessage(authenticationResult.error))
        return
      }
      await handleGoogleResult()
    } finally {
      if (popupClosedTimer !== undefined) {
        window.clearInterval(popupClosedTimer)
      }
      if (!googlePopup.closed) googlePopup.close()
    }
  }

  /** Selects the platform OAuth flow while keeping cancellation out of error copy. */
  const startGoogleFlow = async () => {
    if (requestPending || verificationMode) return
    setErrorMessage(null)
    setGooglePending(true)
    onStart()

    try {
      if (isNativeOAuthPlatform()) {
        await startNativeGoogleFlow()
      } else {
        await startWebGoogleFlow()
      }
    } catch (error) {
      if (!isOAuthCancellation(error)) {
        setErrorMessage(authErrorMessage(error))
      }
    } finally {
      setGooglePending(false)
    }
  }

  /** Creates or resumes an email attempt, then sends its first verification code. */
  const startEmailFlow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedEmail = emailAddress.trim().toLowerCase()
    if (!normalizedEmail || requestPending) return

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
      setVerificationDestination(normalizedEmail)
      setVerificationCode('')
      setVerificationMode('primary')
    } catch (error) {
      setErrorMessage(authErrorMessage(error))
    }
  }

  /** Converts a verified, previously unknown email into a Clerk sign-up. */
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

  /** Verifies the active primary or second-factor code against the matching API. */
  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      verificationCode.length !== 6 ||
      requestPending ||
      !verificationMode
    ) {
      return
    }
    setErrorMessage(null)

    try {
      if (verificationMode === 'second-factor') {
        const { error } = await signIn.mfa.verifyEmailCode({
          code: verificationCode,
        })
        if (error) {
          setErrorMessage(authErrorMessage(error))
          return
        }
        await handleCompletedSignInStep()
        return
      }

      const { error } = await signIn.emailCode.verifyCode({
        code: verificationCode,
      })
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

  /** Resends only the factor currently displayed in the modal. */
  const resendCode = async () => {
    if (requestPending || !verificationMode) return
    setErrorMessage(null)
    setMaintenanceAction('resend')
    try {
      const { error } =
        verificationMode === 'second-factor'
          ? await signIn.mfa.sendEmailCode()
          : await signIn.emailCode.sendCode()
      setErrorMessage(
        error ? authErrorMessage(error) : 'A fresh code is on its way.',
      )
    } catch (error) {
      // Clerk may reject instead of returning its structured error result when the
      // network drops. Always translate that branch and release the visual lock.
      setErrorMessage(authErrorMessage(error))
    } finally {
      setMaintenanceAction(null)
    }
  }

  /** Resets both Clerk attempts before returning to email selection. */
  const startOver = async () => {
    if (requestPending) return
    setErrorMessage(null)
    setMaintenanceAction('start-over')
    try {
      await Promise.all([signIn.reset(), signUp.reset()])
      setVerificationCode('')
      setVerificationDestination('')
      setVerificationMode(null)
    } catch (error) {
      // Keep the current verification UI when Clerk could not clear its attempt;
      // moving back locally would make the next submit race stale Clerk state.
      setErrorMessage(authErrorMessage(error))
    } finally {
      setMaintenanceAction(null)
    }
  }

  /** Dismisses the modal even when remote attempt cleanup cannot complete. */
  const close = async () => {
    if (requestPending) return
    setMaintenanceAction('close')
    // Dismissal must never strand someone in the modal because an optional remote
    // reset failed. allSettled drains both attempts without creating an unhandled
    // rejection; the next open starts by resetting Clerk again before submission.
    try {
      await Promise.allSettled([
        Promise.resolve().then(() => signIn.reset()),
        Promise.resolve().then(() => signUp.reset()),
      ])
    } finally {
      setMaintenanceAction(null)
      onClose()
    }
  }

  /** Implements Escape dismissal and a wrapping keyboard focus trap. */
  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void close()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(dialogFocusSelector) ?? [],
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true')
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus({ preventScroll: true })
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    } else if (!dialogRef.current?.contains(document.activeElement)) {
      // Programmatic focus can occasionally escape while an OAuth window closes.
      // Pull it back into the modal on the next keyboard navigation gesture.
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }

  const visibleErrorMessage =
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
        disabled={requestPending}
      />
      <section
        ref={dialogRef}
        className="email-auth__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-auth-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <button
          className="email-auth__close"
          type="button"
          aria-label="Close sign in"
          onClick={() => void close()}
          disabled={requestPending}
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
                <strong>
                  {verificationDestination || emailAddress || 'your email address'}
                </strong>
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
                value={verificationCode}
                onChange={(event) =>
                  setVerificationCode(
                    event.target.value.replace(/\D/g, '').slice(0, 6),
                  )
                }
                aria-invalid={visibleErrorMessage ? 'true' : undefined}
                aria-describedby={
                  visibleErrorMessage ? 'email-auth-error' : undefined
                }
                placeholder="000000"
              />
            </label>
            {visibleErrorMessage ? (
              <p className="email-auth__message" id="email-auth-error" role="status">
                {visibleErrorMessage}
              </p>
            ) : null}
            <button
              className="email-auth__primary"
              type="submit"
              disabled={requestPending || verificationCode.length !== 6}
            >
              {finishing
                ? 'Opening Bubble…'
                : requestPending
                  ? 'Checking…'
                  : 'Continue'}
            </button>
            <div className="email-auth__secondary-actions">
              <button
                type="button"
                onClick={() => void resendCode()}
                disabled={requestPending}
              >
                {maintenanceAction === 'resend' ? 'Sending…' : 'Send a new code'}
              </button>
              <button
                type="button"
                onClick={() => void startOver()}
                disabled={requestPending}
              >
                {maintenanceAction === 'start-over' ? 'Resetting…' : 'Change email'}
              </button>
            </div>
          </form>
        ) : (
          <form className="email-auth__form" onSubmit={startEmailFlow}>
            <div className="email-auth__heading">
              <p>Welcome to Bubble</p>
              <h2 id="email-auth-title">Choose how to continue</h2>
              <span>
                Sign in or create an account without leaving Bubble behind.
              </span>
            </div>
            <button
              className="email-auth__google"
              type="button"
              onClick={() => void startGoogleFlow()}
              disabled={requestPending}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path
                  fill="#4285f4"
                  d="M21.6 12.23c0-.71-.06-1.4-.18-2.06H12v3.9h5.38a4.6 4.6 0 0 1-2 3.02v2.53h3.24c1.9-1.75 2.98-4.33 2.98-7.39Z"
                />
                <path
                  fill="#34a853"
                  d="M12 22c2.7 0 4.98-.9 6.63-2.38l-3.24-2.53c-.9.6-2.05.96-3.39.96-2.61 0-4.83-1.76-5.62-4.13H3.03v2.61A10 10 0 0 0 12 22Z"
                />
                <path
                  fill="#fbbc05"
                  d="M6.38 13.92A6.02 6.02 0 0 1 6.06 12c0-.67.11-1.32.32-1.92V7.47H3.03A10 10 0 0 0 2 12c0 1.62.39 3.15 1.03 4.53l3.35-2.61Z"
                />
                <path
                  fill="#ea4335"
                  d="M12 5.95c1.47 0 2.79.5 3.82 1.5l2.88-2.88A9.65 9.65 0 0 0 12 2a10 10 0 0 0-8.97 5.47l3.35 2.61C7.17 7.71 9.39 5.95 12 5.95Z"
                />
              </svg>
              <span>{googlePending ? 'Opening Google…' : 'Continue with Google'}</span>
            </button>
            <div className="email-auth__divider" aria-hidden="true">
              <span>or use email</span>
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
                aria-invalid={visibleErrorMessage ? 'true' : undefined}
                aria-describedby={
                  visibleErrorMessage ? 'email-auth-error' : undefined
                }
                placeholder="you@example.com"
                required
              />
            </label>
            {visibleErrorMessage ? (
              <p className="email-auth__message" id="email-auth-error" role="status">
                {visibleErrorMessage}
              </p>
            ) : null}
            <button
              className="email-auth__primary"
              type="submit"
              disabled={requestPending || !emailAddress.trim()}
            >
              {requestPending ? 'Sending code…' : 'Send me a code'}
            </button>
            <p className="email-auth__privacy">
              No phone number or password needed.
            </p>
          </form>
        )}
      </section>
    </div>
  )
}
