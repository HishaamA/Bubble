import { readImageDimensions, type ImageDimensions } from '../../features/capture/equirectangular'

export const MAX_GENERATED_PANORAMA_BYTES = 36 * 1024 * 1024

/** Checks the decoded artifact, not provider-reported dimensions; never stretches it. */
export async function validateGeneratedPanorama(
  blob: Blob,
  decodeDimensions: (file: File) => Promise<ImageDimensions> = readImageDimensions,
): Promise<ImageDimensions> {
  if (!(blob instanceof Blob) || blob.size === 0 || !blob.type.startsWith('image/')) {
    throw new TypeError('The AI service did not return a non-empty panorama image.')
  }
  if (blob.size > MAX_GENERATED_PANORAMA_BYTES) {
    throw new TypeError('The generated panorama is too large to load safely.')
  }
  const { width, height } = await decodeDimensions(
    new File([blob], 'generated-panorama', { type: blob.type }),
  )
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1024 || height < 512 || width > 8192 || height > 4096 || width !== height * 2
  ) {
    throw new TypeError('The AI service must return a full 2:1 panorama between 1024 × 512 and 8192 × 4096.')
  }
  // Shape is a compatibility gate, not proof of spherical scene geometry or fidelity.
  return { width, height }
}
