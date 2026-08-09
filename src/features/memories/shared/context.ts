import { createContext, type PropsWithChildren } from 'react'
import type {
  MomentChangeNotifier,
  MomentObjectUrlManager,
  MomentStore,
  PanoramaMoment,
  SavePanoramaMomentInput,
  StoredPanoramaMoment,
} from './types'

export type SharedMomentsContextValue = {
  loading: boolean
  error: Error | null
  moments: PanoramaMoment[]
  saveMoment(input: SavePanoramaMomentInput): Promise<StoredPanoramaMoment>
  removeMoments(ids: readonly string[]): Promise<void>
  refresh(): Promise<void>
}

export type SharedMomentsProviderProps = PropsWithChildren<{
  store?: MomentStore
  cacheNamespace?: string
  objectUrls?: MomentObjectUrlManager
  notifierFactory?: () => MomentChangeNotifier
}>

export const SharedMomentsContext =
  createContext<SharedMomentsContextValue | null>(null)
