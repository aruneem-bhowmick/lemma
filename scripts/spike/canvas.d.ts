/**
 * Minimal ambient type declaration for the optional `canvas` package.
 * Canvas is an optional dependency used only for PDF rasterisation in
 * render-test.ts.  The actual package may or may not be installed on a
 * given machine.  This file provides just enough type information for
 * TypeScript to compile without error; the real package ships full types
 * when installed.
 */
declare module 'canvas' {
  /** Creates a Node.js canvas element with the given pixel dimensions. */
  export function createCanvas(
    width: number,
    height: number,
  ): {
    getContext(type: '2d'): CanvasRenderingContext2D;
    /** Encodes the canvas contents to a buffer using the given MIME type. */
    toBuffer(mimeType: string): Buffer;
  };
}
