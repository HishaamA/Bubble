const familyBubbles = [
  {
    className: 'auth-family-bubble--granddad',
    src: '/assets/journal/demo/demo-person-granddad.png',
  },
  {
    className: 'auth-family-bubble--maya',
    src: '/assets/journal/demo/demo-person-maya.png',
  },
  {
    className: 'auth-family-bubble--sunday',
    src: '/assets/journal/demo/demo-album-sunday.png',
  },
  {
    className: 'auth-family-bubble--mum',
    src: '/assets/journal/demo/demo-person-mum.png',
  },
  {
    className: 'auth-family-bubble--summer',
    src: '/assets/journal/demo/demo-album-summer-2026.png',
  },
  {
    className: 'auth-family-bubble--travel',
    src: '/assets/journal/demo/demo-album-travel.png',
  },
] as const

export function AuthFamilyIllustration() {
  return (
    <div className="auth-illustration" aria-hidden="true">
      <div className="auth-illustration__halo" />

      {familyBubbles.map(({ className, src }) => (
        <span className={`auth-family-bubble ${className}`} key={className}>
          <img alt="" src={src} draggable="false" />
        </span>
      ))}
    </div>
  )
}
