import { useState } from 'react'
import { ContentRemovalControl } from '../journal/ContentRemovalControl'
import { CapsulePhotoImage } from './CapsulePhotoImage'
import type { FamilyCapsule } from './types'
import './CapsulePhotoManager.css'

/** A sealed Capsule still lets its uploader manage their own contributions. */
export function CapsulePhotoManager({ capsule, onDelete }: {
  capsule: FamilyCapsule
  onDelete: (photoId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const ownPhotos = capsule.photos.filter((photo) => photo.ownedByCurrentUser)
  if (!ownPhotos.length) return null
  return <section className="capsule-photo-manager">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? 'Close my photos' : `Manage my photos (${ownPhotos.length})`}
    </button>
    {open ? <ul>
      {ownPhotos.map((photo) => <li key={photo.id}>
        <div className="capsule-photo-manager__photo">
          <CapsulePhotoImage source={photo.thumbnail} alt={photo.caption || 'Your Capsule photo'} />
          <span>{photo.caption || 'Your photo'}</span>
        </div>
        <ContentRemovalControl noun="photo" compact
          description="This deletes your contribution from this Capsule, its family recap and Journal entry for everyone. Separate uploads and saved videos stay unchanged."
          onRemove={() => onDelete(photo.id)} />
      </li>)}
    </ul> : null}
  </section>
}
