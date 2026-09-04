import { Component, type ErrorInfo, type PropsWithChildren } from 'react'

type ErrorBoundaryState = { hasError: boolean }
type ErrorBoundaryProps = PropsWithChildren<{ onReload?: () => void }>

/** Prevents a render failure from leaving the application on a blank screen. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false }

  /** Switches rendering to the safe recovery screen after a child throws. */
  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  /** Records diagnostic details without exposing them in the family UI. */
  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the recovery screen intentionally generic. Render errors can include
    // media identifiers, so details stay in the developer console only.
    console.error('Bubble render failure', error, info.componentStack)
  }

  /** Renders either the protected subtree or a self-contained recovery action. */
  override render() {
    if (this.state.hasError) {
      return (
        <div className="fatal-state" role="alert">
          <p className="eyebrow">Something went wrong</p>
          <h1>This memory could not be opened.</h1>
          <p>Your family content is safe. Close and reopen the app to try again.</p>
          <button
            type="button"
            onClick={this.props.onReload ?? (() => window.location.reload())}
          >
            Reload Bubble
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
