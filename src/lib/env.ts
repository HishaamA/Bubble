export type AppEnvironment = {
  mode: string
  supabase: { url: string; publishableKey: string } | null
  configurationIssue: string | null
}

function readOptionalValue(value: string | undefined) {
  return value?.trim() || null
}

export function readAppEnvironment(): AppEnvironment {
  const mode = readOptionalValue(import.meta.env.VITE_APP_ENV) ?? 'development'
  const url = readOptionalValue(import.meta.env.VITE_SUPABASE_URL)
  const publishableKey = readOptionalValue(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)

  if (!url && !publishableKey) {
    return { mode, supabase: null, configurationIssue: null }
  }

  if (!url || !publishableKey) {
    return {
      mode,
      supabase: null,
      configurationIssue:
        'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be configured together.',
    }
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      throw new Error('Supabase URL must use HTTPS outside local development.')
    }
  } catch (error) {
    return {
      mode,
      supabase: null,
      configurationIssue:
        error instanceof Error ? error.message : 'VITE_SUPABASE_URL is invalid.',
    }
  }

  return {
    mode,
    supabase: { url, publishableKey },
    configurationIssue: null,
  }
}

export const appEnvironment = readAppEnvironment()
