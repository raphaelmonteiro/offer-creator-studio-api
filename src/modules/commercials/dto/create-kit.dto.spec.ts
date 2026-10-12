import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateKitDto } from './create-kit.dto';

const MASCOT_ID = '6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f';
const CLIENT_ID = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';

/** Erros planos `propriedade.constraint` — o pipe global devolve 400 para qualquer um deles. */
async function errorsOf(input: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(plainToInstance(CreateKitDto, input), { whitelist: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}).map((k) => `${e.property}.${k}`));
}

describe('CreateKitDto — forma do POST /commercials/kits (D5, erros 400 pelo pipe)', () => {
  it('origem mascote com estilo e mascotId passa', async () => {
    expect(await errorsOf({ source: 'mascot', style: '3d_render', mascotId: MASCOT_ID })).toEqual(
      [],
    );
  });

  it('source é obrigatório e restrito a mascot|logo', async () => {
    expect(await errorsOf({ mascotId: MASCOT_ID })).toContain('source.isIn');
    expect(await errorsOf({ source: 'sticker', mascotId: MASCOT_ID })).toContain('source.isIn');
  });

  it('style é opcional na criação, mas fora do vocabulário é 400', async () => {
    expect(await errorsOf({ source: 'mascot', mascotId: MASCOT_ID })).toEqual([]);
    expect(await errorsOf({ source: 'mascot', style: 'anime', mascotId: MASCOT_ID })).toContain(
      'style.isIn',
    );
  });

  it('origem mascote sem mascotId (ou com id inválido) é 400', async () => {
    expect(await errorsOf({ source: 'mascot', style: 'cartoon_2d' })).toContain('mascotId.isUuid');
    expect(await errorsOf({ source: 'mascot', mascotId: 'mascote-1' })).toContain(
      'mascotId.isUuid',
    );
  });

  it('origem logo não exige mascotId: aceita clientId ou logoMascotId (exclusividade é regra do service)', async () => {
    expect(await errorsOf({ source: 'logo', clientId: CLIENT_ID })).toEqual([]);
    expect(await errorsOf({ source: 'logo', logoMascotId: MASCOT_ID, style: 'realistic' })).toEqual(
      [],
    );
    expect(await errorsOf({ source: 'logo' })).toEqual([]);
  });

  it('origem logo: clientId/logoMascotId precisam ser uuid; rightsConfirmed é booleano', async () => {
    expect(await errorsOf({ source: 'logo', clientId: 'cliente-1' })).toContain('clientId.isUuid');
    expect(await errorsOf({ source: 'logo', logoMascotId: '42' })).toContain('logoMascotId.isUuid');
    expect(
      await errorsOf({ source: 'logo', clientId: CLIENT_ID, rightsConfirmed: 'sim' }),
    ).toContain('rightsConfirmed.isBoolean');
  });

  it('voiceId segue opcional e limitado a 100 caracteres', async () => {
    expect(
      await errorsOf({ source: 'mascot', mascotId: MASCOT_ID, voiceId: 'x'.repeat(101) }),
    ).toContain('voiceId.maxLength');
  });
});
