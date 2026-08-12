import { Navigate, useLocation } from 'react-router-dom'

type LegacyRouteRedirectProps = {
  fromBase: string
  toBase: string
  preservePathSuffix?: boolean
}

export function LegacyRouteRedirect({
  fromBase,
  toBase,
  preservePathSuffix = false,
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
      state={location.state}
    />
  )
}
