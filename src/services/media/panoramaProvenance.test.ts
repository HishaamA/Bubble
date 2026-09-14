import { describe, expect, it } from 'vitest'
import { AI_PANORAMA_DISCLOSURE, copyAiPanoramaProvenance, withAiPanoramaDisclosure, type AiPanoramaProvenance } from './panoramaProvenance'
import { createMemoryMomentStore, preparePanoramaMoment } from '../../features/memories/shared/store'

const provenance: AiPanoramaProvenance = {
  kind: 'ai-reconstruction', provider: 'local', model: 'local-panorama-v1',
  referenceCount: 3, generatedAt: '2026-09-09T12:00:00.000Z',
}

describe('AI panorama provenance', () => {
  it('appends a disclosure exactly once without changing legacy captions', () => {
    const caption = withAiPanoramaDisclosure('Our kitchen', provenance)
    expect(caption).toBe(`Our kitchen\n\n${AI_PANORAMA_DISCLOSURE}`)
    expect(withAiPanoramaDisclosure(caption, provenance)).toBe(caption)
    expect(withAiPanoramaDisclosure(`${caption}\n${AI_PANORAMA_DISCLOSURE}`, provenance)).toBe(caption)
    expect(withAiPanoramaDisclosure('', provenance)).toBe(AI_PANORAMA_DISCLOSURE)
    expect(withAiPanoramaDisclosure('  legacy caption  ')).toBe('  legacy caption  ')
    expect(copyAiPanoramaProvenance()).toBeUndefined()
  })

  it('validates explicit provenance without inferring a provider from disclosure text', () => {
    expect(copyAiPanoramaProvenance(provenance)).toEqual(provenance)
    for (const change of [{ model: '' }, { referenceCount: 0 }, { referenceCount: 2.5 }, { generatedAt: 'invalid' }]) {
      expect(() => copyAiPanoramaProvenance({ ...provenance, ...change })).toThrow('provenance')
    }
    expect(withAiPanoramaDisclosure(AI_PANORAMA_DISCLOSURE)).toBe(AI_PANORAMA_DISCLOSURE)
  })

  it('keeps isolated metadata and disclosure through save, reload and copy', async () => {
    const inputProvenance = { ...provenance }
    const prepared = preparePanoramaMoment({
      id: 'generated', blob: new Blob(['image'], { type: 'image/jpeg' }),
      caption: 'Our kitchen', width: 2048, height: 1024, source: 'manual',
      uploaderDisplayName: 'You', provenance: inputProvenance,
    })
    inputProvenance.model = 'changed outside store'
    const store = createMemoryMomentStore()
    await store.save(prepared)
    prepared.provenance!.model = 'changed after save'
    const [restored] = await store.list()
    expect(restored.provenance).toEqual(provenance)
    expect(restored.caption).toBe(`Our kitchen\n\n${AI_PANORAMA_DISCLOSURE}`)
    restored.provenance!.model = 'changed after read'
    const [again] = await store.list()
    expect(again.provenance).toEqual(provenance)
    expect(preparePanoramaMoment({ ...again, id: 'copy' }).provenance).toEqual(provenance)
    expect(preparePanoramaMoment({ ...again, provenance: undefined }).provenance).toBeUndefined()
  })
})
