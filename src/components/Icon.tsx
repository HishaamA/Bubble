export type IconName =
  | 'memories'
  | 'journal'
  | 'capsules'
  | 'events'
  | 'profile'
  | 'settings'
  | 'sparkles'
  | 'vr'
  | 'arrow'

type IconProps = {
  name: IconName
  size?: number
}

export function Icon({ name, size = 24 }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  if (name === 'memories') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3.2" />
        <circle cx="16.5" cy="7" r="2.2" />
        <circle cx="15" cy="15.5" r="4.1" />
        <circle cx="6.5" cy="16.5" r="1.7" />
      </svg>
    )
  }

  if (name === 'journal') {
    return (
      <svg {...common}>
        <path d="M6.2 3.8h10.1A1.7 1.7 0 0 1 18 5.5v13.1a1.6 1.6 0 0 1-1.6 1.6H6.2a1.7 1.7 0 0 1-1.7-1.7v-13a1.7 1.7 0 0 1 1.7-1.7Z" />
        <path d="M8 3.8v16.4M11 8h4M11 11.5h4" />
      </svg>
    )
  }

  if (name === 'capsules') {
    return (
      <svg {...common}>
        <path d="M8.2 4.8h7.6a4.2 4.2 0 0 1 0 8.4H8.2a4.2 4.2 0 1 1 0-8.4Z" />
        <path d="m9.1 6.1 5.8 5.8" />
        <path d="M12 13.2v6" />
        <path d="M9 19.2h6" />
      </svg>
    )
  }

  if (name === 'events') {
    return (
      <svg {...common}>
        <rect x="4" y="5.5" width="16" height="14" rx="3" />
        <path d="M8 3.8v3.4M16 3.8v3.4M4 9.5h16" />
        <path d="M8 13h3M8 16h6" />
      </svg>
    )
  }

  if (name === 'profile') {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      </svg>
    )
  }

  if (name === 'settings') {
    return (
      <svg {...common}>
        <path d="M4 7h3M11 7h9M4 17h9M17 17h3" />
        <circle cx="9" cy="7" r="2" />
        <circle cx="15" cy="17" r="2" />
      </svg>
    )
  }

  if (name === 'arrow') {
    return (
      <svg {...common}>
        <path d="m9 5 7 7-7 7" />
      </svg>
    )
  }

  if (name === 'vr') {
    return (
      <svg {...common}>
        <path d="M4.2 7.2h15.6a1.7 1.7 0 0 1 1.7 1.7v6.3a2 2 0 0 1-2 2h-3.1l-2.1-3.4h-4.6l-2.1 3.4H4.5a2 2 0 0 1-2-2V8.9a1.7 1.7 0 0 1 1.7-1.7Z" />
        <circle cx="7.4" cy="12" r="2.2" />
        <circle cx="16.6" cy="12" r="2.2" />
        <path d="M9.6 12h4.8M7 7.2l.8-2h8.4l.8 2" />
      </svg>
    )
  }

  return (
    <svg {...common}>
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}
