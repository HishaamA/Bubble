import { createClient } from '@supabase/supabase-js'
import { appEnvironment } from './env'

export const supabase = appEnvironment.supabase
  ? createClient(appEnvironment.supabase.url, appEnvironment.supabase.publishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null
