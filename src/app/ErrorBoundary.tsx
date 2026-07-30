import { Component, type ErrorInfo, type PropsWithChildren } from 'react'

type ErrorBoundaryState = { hasError: boolean }

export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('KinSphere render failure', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="fatal-state" role="alert">
          <p className="eyebrow">Something went wrong</p>
          <h1>This memory could not be opened.</h1>
          <p>Your family content is safe. Close and reopen the app to try again.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload KinSphere
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
