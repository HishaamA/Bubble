import { Component, type ErrorInfo, type PropsWithChildren } from 'react'

type ErrorBoundaryState = { hasError: boolean }
type ErrorBoundaryProps = PropsWithChildren<{ onReload?: () => void }>

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the recovery screen intentionally generic. Render errors can include
    // media identifiers, so details stay in the developer console only.
    console.error('Bubble render failure', error, info.componentStack)
  }

  render() {
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
