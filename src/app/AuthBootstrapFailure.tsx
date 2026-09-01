type AuthBootstrapFailureProps = {
  onReload?: () => void
}

/**
 * Clerk renders this before the router exists, so it cannot rely on app
 * navigation, providers, or theme state. Keep recovery self-contained.
 */
export function AuthBootstrapFailure({ onReload }: AuthBootstrapFailureProps) {
  return (
    <section className="auth-bootstrap-failed" role="alert">
      <p className="auth-bootstrap-failed__eyebrow">Bubble sign-in</p>
      <h1>We couldn’t open sign-in.</h1>
      <p>
        Sign-in is temporarily unavailable. Try again in a moment. Your family
        data has not been changed.
      </p>
      <button
        type="button"
        onClick={onReload ?? (() => window.location.reload())}
      >
        Try again
      </button>
    </section>
  )
}
