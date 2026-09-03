export type AppEnvironment = {
  mode: string
  supabase: { url: string; publishableKey: string } | null
  configurationIssue: string | null
}

type AppEnvironmentSource = {
  VITE_APP_ENV?: string
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_PUBLISHABLE_KEY?: string
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Normalizes an optional build-time value without preserving whitespace. */
function readOptionalValue(value: string | undefined) {
  return value?.trim() || null
}

/**
 * Reads and validates the build-time application configuration.
 * Supabase may use plain HTTP only on a loopback host; every remote endpoint
 * must use HTTPS so authentication tokens are never sent in clear text.
 */
export function readAppEnvironment(
  environment: AppEnvironmentSource = {
    VITE_APP_ENV: import.meta.env.VITE_APP_ENV,
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY:
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  },
): AppEnvironment {
  const mode = readOptionalValue(environment.VITE_APP_ENV) ?? 'development'
  const url = readOptionalValue(environment.VITE_SUPABASE_URL)
  const publishableKey = readOptionalValue(
    environment.VITE_SUPABASE_PUBLISHABLE_KEY,
  )

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
    const secureRemote = parsed.protocol === 'https:'
    const localDevelopment =
      parsed.protocol === 'http:' && LOCAL_HOSTNAMES.has(parsed.hostname)
    if (!secureRemote && !localDevelopment) {
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

/** Immutable configuration snapshot used by runtime services. */
export const appEnvironment = readAppEnvironment()
