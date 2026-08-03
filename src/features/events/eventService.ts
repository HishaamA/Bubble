import {
  getClerkSupabaseIdentity,
  getSupabaseClient,
} from '../../lib/supabase'
import { bootstrapCurrentClerkProfile } from '../../services/persistence'

export type CreateFamilyEventInput = {
  title: string
  startsAt: string
  location: string
  details?: string
}

export type CreateFamilyEventResult = {
  id: string
  synced: boolean
}

export type FamilyEventRecord = {
  id: string
  title: string
  startsAt: string
  location: string
  details: string | null
}

type FamilyEventRow = {
  id?: unknown
  title?: unknown
  starts_at?: unknown
  location?: unknown
  details?: unknown
}

type NormalizedFamilyEventInput = {
  title: string
  startsAt: Date
  location: string
  details: string | null
}

function localEventId() {
  return `family-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function normalizeFamilyEventInput(
  input: CreateFamilyEventInput,
): NormalizedFamilyEventInput {
  const title = input.title.trim()
  const location = input.location.trim()
  const details = input.details?.trim() || null
  const startsAt = new Date(input.startsAt)

  if (!title || title.length > 120) {
    throw new Error('Add an event title of 120 characters or fewer.')
  }
  if (location.length > 240) {
    throw new Error('Keep the event location to 240 characters or fewer.')
  }
  if (details && details.length > 2000) {
    throw new Error('Keep the event details to 2,000 characters or fewer.')
  }
  if (Number.isNaN(startsAt.getTime())) {
    throw new Error('Choose a valid date and time for the event.')
  }
  if (startsAt.getTime() <= Date.now()) {
    throw new Error('Choose a date and time in the future.')
  }

  return { title, startsAt, location, details }
}

async function currentCircleId() {
  const client = getSupabaseClient()
  if (!client || !getClerkSupabaseIdentity()) return null
  const { userId } = await bootstrapCurrentClerkProfile()

  const { data, error } = await client
    .from('circle_members')
    .select('circle_id')
    .eq('user_id', userId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return typeof data?.circle_id === 'string' ? data.circle_id : null
}

function toFamilyEventRecord(row: FamilyEventRow): FamilyEventRecord | null {
  if (
    typeof row.id !== 'string' ||
    !isUuid(row.id) ||
    typeof row.title !== 'string' ||
    typeof row.starts_at !== 'string'
  ) {
    return null
  }

  const startsAt = new Date(row.starts_at)
  if (Number.isNaN(startsAt.getTime())) return null

  return {
    id: row.id,
    title: row.title,
    startsAt: startsAt.toISOString(),
    location:
      typeof row.location === 'string' && row.location.trim()
        ? row.location.trim()
        : 'Location to be decided',
    details: typeof row.details === 'string' ? row.details : null,
  }
}

export async function createFamilyEvent(
  input: CreateFamilyEventInput,
): Promise<CreateFamilyEventResult> {
  const normalized = normalizeFamilyEventInput(input)
  const client = getSupabaseClient()
  if (!client) return { id: localEventId(), synced: false }
  const circleId = await currentCircleId()
  if (!circleId) return { id: localEventId(), synced: false }

  const { data, error } = await client.rpc('create_family_event', {
    p_circle_id: circleId,
    p_title: normalized.title,
    p_starts_at: normalized.startsAt.toISOString(),
    p_location: normalized.location || null,
    p_details: normalized.details,
    p_remind_before: null,
  })
  if (error) throw error
  if (typeof data !== 'string' || !isUuid(data)) {
    throw new Error('The family event could not be saved securely.')
  }
  return { id: data, synced: true }
}

export async function fetchFamilyEvents(): Promise<FamilyEventRecord[]> {
  const client = getSupabaseClient()
  if (!client) return []
  const circleId = await currentCircleId()
  if (!circleId) return []

  const { data, error } = await client
    .from('events')
    .select('id,title,starts_at,location,details')
    .eq('circle_id', circleId)
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(100)
  if (error) throw error

  return ((data ?? []) as FamilyEventRow[])
    .map(toFamilyEventRecord)
    .filter((event): event is FamilyEventRecord => event !== null)
}

export async function subscribeToFamilyEvents(onChange: () => void) {
  const client = getSupabaseClient()
  if (!client) return () => undefined
  const circleId = await currentCircleId()
  if (!circleId) return () => undefined

  const channel = client
    .channel(`family-events:${circleId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'events',
        filter: `circle_id=eq.${circleId}`,
      },
      onChange,
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}

export async function syncEventReminder(eventId: string, enabled: boolean) {
  const client = getSupabaseClient()
  if (!client || !isUuid(eventId)) return false
  const { error } = enabled
    ? await client.rpc('set_event_reminder', {
        p_event_id: eventId,
        p_remind_before: '1 hour',
      })
    : await client.rpc('cancel_event_reminder', {
        p_event_id: eventId,
      })
  if (error) throw error
  return true
}
