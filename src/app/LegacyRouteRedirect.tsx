import { Navigate, useLocation } from 'react-router-dom'

type LegacyRouteRedirectProps = {
  fromBase: string
  toBase: string
  preservePathSuffix?: boolean
  mapState?: (state: unknown) => unknown
}

/** Redirects retired routes while preserving query, hash, and optional state. */
export function LegacyRouteRedirect({
  fromBase,
  toBase,
  preservePathSuffix = false,
  mapState,
}: LegacyRouteRedirectProps) {
  const location = useLocation()
  const pathSuffix = preservePathSuffix
    ? location.pathname.slice(fromBase.length)
    : ''

  return (
    <Navigate
      replace
      to={{
        pathname: `${toBase}${pathSuffix}`,
        search: location.search,
        hash: location.hash,
      }}
      state={mapState ? mapState(location.state) : location.state}
    />
  )
}
