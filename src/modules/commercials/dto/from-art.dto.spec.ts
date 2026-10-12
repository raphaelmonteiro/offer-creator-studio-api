import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ArtOffersQueryDto,
  CreateProjectFromArtDto,
  KitSuggestQueryDto,
  ListProjectsQueryDto,
  SetLogoBoxDto,
} from './from-art.dto';

const ART_ID = '6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f';
const SOURCE_ID = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
const KIT_ID = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';

/** Erros planos `propriedade.constraint` (nested com o caminho) — todos viram 400 no pipe global. */
async function errorsOf<T extends object>(
  cls: new () => T,
  input: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, input), { whitelist: true });
  const flatten = (prefix: string, list: typeof errors): string[] =>
    list.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}).map((k) => `${prefix}${e.property}.${k}`),
      ...flatten(`${prefix}${e.property}.`, e.children ?? []),
    ]);
  return flatten('', errors);
}

const offers = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `offer-${i + 1}` }));

const base = {
  artAssetId: ART_ID,
  sourceKind: 'v2_document',
  sourceId: SOURCE_ID,
  format: 'talking_art',
};

describe('CreateProjectFromArtDto — forma do POST /commercials/projects/from-art (400 pelo pipe)', () => {
  it('mínimo válido: arte, origem e formato (pageIndex, tier, canal, kit e ofertas opcionais)', async () => {
    expect(await errorsOf(CreateProjectFromArtDto, base)).toEqual([]);
    expect(
      await errorsOf(CreateProjectFromArtDto, {
        ...base,
        pageIndex: 2,
        tier: 'premium',
        channel: 'whatsapp',
        kitId: KIT_ID,
        logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        title: 'Vídeo da semana',
        briefing: 'Apresentar as ofertas da semana',
        targetDurationS: 12,
      }),
    ).toEqual([]);
  });

  it('artAssetId/sourceId precisam ser uuid; sourceKind e format são enums fechados', async () => {
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, artAssetId: 'art-1' })).toContain(
      'artAssetId.isUuid',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, sourceId: '42' })).toContain(
      'sourceId.isUuid',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, sourceKind: 'pdf' })).toContain(
      'sourceKind.isIn',
    );
    // O F3 (scenes) não nasce de arte
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, format: 'scenes' })).toContain(
      'format.isIn',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, tier: 'ultra' })).toContain(
      'tier.isIn',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, channel: 'tiktok' })).toContain(
      'channel.isIn',
    );
  });

  it('pageIndex é inteiro ≥ 0; targetDurationS entre 6 e 60', async () => {
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, pageIndex: -1 })).toContain(
      'pageIndex.min',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, pageIndex: 1.5 })).toContain(
      'pageIndex.isInt',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, targetDurationS: 61 })).toContain(
      'targetDurationS.max',
    );
  });

  it('offer_carousel exige de 3 a 6 ofertas: 2 e 7 → 400; 3 e 6 passam', async () => {
    const carousel = { ...base, format: 'offer_carousel' };
    expect(await errorsOf(CreateProjectFromArtDto, { ...carousel, offers: offers(2) })).toContain(
      'offers.offersBoundsForFormat',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...carousel, offers: offers(7) })).toContain(
      'offers.offersBoundsForFormat',
    );
    expect(await errorsOf(CreateProjectFromArtDto, carousel)).toContain(
      'offers.offersBoundsForFormat',
    );
    expect(await errorsOf(CreateProjectFromArtDto, { ...carousel, offers: offers(3) })).toEqual([]);
    expect(await errorsOf(CreateProjectFromArtDto, { ...carousel, offers: offers(6) })).toEqual([]);
  });

  it('talking_art aceita até 3 ofertas citadas, opcionais: 4 → 400', async () => {
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, offers: offers(3) })).toEqual([]);
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, offers: [] })).toEqual([]);
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, offers: offers(4) })).toContain(
      'offers.offersBoundsForFormat',
    );
  });

  it('oferta da seleção: id obrigatório; imageUrl só em /uploads/* (anti-SSRF)', async () => {
    expect(
      await errorsOf(CreateProjectFromArtDto, {
        ...base,
        offers: [{ imageUrl: '/uploads/x.png' }],
      }),
    ).toContain('offers.0.id.isString');
    expect(
      await errorsOf(CreateProjectFromArtDto, {
        ...base,
        offers: [{ id: 'a', imageUrl: 'https://evil.example/x.png' }],
      }),
    ).toContain('offers.0.imageUrl.matches');
    expect(
      await errorsOf(CreateProjectFromArtDto, {
        ...base,
        offers: [
          { id: 'a', imageUrl: '/uploads/gallery/x.png' },
          { id: 'b', imageUrl: null },
        ],
      }),
    ).toEqual([]);
  });

  it('logoBox é em frações 0..1', async () => {
    expect(
      await errorsOf(CreateProjectFromArtDto, { ...base, logoBox: { x: 0, y: 0, w: 1.2, h: 0.1 } }),
    ).toContain('logoBox.w.max');
    expect(
      await errorsOf(CreateProjectFromArtDto, { ...base, logoBox: { x: 0, y: 0, w: 0.5 } }),
    ).toContain('logoBox.h.isNumber');
  });
});

describe('query DTOs da ponte', () => {
  it('ListProjectsQueryDto: filtro opcional, com kind fechado e id uuid', async () => {
    expect(await errorsOf(ListProjectsQueryDto, {})).toEqual([]);
    expect(
      await errorsOf(ListProjectsQueryDto, { sourceKind: 'social', sourceId: SOURCE_ID }),
    ).toEqual([]);
    expect(await errorsOf(ListProjectsQueryDto, { sourceKind: 'pdf' })).toContain(
      'sourceKind.isIn',
    );
    expect(await errorsOf(ListProjectsQueryDto, { sourceId: 'x' })).toContain('sourceId.isUuid');
  });

  it('KitSuggestQueryDto exige clientId uuid', async () => {
    expect(await errorsOf(KitSuggestQueryDto, {})).toContain('clientId.isUuid');
    expect(await errorsOf(KitSuggestQueryDto, { clientId: SOURCE_ID })).toEqual([]);
  });

  it('ArtOffersQueryDto: pageIndex vem como string da query e vira inteiro ≥ 0', async () => {
    expect(await errorsOf(ArtOffersQueryDto, { pageIndex: '2' })).toEqual([]);
    expect(await errorsOf(ArtOffersQueryDto, { pageIndex: '-1' })).toContain('pageIndex.min');
    expect(await errorsOf(ArtOffersQueryDto, { pageIndex: 'abc' })).toContain('pageIndex.isInt');
  });
});

describe('caixa do logo (D9b, tarefa 4.6) — forma dos DTOs (400 pelo pipe)', () => {
  it('`logoFace` é booleano opcional no from-art', async () => {
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, logoFace: true })).toEqual([]);
    expect(await errorsOf(CreateProjectFromArtDto, { ...base, logoFace: 'sim' })).toContain(
      'logoFace.isBoolean',
    );
  });

  it('PUT .../logo-box: x, y, w, h numéricos em frações 0..1', async () => {
    expect(await errorsOf(SetLogoBoxDto, { x: 0.05, y: 0.86, w: 0.22, h: 0.09 })).toEqual([]);
    expect(await errorsOf(SetLogoBoxDto, { x: 1.2, y: 0.86, w: 0.22, h: 0.09 })).toContain('x.max');
    expect(await errorsOf(SetLogoBoxDto, { x: 0.05, y: -0.1, w: 0.22, h: 0.09 })).toContain(
      'y.min',
    );
    expect(await errorsOf(SetLogoBoxDto, { x: 0.05, y: 0.86, w: 0.22 })).toContain('h.isNumber');
    expect(await errorsOf(SetLogoBoxDto, { x: '0.05', y: 0.86, w: 0.22, h: 0.09 })).toContain(
      'x.isNumber',
    );
  });
});
