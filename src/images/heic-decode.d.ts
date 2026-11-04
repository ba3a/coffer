// heic-decode ships without type declarations; jsconfig.json maps the package to this file.

/**
 * Decodes the first picture of a HEIC file into raw RGBA pixels.
 * The rotation and mirroring stored in the file are applied.
 */
export default function decode(input: {
  buffer: Uint8Array;
}): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
