/** Explicit generation metadata; never inferred from a room photograph or caption. */
export type AiPanoramaProvenance = {
  kind: 'ai-reconstruction'
  provider: 'local'
  model: string
  referenceCount: number
  generatedAt: string
}

export const AI_PANORAMA_DISCLOSURE = 'AI reconstruction. Includes imagined details.'

/** Copies and validates metadata at persistence boundaries without retaining references. */
export function copyAiPanoramaProvenance(
  provenance?: AiPanoramaProvenance,
): AiPanoramaProvenance | undefined {
  if (!provenance) return undefined
  if (
    provenance.kind !== 'ai-reconstruction' || provenance.provider !== 'local' ||
    typeof provenance.model !== 'string' || !provenance.model.trim() ||
    !Number.isInteger(provenance.referenceCount) || provenance.referenceCount < 1 ||
    typeof provenance.generatedAt !== 'string' || !Number.isFinite(Date.parse(provenance.generatedAt))
  ) {
    throw new TypeError('AI panorama provenance is invalid.')
  }
  return {
    kind: 'ai-reconstruction',
    provider: 'local',
    model: provenance.model.trim(),
    referenceCount: provenance.referenceCount,
    generatedAt: new Date(provenance.generatedAt).toISOString(),
  }
}

/** Keeps disclosure readable through the existing caption-only family backend. */
export function withAiPanoramaDisclosure(
  caption: string | undefined,
  provenance?: AiPanoramaProvenance,
): string {
  if (!provenance) return caption ?? ''
  let text = (caption ?? '').trim()
  while (text.endsWith(AI_PANORAMA_DISCLOSURE)) {
    text = text.slice(0, -AI_PANORAMA_DISCLOSURE.length).trimEnd()
  }
  return text ? `${text}\n\n${AI_PANORAMA_DISCLOSURE}` : AI_PANORAMA_DISCLOSURE
}
