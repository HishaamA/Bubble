import { describe, expect, it } from 'vitest'
import { readAppEnvironment } from './env'

describe('readAppEnvironment', () => {
  it('uses local-only mode when Supabase is not configured', () => {
    expect(readAppEnvironment({})).toEqual({
      mode: 'development',
      supabase: null,
      configurationIssue: null,
    })
  })

  it('requires the URL and key to be configured together', () => {
    expect(
      readAppEnvironment({ VITE_SUPABASE_URL: 'https://example.supabase.co' }),
    ).toMatchObject({
      supabase: null,
      configurationIssue:
        'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be configured together.',
    })
  })

  it.each([
    'https://example.supabase.co',
    'http://localhost:54321',
    'http://127.0.0.1:54321',
    'http://[::1]:54321',
  ])('accepts a secure or loopback Supabase URL: %s', (url) => {
    expect(
      readAppEnvironment({
        VITE_SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: 'public-key',
      }),
    ).toMatchObject({
      supabase: { url, publishableKey: 'public-key' },
      configurationIssue: null,
    })
  })

  it.each(['http://example.com', 'ftp://localhost/database', 'not a url'])(
    'rejects an unsafe or malformed Supabase URL: %s',
    (url) => {
      expect(
        readAppEnvironment({
          VITE_SUPABASE_URL: url,
          VITE_SUPABASE_PUBLISHABLE_KEY: 'public-key',
        }).configurationIssue,
      ).toBeTruthy()
    },
  )
})
