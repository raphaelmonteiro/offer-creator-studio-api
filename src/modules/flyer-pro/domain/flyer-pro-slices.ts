/** As cinco fatias do encarte, na ordem em que o servidor as confere (A-4); o conteúdo de cada uma é opaco. */
export const FLYER_PRO_SLICE_KEYS = [
  'frame',
  'structure',
  'card',
  'assembly',
  'exportPrefs',
] as const;

export type FlyerProSliceKey = (typeof FLYER_PRO_SLICE_KEYS)[number];

/** O tamanho do valor como o banco o guarda: bytes do JSON (acento conta 2), não caracteres. */
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
