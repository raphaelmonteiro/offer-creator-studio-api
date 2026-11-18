import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { FLYER_PRO_SLICE_KEYS, jsonBytes } from './flyer-pro-slices';

describe('flyer-pro-slices', () => {
  it('lista as cinco fatias na ordem em que o servidor as confere', () => {
    expect([...FLYER_PRO_SLICE_KEYS]).toEqual([
      'frame',
      'structure',
      'card',
      'assembly',
      'exportPrefs',
    ]);
  });

  describe('jsonBytes', () => {
    it('mede bytes do JSON, não caracteres: o acento conta dois', () => {
      expect(jsonBytes({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
      expect(jsonBytes({ a: 'é' })).toBe(jsonBytes({ a: 'e' }) + 1);
    });

    it('mede o JSON de qualquer valor', () => {
      expect(jsonBytes({})).toBe(2);
      expect(jsonBytes([1, 2])).toBe(5);
      expect(jsonBytes('ab')).toBe(4);
    });
  });

  it('os limites usam 1 KB = 1 024 bytes', () => {
    expect(FLYER_PRO_LIMITS.sliceMaxBytes).toBe(256 * 1024);
    expect(FLYER_PRO_LIMITS.layoutSnapshotMaxBytes).toBe(128 * 1024);
    expect(FLYER_PRO_LIMITS.patchMaxBytes).toBe(2 * 1024 * 1024);
    expect(FLYER_PRO_LIMITS.uiMaxBytes).toBe(16 * 1024);
    expect(FLYER_PRO_LIMITS.importedMaxBytes).toBe(2 * 1024);
    expect(FLYER_PRO_LIMITS.itemMax).toBe(500);
  });
});
