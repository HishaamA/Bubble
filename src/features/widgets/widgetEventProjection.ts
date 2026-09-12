import type { FamilyEventRecord } from '../events/eventService'
import { decodePlanDetails, type PlanTask } from '../events/planDetails'
import type { WidgetEvent } from './widgetSnapshot'

type WidgetEventProjectionInput = {
  remoteEvents: readonly FamilyEventRecord[]
  localEvents: readonly WidgetEvent[]
  taskDefinitions: Readonly<Record<string, readonly PlanTask[]>>
  checklist: Readonly<Record<string, readonly string[]>>
  completedPlanIds: ReadonlySet<string>
}

/** Projects server plans and unsynced edits into the widget's read-only model. */
export function projectWidgetEvents({
  remoteEvents,
  localEvents,
  taskDefinitions,
  checklist,
  completedPlanIds,
}: WidgetEventProjectionInput): WidgetEvent[] {
  const eventsById = new Map<string, WidgetEvent>()
  for (const event of remoteEvents) {
    if (completedPlanIds.has(event.id)) continue
    eventsById.set(event.id, {
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
      location: event.location,
      tasks: taskDefinitions[event.id] ?? decodePlanDetails(event.details)?.tasks ?? [],
      completedTaskIds: checklist[event.id] ?? [],
    })
  }
  // Pending local edits win by ID without rearranging the server's plan order.
  for (const event of localEvents) {
    if (completedPlanIds.has(event.id)) continue
    eventsById.set(event.id, {
      ...event,
      tasks: taskDefinitions[event.id] ?? event.tasks,
      completedTaskIds: checklist[event.id] ?? [],
    })
  }
  return [...eventsById.values()]
}
