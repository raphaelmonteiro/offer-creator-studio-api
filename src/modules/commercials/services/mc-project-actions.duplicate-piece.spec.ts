import { UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { McPieceDocument, McPieceProductsBlock, pieceBlock } from '../domain/mc-piece';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McProjectStatus } from '../domain/mc-state-machines';
import { McScript } from '../domain/mc-types';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McPiece } from '../entities/mc-piece.entity';
import { McProject } from '../entities/mc-project.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';
import { McProjectActionsService } from './mc-project-actions.service';

type Row = Record<string, unknown> & { id: string };

const SCRIPT: McScript = {
  version: 2,
  scenes: [
    {
      idx: 0,
      actionPrompt: '',
      actionPromptEn: '',
      dialogue: 'Picanha por cinquenta e nove e noventa o quilo!',
      durationS: 4,
    },
  ],
  seal: { products: [{ name: 'Picanha bovina', price: '59,90' }] },
  endcard: { storeName: 'Mercado do Zé' },
};

/**
 * Tarefa 5.5 — "duplicar em 4:5" de um vídeo da peça de ofertas: peça NOVA
 * com o descritor reorganizado pelo auto-layout do pacote, projeto novo em
 * storyboard_review apontando para ela, origem intacta.
 */
describe('McProjectActionsService — duplicar a peça de ofertas em outro formato (5.5)', () => {
  const userId = 'u1';
  let source: Row;
  let sourcePiece: Row | null;
  let saved: Array<Record<string, unknown>>;
  let manager: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let service: McProjectActionsService;
  const originalFormats = process.env.MC_FORMATS;
  const originalPipelineV2 = process.env.MC_PIPELINE_V2;

  const manualSnapshot = (): McPieceDocument => {
    const doc = fixturePieceDocument();
    const products = pieceBlock(doc, 'products') as McPieceProductsBlock;
    products.layout = 'manual';
    products.items.forEach((item, i) => {
      item.rect = { x: 0.05 + i * 0.22, y: 0.25, w: 0.2, h: 0.2 };
    });
    return doc;
  };

  const savedPiece = () => saved.find((r) => 'document' in r) as Row | undefined;
  const savedProject = () => saved.find((r) => 'script' in r) as Row | undefined;

  beforeEach(() => {
    process.env.MC_FORMATS = 'offer_piece';
    process.env.MC_PIPELINE_V2 = 'all';
    source = {
      id: 'p1',
      userId,
      kitId: 'kit-1',
      title: 'Vídeo das ofertas',
      briefing: 'briefing',
      status: McProjectStatus.SUCCEEDED,
      pipelineVersion: MC_PIPELINE_V2,
      format: 'offer_piece',
      tier: 'economico',
      channel: 'instagram',
      script: JSON.parse(JSON.stringify(SCRIPT)) as McScript,
      aspectRatio: '9:16',
      targetDurationS: 25,
      options: { musicEnabled: false, captionsEnabled: false, products: [] },
      moderation: { flagged: false },
      pieceId: 'piece-1',
      pieceSnapshot: manualSnapshot(),
      logoBox: null,
      reservedCredits: 0,
      consumedCredits: 0,
    };
    sourcePiece = {
      id: 'piece-1',
      userId,
      clientId: 'c1',
      name: 'Ofertas da semana',
      kind: 'piece',
    };
    saved = [];
    manager = {
      create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
      save: jest.fn((obj: Record<string, unknown>) => {
        if (!obj.id)
          obj.id = 'document' in obj ? 'piece-2' : 'script' in obj ? 'p2' : `row-${saved.length}`;
        saved.push(obj);
        return Promise.resolve(obj);
      }),
      find: jest.fn(() => Promise.resolve([])),
      findOne: jest.fn((entity: unknown, opts: { where: { id: string } }) =>
        Promise.resolve(
          entity === McPiece && sourcePiece?.id === opts.where.id ? sourcePiece : null,
        ),
      ),
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McProject) return Promise.resolve(source);
          if (entity === McCharacterKit) {
            return Promise.resolve({
              id: 'kit-1',
              userId,
              status: McKitStatus.APPROVED,
              version: 1,
            });
          }
          return Promise.resolve(null);
        }),
        findOneByOrFail: jest.fn(() => Promise.resolve(savedProject() ?? source)),
        count: jest.fn().mockResolvedValue(0),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    service = new McProjectActionsService(
      dataSource as unknown as DataSource,
      {
        casTransition: jest.fn().mockResolvedValue(true),
        notify: jest.fn().mockResolvedValue(undefined),
      } as unknown as TaskTransitionService,
      { get: jest.fn().mockResolvedValue(null) } as unknown as SystemSettingsService,
      { reserve: jest.fn(), refundUnconsumed: jest.fn() } as unknown as CreditsService,
      { moderate: jest.fn() } as unknown as ModerationProvider,
      commercials as unknown as CommercialsService,
      {} as unknown as McMaterializerService,
      {} as unknown as McPipelineService,
    );
  });

  afterEach(() => {
    if (originalFormats === undefined) delete process.env.MC_FORMATS;
    else process.env.MC_FORMATS = originalFormats;
    if (originalPipelineV2 === undefined) delete process.env.MC_PIPELINE_V2;
    else process.env.MC_PIPELINE_V2 = originalPipelineV2;
  });

  it('9:16 → 4:5: peça NOVA re-layoutada (grade auto, frações dos outros blocos), projeto novo aponta para ela', async () => {
    const copy = await service.duplicateProject(userId, 'p1', { aspectRatio: '4:5' });

    const piece = savedPiece();
    expect(piece).toMatchObject({
      id: 'piece-2',
      userId,
      clientId: 'c1',
      kind: 'piece',
      name: 'Ofertas da semana (4:5)',
      aspectRatio: '4:5',
      revision: 0,
    });
    const document = piece!.document as McPieceDocument;
    expect(document.aspectRatio).toBe('4:5');
    const products = pieceBlock(document, 'products') as McPieceProductsBlock;
    expect(products.layout).toBe('auto');
    products.items.forEach((item) => expect(item).not.toHaveProperty('rect'));
    expect(pieceBlock(document, 'character')?.rect).toEqual(
      pieceBlock(source.pieceSnapshot as McPieceDocument, 'character')?.rect,
    );

    expect(copy).toMatchObject({
      id: 'p2',
      status: McProjectStatus.STORYBOARD_REVIEW,
      format: 'offer_piece',
      aspectRatio: '4:5',
      pieceId: 'piece-2',
      logoBox: null,
      revision: 0,
    });
    expect((copy.pieceSnapshot as McPieceDocument).aspectRatio).toBe('4:5');
    expect(copy.pieceSnapshot).toEqual(document);
    // a origem não muda (snapshot manual em 9:16)
    const original = source.pieceSnapshot as McPieceDocument;
    expect(original.aspectRatio).toBe('9:16');
    expect((pieceBlock(original, 'products') as McPieceProductsBlock).layout).toBe('manual');
    // peça salva ANTES do projeto (o projeto precisa do id dela)
    expect(saved.indexOf(piece!)).toBeLessThan(saved.indexOf(savedProject()!));

    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        kind: 'project_duplicated',
        detail: expect.objectContaining({
          sourceProjectId: 'p1',
          aspectRatio: '4:5',
          pieceId: 'piece-2',
          sourcePieceId: 'piece-1',
          pieceRelayout: expect.objectContaining({ cols: 2, rows: 2 }),
        }),
      }),
    );
  });

  it('mesmo formato: peça nova é cópia fiel (layout manual preservado), sem re-layout no evento', async () => {
    const copy = await service.duplicateProject(userId, 'p1', {});
    const document = savedPiece()!.document as McPieceDocument;
    expect(document).toEqual(source.pieceSnapshot);
    expect(document).not.toBe(source.pieceSnapshot);
    expect(copy.aspectRatio).toBe('9:16');
    expect(copy.pieceId).toBe('piece-2');
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        detail: expect.objectContaining({ pieceId: 'piece-2', pieceRelayout: null }),
      }),
    );
  });

  it('origem sem a peça original (só o snapshot): a peça nova nasce do título, sem cliente', async () => {
    source.pieceId = null;
    sourcePiece = null;
    await service.duplicateProject(userId, 'p1', { aspectRatio: '4:5' });
    expect(savedPiece()).toMatchObject({ name: 'Vídeo das ofertas (4:5)', clientId: null });
    expect(savedProject()).toMatchObject({ pieceId: 'piece-2' });
  });

  it('rosto do logo: a caixa do logo da cópia vem do bloco do personagem re-layoutado', async () => {
    source.pieceSnapshot = fixturePieceDocument({ character: { mode: 'logo_face' } });
    const copy = await service.duplicateProject(userId, 'p1', { aspectRatio: '4:5' });
    const character = pieceBlock(copy.pieceSnapshot as McPieceDocument, 'character')!;
    expect(copy.logoBox).toMatchObject({
      x: character.rect.x,
      y: character.rect.y,
      w: character.rect.w,
      h: character.rect.h,
      logoBoxConfirmed: true,
      logoBoxSource: 'layout',
    });
  });

  it('sem pieceSnapshot na origem → 422 PIECE_SNAPSHOT_MISSING, nada salvo', async () => {
    source.pieceSnapshot = null;
    await expect(
      service.duplicateProject(userId, 'p1', { aspectRatio: '4:5' }),
    ).rejects.toMatchObject({
      response: { code: 'PIECE_SNAPSHOT_MISSING' },
    });
    await expect(service.duplicateProject(userId, 'p1', {})).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('formato sem peça (F1) não cria peça nem mexe em pieceId', async () => {
    source.format = 'talking_art';
    source.pieceId = null;
    source.pieceSnapshot = null;
    process.env.MC_FORMATS = 'talking_art';
    const copy = await service.duplicateProject(userId, 'p1', {});
    expect(savedPiece()).toBeUndefined();
    expect(copy.pieceId ?? null).toBeNull();
    expect(copy.pieceSnapshot ?? null).toBeNull();
  });
});
