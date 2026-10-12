import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService, InsufficientCreditsError } from '../../shared/credits/credits.service';
import { MediaAssetsService } from '../../shared/media-assets/media-assets.service';
import { AnimationQueueService } from '../../shared/queue/animation-queue.service';
import { summarizeRenderPreflight } from '../../shared/ffmpeg/render-preflight';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { WORKER_HEARTBEAT_KEY } from '../../shared/settings/worker-heartbeat.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { CommercialsService, MC_PAUSED_KEY } from './commercials.service';
import { MC_PROJECT_MINI_RESERVE_CREDITS } from './domain/mc-pricing.config';
import { CreateProjectDto } from './dto/create-project.dto';
import { McKitStatus } from './entities/mc-character-kit.entity';

/** Manager fake: create/save com id sequencial + findOneByOrFail em memória. */
function fakeManager() {
  const saved: Array<Record<string, unknown> & { id?: string }> = [];
  let seq = 0;
  const manager = {
    saved,
    create: jest.fn((_entity: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((obj: Record<string, unknown> & { id?: string }) => {
      if (!obj.id) obj.id = `id-${++seq}`;
      saved.push(obj);
      return Promise.resolve(obj);
    }),
    insert: jest.fn().mockResolvedValue(undefined),
    findOneByOrFail: jest.fn((_entity: unknown, { id }: { id: string }) =>
      Promise.resolve(saved.find((s) => s.id === id)),
    ),
  };
  return manager as unknown as EntityManager & typeof manager;
}

describe('CommercialsService.createProject — kill-switch + mini-reserva (plano §6.7)', () => {
  const originalMc = process.env.MC_CREDITS_ENABLED;
  const originalFormats = process.env.MC_FORMATS;
  const originalPipelineV2 = process.env.MC_PIPELINE_V2;
  const kit = { id: 'kit-1', userId: 'u1', status: McKitStatus.APPROVED, version: 1 };
  const dto: CreateProjectDto = {
    kitId: 'kit-1',
    title: 'Ofertas da semana',
    briefing: 'Mascote apresenta as ofertas',
    aspectRatio: '9:16',
    targetDurationS: 10,
  } as CreateProjectDto;

  let manager: ReturnType<typeof fakeManager>;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let settings: { get: jest.Mock; getFresh: jest.Mock };
  let credits: { reserve: jest.Mock; refundUnconsumed: jest.Mock };
  let mediaAssets: { findOwned: jest.Mock };
  let service: CommercialsService;

  beforeEach(() => {
    manager = fakeManager();
    dataSource = {
      getRepository: jest.fn(() => ({ findOneBy: jest.fn().mockResolvedValue(kit) })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) => cb(manager)),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    settings = {
      get: jest.fn().mockResolvedValue(null),
      getFresh: jest.fn().mockResolvedValue(null),
    };
    credits = {
      reserve: jest.fn().mockResolvedValue(undefined),
      refundUnconsumed: jest.fn().mockResolvedValue(0),
    };
    mediaAssets = {
      findOwned: jest.fn((_userId: string, id: string) =>
        Promise.resolve({ id, userId: 'u1', kind: 'video_art', fileUrl: '/uploads/art.png' }),
      ),
    };
    service = new CommercialsService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      settings as unknown as SystemSettingsService,
      credits as unknown as CreditsService,
      mediaAssets as unknown as MediaAssetsService,
    );
    delete process.env.MC_FORMATS;
    delete process.env.MC_PIPELINE_V2;
  });

  afterEach(() => {
    if (originalMc === undefined) delete process.env.MC_CREDITS_ENABLED;
    else process.env.MC_CREDITS_ENABLED = originalMc;
    if (originalFormats === undefined) delete process.env.MC_FORMATS;
    else process.env.MC_FORMATS = originalFormats;
    if (originalPipelineV2 === undefined) delete process.env.MC_PIPELINE_V2;
    else process.env.MC_PIPELINE_V2 = originalPipelineV2;
  });

  // ── admissão por formato e versão (change video-formatos-personagem, D6/D13, tarefa 4.2) ──
  describe('admissão dos formatos novos (MC_FORMATS × MC_PIPELINE_V2)', () => {
    const ART = '11111111-1111-4111-8111-111111111111';
    const f1 = { ...dto, format: 'talking_art' as const, backgroundArtAssetId: ART };

    it('formato desligado (MC_FORMATS vazio) → 422 FORMAT_NOT_ENABLED sem ler o kit, sem TTS, sem publish', async () => {
      process.env.MC_PIPELINE_V2 = 'all';
      await expect(service.createProject('u1', f1)).rejects.toMatchObject({
        status: 422,
        response: { code: 'FORMAT_NOT_ENABLED', details: { format: 'talking_art' } },
      });
      expect(dataSource.getRepository).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
      expect(mediaAssets.findOwned).not.toHaveBeenCalled();
    });

    it('formato ligado → projeto criado no executor v2 com format/tier/canal/arte explícitos e quality vazio', async () => {
      process.env.MC_FORMATS = 'talking_art';
      process.env.MC_PIPELINE_V2 = 'all';
      const project = await service.createProject('u1', {
        ...f1,
        aspectRatio: '4:5',
        tier: 'premium',
        channel: 'whatsapp',
        layoutPreset: 'canto_inferior_direito',
        logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        sourceArt: { kind: 'social', id: 'fl-1', pageIndex: 0, snapshotHash: 'h' },
      });
      expect(project).toMatchObject({
        pipelineVersion: 2,
        format: 'talking_art',
        tier: 'premium',
        channel: 'whatsapp',
        aspectRatio: '4:5',
        backgroundArtAssetId: ART,
        layoutPreset: 'canto_inferior_direito',
        logoBox: { x: 0.1, y: 0.8, w: 0.2, h: 0.1 },
        sourceArt: { kind: 'social', id: 'fl-1', pageIndex: 0, snapshotHash: 'h' },
        revision: 0,
        quality: expect.objectContaining({ budgets: [], timeline: null }),
      });
      expect(mediaAssets.findOwned).toHaveBeenCalledWith('u1', ART);
      expect(queue.publish).toHaveBeenCalledTimes(1);
    });

    it('`scenes` passa sempre, mesmo com MC_FORMATS vazio e MC_PIPELINE_V2=off (legado)', async () => {
      const project = await service.createProject('u1', { ...dto, format: 'scenes' });
      expect(project).toMatchObject({ format: 'scenes', pipelineVersion: 1, channel: 'instagram' });
    });

    it('MC_PIPELINE_V2=off + talking_art → 422 PIPELINE_V2_REQUIRED antes de qualquer escrita', async () => {
      process.env.MC_FORMATS = 'talking_art';
      process.env.MC_PIPELINE_V2 = 'off';
      await expect(service.createProject('u1', f1)).rejects.toMatchObject({
        status: 422,
        response: { code: 'PIPELINE_V2_REQUIRED', details: { format: 'talking_art' } },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('4:5 é aceito no talking_art (só o F3 recusa)', async () => {
      process.env.MC_FORMATS = 'talking_art';
      process.env.MC_PIPELINE_V2 = 'all';
      await expect(
        service.createProject('u1', { ...f1, aspectRatio: '4:5' }),
      ).resolves.toMatchObject({ aspectRatio: '4:5', format: 'talking_art' });
    });

    it('arte de fundo que não é `video_art` do usuário → 422 BACKGROUND_ART_INVALID; ausente → BACKGROUND_ART_REQUIRED', async () => {
      process.env.MC_FORMATS = 'talking_art';
      process.env.MC_PIPELINE_V2 = 'all';
      mediaAssets.findOwned.mockResolvedValueOnce({
        id: ART,
        kind: 'image',
        fileUrl: '/uploads/x',
      });
      await expect(service.createProject('u1', f1)).rejects.toMatchObject({
        status: 422,
        response: { code: 'BACKGROUND_ART_INVALID', details: { assetId: ART, kind: 'image' } },
      });
      const { backgroundArtAssetId: _omit, ...withoutArt } = f1;
      await expect(
        service.createProject('u1', withoutArt as CreateProjectDto),
      ).rejects.toMatchObject({ status: 422, response: { code: 'BACKGROUND_ART_REQUIRED' } });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('admitProjectFormat é reutilizável (createFromArt): devolve v2 para os formatos novos e a coorte para scenes', () => {
      process.env.MC_FORMATS = 'talking_art';
      process.env.MC_PIPELINE_V2 = 'all';
      expect(service.admitProjectFormat('u1', 'talking_art')).toBe(2);
      process.env.MC_PIPELINE_V2 = 'cohort';
      process.env.MC_PIPELINE_V2_USERS = 'u9';
      expect(service.admitProjectFormat('u1', 'scenes')).toBe(1);
      expect(() => service.admitProjectFormat('u1', 'talking_art')).toThrow(HttpException);
      delete process.env.MC_PIPELINE_V2_USERS;
    });
  });

  it('mc_paused=true → 503 MC_PAUSED, nada criado nem enfileirado', async () => {
    settings.get.mockResolvedValue(true);
    const promise = service.createProject('u1', dto);
    await expect(promise).rejects.toThrow(HttpException);
    await promise.catch((err: HttpException) => {
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({
        code: 'MC_PAUSED',
        message: 'Geração de comerciais pausada temporariamente pelo administrador',
      });
    });
    expect(settings.get).toHaveBeenCalledWith(MC_PAUSED_KEY);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('mc_paused ausente (null) não pausa', async () => {
    settings.get.mockResolvedValue(null);
    await expect(service.createProject('u1', dto)).resolves.toBeDefined();
    expect(queue.publish).toHaveBeenCalledTimes(1);
  });

  // Aspecto × formato (video-formatos-personagem, design D12): o F3 monta em 720p e recusa 4:5.
  it('formato scenes + aspecto 4:5 → 422 ASPECT_NOT_SUPPORTED_FOR_FORMAT antes de ler o kit ou gastar', async () => {
    const promise = service.createProject('u1', { ...dto, aspectRatio: '4:5' });
    await expect(promise).rejects.toThrow(HttpException);
    await promise.catch((err: HttpException) => {
      expect(err.getStatus()).toBe(422);
      expect(err.getResponse()).toMatchObject({
        code: 'ASPECT_NOT_SUPPORTED_FOR_FORMAT',
        details: { format: 'scenes', aspectRatio: '4:5' },
      });
    });
    expect(settings.getFresh).not.toHaveBeenCalled();
    expect(dataSource.getRepository).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('projeto nasce com format=scenes e tier=economico explícitos (mesmos defaults da migration)', async () => {
    await service.createProject('u1', dto);
    const project = manager.saved.find((row) => row.title === dto.title);
    expect(project).toMatchObject({ format: 'scenes', tier: 'economico', aspectRatio: '9:16' });
  });

  it('aspectRatio omitido cai em 9:16 (contrato v1-B1) e passa pela regra do formato', async () => {
    const { aspectRatio: _omit, ...withoutAspect } = dto;
    await expect(
      service.createProject('u1', withoutAspect as CreateProjectDto),
    ).resolves.toBeDefined();
    const project = manager.saved.find((row) => row.title === dto.title);
    expect(project).toMatchObject({ aspectRatio: '9:16', format: 'scenes' });
  });

  // Preflight por formato (spec video-composition-render / design D14)
  const heartbeatWith = (checks: Array<{ id: string; ok: boolean }>) => ({
    at: new Date().toISOString(),
    pid: 1,
    render: summarizeRenderPreflight(
      checks.map((c) => ({
        ...c,
        version: c.ok ? c.id : null,
        detail: c.ok ? undefined : `${c.id}: não encontrado`,
      })) as never,
      '2026-10-12T00:00:00.000Z',
    ),
  });

  it('worker sem ffmpeg → 422 RENDER_UNAVAILABLE para os formatos novos, com o motivo', async () => {
    settings.getFresh.mockResolvedValue(
      heartbeatWith([
        { id: 'ffmpeg', ok: false },
        { id: 'ffprobe', ok: true },
        { id: 'fonts', ok: true },
      ]),
    );
    const promise = service.assertRenderAvailable('talking_art');
    await expect(promise).rejects.toThrow(HttpException);
    await promise.catch((err: HttpException) => {
      expect(err.getStatus()).toBe(422);
      expect(err.getResponse()).toMatchObject({
        code: 'RENDER_UNAVAILABLE',
        details: {
          format: 'talking_art',
          missing: ['ffmpeg'],
          details: { ffmpeg: 'ffmpeg: não encontrado' },
        },
      });
    });
    expect(settings.getFresh).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY);
  });

  it('o formato de cenas (F3) NÃO é gated pelo preflight: cria mesmo sem ffmpeg no worker', async () => {
    settings.getFresh.mockResolvedValue(
      heartbeatWith([
        { id: 'ffmpeg', ok: false },
        { id: 'ffprobe', ok: true },
        { id: 'fonts', ok: true },
      ]),
    );
    await expect(service.createProject('u1', dto)).resolves.toBeDefined();
    expect(queue.publish).toHaveBeenCalledTimes(1);
  });

  it('só o navegador ausente não bloqueia o formato de cenas', async () => {
    settings.getFresh.mockResolvedValue(
      heartbeatWith([
        { id: 'ffmpeg', ok: true },
        { id: 'ffprobe', ok: true },
        { id: 'fonts', ok: true },
        { id: 'browser', ok: false },
      ]),
    );
    await expect(service.createProject('u1', dto)).resolves.toBeDefined();
    await expect(service.assertRenderAvailable('offer_carousel')).rejects.toMatchObject({
      response: { code: 'RENDER_UNAVAILABLE', details: { missing: ['browser'] } },
    });
  });

  it('preflight desconhecido (sem heartbeat ou sem tabela) não bloqueia', async () => {
    settings.getFresh.mockResolvedValue({ at: new Date().toISOString(), pid: 1 });
    await expect(service.createProject('u1', dto)).resolves.toBeDefined();
    settings.getFresh.mockRejectedValue(new Error('relation system_settings does not exist'));
    await expect(service.createProject('u1', dto)).resolves.toBeDefined();
  });

  it('família commercials LIGADA: mini-reserva de 10 cr no create, na mesma transação do enqueue', async () => {
    process.env.MC_CREDITS_ENABLED = 'true';
    const project = (await service.createProject('u1', dto)) as unknown as {
      id: string;
      reservedCredits: number;
    };

    expect(project.reservedCredits).toBe(MC_PROJECT_MINI_RESERVE_CREDITS);
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.reserve).toHaveBeenCalledWith(
      manager, // mesmo EntityManager da transação do enqueue
      'u1',
      project.id, // projectId como ref do ledger (coluna taskId é livre, sem FK)
      MC_PROJECT_MINI_RESERVE_CREDITS,
    );
    // reserva acontece ANTES do publish: 402 aborta sem enfileirar
    const reserveOrder = credits.reserve.mock.invocationCallOrder[0];
    const publishOrder = queue.publish.mock.invocationCallOrder[0];
    expect(reserveOrder).toBeLessThan(publishOrder);
  });

  it('família commercials DESLIGADA (default): reserva 0 e projeto sem débito', async () => {
    delete process.env.MC_CREDITS_ENABLED;
    const project = (await service.createProject('u1', dto)) as unknown as {
      reservedCredits: number;
    };
    expect(project.reservedCredits).toBe(0);
    // reserve(…, 0) é no-op por contrato do CreditsService (nenhuma linha no ledger)
    expect(credits.reserve).toHaveBeenCalledWith(manager, 'u1', expect.any(String), 0);
  });

  it('saldo insuficiente → 402 INSUFFICIENT_CREDITS propaga e nada é enfileirado', async () => {
    process.env.MC_CREDITS_ENABLED = 'true';
    credits.reserve.mockRejectedValue(new InsufficientCreditsError(3, 10));
    await expect(service.createProject('u1', dto)).rejects.toThrow(InsufficientCreditsError);
    expect(queue.publish).not.toHaveBeenCalled();
  });
});
