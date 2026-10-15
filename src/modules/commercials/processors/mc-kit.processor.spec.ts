import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, FindOperator } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  GeminiImageProvider,
  withGeminiBilling,
} from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McKitMouthGate, McMouthVerdict } from '../domain/mc-mouth-gate';
import { computeTileCrop, edgeUniformity } from '../domain/mc-tile';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McEvent } from '../entities/mc-event.entity';
import { McKitViewService } from '../services/mc-kit-view.service';
import * as sharp from 'sharp';
import { McKitProcessor, MOCK_REFERENCE_SIZE, mockReferenceFromIdentity } from './mc-kit.processor';

/** `JsonContains` do TypeORM (`@>` no Postgres) avaliado em memória: subconjunto raso. */
function jsonContains(value: unknown, operator: unknown): boolean {
  if (!(operator instanceof FindOperator)) return true;
  const expected = operator.value as Record<string, unknown>;
  const actual = (value ?? {}) as Record<string, unknown>;
  return Object.entries(expected).every(([k, v]) => actual[k] === v);
}

describe('McKitProcessor — geração do kit na fila mc.image (plano §4)', () => {
  // sharp real nos PNGs mock: sob a suíte inteira em paralelo, um teste pode
  // passar dos 5 s padrão do jest (e a execução abandonada vazaria para o
  // teste seguinte) — mesmo teto do spec dos candidatos.
  jest.setTimeout(60_000);
  const originalProvider = process.env.MC_KIT_PROVIDER;
  let tmpDir: string;

  const baseKit = {
    id: 'kit-1',
    userId: 'u1',
    mascotId: 'mascot-1',
    status: McKitStatus.GENERATING,
    canonicalDesc: null as string | null,
    referenceAssetIds: [] as string[],
  };

  let assetSeq: number;
  let kitRepo: { findOneBy: jest.Mock };
  let assetRepo: { save: jest.Mock; findOneBy: jest.Mock; find: jest.Mock };
  let eventRepo: { findOne: jest.Mock };
  /** Assets gravados e eventos anexados neste teste (o "banco" em memória). */
  let savedAssets: Array<Record<string, unknown>>;
  let savedEvents: Array<Record<string, unknown>>;
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    softDelete: jest.Mock;
    save: jest.Mock;
    increment: jest.Mock;
  };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let gemini: { generateImageWithModel: jest.Mock };
  let mascots: { findOne: jest.Mock };
  let config: { get: jest.Mock };
  let view: { resolveIdentityAsset: jest.Mock };
  let env: Record<string, string | undefined>;
  let processor: McKitProcessor;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-kit-proc-'));
    await fs.mkdir(path.join(tmpDir, 'mascots'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'mascots', 'cutout.png'), Buffer.from('png-bytes'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.MC_KIT_PROVIDER; // default = mock
    assetSeq = 0;
    const assets: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    savedAssets = assets;
    savedEvents = events;
    kitRepo = { findOneBy: jest.fn().mockResolvedValue({ ...baseKit }) };
    assetRepo = {
      save: jest.fn((obj: Record<string, unknown>) => {
        const row = { id: `asset-${++assetSeq}`, ...obj };
        assets.push(row);
        return Promise.resolve(row);
      }),
      findOneBy: jest.fn().mockResolvedValue(null),
      // busca da referência já paga (idempotência 2.6): mais recente primeiro
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          [...assets]
            .reverse()
            .filter(
              (a) =>
                a.kind === where.kind &&
                a.userId === where.userId &&
                jsonContains(a.metadata, where.metadata),
            ),
        ),
      ),
    };
    eventRepo = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          [...events]
            .reverse()
            .find(
              (e) =>
                e.refKind === where.refKind &&
                e.refId === where.refId &&
                e.kind === where.kind &&
                jsonContains(e.detail, where.detail),
            ) ?? null,
        ),
      ),
    };
    const testAssetRepo = assetRepo;
    manager = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
      // a referência nasce na transação do registro de custo (2.6)
      save: jest.fn((_entity: unknown, obj: Record<string, unknown>) => testAssetRepo.save(obj)),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    // Repositórios e manager DESTE teste presos na closure: uma execução que
    // sobre de um teste anterior nunca escreve nos mocks do teste seguinte.
    const repos = new Map<unknown, unknown>([
      [McCharacterKit, kitRepo],
      [McEvent, eventRepo],
      [AnimationAsset, assetRepo],
    ]);
    const txManager = manager;
    dataSource = {
      getRepository: jest.fn((entity: unknown) => repos.get(entity) ?? testAssetRepo),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(txManager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    commercials = {
      appendEvent: jest.fn((_m: unknown, event: Record<string, unknown>) => {
        events.push({ id: String(events.length + 1), ...event });
        return Promise.resolve(undefined);
      }),
    };
    gemini = { generateImageWithModel: jest.fn() };
    mascots = {
      findOne: jest.fn().mockResolvedValue({
        id: 'mascot-1',
        cutoutUrl: '/uploads/mascots/cutout.png',
        sourceImageUrl: '/uploads/mascots/cutout.png',
      }),
    };
    env = { UPLOAD_DEST: tmpDir };
    config = {
      get: jest.fn((key: string, def?: string) => env[key] ?? def),
    };
    view = { resolveIdentityAsset: jest.fn().mockResolvedValue(null) };
    processor = new McKitProcessor(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      gemini as unknown as GeminiImageProvider,
      mascots as unknown as MascotsService,
      config as unknown as ConfigService,
      view as unknown as McKitViewService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_KIT_PROVIDER;
    else process.env.MC_KIT_PROVIDER = originalProvider;
  });

  it('provider mock: 4 referências sintéticas, kit → review com canonicalDesc + assets, notify em mc_events', async () => {
    await processor.process({ kitId: 'kit-1' });

    // 4 media assets kind kit_reference, um por slot
    expect(assetRepo.save).toHaveBeenCalledTimes(4);
    const slots = assetRepo.save.mock.calls.map(
      (c) => (c[0] as { metadata: { slot: number } }).metadata.slot,
    );
    expect(slots).toEqual([0, 1, 2, 3]);
    for (const [arg] of assetRepo.save.mock.calls) {
      expect(arg).toMatchObject({ kind: 'kit_reference', status: 'ready', userId: 'u1' });
      expect((arg as { fileUrl: string }).fileUrl).toMatch(
        /^\/uploads\/commercials\/kits\/kit-1\/ref-\d-\d+\.png$/,
      );
    }

    // CAS generating → review com a descrição canônica JSON e os 4 assets
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.REVIEW,
      expect.objectContaining({
        referenceAssetIds: ['asset-1', 'asset-2', 'asset-3', 'asset-4'],
        canonicalDesc: expect.any(String),
      }),
    );
    const patch = transitions.casTransition.mock.calls[0][5] as { canonicalDesc: string };
    const desc = JSON.parse(patch.canonicalDesc) as Record<string, unknown>;
    expect(desc).toMatchObject({
      traits: expect.any(Array),
      colors: expect.any(Array),
      style: expect.any(String),
      doNots: expect.any(Array),
    });

    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.REVIEW },
      MC_EVENTS_CHANNEL,
    );
    expect(gemini.generateImageWithModel).not.toHaveBeenCalled(); // mock não gasta API
  });

  describe('referências mock derivadas da identidade enviada (achado 6 da 3.7)', () => {
    /** Mascote de teste: círculo vermelho sobre fundo transparente, 400×600. */
    const mascot = () =>
      sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">' +
            '<circle cx="200" cy="160" r="140" fill="#E01010"/></svg>',
        ),
      )
        .png()
        .toBuffer();
    const pixel = async (png: Buffer, x: number, y: number) => {
      const raw = await sharp(png)
        .extract({ left: x, top: y, width: 1, height: 1 })
        .raw()
        .toBuffer();
      return [raw[0], raw[1], raw[2]];
    };

    it('compõe a imagem do mascote no quadro, com o fundo do kit e o rosto na caixa do gate mock', async () => {
      const png = await mockReferenceFromIdentity(2, await mascot(), '#FFCC00');
      const meta = await sharp(png).metadata();
      expect([meta.width, meta.height]).toEqual([MOCK_REFERENCE_SIZE, MOCK_REFERENCE_SIZE]);
      // borda lisa na cor do kit (o tile é recortado com fundo uniforme)
      expect(await pixel(png, 0, 0)).toEqual([255, 204, 0]);
      expect(await pixel(png, MOCK_REFERENCE_SIZE - 1, MOCK_REFERENCE_SIZE - 1)).toEqual([
        255, 204, 0,
      ]);
      // centro da caixa do rosto do gate mock (x 0,5 · y 0,35) cai no personagem
      const [r, g, b] = await pixel(png, 512, Math.round(0.35 * MOCK_REFERENCE_SIZE));
      expect(r).toBeGreaterThan(200);
      expect(g).toBeLessThan(40);
      expect(b).toBeLessThan(40);
    });

    it('o tile recortado pela caixa do gate mock tem borda lisa (sem TILE_BORDER_NOT_UNIFORM)', async () => {
      const png = await mockReferenceFromIdentity(2, await mascot(), '#FFCC00');
      const plan = computeTileCrop({
        width: MOCK_REFERENCE_SIZE,
        height: MOCK_REFERENCE_SIZE,
        bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
      });
      const { data, info } = await sharp(png)
        .ensureAlpha()
        .extract(plan.extract)
        .resize(64, 64, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const edge = edgeUniformity({ data, width: info.width, height: info.height, channels: 4 });
      expect(edge.uniform).toBe(true);
      expect(edge.hex?.toUpperCase()).toBe('#FFCC00');
    });

    it('imagem opaca: o fundo do quadro é a cor do canto da própria imagem; cor legada não-hex não quebra', async () => {
      const opaque = await sharp({
        create: { width: 300, height: 300, channels: 3, background: { r: 250, g: 250, b: 250 } },
      })
        .composite([
          {
            input: await sharp({
              create: { width: 100, height: 100, channels: 3, background: '#0000FF' },
            })
              .png()
              .toBuffer(),
            left: 100,
            top: 40,
          },
        ])
        .png()
        .toBuffer();
      const png = await mockReferenceFromIdentity(0, opaque, 'light gray');
      expect(await pixel(png, 0, 0)).toEqual([250, 250, 250]);
    });

    it('processo mock: a referência frontal (slot 2) gravada é a do mascote, não o círculo sintético', async () => {
      await fs.writeFile(path.join(tmpDir, 'mascots', 'real.png'), await mascot());
      mascots.findOne.mockResolvedValue({
        id: 'mascot-1',
        cutoutUrl: '/uploads/mascots/real.png',
        sourceImageUrl: '/uploads/mascots/real.png',
      });
      await processor.process({ kitId: 'kit-1' });
      const front = savedAssets.find((a) => (a.metadata as { slot: number }).slot === 2);
      const file = path.join(tmpDir, (front?.fileUrl as string).replace(/^\/uploads\//, ''));
      const png = await fs.readFile(file);
      const [r, g, b] = await pixel(png, 512, Math.round(0.35 * MOCK_REFERENCE_SIZE));
      expect(r).toBeGreaterThan(200);
      expect(g).toBeLessThan(40);
      expect(b).toBeLessThan(40);
      expect(gemini.generateImageWithModel).not.toHaveBeenCalled();
    });
  });

  it('gemini: falha de UMA imagem não derruba o kit — segue para review com 3 referências', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    jest
      .spyOn(
        processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
        'generateCanonicalDesc',
      )
      .mockResolvedValue({ traits: ['t'], colors: ['#fff'], style: 's', doNots: [] });
    const ok = (name: string) => ({ image: Buffer.from(name), model: 'nano-banana-pro-preview' });
    gemini.generateImageWithModel
      .mockResolvedValueOnce(ok('img-0'))
      .mockRejectedValueOnce(new TerminalProviderError('bloqueada', 'content_policy'))
      .mockResolvedValueOnce(ok('img-2'))
      .mockResolvedValueOnce(ok('img-3'));

    await processor.process({ kitId: 'kit-1' });

    expect(assetRepo.save).toHaveBeenCalledTimes(3);
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.REVIEW,
      expect.objectContaining({ referenceAssetIds: ['asset-1', 'asset-2', 'asset-3'] }),
    );
    // a falha do slot 1 ficou auditada em mc_events
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        refKind: 'kit',
        kind: 'reference_failed',
        detail: expect.objectContaining({ slot: 1 }),
      }),
    );
  });

  it('menos de 2 referências geradas → kit failed (sem estorno: kit não reserva créditos na v0)', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    jest
      .spyOn(
        processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
        'generateCanonicalDesc',
      )
      .mockResolvedValue({ traits: ['t'], colors: [], style: 's', doNots: [] });
    gemini.generateImageWithModel
      .mockResolvedValueOnce({ image: Buffer.from('img-0'), model: 'nano-banana-pro-preview' })
      .mockRejectedValue(new TerminalProviderError('bloqueada', 'content_policy'));

    await processor.process({ kitId: 'kit-1' });

    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.FAILED,
    );
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        kind: 'transition',
        toStatus: McKitStatus.FAILED,
        detail: expect.objectContaining({ errorCode: 'kit_generation_failed' }),
      }),
    );
    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.FAILED },
      MC_EVENTS_CHANNEL,
    );
  });

  it('descrição canônica falhou → kit failed antes de gastar com imagens', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini'; // sem OPENAI_API_KEY no ConfigService fake → falha
    await processor.process({ kitId: 'kit-1' });

    expect(gemini.generateImageWithModel).not.toHaveBeenCalled();
    expect(assetRepo.save).not.toHaveBeenCalled();
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.FAILED,
    );
  });

  it('job re-entrando com kit fora de generating é no-op (idempotência CAS)', async () => {
    kitRepo.findOneBy.mockResolvedValue({ ...baseKit, status: McKitStatus.REVIEW });
    await processor.process({ kitId: 'kit-1' });
    expect(mascots.findOne).not.toHaveBeenCalled();
    expect(transitions.casTransition).not.toHaveBeenCalled();
    expect(assetRepo.save).not.toHaveBeenCalled();
  });

  /** Change video-formatos-personagem: identidade escolhida como fonte, modelo das referências (2.6). */
  describe('identidade e modelo das referências (D4 / 2.6)', () => {
    it('kit de logo em generating SEM candidato escolhido → no-op (nunca falha o kit; a rodada de candidatos é quem gera)', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...baseKit,
        source: 'logo',
        identityMode: 'generated',
        identityAssetId: null,
      });
      await processor.process({ kitId: 'kit-1' });
      expect(mascots.findOne).not.toHaveBeenCalled();
      expect(assetRepo.save).not.toHaveBeenCalled();
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('logo usado como está não gera referências (no-op)', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...baseKit,
        source: 'logo',
        identityMode: 'logo_as_is',
        identityAssetId: 'logo-asset',
      });
      await processor.process({ kitId: 'kit-1' });
      expect(assetRepo.save).not.toHaveBeenCalled();
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('com identityAssetId (candidato escolhido): a fonte das referências é a identidade, não a imagem do mascote; referências antigas são descartadas', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'mascots', 'identity.png'),
        Buffer.from('identity-bytes'),
      );
      kitRepo.findOneBy.mockResolvedValue({
        ...baseKit,
        source: 'logo',
        identityAssetId: 'cand-asset',
        referenceAssetIds: ['old-1', 'old-2'],
      });
      assetRepo.findOneBy.mockResolvedValue({
        id: 'cand-asset',
        fileUrl: '/uploads/mascots/identity.png',
      });
      process.env.MC_KIT_PROVIDER = 'gemini';
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: (img: Buffer) => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue({ traits: ['t'], colors: [], style: 's', doNots: [] });
      gemini.generateImageWithModel.mockResolvedValue({
        image: Buffer.from('img'),
        model: 'nano-banana-pro-preview',
      });

      await processor.process({ kitId: 'kit-1' });

      expect(mascots.findOne).not.toHaveBeenCalled();
      const call = gemini.generateImageWithModel.mock.calls[0][0] as { referenceImages: Buffer[] };
      expect(call.referenceImages[0]).toEqual(Buffer.from('identity-bytes'));
      expect(manager.softDelete).toHaveBeenCalledWith(AnimationAsset, ['old-1', 'old-2']);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        expect.objectContaining({
          referenceAssetIds: ['asset-1', 'asset-2', 'asset-3', 'asset-4'],
        }),
      );
    });

    it('GEMINI_IMAGE_MODEL_REFS escolhe o modelo das referências; o hash/metadata levam o modelo EFETIVO (fallback do provider)', async () => {
      env.GEMINI_IMAGE_MODEL_REFS = 'gemini-nano-banana-2.1';
      process.env.MC_KIT_PROVIDER = 'gemini';
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: (img: Buffer) => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue({ traits: ['t'], colors: [], style: 's', doNots: [] });
      gemini.generateImageWithModel.mockResolvedValue({
        image: Buffer.from('img'),
        model: 'nano-banana-pro-preview', // o provider caiu para o modelo atual
      });

      await processor.process({ kitId: 'kit-1' });

      expect(gemini.generateImageWithModel).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-nano-banana-2.1', aspectRatio: '1:1' }),
      );
      const saved = assetRepo.save.mock.calls[0][0] as { metadata: { model: string } };
      expect(saved.metadata.model).toBe('nano-banana-pro-preview');
    });
  });

  /** M3: referências refeitas a partir de uma identidade escolhida em REVISÃO não falham o kit. */
  describe('regeneração a partir de review ({kitId, fromReview, previous})', () => {
    const verdict: McMouthVerdict = {
      hasMouth: true,
      mouthOpenPossible: true,
      confidence: 0.9,
      bbox: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
      model: 'mock',
      at: '2026-10-12T00:00:00.000Z',
    };
    const previous = {
      identityAssetId: 'old-identity',
      identityMode: 'generated' as const,
      mouthGate: {
        logo: verdict,
        identity: { ...verdict, identityAssetId: 'old-identity' },
      } as McKitMouthGate,
    };
    const reviewOrigin = {
      ...baseKit,
      source: 'logo',
      identityAssetId: 'new-cand',
      canonicalDesc: JSON.stringify({ traits: ['t'], colors: [], style: 's', doNots: [] }),
      referenceAssetIds: ['a1', 'a2', 'a3', 'a4'],
    };

    it('falha da descrição canônica → generating → review restaurando a identidade anterior; referências e ficha intactas; evento + SSE references_regeneration_failed', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewOrigin });
      assetRepo.findOneBy.mockResolvedValue({
        id: 'new-cand',
        fileUrl: '/uploads/mascots/cutout.png',
      });
      process.env.MC_KIT_PROVIDER = 'gemini'; // sem OPENAI_API_KEY → descrição falha

      await processor.process({ kitId: 'kit-1', fromReview: true, previous });

      expect(transitions.casTransition).toHaveBeenCalledTimes(1);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        {
          identityAssetId: 'old-identity',
          identityMode: 'generated',
          mouthGate: previous.mouthGate,
        },
      );
      // referências/ficha NÃO entram no patch: seguem como estavam
      const patch = transitions.casTransition.mock.calls[0][5] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('referenceAssetIds');
      expect(patch).not.toHaveProperty('canonicalDesc');
      // o candidato "escolhido" volta a ser o da identidade anterior
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { kitId: 'kit-1', chosen: true },
        { chosen: false },
      );
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { kitId: 'kit-1', assetId: 'old-identity' },
        { chosen: true },
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'references_regeneration_failed',
          fromStatus: McKitStatus.GENERATING,
          toStatus: McKitStatus.REVIEW,
          detail: expect.objectContaining({
            errorCode: 'canonical_desc_failed',
            attemptedIdentityAssetId: 'new-cand',
            restoredIdentityAssetId: 'old-identity',
          }),
        }),
      );
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        {
          kind: 'mc_kit',
          kitId: 'kit-1',
          status: McKitStatus.REVIEW,
          event: 'references_regeneration_failed',
        },
        MC_EVENTS_CHANNEL,
      );
    });

    it('menos de 2 referências → volta a review e descarta as referências parciais desta tentativa; identidade anterior nula (frontal do mascote) não marca candidato', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewOrigin, source: 'mascot' });
      assetRepo.findOneBy.mockResolvedValue({
        id: 'new-cand',
        fileUrl: '/uploads/mascots/cutout.png',
      });
      process.env.MC_KIT_PROVIDER = 'gemini';
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue({ traits: ['t'], colors: [], style: 's', doNots: [] });
      gemini.generateImageWithModel
        .mockResolvedValueOnce({ image: Buffer.from('img-0'), model: 'm' })
        .mockRejectedValue(new TerminalProviderError('bloqueada', 'content_policy'));

      await processor.process({
        kitId: 'kit-1',
        fromReview: true,
        previous: { identityAssetId: null, identityMode: 'generated', mouthGate: null },
      });

      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        { identityAssetId: null, identityMode: 'generated', mouthGate: null },
      );
      expect(manager.softDelete).toHaveBeenCalledWith(AnimationAsset, ['asset-1']);
      expect(manager.update).toHaveBeenCalledTimes(1); // só o "desmarcar"
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.FAILED,
      );
    });

    it('sem fromReview (primeira geração) a mesma falha continua terminal: failed', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewOrigin, referenceAssetIds: [] });
      assetRepo.findOneBy.mockResolvedValue({
        id: 'new-cand',
        fileUrl: '/uploads/mascots/cutout.png',
      });
      process.env.MC_KIT_PROVIDER = 'gemini';
      await processor.process({ kitId: 'kit-1' });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.FAILED,
      );
      expect(commercials.appendEvent).not.toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'references_regeneration_failed' }),
      );
    });
  });

  describe('regeneração de 1 célula ({kitId, slot})', () => {
    const reviewKit = {
      ...baseKit,
      status: McKitStatus.REVIEW,
      canonicalDesc: JSON.stringify({ traits: ['t'], colors: [], style: 's', doNots: [] }),
      referenceAssetIds: ['a1', 'a2', 'a3', 'a4'],
    };

    it('troca só o asset do slot: novo entra, antigo sai do array e é soft-deletado', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      manager.findOne.mockResolvedValue({ ...reviewKit });
      manager.find.mockResolvedValue([
        { id: 'a1', metadata: { slot: 0 } },
        { id: 'a2', metadata: { slot: 1 } },
        { id: 'a3', metadata: { slot: 2 } },
        { id: 'a4', metadata: { slot: 3 } },
      ]);

      await processor.process({ kitId: 'kit-1', slot: 2 });

      expect(assetRepo.save).toHaveBeenCalledTimes(1);
      // slot 2 é a referência FRONTAL = identidade do kit de mascote: trocá-la
      // também zera o tile/veredito (ainda inexistentes aqui) — ver teste abaixo.
      expect(manager.update).toHaveBeenCalledWith(
        McCharacterKit,
        { id: 'kit-1' },
        { referenceAssetIds: ['a1', 'a2', 'a4', 'asset-1'], tileAssetId: null, mouthGate: null },
      );
      expect(manager.softDelete).toHaveBeenCalledWith(AnimationAsset, 'a3');
      expect(manager.softDelete).toHaveBeenCalledTimes(1); // sem tile anterior, nada mais a descartar
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'reference_regenerated',
          detail: expect.objectContaining({ slot: 2, assetId: 'asset-1' }),
        }),
      );
      // kit permanece em review — nenhuma transição de status
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('regenerar a referência frontal (slot 2) de um kit de mascote descarta o tile e o veredito de boca da identidade anterior', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      manager.findOne.mockResolvedValue({
        ...reviewKit,
        identityAssetId: null,
        tileAssetId: 'tile-old',
        mouthGate: {
          logo: { hasMouth: true },
          identity: { hasMouth: true, identityAssetId: 'a3' },
          riskAccepted: { at: 'x' },
        },
      });
      manager.find.mockResolvedValue([{ id: 'a3', metadata: { slot: 2 } }]);

      await processor.process({ kitId: 'kit-1', slot: 2 });

      expect(manager.update).toHaveBeenCalledWith(
        McCharacterKit,
        { id: 'kit-1' },
        {
          referenceAssetIds: ['a1', 'a2', 'a4', 'asset-1'],
          tileAssetId: null,
          mouthGate: { logo: { hasMouth: true } },
        },
      );
      expect(manager.softDelete).toHaveBeenCalledWith(AnimationAsset, 'tile-old');

      // slot que não é o frontal não mexe no tile
      manager.update.mockClear();
      manager.find.mockResolvedValue([{ id: 'a2', metadata: { slot: 1 } }]);
      await processor.process({ kitId: 'kit-1', slot: 1 });
      expect(manager.update).toHaveBeenCalledWith(
        McCharacterKit,
        { id: 'kit-1' },
        { referenceAssetIds: ['a1', 'a3', 'a4', 'asset-2'] },
      );
    });

    it('kit fora de review → regeneração é no-op', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, status: McKitStatus.APPROVED });
      await processor.process({ kitId: 'kit-1', slot: 1 });
      expect(assetRepo.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('slot inválido → no-op', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await processor.process({ kitId: 'kit-1', slot: 7 });
      expect(assetRepo.save).not.toHaveBeenCalled();
    });
  });
  /**
   * Tarefa 2.6 — custo registrado por chamada, conta sem crédito terminal e
   * geração idempotente por slot (re-entrega do pg-boss após a expiração).
   */
  describe('custo, quota e idempotência (2.6)', () => {
    const desc = {
      traits: ['capybara', 'green apron'],
      accessories: [],
      colors: ['#7B4A2D', '#2E7D32'],
      style: '3D cartoon',
      doNots: ['never change the apron color'],
      pt: { traits: ['capivara', 'avental verde'], accessories: [], style: '3D', doNots: ['x'] },
    };
    const descResponse = {
      model: 'gpt-4o-2024-08-06',
      usage: { prompt_tokens: 1200, completion_tokens: 500, total_tokens: 1700 },
      choices: [{ message: { content: JSON.stringify(desc) } }],
    };
    const usage = {
      promptTokens: 1000,
      candidatesTokens: 1120,
      thoughtsTokens: 0,
      outputImageTokens: 1120,
      totalTokens: 2120,
    };
    const image = (model: string) => ({ image: Buffer.from(`img-${model}`), model, usage });

    /** Cliente OpenAI fake injetado no processor (o real nasce do OPENAI_API_KEY). */
    const withOpenAi = (target: McKitProcessor, create: jest.Mock) => {
      (target as unknown as { openai: unknown }).openai = { chat: { completions: { create } } };
    };
    const newProcessor = () =>
      new McKitProcessor(
        dataSource as unknown as DataSource,
        transitions as unknown as TaskTransitionService,
        commercials as unknown as CommercialsService,
        gemini as unknown as GeminiImageProvider,
        mascots as unknown as MascotsService,
        config as unknown as ConfigService,
        view as unknown as McKitViewService,
      );
    const costEvents = () => savedEvents.filter((e) => e.kind === 'provider_cost');
    const costDetail = (i: number) => costEvents()[i].detail as Record<string, unknown>;
    const incrementTotal = () =>
      manager.increment.mock.calls.reduce((sum, call) => sum + (call[3] as number), 0);
    /** Espera a execução em segundo plano chegar à N-ésima chamada de imagem. */
    const untilImageCalls = async (n: number) => {
      for (let i = 0; i < 500 && gemini.generateImageWithModel.mock.calls.length < n; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(gemini.generateImageWithModel).toHaveBeenCalledTimes(n);
    };
    const quotaError = () =>
      Object.assign(new Error('429 You exceeded your current quota'), {
        status: 429,
        code: 'insufficient_quota',
        type: 'insufficient_quota',
      });

    beforeEach(() => {
      process.env.MC_KIT_PROVIDER = 'gemini';
      env.GEMINI_IMAGE_MODEL_REFS = 'gemini-nano-banana-2.1';
    });

    it('cada chamada paga vira uma linha de custo: descrição pelos tokens do usage (gpt-4o) e cada referência pelo modelo EFETIVO; a soma vai para o kit', async () => {
      const create = jest.fn().mockResolvedValue(descResponse);
      withOpenAi(processor, create);
      gemini.generateImageWithModel
        .mockResolvedValueOnce(image('gemini-nano-banana-2.1'))
        .mockResolvedValueOnce(image('gemini-nano-banana-2.1'))
        .mockResolvedValueOnce(image('gemini-nano-banana-2.1'))
        .mockResolvedValueOnce(image('nano-banana-pro-preview')); // fallback no slot 3

      await processor.process({ kitId: 'kit-1' }, 'job-1');

      // SDK sem retry próprio (o withRetry decide) e com timeout por chamada
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][1]).toEqual({ maxRetries: 0, timeout: 60_000 });

      expect(costEvents()).toHaveLength(5);
      // 1200 × 2,5/1M + 500 × 10/1M
      expect(costDetail(0)).toMatchObject({
        call: 'canonical_desc',
        provider: 'openai',
        model: 'gpt-4o-2024-08-06',
        requestedModel: 'gpt-4o',
        usage: { inputTokens: 1200, outputTokens: 500, images: 0 },
        generationKey: 'job-1',
        desc,
      });
      expect(costDetail(0).costUsd).toBeCloseTo(0.008, 6);
      // 2.1: 0,034 por imagem + 1000 × 2/1M; Pro (fallback): 0,134 + 0,002
      const refs = [1, 2, 3, 4].map(costDetail);
      expect(refs.map((r) => r.call)).toEqual(['reference', 'reference', 'reference', 'reference']);
      expect(refs.map((r) => r.slot)).toEqual([0, 1, 2, 3]);
      expect(refs.map((r) => r.model)).toEqual([
        'gemini-nano-banana-2.1',
        'gemini-nano-banana-2.1',
        'gemini-nano-banana-2.1',
        'nano-banana-pro-preview',
      ]);
      expect(refs.map((r) => r.costUsd)).toEqual([0.036, 0.036, 0.036, 0.136]);
      expect(refs.map((r) => r.assetId)).toEqual(['asset-1', 'asset-2', 'asset-3', 'asset-4']);

      // soma no kit: incremento atômico por chamada (US$ 0,252 no total)
      for (const call of manager.increment.mock.calls) {
        expect(call.slice(0, 3)).toEqual([McCharacterKit, { id: 'kit-1' }, 'providerCostUsd']);
      }
      expect(incrementTotal()).toBeCloseTo(0.252, 6);

      // custo e chave de idempotência também no metadata do asset
      const meta = savedAssets[3].metadata as Record<string, unknown>;
      expect(meta).toMatchObject({
        slot: 3,
        model: 'nano-banana-pro-preview',
        requestedModel: 'gemini-nano-banana-2.1',
        generationKey: 'job-1',
        providerCostUsd: 0.136,
        usage: { inputTokens: 1000, outputTokens: 0, images: 1 },
      });
      expect(meta.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.requestHash).not.toBe(meta.inputHash);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        expect.objectContaining({
          referenceAssetIds: ['asset-1', 'asset-2', 'asset-3', 'asset-4'],
        }),
      );
    });

    it('OpenAI sem crédito (429 insufficient_quota) é terminal: UMA chamada, nenhuma imagem, kit failed com providerErrorCode quota', async () => {
      const create = jest.fn().mockRejectedValue(quotaError());
      withOpenAi(processor, create);

      await processor.process({ kitId: 'kit-1' }, 'job-1');

      expect(create).toHaveBeenCalledTimes(1);
      expect(gemini.generateImageWithModel).not.toHaveBeenCalled();
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'transition',
          toStatus: McKitStatus.FAILED,
          detail: expect.objectContaining({
            errorCode: 'canonical_desc_failed',
            providerErrorCode: 'quota',
            errorMessage: expect.stringContaining('insufficient_quota'),
          }),
        }),
      );
      expect(costEvents()).toHaveLength(0); // não houve cobrança
      expect(manager.increment).not.toHaveBeenCalled();
    });

    it('429 de LIMITE DE TAXA continua transitório: re-tenta e segue', async () => {
      const rateLimited = Object.assign(new Error('429 Rate limit reached'), {
        status: 429,
        code: 'rate_limit_exceeded',
        type: 'requests',
      });
      const create = jest.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue(descResponse);
      withOpenAi(processor, create);
      gemini.generateImageWithModel.mockResolvedValue(image('gemini-nano-banana-2.1'));

      await processor.process({ kitId: 'kit-1' }, 'job-1');

      expect(create).toHaveBeenCalledTimes(2);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        expect.anything(),
      );
    });

    it('Gemini sem crédito (quota) numa referência: os slots restantes não são tentados; kit failed com providerErrorCode quota', async () => {
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue(desc);
      gemini.generateImageWithModel.mockRejectedValue(
        new TerminalProviderError('HTTP 403: billing', 'quota'),
      );

      await processor.process({ kitId: 'kit-1' }, 'job-1');

      expect(gemini.generateImageWithModel).toHaveBeenCalledTimes(1);
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'reference_failed',
          detail: expect.objectContaining({ slot: 0, providerErrorCode: 'quota' }),
        }),
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'transition',
          toStatus: McKitStatus.FAILED,
          detail: expect.objectContaining({
            errorCode: 'kit_generation_failed',
            providerErrorCode: 'quota',
            failures: [expect.objectContaining({ slot: 0 })],
          }),
        }),
      );
    });

    it('re-entrega do MESMO job depois de pagar 2 referências (worker caiu / job expirou): descrição reaproveitada sem nova chamada e só os slots que faltam são gerados', async () => {
      const createA = jest.fn().mockResolvedValue(descResponse);
      withOpenAi(processor, createA);
      gemini.generateImageWithModel
        .mockResolvedValueOnce(image('gemini-nano-banana-2.1'))
        .mockResolvedValueOnce(image('gemini-nano-banana-2.1'))
        .mockImplementationOnce(() => new Promise(() => undefined)); // slot 2 nunca responde
      void processor.process({ kitId: 'kit-1' }, 'job-1');
      await untilImageCalls(3);

      // outro worker pega a re-entrega (mesmo id de job)
      gemini.generateImageWithModel.mockResolvedValue(image('gemini-nano-banana-2.1'));
      const other = newProcessor();
      const createB = jest.fn().mockResolvedValue(descResponse);
      withOpenAi(other, createB);
      await other.process({ kitId: 'kit-1' }, 'job-1');

      expect(createA).toHaveBeenCalledTimes(1);
      expect(createB).not.toHaveBeenCalled(); // descrição da execução anterior
      expect(gemini.generateImageWithModel).toHaveBeenCalledTimes(5); // 3 + só os slots 2 e 3
      // os prompts da re-entrega são idênticos aos da primeira execução
      const prompts = gemini.generateImageWithModel.mock.calls.map(
        (c) => (c[0] as { prompt: string }).prompt,
      );
      expect(prompts[3]).toBe(prompts[2]);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        expect.objectContaining({
          referenceAssetIds: ['asset-1', 'asset-2', 'asset-3', 'asset-4'],
        }),
      );
      // nenhuma chamada paga em dobro: 1 descrição + 4 referências
      expect(costEvents().map((e) => (e.detail as { call: string }).call)).toEqual([
        'canonical_desc',
        'reference',
        'reference',
        'reference',
        'reference',
      ]);
    });

    it('outro job (outra geração) NÃO reaproveita a descrição de um job anterior', async () => {
      savedEvents.push({
        id: '99',
        refKind: 'kit',
        refId: 'kit-1',
        kind: 'provider_cost',
        detail: { call: 'canonical_desc', generationKey: 'job-1', desc },
      });
      const create = jest.fn().mockResolvedValue(descResponse);
      withOpenAi(processor, create);
      gemini.generateImageWithModel.mockResolvedValue(image('gemini-nano-banana-2.1'));
      await processor.process({ kitId: 'kit-1' }, 'job-2');
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('execução sobreposta do MESMO job no mesmo worker: a re-entrega ESPERA a execução em curso (sem gerar de novo) e conclui junto com ela', async () => {
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue(desc);
      let release!: (value: ReturnType<typeof image>) => void;
      gemini.generateImageWithModel
        .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
        .mockResolvedValue(image('gemini-nano-banana-2.1'));
      const first = processor.process({ kitId: 'kit-1' }, 'job-1');
      await untilImageCalls(1);

      let duplicateDone = false;
      const duplicate = processor.process({ kitId: 'kit-1' }, 'job-1').then(() => {
        duplicateDone = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      // não voltou antes do trabalho real (voltar na hora concluía o job no pg-boss)
      expect(duplicateDone).toBe(false);
      expect(kitRepo.findOneBy).toHaveBeenCalledTimes(1);

      release(image('gemini-nano-banana-2.1'));
      await Promise.all([first, duplicate]);
      expect(duplicateDone).toBe(true);
      expect(gemini.generateImageWithModel).toHaveBeenCalledTimes(4); // uma geração só
      expect(kitRepo.findOneBy).toHaveBeenCalledTimes(1);

      // terminada a execução, o claim é liberado: uma entrega nova roda de verdade
      await processor.process({ kitId: 'kit-1' }, 'job-1');
      expect(kitRepo.findOneBy).toHaveBeenCalledTimes(2);
    });

    it('re-entrega sobreposta falha junto com a execução em curso (o job continua re-tentável)', async () => {
      jest
        .spyOn(processor as unknown as { run: () => Promise<void> }, 'run')
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error('worker caiu')), 20),
            ),
        );
      const first = processor.process({ kitId: 'kit-1' }, 'job-1');
      const duplicate = processor.process({ kitId: 'kit-1' }, 'job-1');
      await expect(first).rejects.toThrow('worker caiu');
      await expect(duplicate).rejects.toThrow('worker caiu');
    });

    it('resposta 200 SEM imagem (IMAGE_SAFETY) foi cobrada: linha de custo sem asset pelo uso devolvido, evento reference_failed e o kit segue', async () => {
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue(desc);
      gemini.generateImageWithModel
        .mockRejectedValueOnce(
          withGeminiBilling(
            new TerminalProviderError('Geração bloqueada (IMAGE_SAFETY)', 'content_policy'),
            {
              model: 'gemini-nano-banana-2.1',
              usage: {
                promptTokens: 1500,
                candidatesTokens: 0,
                thoughtsTokens: 250,
                outputImageTokens: null,
                totalTokens: 1750,
              },
            },
          ),
        )
        .mockResolvedValue(image('gemini-nano-banana-2.1'));

      await processor.process({ kitId: 'kit-1' }, 'job-1');

      // timeout da imagem é terminal: o kit pede ao provider sem re-tentativa de timeout
      for (const call of gemini.generateImageWithModel.mock.calls) {
        expect(call[0]).toMatchObject({ retryOnTimeout: false });
      }
      expect(costEvents()).toHaveLength(4); // 1 sem resultado + 3 referências
      expect(costDetail(0)).toMatchObject({
        call: 'reference',
        slot: 0,
        model: 'gemini-nano-banana-2.1',
        assetId: null,
        failure: 'no_output',
        providerErrorCode: 'content_policy',
        usage: { inputTokens: 1500, outputTokens: 250, images: 0 },
      });
      // 1500 × 2/1M + 250 × 12/1M = 0,006 (sem preço de imagem: nenhuma veio)
      expect(costDetail(0).costUsd).toBeCloseTo(0.006, 6);
      expect(costDetail(0).estimated).toBeUndefined();
      expect(incrementTotal()).toBeCloseTo(0.006 + 3 * 0.036, 6);
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'reference_failed',
          detail: expect.objectContaining({ slot: 0, providerErrorCode: 'content_policy' }),
        }),
      );
    });

    it('timeout de uma referência: terminal, SEM nova requisição, linha de custo ESTIMADA pelo preço da imagem', async () => {
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue(desc);
      gemini.generateImageWithModel
        .mockResolvedValueOnce(image('gemini-nano-banana-2.1'))
        .mockRejectedValueOnce(
          withGeminiBilling(new TerminalProviderError('Tempo esgotado', 'provider_timeout'), {
            model: 'gemini-nano-banana-2.1',
            usage: null,
            timedOut: true,
          }),
        )
        .mockResolvedValue(image('gemini-nano-banana-2.1'));

      await processor.process({ kitId: 'kit-1' }, 'job-1');

      expect(gemini.generateImageWithModel).toHaveBeenCalledTimes(4); // 1 chamada por slot
      const timedOut = costEvents()
        .map((e) => e.detail as Record<string, unknown>)
        .find((d) => d.failure === 'timed_out');
      expect(timedOut).toMatchObject({
        call: 'reference',
        slot: 1,
        assetId: null,
        estimated: true,
        costUsd: 0.034,
        usage: { inputTokens: 0, outputTokens: 0, images: 1 },
        providerErrorCode: 'provider_timeout',
      });
      expect(incrementTotal()).toBeCloseTo(0.034 + 3 * 0.036, 6);
    });

    it('erro sem resposta cobrada (rede, quota) não grava linha de custo', async () => {
      jest
        .spyOn(
          processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
          'generateCanonicalDesc',
        )
        .mockResolvedValue(desc);
      gemini.generateImageWithModel
        .mockRejectedValueOnce(new Error('Falha de rede'))
        .mockResolvedValue(image('gemini-nano-banana-2.1'));
      await processor.process({ kitId: 'kit-1' }, 'job-1');
      expect(costEvents()).toHaveLength(3);
      expect(costEvents().every((e) => (e.detail as { failure?: string }).failure == null)).toBe(
        true,
      );
    });
  });

  describe('regeneração de 1 célula — idempotência (2.6)', () => {
    const reviewKit = {
      ...baseKit,
      status: McKitStatus.REVIEW,
      canonicalDesc: JSON.stringify({ traits: ['t'], colors: [], style: 's', doNots: [] }),
      referenceAssetIds: ['a1', 'a2', 'a3', 'a4'],
    };
    const grid = [
      { id: 'a1', metadata: { slot: 0 } },
      { id: 'a2', metadata: { slot: 1 } },
      { id: 'a3', metadata: { slot: 2 } },
      { id: 'a4', metadata: { slot: 3 } },
    ];

    it('re-entrega depois de pagar a imagem e antes da troca: reaproveita o asset gravado, sem nova imagem', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      manager.findOne
        .mockRejectedValueOnce(new Error('conexão caiu')) // primeira execução morre na troca
        .mockResolvedValue({ ...reviewKit });
      manager.find.mockResolvedValue(grid);

      await processor.process({ kitId: 'kit-1', slot: 1 }, 'job-r');
      await processor.process({ kitId: 'kit-1', slot: 1 }, 'job-r');

      expect(assetRepo.save).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        McCharacterKit,
        { id: 'kit-1' },
        { referenceAssetIds: ['a1', 'a3', 'a4', 'asset-1'] },
      );
    });

    it('referência do grid ATUAL com a mesma requisição não é reaproveitada: o usuário pediu imagem nova', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      manager.findOne.mockResolvedValue({ ...reviewKit });
      manager.find.mockResolvedValue(grid);
      await processor.process({ kitId: 'kit-1', slot: 1 });

      // o asset novo agora está no grid; nova regeneração do mesmo slot gera outra imagem
      const updated = { ...reviewKit, referenceAssetIds: ['a1', 'a3', 'a4', 'asset-1'] };
      kitRepo.findOneBy.mockResolvedValue(updated);
      manager.findOne.mockResolvedValue(updated);
      manager.find.mockResolvedValue([...grid, { id: 'asset-1', metadata: { slot: 1 } }]);
      await processor.process({ kitId: 'kit-1', slot: 1 });

      expect(assetRepo.save).toHaveBeenCalledTimes(2);
      expect(assetRepo.find).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: 'kit_reference', userId: 'u1' }),
        }),
      );
    });
  });
});
