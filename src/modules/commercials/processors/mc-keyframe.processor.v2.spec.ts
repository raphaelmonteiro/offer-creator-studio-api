import { DataSource, EntityManager } from 'typeorm';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { assertScenesAspect, McKeyframeProcessor } from './mc-keyframe.processor';

/**
 * Keyframe v2 com referências SELECIONADAS no snapshot: assets do kit por id
 * e a FOTO REAL do produto por `fileUrl` (não é AnimationAsset — buscá-la por
 * id explodia com "invalid input syntax for type uuid", bug pego em uso real).
 */
describe('McKeyframeProcessor — pipeline v2: referências por função e foto do produto', () => {
  const step = {
    id: 'st-kf',
    projectId: 'p1',
    sceneId: 'sc1',
    sceneGeneration: 1,
    type: McStepType.KEYFRAME,
    status: McStepStatus.RUNNING,
    phase: 'preparation',
    attempt: 1,
    projectRevision: 0,
    inputHash: 'h',
    inputSnapshot: {
      baseHash: 'b',
      prompt: 'Rice bag on the shelf, mascot hand close',
      motion: 'picks the bag',
      lang: 'en',
      references: [
        { assetId: 'kit-0', role: 'identity', slot: 0, reason: 'slot 0' },
        {
          assetId: 'product:http://localhost:3001/uploads/gallery/arroz.png',
          fileUrl: 'http://localhost:3001/uploads/gallery/arroz.png',
          role: 'product',
          slot: null,
          reason: 'foto do produto',
        },
        { assetId: 'kit-3', role: 'interaction', slot: 3, reason: 'slot 3' },
      ],
      environment: null,
      aspectRatio: '9:16',
      kitVersion: 1,
      safeArea: 'lower_third',
      productName: 'Arroz Tio João 5kg',
    },
  };
  const scene = {
    id: 'sc1',
    idx: 1,
    generation: 1,
    scriptSceneId: 's2',
    actionPrompt: 'x',
  } as McScene;
  const project = {
    id: 'p1',
    userId: 'u1',
    kitId: 'k1',
    title: 'Feirão',
    aspectRatio: '9:16',
    script: { schemaVersion: 2, environments: [], scenes: [] },
  } as unknown as McProject;
  const kit = {
    id: 'k1',
    canonicalDesc: null,
    referenceAssetIds: ['kit-0', 'kit-3'],
  } as unknown as McCharacterKit;

  let findWhere: unknown[];
  let gemini: { generateImage: jest.Mock };
  let storage: { readUploadsFile: jest.Mock; sceneRelDir: jest.Mock; saveFile: jest.Mock };
  let pipeline: { claimStep: jest.Mock; completeStepAndAdvance: jest.Mock; failStep: jest.Mock };
  let processor: McKeyframeProcessor;

  beforeEach(() => {
    process.env.MC_PIPELINE_PROVIDER = 'real';
    findWhere = [];
    const repo = (entity: unknown) => ({
      findOneBy: jest.fn(() =>
        Promise.resolve(entity === McScene ? scene : entity === McProject ? project : null),
      ),
      findOneByOrFail: jest.fn(() => Promise.resolve(kit)),
      find: jest.fn((opts: { where: unknown }) => {
        findWhere.push(opts.where);
        return Promise.resolve([
          { id: 'kit-0', fileUrl: '/uploads/kit/0.png' },
          { id: 'kit-3', fileUrl: '/uploads/kit/3.png' },
        ]);
      }),
      save: jest.fn((obj: Record<string, unknown>) => Promise.resolve({ id: 'asset-kf', ...obj })),
    });
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => repo(entity)),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb({ getRepository: (entity: unknown) => repo(entity) } as unknown as EntityManager),
      ),
    };
    gemini = { generateImage: jest.fn().mockResolvedValue(Buffer.from('png')) };
    storage = {
      readUploadsFile: jest.fn((url: string) => Promise.resolve(Buffer.from(`file:${url}`))),
      sceneRelDir: jest.fn(() => 'commercials/u1/p1/scenes/1/g1'),
      saveFile: jest.fn().mockResolvedValue('/uploads/commercials/u1/p1/scenes/1/g1/keyframe.png'),
    };
    pipeline = {
      claimStep: jest.fn().mockResolvedValue({ ...step }),
      completeStepAndAdvance: jest.fn().mockResolvedValue(true),
      failStep: jest.fn().mockResolvedValue(undefined),
    };
    processor = new McKeyframeProcessor(
      dataSource as unknown as DataSource,
      pipeline as unknown as McPipelineService,
      gemini as unknown as GeminiImageProvider,
      storage as unknown as McStorageService,
    );
  });

  afterEach(() => {
    delete process.env.MC_PIPELINE_PROVIDER;
  });

  it('carrega kit por id, foto do produto por URL (nunca por id) e envia as 3 na ordem selecionada', async () => {
    await processor.process({ stepId: 'st-kf' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    // o lookup por id NUNCA inclui o "product:<url>"
    const inClause = findWhere[0] as { id: { _value: string[] } };
    expect(inClause.id._value).toEqual(['kit-0', 'kit-3']);
    const call = gemini.generateImage.mock.calls[0][0] as {
      prompt: string;
      referenceImages: Buffer[];
    };
    expect(call.referenceImages.map((b) => b.toString())).toEqual([
      'file:/uploads/kit/0.png',
      'file:http://localhost:3001/uploads/gallery/arroz.png',
      'file:/uploads/kit/3.png',
    ]);
    expect(call.prompt).toMatch(/REAL package of "Arroz Tio João 5kg"/);
    expect(call.prompt).toMatch(/Starting frame: Rice bag on the shelf/);
    // rastreio no asset: referências e idioma efetivamente usados
    expect(pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'st-kf' }),
      expect.objectContaining({ outputAssetId: 'asset-kf', consumeOnSuccess: true }),
    );
  });

  it('foto do produto ilegível no bucket: keyframe segue só com o kit (aviso, não falha)', async () => {
    storage.readUploadsFile.mockImplementation((url: string) =>
      Promise.resolve(url.includes('gallery') ? null : Buffer.from(`file:${url}`)),
    );
    await processor.process({ stepId: 'st-kf' });
    expect(pipeline.failStep).not.toHaveBeenCalled();
    const call = gemini.generateImage.mock.calls[0][0] as { referenceImages: Buffer[] };
    expect(call.referenceImages).toHaveLength(2);
  });

  // Aspecto × formato (video-formatos-personagem, design D12): o executor de
  // cenas só conhece 9:16 · 1:1 · 16:9. Um 4:5 que escape da admissão falha
  // TERMINAL antes de qualquer chamada paga — nunca cai em outro tamanho.
  it('projeto 4:5 (fora do formato scenes): falha terminal aspect_not_supported sem chamar o Gemini nem gravar asset', async () => {
    const original = project.aspectRatio;
    (project as { aspectRatio: string }).aspectRatio = '4:5';
    try {
      await processor.process({ stepId: 'st-kf' });
    } finally {
      (project as { aspectRatio: string }).aspectRatio = original;
    }
    expect(gemini.generateImage).not.toHaveBeenCalled();
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
    expect(pipeline.failStep).toHaveBeenCalledTimes(1);
    const err = pipeline.failStep.mock.calls[0][2] as { code: string; message: string };
    expect(err.code).toBe('aspect_not_supported');
    expect(err.message).toMatch(/"4:5".*formato de cenas/);
  });

  it('assertScenesAspect: aceita os três aspectos do F3 e recusa 4:5/desconhecido', () => {
    expect(assertScenesAspect('9:16')).toBe('9:16');
    expect(assertScenesAspect('1:1')).toBe('1:1');
    expect(assertScenesAspect('16:9')).toBe('16:9');
    expect(() => assertScenesAspect('4:5')).toThrow(/não é suportado pelo formato de cenas/);
    expect(() => assertScenesAspect('4:3')).toThrow(/não é suportado pelo formato de cenas/);
  });
});
