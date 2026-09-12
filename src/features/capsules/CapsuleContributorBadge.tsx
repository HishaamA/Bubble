import { useState } from 'react'
import { capsuleContributorAvatarUrl, capsuleContributorInitials } from './capsuleContributor'
import './CapsuleContributorBadge.css'

/** Mounted only alongside visible photos, never on a sealed Capsule's cover. */
export function CapsuleContributorBadge({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const source = capsuleContributorAvatarUrl(avatarUrl)
  const [failedSource, setFailedSource] = useState<string>()
  return (
    <span className="capsule-contributor-badge" role="img" aria-label={`Uploaded by ${name}`} title={`Uploaded by ${name}`}>
      {source && failedSource !== source ? (
        <img src={source} alt="" aria-hidden="true" referrerPolicy="no-referrer" onError={() => setFailedSource(source)} />
      ) : <span aria-hidden="true">{capsuleContributorInitials(name)}</span>}
    </span>
  )
}
