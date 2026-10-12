import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ScriptSceneV2Dto } from './quality-v2.dto';

async function errorsOf(dto: object): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true });
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}).map((k) => `${e.property}.${k}`));
}

/** Forma das cenas v2 (D13: forma → 400 pelo pipe; regra → 422 no service). */
describe('ScriptSceneV2Dto — cena talk_tile sem campos de keyframe (video-formatos-personagem, D6)', () => {
  const talk = {
    sceneType: 'talk_tile',
    dialogue: 'Olá, chegaram as ofertas!',
    durationS: 6,
    productRef: null,
  };

  it('talk_tile aceita actionPrompt vazio ou omitido (gesto opcional) e sem initialFrame', async () => {
    expect(await errorsOf(plainToInstance(ScriptSceneV2Dto, talk))).toEqual([]);
    expect(
      await errorsOf(plainToInstance(ScriptSceneV2Dto, { ...talk, actionPrompt: '' })),
    ).toEqual([]);
    expect(
      await errorsOf(
        plainToInstance(ScriptSceneV2Dto, { ...talk, actionPrompt: 'Acena no início.' }),
      ),
    ).toEqual([]);
  });

  it('talk_tile com gesto curto demais ainda cai na regra de tamanho', async () => {
    expect(
      await errorsOf(plainToInstance(ScriptSceneV2Dto, { ...talk, actionPrompt: 'ok' })),
    ).toEqual(['actionPrompt.isLength']);
  });

  it('presenter continua exigindo a ação (3 a 2000 caracteres)', async () => {
    const presenter = { ...talk, sceneType: 'presenter', initialFrame: 'frente' };
    expect((await errorsOf(plainToInstance(ScriptSceneV2Dto, presenter))).sort()).toEqual([
      'actionPrompt.isLength',
      'actionPrompt.isString',
    ]);
    expect(
      await errorsOf(plainToInstance(ScriptSceneV2Dto, { ...presenter, actionPrompt: 'Acena.' })),
    ).toEqual([]);
  });

  it('tipo de cena fora do enum é recusado na forma (e a ação volta a ser exigida)', async () => {
    const errors = await errorsOf(
      plainToInstance(ScriptSceneV2Dto, { ...talk, sceneType: 'talk' }),
    );
    expect(errors).toContain('sceneType.isIn');
    expect(errors).toContain('actionPrompt.isLength');
  });
});
