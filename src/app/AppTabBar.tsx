import { Link, useLocation } from 'react-router-dom'
import { Icon, type IconName } from '../components/Icon'

const tabs: Array<{ label: string; path: string; icon: IconName }> = [
  { label: 'Capsules', path: '/capsules', icon: 'capsules' },
  { label: 'Memories', path: '/', icon: 'memories' },
  { label: 'Relay', path: '/relay', icon: 'relay' },
  { label: 'Events', path: '/events', icon: 'events' },
  { label: 'Profile', path: '/profile', icon: 'profile' },
]

export function AppTabBar() {
  const location = useLocation()

  return (
    <nav className="tab-bar" aria-label="Primary navigation">
      {tabs.map((tab) => {
        const isActive =
          tab.path === '/'
            ? location.pathname === '/' ||
              location.pathname.startsWith('/memory/') ||
              location.pathname.startsWith('/capture')
            : location.pathname.startsWith(tab.path)

        return (
          <Link
            key={tab.path}
            to={tab.path}
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
