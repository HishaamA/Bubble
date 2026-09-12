/** Renders the small line icon set shared by capture states and actions. */
export function CaptureIcon({ name }: { name: 'close' | 'lock' | 'camera' | 'check' | 'image' }) {
  const common = {
    'aria-hidden': true,
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }

  if (name === 'close') return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>
  if (name === 'check') return <svg {...common}><path d="m5 12.5 4.3 4.3L19 7" /></svg>
  if (name === 'image') return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m4 17 4.5-4 3.4 3 2.8-2.5L20 18" /></svg>
  if (name === 'camera') return <svg {...common}><path d="M4.5 7.5h3l1.4-2h6.2l1.4 2h3A2.5 2.5 0 0 1 22 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5V10a2.5 2.5 0 0 1 2.5-2.5Z" /><circle cx="12" cy="13.5" r="3.4" /></svg>
  return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
}
