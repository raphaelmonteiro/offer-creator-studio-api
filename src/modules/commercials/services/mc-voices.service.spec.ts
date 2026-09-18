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
      // o flag interno de curadoria não vai para o banco
      expect(rows[0]).not.toHaveProperty('curated');
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
          sort: 1,
        },
        {
          id: 'row-sarah',
          providerVoiceId: 'v-sarah',
          name: 'Sarah — Apresentadora',
          gender: 'female',
          style: 'institucional',
          enabled: true,
          sort: 1, // ordem antiga (era a 2ª de 6)
        },
      ]);
      await service.syncCatalog();
      const rows = voiceRepo.save.mock.calls[0][0] as Array<Record<string, unknown>>;
      // Laura: nada mudou → não é reescrita; Sarah: só a ordem → atualizada mantendo id/enabled
      expect(rows.map((r) => r.providerVoiceId)).toEqual(['v-liam', 'v-sarah', 'v-cloned']);
      const sarah = rows.find((r) => r.providerVoiceId === 'v-sarah');
      expect(sarah).toMatchObject({ id: 'row-sarah', enabled: true, sort: 6 });
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
          sort: 1,
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
      await service.resolveProviderVoiceId('FGY2WhTYpPnrIDTdsKH5');
      const where = voiceRepo.findOne.mock.calls.at(-1)?.[0]?.where;
      expect(where).toEqual([{ providerVoiceId: 'FGY2WhTYpPnrIDTdsKH5', enabled: true }]);
    });

    it('input em formato UUID consulta id OU providerVoiceId', async () => {
      voiceRepo.findOne.mockResolvedValueOnce({ providerVoiceId: 'voice-1' });
      await service.resolveProviderVoiceId('d85f1a8d-f6e9-413d-bf19-a42ba036f3e3');
      const where = voiceRepo.findOne.mock.calls.at(-1)?.[0]?.where;
      expect(where).toHaveLength(2);
    });

    it('voz fora do catálogo → 422 VOICE_NOT_IN_CATALOG', async () => {
      voiceRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.resolveProviderVoiceId('inexistente')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VOICE_NOT_IN_CATALOG' }),
      });
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
