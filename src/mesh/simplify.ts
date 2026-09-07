export interface SimplifyResult {
  newBlobId?: string;
  byteSize?: number;
  trianglesBefore: number;
  trianglesAfter: number;
}

/**
 * Reads the triangle count from a binary STL header in O(1) time.
 * Falls back to ASCII scan or null if unrecognized.
 */
export function getStlTriangleCount(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 84) return null;
  const view = new DataView(buffer);
  const numFaces = view.getUint32(80, true);

  // Exact binary STL check: 80-byte header + 4-byte count + 50 bytes per face
  if (84 + numFaces * 50 === buffer.byteLength) {
    return numFaces;
  }

  // Common real-world variation: binary STL with slight trailing padding
  if (
    numFaces > 0 &&
    numFaces < 50_000_000 &&
    Math.abs(84 + numFaces * 50 - buffer.byteLength) < 1000
  ) {
    return numFaces;
  }

  // Fallback for ASCII STL files
  try {
    const textSample = new TextDecoder().decode(
      buffer.slice(0, Math.min(buffer.byteLength, 1024)),
    );
    if (textSample.trim().startsWith("solid")) {
      const fullText = new TextDecoder().decode(buffer);
      const matches = fullText.match(/endfacet/g);
      return matches ? matches.length : null;
    }
  } catch {}

  return null;
}
