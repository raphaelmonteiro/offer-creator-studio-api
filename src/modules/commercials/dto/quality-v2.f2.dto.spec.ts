import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCompositionDto, UpdateOfferDto, UpdateScriptV2Dto } from './quality-v2.dto';

async function errorsOf(dto: object): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true });
  const walk = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((e) => [
      ...Object.keys(e.constraints ?? {}).map((k) => `${prefix}${e.property}.${k}`),
      ...walk(e.children ?? [], `${prefix}${e.property}.`),
    ]);
  return walk(errors);
}

const offer = (n: number) => ({
  id: `of-${n}`,
  name: `Produto ${n}`,
  price: '9,90',
  originalPrice: '12,90',
  badge: 'OFERTA',
  imageUrl: `/uploads/p${n}.png`,
});

/** Forma dos DTOs do F2/F1 (D13: forma → 400 pelo pipe; regra → 422 no service). */
describe('DTOs do F2 e da composição format-aware (tarefas 6.6/6.8, bugs A/B)', () => {
  const scene = { sceneType: 'talk_tile', dialogue: 'Oi!', durationS: 4, productRef: null };

  it('PATCH script: ofertas (até 6) com preço anterior/badge, preset e legendas; 12 produtos na forma (F1)', async () => {
    const ok = plainToInstance(UpdateScriptV2Dto, {
      expectedRevision: 1,
      scenes: [scene],
      offers: [1, 2, 3].map(offer),
      products: Array.from({ length: 12 }, (_, i) => offer(i)),
      layoutPreset: 'character_bottom',
      captions: false,
    });
    expect(await errorsOf(ok)).toEqual([]);
    const bad = plainToInstance(UpdateScriptV2Dto, {
      expectedRevision: 1,
      scenes: [scene],
      offers: Array.from({ length: 7 }, (_, i) => offer(i)),
      layoutPreset: 'diagonal',
      captions: 'sim',
    });
    expect((await errorsOf(bad)).sort()).toEqual(
      ['captions.isBoolean', 'layoutPreset.isIn', 'offers.arrayMaxSize'].sort(),
    );
    const badge = plainToInstance(UpdateScriptV2Dto, {
      expectedRevision: 1,
      scenes: [scene],
      offers: [{ ...offer(1), badge: 'X'.repeat(25) }],
    });
    expect(await errorsOf(badge)).toEqual(['offers.0.badge.isLength']);
  });

  it('PATCH composition: janela/cor (F1) e preset/ofertas/ordem (F2) na forma; foto fora de /uploads → 400', async () => {
    const ok = plainToInstance(UpdateCompositionDto, {
      expectedRevision: 2,
      window: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      talkBackgroundColor: '#ABCDEF',
      layoutPreset: 'character_right',
      offers: [
        { id: 'of-1', imageUrl: '/uploads/x.png', badge: null, unit: 'kg', originalPrice: null },
      ],
      offerOrder: ['of-2', 'of-1', 'of-3'],
    });
    expect(await errorsOf(ok)).toEqual([]);
    const bad = plainToInstance(UpdateCompositionDto, {
      expectedRevision: 2,
      window: { x: 2, y: 0, w: 0.3, h: 0.4 },
      talkBackgroundColor: 'azul',
      offers: [{ id: 'of-1', imageUrl: 'https://evil.example/x.png' }],
    });
    expect((await errorsOf(bad)).sort()).toEqual(
      ['offers.0.imageUrl.matches', 'talkBackgroundColor.matches', 'window.x.max'].sort(),
    );
  });

  it('PATCH offers/:offerId: campos opcionais, fala confirmada e dryRun; revisão obrigatória', async () => {
    expect(
      await errorsOf(
        plainToInstance(UpdateOfferDto, {
          expectedRevision: 1,
          price: '6,49',
          dialogue: 'Óleo por seis e quarenta e nove!',
          dryRun: true,
        }),
      ),
    ).toEqual([]);
    expect((await errorsOf(plainToInstance(UpdateOfferDto, { price: '' }))).sort()).toEqual(
      ['expectedRevision.isInt', 'expectedRevision.min', 'price.isLength'].sort(),
    );
  });
});
