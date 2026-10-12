import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ElevenLabsProvider } from '../../../shared/providers/elevenlabs.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import {
  MC_VOICE_DELIVERY_DEFAULT,
  elevenLabsVoiceSettings,
  voiceDeliveryKey,
} from '../domain/mc-voice-delivery';
import {
  CURATED_VOICES,
  McVoicesService,
  VOICE_PREVIEW_DAILY_LIMIT,
  VOICE_PREVIEW_FALLBACK_MODEL,
  VOICE_PREVIEW_MODEL,
} from './mc-voices.service';

describe('McVoicesService — seed do catálogo + preview de TTS (plano §5.3)', () => {
  let tmpDir: string;
  const today = new Date().toISOString().slice(0, 10);

  let voiceRepo: { count: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock };
  let dataSource: { getRepository: jest.Mock };
  let elevenLabs: { listVoices: jest.Mock; synthesize: jest.Mock };
  let settings: { getFresh: jest.Mock; set: jest.Mock };
  let config: { get: jest.Mock };
  let service: McVoicesService;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-voices-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    voiceRepo = {
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([]),
      // resolveProviderVoiceId: 'voice-1' do catálogo resolve para si mesmo
      // (nos testes o dto já usa o id do provider)
      findOne: jest.fn().mockResolvedValue({ providerVoiceId: 'voice-1' }),
    };
    dataSource = { getRepository: jest.fn(() => voiceRepo) };
    elevenLabs = {
      listVoices: jest.fn().mockResolvedValue([]),
      synthesize: jest.fn().mockResolvedValue(Buffer.from('mp3-bytes')),
    };
    settings = {
      getFresh: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    service = new McVoicesService(
      dataSource as unknown as DataSource,
      elevenLabs as unknown as ElevenLabsProvider,
      settings as unknown as SystemSettingsService,
      config as unknown as ConfigService,
    );
  });

  describe('syncCatalog (aditivo e idempotente)', () => {
    const account = [
      { voice_id: 'v-laura', name: 'Laura - Enthusiast', category: 'premade' },
      { voice_id: 'v-sarah', name: 'Sarah - Mature', category: 'premade' },
      { voice_id: 'v-liam', name: 'Liam - Energetic', category: 'premade' },
      {
        voice_id: 'v-cloned',
        name: 'Locutor da Rede',
        category: 'cloned',
        labels: { gender: 'male' },
      },
    ];

    it('tabela vazia: insere TODAS as vozes da conta — curadas primeiro (nome pt-BR, ordem da curadoria), depois as demais com o nome original', async () => {
      elevenLabs.listVoices.mockResolvedValue(account);
      await service.syncCatalog();
      expect(voiceRepo.save).toHaveBeenCalledTimes(1);
      const rows = voiceRepo.save.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.providerVoiceId)).toEqual([
        'v-liam',
        'v-laura',
        'v-sarah',
        'v-cloned',
      ]);
      expect(rows[0]).toMatchObject({ name: 'Liam — Jovem e Energético', gender: 'male', sort: 0 });
      expect(rows[1]).toMatchObject({ name: 'Laura — Animada', language: 'pt-BR' });
      // fora da curadoria: nome original, ordenada depois de todas as curadas
      expect(rows[3]).toMatchObject({ name: 'Locutor da Rede', gender: 'male', enabled: true });
      expect(rows[3].sort as number).toBeGreaterThan(CURATED_VOICES.length);
      // D10: `curated` é PERSISTIDO — true nas curadas, false nas demais; o sync
      // nunca atribui dono (não sabe para quem um clone foi feito)
      expect(rows.slice(0, 3).every((r) => r.curated === true)).toBe(true);
      expect(rows[3]).toMatchObject({ curated: false });
      expect(rows.some((r) => 'ownerUserId' in r)).toBe(false);
    });

    it('tabela já populada: só insere o que falta, aplica nome/ordem da curadoria e PRESERVA id/enabled', async () => {
      elevenLabs.listVoices.mockResolvedValue(account);
      voiceRepo.find.mockResolvedValue([
        {
          id: 'row-laura',
          providerVoiceId: 'v-laura',
          name: 'Laura — Animada',
          gender: 'female',
          style: 'animada',
          enabled: false, // admin tirou do ar
          curated: true,
          sort: 1,
        },
        {
          id: 'row-sarah',
          providerVoiceId: 'v-sarah',
          name: 'Sarah — Apresentadora',
          gender: 'female',
          style: 'institucional',
          enabled: true,
          curated: true,
          sort: 1, // ordem antiga (era a 2ª de 6)
        },
      ]);
      await service.syncCatalog();
      const rows = voiceRepo.save.mock.calls[0][0] as Array<Record<string, unknown>>;
      // Laura: nada mudou → não é reescrita; Sarah: só a ordem → atualizada mantendo id/enabled
      expect(rows.map((r) => r.providerVoiceId)).toEqual(['v-liam', 'v-sarah', 'v-cloned']);
      const sarah = rows.find((r) => r.providerVoiceId === 'v-sarah');
      expect(sarah).toMatchObject({ id: 'row-sarah', enabled: true, curated: true, sort: 6 });
      expect(rows.find((r) => r.providerVoiceId === 'v-laura')).toBeUndefined();
    });

    it('tudo sincronizado ⇒ não grava nada (idempotente)', async () => {
      elevenLabs.listVoices.mockResolvedValue([account[0]]);
      voiceRepo.find.mockResolvedValue([
        {
          id: 'row-laura',
          providerVoiceId: 'v-laura',
          name: 'Laura — Animada',
          gender: 'female',
          style: 'animada',
          enabled: true,
          curated: true,
          sort: 1,
        },
      ]);
      await service.syncCatalog();
      expect(voiceRepo.save).not.toHaveBeenCalled();
    });

    it('D10: linha curada antiga sem o flag (anterior à migration) recebe curated = true no próximo sync, preservando id/enabled/dono', async () => {
      elevenLabs.listVoices.mockResolvedValue([account[0]]);
      voiceRepo.find.mockResolvedValue([
        {
          id: 'row-laura',
          providerVoiceId: 'v-laura',
          name: 'Laura — Animada',
          gender: 'female',
          style: 'animada',
          enabled: false,
          curated: false,
          ownerUserId: null,
          sort: 1,
        },
      ]);
      await service.syncCatalog();
      const rows = voiceRepo.save.mock.calls[0][0] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'row-laura',
        enabled: false,
        curated: true,
        ownerUserId: null,
        sort: 1,
      });
    });

    it('D10: voz fora da curadoria promovida pelo admin (curated = true) ou com dono NÃO é rebaixada nem reescrita pelo sync', async () => {
      elevenLabs.listVoices.mockResolvedValue([account[3]]);
      voiceRepo.find.mockResolvedValue([
        {
          id: 'row-cloned',
          providerVoiceId: 'v-cloned',
          name: 'Locutor da Rede',
          gender: 'male',
          style: null,
          enabled: true,
          curated: true, // promoção manual
          ownerUserId: 'u1',
          sort: 100,
        },
      ]);
      await service.syncCatalog();
      expect(voiceRepo.save).not.toHaveBeenCalled();
    });

    it('a curadoria cobre as 21 vozes premade padrão da ElevenLabs, as mais animadas primeiro', () => {
      expect(CURATED_VOICES).toHaveLength(21);
      expect(new Set(CURATED_VOICES.map((v) => v.match)).size).toBe(21);
      expect(CURATED_VOICES.slice(0, 4).map((v) => v.match)).toEqual([
        'liam',
        'laura',
        'jessica',
        'charlie',
      ]);
    });

    it('falha da API não derruba o boot e não altera nada (tenta na próxima subida)', async () => {
      elevenLabs.listVoices.mockRejectedValue(new Error('rede fora'));
      await expect(service.syncCatalog()).resolves.toBeUndefined();
      expect(voiceRepo.save).not.toHaveBeenCalled();
    });

    it('API sem vozes ⇒ nada apagado, nada inserido', async () => {
      elevenLabs.listVoices.mockResolvedValue([]);
      await service.syncCatalog();
      expect(voiceRepo.find).not.toHaveBeenCalled();
      expect(voiceRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('resolveProviderVoiceId', () => {
    it('REGRESSÃO: input não-UUID (providerVoiceId) NUNCA consulta a coluna id — o cast uuid do Postgres estoura antes do OR', async () => {
      voiceRepo.findOne.mockResolvedValueOnce({ providerVoiceId: 'FGY2WhTYpPnrIDTdsKH5' });
      await service.resolveProviderVoiceId('u1', 'FGY2WhTYpPnrIDTdsKH5');
      const where = voiceRepo.findOne.mock.calls.at(-1)?.[0]?.where as Array<
        Record<string, unknown>
      >;
      // D10: cada alternativa é escopada ao tenant (curada OU do usuário), sempre habilitada
      expect(where).toEqual([
        { providerVoiceId: 'FGY2WhTYpPnrIDTdsKH5', enabled: true, curated: true },
        { providerVoiceId: 'FGY2WhTYpPnrIDTdsKH5', enabled: true, ownerUserId: 'u1' },
      ]);
      expect(where.some((w) => 'id' in w)).toBe(false);
    });

    it('input em formato UUID consulta id OU providerVoiceId (cada um escopado ao tenant)', async () => {
      voiceRepo.findOne.mockResolvedValueOnce({ providerVoiceId: 'voice-1' });
      const uuid = 'd85f1a8d-f6e9-413d-bf19-a42ba036f3e3';
      await service.resolveProviderVoiceId('u1', uuid);
      const where = voiceRepo.findOne.mock.calls.at(-1)?.[0]?.where as Array<
        Record<string, unknown>
      >;
      expect(where).toHaveLength(4);
      expect(where).toEqual(
        expect.arrayContaining([
          { id: uuid, enabled: true, curated: true },
          { id: uuid, enabled: true, ownerUserId: 'u1' },
          { providerVoiceId: uuid, enabled: true, curated: true },
          { providerVoiceId: uuid, enabled: true, ownerUserId: 'u1' },
        ]),
      );
    });

    it('voz fora do catálogo → 422 VOICE_NOT_IN_CATALOG', async () => {
      voiceRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.resolveProviderVoiceId('u1', 'inexistente')).rejects.toMatchObject({
        status: 422,
        response: expect.objectContaining({ code: 'VOICE_NOT_IN_CATALOG' }),
      });
    });
  });

  /**
   * Cenários da spec `video-character-kit` ("Vozes visíveis por tenant"):
   * repositório em memória que avalia o `where` do TypeORM (array = OR entre
   * alternativas; objeto = AND entre chaves) sobre um catálogo fixo — o
   * resultado de list/resolve é verificado de ponta a ponta, não só a consulta.
   */
  describe('visibilidade por tenant (D10) — list e resolveProviderVoiceId', () => {
    const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const catalog = [
      {
        id: uuidOf(1),
        providerVoiceId: 'pv-liam',
        name: 'Liam — Jovem',
        enabled: true,
        curated: true,
        ownerUserId: null,
        sort: 0,
      },
      {
        id: uuidOf(2),
        providerVoiceId: 'pv-laura',
        name: 'Laura — Animada',
        enabled: true,
        curated: true,
        ownerUserId: null,
        sort: 1,
      },
      {
        id: uuidOf(3),
        providerVoiceId: 'pv-off',
        name: 'Fora do ar',
        enabled: false,
        curated: true,
        ownerUserId: null,
        sort: 2,
      },
      {
        id: uuidOf(4),
        providerVoiceId: 'pv-mine',
        name: 'Clone do u1',
        enabled: true,
        curated: false,
        ownerUserId: 'u1',
        sort: 100,
      },
      {
        id: uuidOf(5),
        providerVoiceId: 'pv-theirs',
        name: 'Clone do u2',
        enabled: true,
        curated: false,
        ownerUserId: 'u2',
        sort: 101,
      },
      {
        id: uuidOf(6),
        providerVoiceId: 'pv-orphan',
        name: 'Voice Library',
        enabled: true,
        curated: false,
        ownerUserId: null,
        sort: 102,
      },
    ];
    const matches = (row: Record<string, unknown>, where: unknown): boolean => {
      const alternatives = Array.isArray(where) ? where : [where];
      return alternatives.some((alt) =>
        Object.entries(alt as Record<string, unknown>).every(([k, v]) => row[k] === v),
      );
    };

    beforeEach(() => {
      voiceRepo.find.mockImplementation(async ({ where }: { where: unknown }) =>
        catalog.filter((r) => matches(r, where)),
      );
      voiceRepo.findOne.mockImplementation(
        async ({ where }: { where: unknown }) => catalog.find((r) => matches(r, where)) ?? null,
      );
    });

    it('voz curada: todas as curadas habilitadas aparecem na lista de qualquer usuário e resolvem', async () => {
      const ids = (await service.list('u3')).map((v) => v.providerVoiceId);
      expect(ids).toEqual(['pv-liam', 'pv-laura']);
      await expect(service.resolveProviderVoiceId('u3', uuidOf(1))).resolves.toBe('pv-liam');
      await expect(service.resolveProviderVoiceId('u3', 'pv-laura')).resolves.toBe('pv-laura');
    });

    it('voz de outro tenant: não aparece na lista deste usuário e um kit que a referencie é recusado com VOICE_NOT_IN_CATALOG', async () => {
      const ids = (await service.list('u1')).map((v) => v.providerVoiceId);
      expect(ids).toContain('pv-mine');
      expect(ids).not.toContain('pv-theirs');
      // pelo id do catálogo e pelo providerVoiceId — os dois formatos que approveKit/preview/worker aceitam
      for (const input of [uuidOf(5), 'pv-theirs']) {
        await expect(service.resolveProviderVoiceId('u1', input)).rejects.toMatchObject({
          status: 422,
          response: expect.objectContaining({ code: 'VOICE_NOT_IN_CATALOG' }),
        });
      }
      // para o dono, a mesma voz resolve
      await expect(service.resolveProviderVoiceId('u2', uuidOf(5))).resolves.toBe('pv-theirs');
    });

    it('voz não curada sem dono (Voice Library): oculta para todos e recusada em kit, até um admin marcá-la como curada', async () => {
      for (const userId of ['u1', 'u2', 'u3']) {
        const ids = (await service.list(userId)).map((v) => v.providerVoiceId);
        expect(ids).not.toContain('pv-orphan');
        expect(ids).not.toContain('pv-off');
        await expect(service.resolveProviderVoiceId(userId, 'pv-orphan')).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'VOICE_NOT_IN_CATALOG' }),
        });
      }
      // promoção pelo admin: curated = true → visível para todos
      catalog[5].curated = true;
      try {
        expect((await service.list('u3')).map((v) => v.providerVoiceId)).toContain('pv-orphan');
      } finally {
        catalog[5].curated = false;
      }
    });

    it('preview usa o resolve escopado: voz de outro dono não gera TTS nem conta no teto', async () => {
      await expect(
        service.preview('u1', { voiceId: 'pv-theirs', text: 'oi' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VOICE_NOT_IN_CATALOG' }),
      });
      expect(elevenLabs.synthesize).not.toHaveBeenCalled();
      expect(settings.set).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    const dto = { voiceId: 'voice-1', text: 'Ofertas imperdíveis!' };

    it('gera com o modelo principal (multilingual_v2 — obedece speed/style), salva o mp3 e conta no teto diário', async () => {
      const result = await service.preview('u1', dto);

      expect(elevenLabs.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: VOICE_PREVIEW_MODEL,
          voiceId: 'voice-1',
          // perfil de entrega (velocidade/expressividade) — o mesmo do TTS das cenas
          settings: elevenLabsVoiceSettings(MC_VOICE_DELIVERY_DEFAULT, VOICE_PREVIEW_MODEL),
        }),
      );
      expect(result.cached).toBe(false);
      expect(result.url).toMatch(/^\/uploads\/commercials\/voice-previews\/[a-f0-9]{64}\.mp3$/);
      const absolute = path.join(tmpDir, result.url.replace('/uploads/', ''));
      await expect(fs.readFile(absolute)).resolves.toEqual(Buffer.from('mp3-bytes'));
      expect(settings.set).toHaveBeenCalledWith('mc_voice_previews:u1', {
        date: today,
        count: 1,
      });
    });

    it('ajuste do usuário (velocidade/expressividade) vai ao provider e muda o cache', async () => {
      const result = await service.preview('u1', {
        ...dto,
        text: 'com ajuste',
        delivery: { speed: 1.2, style: 0.9 },
      });
      expect(elevenLabs.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ speed: 1.2, style: 0.9 }),
        }),
      );
      const plain = await service.preview('u1', { ...dto, text: 'com ajuste' });
      expect(plain.url).not.toBe(result.url);
    });

    it('erro terminal no principal → fallback (plano §5.3)', async () => {
      elevenLabs.synthesize
        .mockRejectedValueOnce(new TerminalProviderError('modelo indisponível'))
        .mockResolvedValueOnce(Buffer.from('mp3-v2'));
      const result = await service.preview('u1', { ...dto, text: 'fallback aqui' });

      expect(elevenLabs.synthesize).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ modelId: VOICE_PREVIEW_MODEL }),
      );
      expect(elevenLabs.synthesize).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ modelId: VOICE_PREVIEW_FALLBACK_MODEL }),
      );
      expect(result.cached).toBe(false);
    });

    it('cache hit por hash: devolve a URL sem chamar TTS e SEM contar no teto', async () => {
      const text = 'texto cacheado';
      const hash = createHash('sha256')
        .update(`voice-1|${voiceDeliveryKey(MC_VOICE_DELIVERY_DEFAULT)}|${text}`)
        .digest('hex');
      const dir = path.join(tmpDir, 'commercials', 'voice-previews');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${hash}.mp3`), Buffer.from('cached'));

      const result = await service.preview('u1', { voiceId: 'voice-1', text });
      expect(result).toEqual({
        url: `/uploads/commercials/voice-previews/${hash}.mp3`,
        cached: true,
      });
      expect(elevenLabs.synthesize).not.toHaveBeenCalled();
      expect(settings.set).not.toHaveBeenCalled();
    });

    it(`limite de ${VOICE_PREVIEW_DAILY_LIMIT}/dia → 429 VOICE_PREVIEW_LIMIT`, async () => {
      settings.getFresh.mockResolvedValue({ date: today, count: VOICE_PREVIEW_DAILY_LIMIT });
      // texto inédito: cache hit passaria ANTES do teto (e não conta nele)
      const promise = service.preview('u1', { ...dto, text: 'texto sem cache' });
      await expect(promise).rejects.toMatchObject({
        status: 429,
        response: { code: 'VOICE_PREVIEW_LIMIT' },
      });
      expect(elevenLabs.synthesize).not.toHaveBeenCalled();
    });

    it('contagem de ONTEM não vale hoje (reseta na virada do dia)', async () => {
      settings.getFresh.mockResolvedValue({ date: '2000-01-01', count: 99 });
      await expect(service.preview('u1', { ...dto, text: 'novo dia' })).resolves.toMatchObject({
        cached: false,
      });
      expect(settings.set).toHaveBeenCalledWith('mc_voice_previews:u1', {
        date: today,
        count: 1,
      });
    });
  });
});
