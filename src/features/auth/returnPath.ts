const INTERNAL_APP_ORIGIN = 'https://bubble.local'

/**
 * Converts an untrusted navigation target into an internal app path.
 *
 * URL parsing is required even after the leading-slash check because browsers
 * normalize backslashes and other unusual input before navigation. Paths below
 * a blocked route are rejected as well, which prevents authentication and
 * onboarding gates from redirecting back into themselves.
 */
export function getSafeReturnPath(
  candidate: unknown,
  blockedRouteRoots: readonly string[],
) {
  if (
    typeof candidate !== 'string' ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//')
  ) {
    return '/'
  }

  try {
    const destination = new URL(candidate, INTERNAL_APP_ORIGIN)
    const entersBlockedRoute = blockedRouteRoots.some(
      (routeRoot) =>
        destination.pathname === routeRoot ||
        destination.pathname.startsWith(`${routeRoot}/`),
    )

    if (destination.origin !== INTERNAL_APP_ORIGIN || entersBlockedRoute) {
      return '/'
    }

    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return '/'
  }
}
