import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProjectDto } from './create-project.dto';
import { ApproveProductionDto, UpdateScriptV2Dto } from './quality-v2.dto';

const BASE = {
  kitId: '11111111-1111-4111-8111-111111111111',
  title: 'Ofertas',
  briefing: 'Briefing com mais de dez caracteres',
  targetDurationS: 15,
};
const ART = '22222222-2222-4222-8222-222222222222';

async function errorsOf<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

/** Convenção D13: FORMA do DTO → 400 pelo pipe global (aqui, erros do class-validator). */
describe('CreateProjectDto — campos dos formatos novos (tarefa 4.2)', () => {
  it('sem campos novos continua válido (defaults scenes/economico/instagram são do service)', async () => {
    expect(await errorsOf(CreateProjectDto, BASE)).toEqual([]);
  });

  it('talking_art exige backgroundArtAssetId (uuid); scenes não', async () => {
    expect(await errorsOf(CreateProjectDto, { ...BASE, format: 'talking_art' })).toEqual([
      'backgroundArtAssetId',
    ]);
    expect(
      await errorsOf(CreateProjectDto, {
        ...BASE,
        format: 'talking_art',
        backgroundArtAssetId: 'x',
      }),
    ).toEqual(['backgroundArtAssetId']);
    expect(
      await errorsOf(CreateProjectDto, {
        ...BASE,
        format: 'talking_art',
        backgroundArtAssetId: ART,
      }),
    ).toEqual([]);
    expect(await errorsOf(CreateProjectDto, { ...BASE, format: 'scenes' })).toEqual([]);
  });

  it('format/tier/channel fora do enum → erro de forma; dentro → ok', async () => {
    expect(
      await errorsOf(CreateProjectDto, {
        ...BASE,
        format: 'slides',
        tier: 'gold',
        channel: 'tiktok',
      }),
    ).toEqual(expect.arrayContaining(['format', 'tier', 'channel']));
    expect(
      await errorsOf(CreateProjectDto, {
        ...BASE,
        format: 'talking_art',
        backgroundArtAssetId: ART,
        tier: 'premium',
        channel: 'whatsapp',
        aspectRatio: '4:5',
        layoutPreset: 'canto_inferior_direito',
      }),
    ).toEqual([]);
  });

  it('logoBox e sourceArt aninhados: frações 0..1 e origem bem formada', async () => {
    expect(
      await errorsOf(CreateProjectDto, {
        ...BASE,
        logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        sourceArt: { kind: 'v2_document', id: 'doc-1', pageIndex: 2, snapshotHash: 'abc' },
      }),
    ).toEqual([]);
    expect(
      await errorsOf(CreateProjectDto, {
        ...BASE,
        logoBox: { x: 1.2, y: 0.8, w: 0.2, h: 0.1 },
        sourceArt: { kind: 'pdf', id: 'doc-1', pageIndex: -1, snapshotHash: 'abc' },
      }),
    ).toEqual(expect.arrayContaining(['logoBox', 'sourceArt']));
  });
});

describe('UpdateScriptV2Dto / ApproveProductionDto — campos do F1', () => {
  const scene = { sceneType: 'talk_tile', dialogue: 'Olá!', durationS: 5, productRef: null };

  it('janela em frações 0..1, até 3 ofertas citadas, cor #RRGGBB, aceites booleanos', async () => {
    expect(
      await errorsOf(UpdateScriptV2Dto, {
        expectedRevision: 1,
        scenes: [scene],
        narration: 'Olá! Chegaram as ofertas.',
        window: { x: 0.5, y: 0.4, w: 0.4, h: 0.2 },
        logoFace: false,
        citedOfferIds: ['a', 'b'],
        talkBackgroundColor: '#112233',
      }),
    ).toEqual([]);
    expect(
      await errorsOf(UpdateScriptV2Dto, {
        expectedRevision: 1,
        scenes: [scene],
        window: { x: 1.5, y: 0.4, w: 0.4, h: 0.2 },
        citedOfferIds: ['a', 'b', 'c', 'd'],
        talkBackgroundColor: 'azul',
      }),
    ).toEqual(expect.arrayContaining(['window', 'citedOfferIds', 'talkBackgroundColor']));
    expect(
      await errorsOf(ApproveProductionDto, {
        expectedRevision: 1,
        manifestHash: 'abcdefghijklmnopqrst',
        acceptSpeechDuration: true,
      }),
    ).toEqual([]);
    expect(
      await errorsOf(ApproveProductionDto, {
        expectedRevision: 1,
        manifestHash: 'abcdefghijklmnopqrst',
        acceptSpeechDuration: 'sim',
      }),
    ).toEqual(['acceptSpeechDuration']);
  });
});
