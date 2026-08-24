import { Link, useLocation } from 'react-router-dom'
import { Icon, type IconName } from '../components/Icon'

type Tab = {
  label: string
  path: string
  icon: IconName
  isActive: (pathname: string, returnTo?: string) => boolean
}

const tabs: Tab[] = [
  {
    label: 'Moments',
    path: '/',
    icon: 'memories',
    isActive: (pathname, returnTo) =>
      pathname === '/' ||
      (pathname.startsWith('/memory/') && returnTo !== '/journal') ||
      pathname.startsWith('/capture') ||
      pathname.startsWith('/relay'),
  },
  {
    label: 'Capsule',
    path: '/capsule',
    icon: 'capsules',
    isActive: (pathname) =>
      pathname === '/capsule' || pathname.startsWith('/capsule/'),
  },
  {
    label: 'Journal',
    path: '/journal',
    icon: 'journal',
    isActive: (pathname, returnTo) =>
      pathname.startsWith('/journal') ||
      (pathname.startsWith('/memory/') && returnTo === '/journal'),
  },
]

export function AppTabBar() {
  const location = useLocation()
  const routeState = location.state as {
    returnTo?: string
    journalContext?: unknown
  } | null

  return (
    <nav className="tab-bar" aria-label="Primary navigation">
      {tabs.map((tab) => {
        const isActive = tab.isActive(location.pathname, routeState?.returnTo)
        const preservesJournalContext =
          tab.path === '/journal' && routeState?.returnTo === '/journal'

        return (
          <Link
            key={tab.path}
            to={tab.path}
            state={
              preservesJournalContext
                ? { journalContext: routeState.journalContext }
                : undefined
            }
            aria-current={isActive ? 'page' : undefined}
            className={`tab-bar__item${isActive ? ' tab-bar__item--active' : ''}`}
          >
            <span className="tab-bar__icon" aria-hidden="true">
              <Icon name={tab.icon} size={22} />
            </span>
            <span>{tab.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
