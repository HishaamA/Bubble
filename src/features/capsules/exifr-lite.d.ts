declare module 'exifr/dist/lite.esm.mjs' {
  export type ExifrDateMetadata = Record<string, unknown>

  export type ExifrDateParseOptions = {
    tiff: boolean
    ifd1: boolean
    exif: { pick: readonly (string | number)[] }
    gps: boolean
    interop: boolean
    xmp: boolean
    icc: boolean
    iptc: boolean
    jfif: boolean
    makerNote: boolean
    userComment: boolean
    chunked: boolean
  }

  export function parse(
    input: Blob,
    options: ExifrDateParseOptions,
  ): Promise<ExifrDateMetadata | undefined>
}
