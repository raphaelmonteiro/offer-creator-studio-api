import { EntityManager } from 'typeorm';
import { CommercialsService } from '../commercials.service';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { McPieceProductsBlock, pieceCanonicalHash } from '../domain/mc-piece';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { computeRenderStillHash } from '../domain/mc-step-hashes';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { Font } from '../../fonts/entities/font.entity';
import { McMaterializerService } from './mc-materializer.service';

/** Manager fake em memória (mesmo desenho dos specs F1/F2): find/findOne por igualdade rasa, In() suportado. */
function fakeManager() {
  let seq = 0;
  const rows = new Map<unknown, Array<Record<string, unknown>>>();
  const table = (entity: unknown) => {
    if (!rows.has(entity)) rows.set(entity, []);
    return rows.get(entity)!;
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && '_type' in (v as object)) {
        return ((v as { _value: unknown[] })._value ?? []).includes(row[k]);
      }
      return row[k] === v;
    });
  const manager = {
    create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((obj: Record<string, unknown> & { id?: string }) => {
      if (!obj.id) obj.id = `id-${++seq}`;
      const list = table(McStep);
      const i = list.findIndex((r) => r.id === obj.id);
      if (i >= 0) list[i] = obj;
      else list.push(obj);
      return Promise.resolve(obj);
    }),
    update: jest.fn(
      (entity: unknown, where: Record<string, unknown>, patch: Record<string, unknown>) => {
        let affected = 0;
        for (const row of table(entity)) {
          if (matches(row, where)) {
            Object.assign(row, patch);
            affected += 1;
          }
        }
        return Promise.resolve({ affected });
      },
    ),
    find: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) =>
      Promise.resolve(table(entity).filter((r) => matches(r, options.where ?? {}))),
    ),
    findOne: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) =>
      Promise.resolve(table(entity).find((r) => matches(r, options.where ?? {})) ?? null),
    ),
    seed(entity: unknown, list: Array<Record<string, unknown>>) {
      rows.set(entity, list);
    },
    steps: () => table(McStep) as unknown as McStep[],
  };
  return manager as unknown as EntityManager & typeof manager;
}

const kit = {
  id: 'kit-1',
  userId: 'u1',
  version: 1,
  voiceId: 'voice-1',
  tileAssetId: 'tile-1',
  tileBackgroundColor: '#112233',
  identityMode: 'generated',
  source: 'mascot',
} as unknown as McCharacterKit;

function pieceScript(): McScript {
  // roteiro da peça: janela = rect do personagem, cor = painel, formato offer_piece
  return {
    ...fixtureTalkTileScript({ backgroundColor: '#FFE082' }),
    format: 'offer_piece',
    window: { x: 0.58, y: 0.6, w: 0.37, h: 0.28 },
  };
}

function pieceProject(over: Partial<McProject> = {}): McProject {
  return {
    id: 'proj-piece',
    userId: 'u1',
    kitId: 'kit-1',
    aspectRatio: '9:16',
    pipelineVersion: MC_PIPELINE_V2,
    revision: 1,
    tier: 'economico',
    format: 'offer_piece',
    channel: 'instagram',
    pieceId: 'piece-1',
    pieceSnapshot: fixturePieceDocument(),
    options: { musicEnabled: false, captionsEnabled: false, products: [] },
    ...over,
  } as unknown as McProject;
}

function readyScenes(script: McScript): McScene[] {
  return script.scenes.map(
    (s, i) =>
      ({
        id: `row-${i}`,
        projectId: 'proj-piece',
        idx: i,
        scriptSceneId: s.sceneId,
        generation: 1,
        status: McSceneStatus.READY,
        finalAssetId: `clip-${s.sceneId}`,
      }) as unknown as McScene,
  );
}

/** Tarefas 6.1/6.3/6.5 — cadeia de projeto da peça de ofertas no materializer. */
describe('McMaterializerService — cadeia da peça de ofertas (render_still → compose → finalize)', () => {
  const env = { ...process.env };
  let service: McMaterializerService;
  beforeEach(() => {
    process.env.MC_PIPELINE_PROVIDER = 'mock';
    process.env.MC_COMPOSITION_VERSION = '0.1.0';
    service = new McMaterializerService({
      appendEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as CommercialsService);
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const chainOf = (manager: ReturnType<typeof fakeManager>) =>
    manager
      .steps()
      .filter((s) => s.sceneId === null)
      .map((s) => ({
        type: s.type,
        status: s.status,
        phase: s.phase,
        attempt: s.attempt,
        hash: s.inputHash,
        credits: s.costCredits,
      }));

  it('cria render_still → compose_ffmpeg → finalize pendentes (sceneId null, fase assembly, mesmo attempt, 0 cr); o quadro leva o hash do descritor + versão + renderizador + fontes', async () => {
    const manager = fakeManager();
    manager.seed(McCharacterKit, [{ ...kit }]);
    const script = pieceScript();
    const project = pieceProject();
    const first = await service.ensureAssemblyStepV2(manager, project, script, readyScenes(script));
    expect(first.type).toBe(McStepType.RENDER_STILL);
    const chain = chainOf(manager);
    expect(chain.map((s) => [s.type, s.status, s.phase, s.attempt, s.credits])).toEqual([
      [McStepType.RENDER_STILL, McStepStatus.PENDING, 'assembly', 1, 0],
      [McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING, 'assembly', 1, 0],
      [McStepType.FINALIZE, McStepStatus.PENDING, 'assembly', 1, 0],
    ]);
    expect(chain[0].hash).toBe(
      computeRenderStillHash({
        pieceHash: pieceCanonicalHash(project.pieceSnapshot as never),
        aspectRatio: '9:16',
        compositionVersion: '0.1.0',
        renderer: 'mock',
        fonts: [],
      }),
    );
    expect(
      manager
        .steps()
        .some((s) => s.type === McStepType.ASSEMBLY || s.type === McStepType.RENDER_REMOTION),
    ).toBe(false);
  });

  it('fontes da conta citadas pelos textos entram no hash do quadro (arquivo da família)', async () => {
    const manager = fakeManager();
    manager.seed(McCharacterKit, [{ ...kit }]);
    manager.seed(Font, [
      { id: 'f1', family: 'Bebas Neue', fileUrl: '/uploads/fonts/bebas.ttf' },
      { id: 'f2', family: 'Outra', fileUrl: '/uploads/fonts/outra.ttf' },
    ]);
    const script = pieceScript();
    const snapshot = fixturePieceDocument({
      texts: [{ text: 'OFERTAS', fontFamily: 'Bebas Neue' }],
    });
    const project = pieceProject({ pieceSnapshot: snapshot } as Partial<McProject>);
    await service.ensureAssemblyStepV2(manager, project, script, readyScenes(script));
    expect(chainOf(manager)[0].hash).toBe(
      computeRenderStillHash({
        pieceHash: pieceCanonicalHash(snapshot),
        aspectRatio: '9:16',
        compositionVersion: '0.1.0',
        renderer: 'mock',
        fonts: [{ family: 'Bebas Neue', url: '/uploads/fonts/bebas.ttf' }],
      }),
    );
  });

  it('matriz de invalidação: só a fala muda ⇒ quadro igual, compose/finalize novos; só a peça muda ⇒ quadro, compose e finalize novos', async () => {
    const hashes = async (script: McScript, project: McProject, scenes: McScene[]) => {
      const manager = fakeManager();
      manager.seed(McCharacterKit, [{ ...kit }]);
      await service.ensureAssemblyStepV2(manager, project, script, scenes);
      const chain = chainOf(manager);
      return {
        still: chain[0].hash,
        compose: chain[1].hash,
        finalize: chain[2].hash,
      };
    };
    const script = pieceScript();
    const base = await hashes(script, pieceProject(), readyScenes(script));

    // outra fala gravada → outro clipe final → compose e finalize mudam; o quadro não
    const otherClips = readyScenes(script);
    otherClips[1].finalAssetId = 'clip-regravado';
    const spoken = await hashes(script, pieceProject(), otherClips);
    expect(spoken.still).toBe(base.still);
    expect(spoken.compose).not.toBe(base.compose);
    expect(spoken.finalize).not.toBe(base.finalize);

    // só a peça (foto de um produto) → quadro novo e compose novo, mesmos clipes
    const edited = fixturePieceDocument();
    (edited.blocks[0] as McPieceProductsBlock).items[1].imageUrl = '/uploads/gallery/outra.png';
    const visual = await hashes(
      script,
      pieceProject({ pieceSnapshot: edited } as Partial<McProject>),
      readyScenes(script),
    );
    expect(visual.still).not.toBe(base.still);
    expect(visual.compose).not.toBe(base.compose);

    // mesma peça e mesmos clipes → tudo igual (reaproveitamento por hash)
    const again = await hashes(script, pieceProject(), readyScenes(script));
    expect(again).toEqual(base);
  });

  it('repetir só atualiza os hashes dos pendentes; cadeia entregue ⇒ a próxima nasce com attempt 2', async () => {
    const manager = fakeManager();
    manager.seed(McCharacterKit, [{ ...kit }]);
    const script = pieceScript();
    const project = pieceProject();
    const scenes = readyScenes(script);
    await service.ensureAssemblyStepV2(manager, project, script, scenes);
    const before = chainOf(manager);
    await service.ensureAssemblyStepV2(manager, project, script, scenes);
    expect(chainOf(manager)).toEqual(before);

    // cor do painel diferente → compose novo, quadro igual (a cor da janela não está no quadro… está no descritor,
    // mas aqui só o roteiro mudou)
    await service.ensureAssemblyStepV2(
      manager,
      project,
      { ...script, talkBackgroundColor: '#000000' },
      scenes,
    );
    const recolored = chainOf(manager);
    expect(recolored).toHaveLength(3);
    expect(recolored[0].hash).toBe(before[0].hash);
    expect(recolored[1].hash).not.toBe(before[1].hash);

    for (const s of manager.steps().filter((x) => x.sceneId === null))
      s.status = McStepStatus.SUCCEEDED;
    await service.ensureAssemblyStepV2(manager, project, script, scenes);
    const pending = chainOf(manager).filter((s) => s.status === McStepStatus.PENDING);
    expect(pending.map((s) => [s.type, s.attempt])).toEqual([
      [McStepType.RENDER_STILL, 2],
      [McStepType.COMPOSE_FFMPEG, 2],
      [McStepType.FINALIZE, 2],
    ]);
  });

  it('projeto offer_piece sem pieceSnapshot é um erro de programação (nunca cria cadeia)', async () => {
    const manager = fakeManager();
    manager.seed(McCharacterKit, [{ ...kit }]);
    const script = pieceScript();
    await expect(
      service.ensureAssemblyStepV2(
        manager,
        pieceProject({ pieceSnapshot: null } as Partial<McProject>),
        script,
        readyScenes(script),
      ),
    ).rejects.toThrow(/pieceSnapshot/);
    expect(manager.steps()).toHaveLength(0);
  });
});
