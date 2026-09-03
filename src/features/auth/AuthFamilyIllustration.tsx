const familyBubbles = [
  {
    className: 'auth-family-bubble--sunday',
    src: '/assets/journal/demo/demo-album-sunday.png',
  },
] as const

/** Renders the decorative family-memory artwork on the authentication cover. */
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
