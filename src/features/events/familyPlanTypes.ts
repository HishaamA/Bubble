import type { ReminderEvent } from './eventReminders'
import type { PlanCategory, PlanDoodleName, PlanTask } from './planDetails'

export type FamilyEvent = ReminderEvent & {
  date: string
  time: string
  location: string
  category: PlanCategory
  doodle?: PlanDoodleName
  tasks?: PlanTask[]
  demoPresentation?: DemoPlanPresentation
}

export type DemoPlanPresentation = {
  attendees: Array<{ name: string; initials: string; avatar?: string }>
  additionalAttendees: number
  checklist: Array<PlanTask & { initiallyDone: boolean }>
  doodle: PlanDoodleName
  timeStyle: 'time-location' | 'weekday-time' | 'next-weekend'
}

export type PlanChecklistProgress = Record<string, string[]>
export type PlanTaskDefinitions = Record<string, PlanTask[]>
