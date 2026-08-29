import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyPersonScrapbookProfile,
  loadPersonScrapbookProfile,
  personScrapbookStorageKey,
  removePersonScrapbookProfile,
  savePersonScrapbookProfile,
} from './personScrapbookStore'

describe('personScrapbookStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns an empty profile before a person scrapbook is written', () => {
    expect(loadPersonScrapbookProfile('family-a', 'maya')).toEqual(
      emptyPersonScrapbookProfile(),
    )
  })

  it('stores details separately for every namespace and person', () => {
    const maya = {
      birthday: '2004-05-12',
      relation: 'Cousin',
      favoriteThings: 'Sea swims, mango cake, yellow flowers',
      notes: 'Always remembers everyone’s birthday.',
    }

    expect(savePersonScrapbookProfile('family-a', 'maya', maya)).toBe(true)
    expect(savePersonScrapbookProfile('family-a', 'lea', {
      ...maya,
      relation: 'Sister',
    })).toBe(true)

    expect(loadPersonScrapbookProfile('family-a', 'maya')).toEqual(maya)
    expect(loadPersonScrapbookProfile('family-a', 'lea').relation).toBe('Sister')
    expect(loadPersonScrapbookProfile('family-b', 'maya')).toEqual(
      emptyPersonScrapbookProfile(),
    )
    expect(personScrapbookStorageKey('family/a', 'maya rose')).toContain(
      'family%2Fa:maya%20rose',
    )
  })

  it('rejects malformed dates and bounds text loaded from storage', () => {
    window.localStorage.setItem(
      personScrapbookStorageKey('family-a', 'maya'),
      JSON.stringify({
        version: 1,
        birthday: '2025-02-30',
        relation: 42,
        favoriteThings: 'x'.repeat(300),
        notes: 'y'.repeat(1_400),
      }),
    )

    const profile = loadPersonScrapbookProfile('family-a', 'maya')
    expect(profile.birthday).toBe('')
    expect(profile.relation).toBe('')
    expect(profile.favoriteThings).toHaveLength(240)
    expect(profile.notes).toHaveLength(1_200)
  })

  it('removes only the requested person profile', () => {
    const profile = {
      birthday: '',
      relation: 'Cousin',
      favoriteThings: '',
      notes: '',
    }
    savePersonScrapbookProfile('family-a', 'maya', profile)
    savePersonScrapbookProfile('family-a', 'lea', profile)

    expect(removePersonScrapbookProfile('family-a', 'maya')).toBe(true)
    expect(loadPersonScrapbookProfile('family-a', 'maya')).toEqual(
      emptyPersonScrapbookProfile(),
    )
    expect(loadPersonScrapbookProfile('family-a', 'lea')).toEqual(profile)
  })

  it('fails safely when local storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable')
    })
    expect(savePersonScrapbookProfile('family-a', 'maya', {
      birthday: '',
      relation: 'Friend',
      favoriteThings: '',
      notes: '',
    })).toBe(false)

    vi.restoreAllMocks()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable')
    })
    expect(loadPersonScrapbookProfile('family-a', 'maya')).toEqual(
      emptyPersonScrapbookProfile(),
    )
  })
})
