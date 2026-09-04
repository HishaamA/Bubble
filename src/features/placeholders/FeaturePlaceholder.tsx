import { Icon, type IconName } from '../../components/Icon'

type FeaturePlaceholderProps = {
  eyebrow: string
  title: string
  description: string
  icon: IconName
}

/** Renders a consistent status page for a named feature that is not yet available. */
export function FeaturePlaceholder({
  eyebrow,
  title,
  description,
  icon,
}: FeaturePlaceholderProps) {
  return (
    <section className="feature-screen" aria-labelledby={`feature-${icon}`}>
      <div className="feature-screen__orb" aria-hidden="true">
        <Icon name={icon} size={42} />
      </div>
      <p className="eyebrow">{eyebrow}</p>
      <h1 id={`feature-${icon}`}>{title}</h1>
      <p className="feature-screen__description">{description}</p>
      <div className="feature-screen__status">
        <span aria-hidden="true" />
        Planned in the implementation handoff
      </div>
    </section>
  )
}
