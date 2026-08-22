import type { JournalPhoto } from './journalPhotoTypes'

const demoPhotoDefinitions = [
  {
    id: 'demo-journal-lake-sunset',
    asset: 'demo-lake-sunset.jpg',
    caption: 'Sunset after the long drive',
    capturedAt: '2025-06-14T18:42:00.000Z',
    contributorName: 'Maya',
  },
  {
    id: 'demo-journal-listening-room',
    asset: 'demo-listening-room.jpg',
    caption: 'Grandpa’s favorite record',
    capturedAt: '2025-06-14T21:10:00.000Z',
    contributorName: 'James',
  },
  {
    id: 'demo-journal-park-picnic',
    asset: 'demo-park-picnic.jpg',
    caption: 'Sunday picnic under the trees',
    capturedAt: '2026-07-12T13:05:00.000Z',
    contributorName: 'Emily',
  },
  {
    id: 'demo-journal-breakfast-table',
    asset: 'demo-breakfast-table.jpg',
    caption: 'Breakfast before everyone woke up',
    capturedAt: '2025-07-02T09:15:00.000Z',
    contributorName: 'Maya',
  },
  {
    id: 'demo-journal-city-at-dusk',
    asset: 'demo-city-at-dusk.jpg',
    caption: 'The city turned pink',
    capturedAt: '2025-07-02T20:11:00.000Z',
    contributorName: 'James',
  },
  {
    id: 'demo-journal-flowers-at-home',
    asset: 'demo-flowers-at-home.jpg',
    caption: 'Flowers for Mum',
    capturedAt: '2025-07-11T17:20:00.000Z',
    contributorName: 'Sofia',
  },
  {
    id: 'demo-journal-sleepy-dog',
    asset: 'demo-sleepy-dog.jpg',
    caption: 'Milo claimed the sofa',
    capturedAt: '2025-08-03T15:40:00.000Z',
    contributorName: 'Emily',
  },
  {
    id: 'demo-journal-quiet-journal',
    asset: 'demo-quiet-journal.jpg',
    caption: 'Tea and stories after dinner',
    capturedAt: '2025-08-03T21:05:00.000Z',
    contributorName: 'Maya',
  },
  {
    id: 'demo-journal-dumpling-night',
    asset: 'demo-dumpling-night.jpg',
    caption: 'Dumpling night at home',
    capturedAt: '2025-08-10T18:30:00.000Z',
    contributorName: 'Family',
  },
] as const

export const demoJournalPhotos: readonly JournalPhoto[] =
  demoPhotoDefinitions.map((definition) => {
    const source = `/assets/journal/demo/${definition.asset}`
    return {
      id: definition.id,
      image: source,
      thumbnail: source,
      width: 418,
      height: 418,
      thumbnailWidth: 418,
      thumbnailHeight: 418,
      caption: definition.caption,
      capturedAt: definition.capturedAt,
      contributorName: definition.contributorName,
      ownedByCurrentUser: false,
      syncStatus: 'synced',
    }
  })

/**
 * Adds static preview entries without writing them to the user's durable
 * photo store. Real records win if an ID ever collides with a demo fixture.
 */
export function withDemoJournalPhotos(
  photos: readonly JournalPhoto[],
  demoMode: boolean,
): readonly JournalPhoto[] {
  if (!demoMode) return photos
  const realPhotoIds = new Set(photos.map(({ id }) => id))
  return [
    ...photos,
    ...demoJournalPhotos.filter(({ id }) => !realPhotoIds.has(id)),
  ].sort((left, right) =>
    right.capturedAt.localeCompare(left.capturedAt) ||
    right.id.localeCompare(left.id),
  )
}
