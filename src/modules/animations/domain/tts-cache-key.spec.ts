import { ttsCacheKey } from './tts-cache-key';

describe('ttsCacheKey (TDD §5.3)', () => {
  it('é determinístico para a mesma entrada', () => {
    const a = ttsCacheKey({ text: 'Aproveite as ofertas!', voiceId: 'v1' });
    const b = ttsCacheKey({ text: 'Aproveite as ofertas!', voiceId: 'v1' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('normaliza espaços mas preserva case (entonação)', () => {
    const base = ttsCacheKey({ text: 'Oferta   imperdível ', voiceId: 'v1' });
    expect(ttsCacheKey({ text: ' Oferta imperdível', voiceId: 'v1' })).toBe(base);
    expect(ttsCacheKey({ text: 'OFERTA IMPERDÍVEL', voiceId: 'v1' })).not.toBe(base);
  });

  it('muda com voiceId e settings', () => {
    const a = ttsCacheKey({ text: 'x', voiceId: 'v1' });
    expect(ttsCacheKey({ text: 'x', voiceId: 'v2' })).not.toBe(a);
    expect(ttsCacheKey({ text: 'x', voiceId: 'v1', settings: { stability: 0.9 } })).not.toBe(a);
  });

  it('settings com chaves em ordem diferente geram a mesma chave (canônico)', () => {
    const a = ttsCacheKey({ text: 'x', voiceId: 'v1', settings: { a: 1, b: 2 } });
    const b = ttsCacheKey({ text: 'x', voiceId: 'v1', settings: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });
});
