/** Development-only visual fixture. Not imported by the app or production build.
 * All members, codes and requests are fabricated; no account is authenticated. */
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { FamilySyncPanel } from '../../features/profile/family-sync/FamilySyncPanel'
import { AppearanceSettings } from '../../features/profile/AppearanceSettings'
import { ProfilePreferences } from '../../features/profile/ProfilePreferences'
import type { FamilySyncAdapter, FamilySyncSnapshot } from '../../features/profile/family-sync/types'
import { setAppTheme, type AppTheme } from '../../theme/AppTheme'
import '../../index.css'
import '../../App.css'
import '../../features/FeaturePages.css'
import '../../theme/AppTheme.css'
import './FamilyScreenQA.css'

setAppTheme('plum')

function fixtureAdapter(failure: boolean, count: number, owner: boolean): FamilySyncAdapter {
  let revision = 1
  const code = () => `BUB-AAAA-BBBB-CCCC-DDDD-EEEE-${String(revision).padStart(4, '0')}`
  const pause = () => new Promise<void>((resolve) => window.setTimeout(resolve, 550))
  return {
    async loadSnapshot(): Promise<FamilySyncSnapshot> {
      await pause()
      return {
        kind: 'connected',
        person: { id: 'qa-self', displayName: 'Alex Morgan', email: 'alex@example.invalid' },
        circle: { id: 'qa-family', name: 'Our wonderfully long family name', role: owner ? 'owner' : 'member', memberCount: count, shareCode: code() },
        pendingRequests: [],
        members: Array.from({ length: count }, (_, index) => ({
          id: index === 0 ? 'qa-self' : `qa-member-${index}`,
          displayName: index === 0 ? 'Alex Morgan' : index === 1 ? 'Noor Alexandra Verylongfamilyname' : `Family member ${index + 1}`,
          avatarUrl: index === 1 ? '/qa-missing-portrait.png' : null,
          role: (index === 0 && owner) || (index === 1 && !owner) ? 'owner' : 'member',
          isCurrentUser: index === 0,
        })),
      }
    },
    async createCircle() { await pause() },
    async requestCircleJoin() { await pause() },
    async decideJoinRequest() { await pause() },
    async rotateFamilyCode() {
      await pause()
      if (failure) throw new Error('Network request failed')
      revision += 1
      return code()
    },
  }
}

export function FamilyScreenQA() {
  const [failure, setFailure] = useState(false)
  const [count, setCount] = useState(2)
  const [owner, setOwner] = useState(true)
  const adapter = useMemo(() => fixtureAdapter(failure, count, owner), [failure, count, owner])
  return <>
    <aside className="qa-controls" aria-label="Isolated test controls">
      <strong>QA fixture · no real people or codes</strong>
      <label>Theme <select defaultValue="plum" onChange={(event) => setAppTheme(event.target.value as AppTheme)}>
        <option value="plum">Plum</option><option value="forest">Forest</option><option value="midnight">Midnight</option>
      </select></label>
      <label>Text <select defaultValue="16" onChange={(event) => { document.documentElement.style.fontSize = `${event.target.value}px` }}>
        <option value="16">Standard</option><option value="24">150%</option><option value="32">200%</option>
      </select></label>
      <label>Members <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
        <option value="2">2</option><option value="25">25</option>
      </select></label>
      <label><input type="checkbox" checked={failure} onChange={(event) => setFailure(event.target.checked)} />Fail rotation</label>
      <label><input type="checkbox" checked={owner} onChange={(event) => setOwner(event.target.checked)} />Owner</label>
    </aside>
    <MemoryRouter>
      <div className="app-viewport app-viewport--native qa-viewport" data-app-shell="native">
        <main className="app-content">
          <section className="ks-feature profile-page" aria-label="Family screen test">
            <h1>Family group</h1>
            <FamilySyncPanel key={`${count}:${owner}:${failure}`} adapter={adapter} copyCode={async () => undefined} shareCode={async () => 'copied'} />
            <AppearanceSettings />
            <ProfilePreferences userId={null} widgetStorageSubject="qa-signed-out" />
          </section>
        </main>
        <div className="app-status-bar-backdrop" aria-hidden="true" />
        <span className="qa-native-clock" aria-hidden="true">9:41</span>
      </div>
    </MemoryRouter>
  </>
}

createRoot(document.getElementById('root')!).render(<FamilyScreenQA />)
