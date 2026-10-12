import {
  RenderRequirementCheck,
  renderMissingFor,
  summarizeRenderPreflight,
} from './render-preflight';

const at = '2026-10-12T00:00:00.000Z';
const ok = (id: RenderRequirementCheck['id'], version: string = id): RenderRequirementCheck => ({
  id,
  ok: true,
  version,
});
const missing = (id: RenderRequirementCheck['id']): RenderRequirementCheck => ({
  id,
  ok: false,
  version: null,
  detail: `${id}: não encontrado`,
});

/** Spec video-composition-render — "Preflight por formato". */
describe('preflight de render por formato', () => {
  it('compositor de vídeo ausente → os formatos novos e o de cenas ficam indisponíveis', () => {
    const p = summarizeRenderPreflight(
      [missing('ffmpeg'), ok('ffprobe'), ok('fonts'), ok('browser')],
      at,
    );
    expect(p.formats.talking_art).toEqual({ available: false, missing: ['ffmpeg'] });
    expect(p.formats.offer_carousel).toEqual({ available: false, missing: ['ffmpeg'] });
    expect(p.formats.scenes).toEqual({ available: false, missing: ['ffmpeg'] });
    expect(p.checkedAt).toBe(at);
  });

  it('navegador ausente → só "ofertas em sequência" fica indisponível', () => {
    const p = summarizeRenderPreflight(
      [ok('ffmpeg', '6.1.2'), ok('ffprobe', '6.1.2'), ok('fonts'), missing('browser')],
      at,
    );
    expect(p.formats.talking_art).toEqual({ available: true, missing: [] });
    expect(p.formats.scenes).toEqual({ available: true, missing: [] });
    expect(p.formats.offer_carousel).toEqual({ available: false, missing: ['browser'] });
    expect(p.versions).toEqual({ ffmpeg: '6.1.2', ffprobe: '6.1.2', fonts: 'fonts' });
  });

  it('fonte ausente → formatos marcados com "fonts"', () => {
    const p = summarizeRenderPreflight([ok('ffmpeg'), ok('ffprobe'), missing('fonts')], at);
    expect(p.formats.talking_art.missing).toEqual(['fonts']);
    expect(p.formats.offer_carousel.missing).toEqual(['fonts', 'browser']); // browser nem checado
    // o motivo (ex.: nome da fonte) acompanha o requisito que falhou
    expect(p.details).toEqual({ fonts: 'fonts: não encontrado' });
  });

  it('tudo presente → todos disponíveis', () => {
    const p = summarizeRenderPreflight(
      [ok('ffmpeg'), ok('ffprobe'), ok('fonts'), ok('browser')],
      at,
    );
    expect(Object.values(p.formats).every((f) => f.available)).toBe(true);
  });

  it('renderMissingFor: preflight desconhecido devolve null; conhecido devolve a lista', () => {
    expect(renderMissingFor('talking_art', null)).toBeNull();
    expect(renderMissingFor('talking_art', undefined)).toBeNull();
    const p = summarizeRenderPreflight([ok('ffmpeg'), ok('ffprobe'), ok('fonts')], at);
    expect(renderMissingFor('talking_art', p)).toEqual([]);
    expect(renderMissingFor('offer_carousel', p)).toEqual(['browser']);
  });
});
