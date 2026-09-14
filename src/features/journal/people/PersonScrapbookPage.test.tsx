import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonScrapbookPage } from './PersonScrapbookPage'
import { loadPersonScrapbookProfile, savePersonScrapbookProfile } from './personScrapbookStore'
import type { PeopleTimelinePhoto, TimelinePerson } from './types'

const maya: TimelinePerson = {
  id: 'maya',
  name: 'Maya',
  createdAt: '2026-01-01T00:00:00.000Z',
}

function timelinePhoto(
  id: string,
  caption: string,
  dimensions: readonly [number, number] = [1200, 800],
): PeopleTimelinePhoto {
  return {
    key: `photo:${id}`,
    id,
    kind: 'capsule-photo',
    source: `/photos/${id}-thumb.jpg`,
    scanSource: `/photos/${id}.jpg`,
    displayWidth: dimensions[0],
    displayHeight: dimensions[1],
    capturedAt: '2020-06-03T12:00:00.000Z',
    caption,
    contributorName: 'Lea',
    capsuleId: 'summer-week',
    memoryId: `memory-${id}`,
    canScanFaces: true,
  }
}

describe('PersonScrapbookPage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('renders every photo as a non-clickable collage with natural dimensions', () => {
    const photos = [
      timelinePhoto('picnic', 'Garden picnic', [1200, 800]),
      timelinePhoto('portrait', 'Birthday smile', [700, 1100]),
      timelinePhoto('square', 'Kitchen dancing', [900, 900]),
    ]
    const { container } = render(
      <PersonScrapbookPage
        person={maya}
        photos={photos}
        cacheNamespace="family-a"
      />,
    )

    expect(screen.getByRole('heading', { name: 'Maya' })).toBeInTheDocument()
    expect(screen.getByText('3 little moments, gathered together.')).toBeInTheDocument()
    expect(container.querySelectorAll('.person-scrapbook__photo')).toHaveLength(3)
    const landscape = screen.getByRole('img', { name: 'Garden picnic' })
    expect(landscape).toHaveAttribute('src', '/photos/picnic.jpg')
    expect(landscape).toHaveAttribute('width', '1200')
    expect(landscape).toHaveAttribute('height', '800')
    expect(landscape).toHaveAttribute('loading', 'lazy')
    expect(landscape).toHaveAttribute('decoding', 'async')

    const collage = screen.getByRole('region', {
      name: 'Maya’s little moments',
    })
    expect(within(collage).queryByRole('link')).not.toBeInTheDocument()
    expect(within(collage).queryByRole('button')).not.toBeInTheDocument()
  })

  it('uses an edited timeline date in the photo caption', () => {
    const photo = timelinePhoto('childhood', 'First day of school')
    render(
      <PersonScrapbookPage
        person={maya}
        photos={[photo]}
        cacheNamespace="family-a"
        dateOverrides={{
          [photo.key]: { precision: 'year', value: '1998' },
        }}
      />,
    )

    expect(screen.getByText(/Around 1998/)).toBeInTheDocument()
    expect(screen.getByText('1 little moment, gathered together.')).toBeInTheDocument()
  })

  it('uses a neutral fallback label instead of guaranteeing a recognized identity', () => {
    render(<PersonScrapbookPage person={maya} photos={[timelinePhoto('uncaptioned', '')]} cacheNamespace="neutral-description" />)
    expect(screen.getByRole('img', { name: 'A photo in Maya’s scrapbook' })).toBeInTheDocument()
    expect(screen.queryByText('A family photo with Maya')).not.toBeInTheDocument()
  })

  it('renders optional per-photo corrections without turning the photo into a navigation or removal target', () => {
    const photos = [timelinePhoto('first', 'First photo'), timelinePhoto('second', 'Second photo')]
    const correct = vi.fn()
    render(<PersonScrapbookPage person={maya} photos={photos} cacheNamespace="per-photo-actions"
      renderPhotoActions={(photo) => photo.key === 'photo:first'
        ? <button type="button" onClick={() => correct(photo.key)}>Not Maya?</button> : null} />)
    const firstCard = screen.getByRole('img', { name: 'First photo' }).closest('figure')!
    const secondCard = screen.getByRole('img', { name: 'Second photo' }).closest('figure')!
    expect(within(secondCard).queryByRole('button')).not.toBeInTheDocument()
    fireEvent.click(within(firstCard).getByRole('button', { name: 'Not Maya?' }))
    expect(correct).toHaveBeenCalledExactlyOnceWith('photo:first')
    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps the complete caption, date and uploader in separate flowing rows', () => {
    const caption = 'Our wonderfully long afternoon together at the family reunion'
    const contributorName = 'Alexandra-Christina LongFamilyNameWithoutSpaces'
    const { container } = render(
      <PersonScrapbookPage
        person={maya}
        photos={[{ ...timelinePhoto('reunion', caption), contributorName }]}
        cacheNamespace="family-a"
      />,
    )
    const footer = container.querySelector('figcaption')!

    expect(footer.querySelector('strong')).toHaveTextContent(caption)
    expect(footer.querySelector('time')).toHaveAttribute('datetime', '2020-06-03T12:00:00.000Z')
    expect(footer.querySelector('time')).toHaveTextContent('June 3, 2020')
    expect(footer.querySelector('.person-scrapbook__photo-contributor'))
      .toHaveTextContent(`Shared by ${contributorName}`)
    expect(footer.children).toHaveLength(3)
  })

  it('persists editable details and restores them on the next visit', async () => {
    const user = userEvent.setup()
    const props = {
      person: maya,
      photos: [timelinePhoto('picnic', 'Garden picnic')],
      cacheNamespace: 'family-a',
    }
    const firstVisit = render(<PersonScrapbookPage {...props} />)

    fireEvent.change(screen.getByLabelText('Birthday'), {
      target: { value: '2004-05-12' },
    })
    await user.type(screen.getByLabelText('Relation'), 'Cousin')
    await user.type(
      screen.getByLabelText('Favorite things'),
      'Sea swims and mango cake',
    )
    await user.type(
      screen.getByLabelText('Notes'),
      'Keeps every handwritten card.',
    )

    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device.')
    expect(loadPersonScrapbookProfile('family-a', 'maya')).toEqual({
      birthday: '2004-05-12',
      relation: 'Cousin',
      favoriteThings: 'Sea swims and mango cake',
      notes: 'Keeps every handwritten card.',
    })

    firstVisit.unmount()
    render(<PersonScrapbookPage {...props} />)
    expect(screen.getByLabelText('Birthday')).toHaveValue('2004-05-12')
    expect(screen.getByLabelText('Relation')).toHaveValue('Cousin')
    expect(screen.getByLabelText('Favorite things')).toHaveValue(
      'Sea swims and mango cake',
    )
    expect(screen.getByLabelText('Notes')).toHaveValue(
      'Keeps every handwritten card.',
    )
  })

  it('reloads person details when the account namespace changes', () => {
    savePersonScrapbookProfile('family-a', maya.id, {
      birthday: '',
      relation: 'Cousin',
      favoriteThings: '',
      notes: '',
    })
    savePersonScrapbookProfile('family-b', maya.id, {
      birthday: '',
      relation: 'Friend',
      favoriteThings: '',
      notes: '',
    })
    const { rerender } = render(
      <PersonScrapbookPage
        person={maya}
        photos={[]}
        cacheNamespace="family-a"
      />,
    )
    expect(screen.getByLabelText('Relation')).toHaveValue('Cousin')

    rerender(
      <PersonScrapbookPage
        person={maya}
        photos={[]}
        cacheNamespace="family-b"
      />,
    )
    expect(screen.getByLabelText('Relation')).toHaveValue('Friend')
  })

  it('offers accessible optional navigation and an inviting empty page', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    const onManage = vi.fn()
    render(
      <PersonScrapbookPage
        person={maya}
        photos={[]}
        cacheNamespace="family-a"
        onBack={onBack}
        onManage={onManage}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Back to people' }))
    await user.click(screen.getByRole('button', { name: 'Manage Maya' }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(onManage).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', {
      name: 'A page waiting for memories',
    })).toBeInTheDocument()
    expect(screen.getByText('Photos matched with Maya will gather here.')).toBeInTheDocument()
  })
})
