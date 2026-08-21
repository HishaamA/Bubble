const legacyPlanPrefix = 'kinsphere-plan-category:v1:'
const planPrefix = 'kinsphere-plan:v2:'

const maxDetailsLength = 2_000
const maxTasks = 12
const maxTaskIdLength = 96
const maxTaskLabelLength = 80

const planCategories = [
  'travel',
  'graduation',
  'wedding',
  'anniversary',
  'appointment',
  'other',
] as const

const planDoodles = ['heart', 'star', 'sun', 'fish'] as const

export type PlanCategory = (typeof planCategories)[number]
export type PlanDoodleName = (typeof planDoodles)[number]
export type PlanTask = {
  id: string
  label: string
}

export type PlanDetails = {
  category: PlanCategory
  doodle?: PlanDoodleName
  tasks: PlanTask[]
}

type PlanDetailsInput = {
  category: PlanCategory
  doodle?: PlanDoodleName
  tasks: readonly PlanTask[]
}

/**
 * Reads both the original category-only value and the structured plan format.
 * Invalid or oversized values are ignored rather than leaking malformed shared
 * data into the Journal UI.
 */
export function decodePlanDetails(
  details: string | null | undefined,
): PlanDetails | null {
  if (typeof details !== 'string') return null
  const normalized = details.trim()
  if (!normalized || normalized.length > maxDetailsLength) return null

  if (normalized.startsWith(legacyPlanPrefix)) {
    const category = parsePlanCategory(
      normalized.slice(legacyPlanPrefix.length),
    )
    return category ? { category, tasks: [] } : null
  }

  if (!normalized.startsWith(planPrefix)) return null

  let payload: unknown
  try {
    payload = JSON.parse(normalized.slice(planPrefix.length))
  } catch {
    return null
  }
  if (!isRecord(payload)) return null

  const category = parsePlanCategory(payload.category)
  if (!category) return null

  const doodle = payload.doodle === undefined
    ? undefined
    : parsePlanDoodle(payload.doodle)
  if (payload.doodle !== undefined && !doodle) return null

  const tasks = decodeTasks(payload.tasks)
  if (!tasks) return null

  return doodle
    ? { category, doodle, tasks }
    : { category, tasks }
}

/** Encodes a plan while enforcing the database's 2,000-character limit. */
export function encodePlanDetails(input: PlanDetailsInput) {
  const category = parsePlanCategory(input.category)
  if (!category) throw new Error('Choose a valid family plan category.')

  const doodle = input.doodle === undefined
    ? undefined
    : parsePlanDoodle(input.doodle)
  if (input.doodle !== undefined && !doodle) {
    throw new Error('Choose a valid family plan doodle.')
  }

  const tasks = normalizeTasks(input.tasks)
  const payload: PlanDetails = doodle
    ? { category, doodle, tasks }
    : { category, tasks }
  const encoded = `${planPrefix}${JSON.stringify(payload)}`
  if (encoded.length > maxDetailsLength) {
    throw new Error('Keep the family plan details to 2,000 characters or fewer.')
  }
  return encoded
}

function decodeTasks(value: unknown): PlanTask[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  try {
    return normalizeTasks(value)
  } catch {
    return null
  }
}

function normalizeTasks(value: readonly unknown[]): PlanTask[] {
  if (value.length > maxTasks) {
    throw new Error(`A family plan can have up to ${maxTasks} tasks.`)
  }

  const ids = new Set<string>()
  return value.map((task) => {
    if (!isRecord(task)) throw new Error('Every family plan task must be valid.')
    const id = normalizeBoundedString(task.id, maxTaskIdLength)
    const label = normalizeBoundedString(task.label, maxTaskLabelLength)
    if (!id || !label || ids.has(id)) {
      throw new Error('Every family plan task must have a unique id and label.')
    }
    ids.add(id)
    return { id, label }
  })
}

function normalizeBoundedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= maxLength ? normalized : null
}

function parsePlanCategory(value: unknown): PlanCategory | null {
  return typeof value === 'string'
    && (planCategories as readonly string[]).includes(value)
    ? value as PlanCategory
    : null
}

function parsePlanDoodle(value: unknown): PlanDoodleName | null {
  return typeof value === 'string'
    && (planDoodles as readonly string[]).includes(value)
    ? value as PlanDoodleName
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
