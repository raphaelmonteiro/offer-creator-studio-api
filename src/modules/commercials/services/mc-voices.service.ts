import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ElevenLabsProvider, ElevenLabsVoice } from '../../../shared/providers/elevenlabs.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { VoiceCatalogEntry } from '../../../shared/voice/voice-catalog.entity';
import { VoicePreviewDto } from '../dto/voice-preview.dto';

/** Modelo preferido do preview (melhor pt-BR + tags de emoção, plano §5.3) e fallback. */
export const VOICE_PREVIEW_MODEL = 'eleven_v3';
export const VOICE_PREVIEW_FALLBACK_MODEL = 'eleven_multilingual_v2';

/** Teto diário de previews por usuário — preview é degustação, não produção. */
export const VOICE_PREVIEW_DAILY_LIMIT = 5;

/**
 * Curadoria: 6 vozes PREMADE da ElevenLabs adequadas a pt-BR de varejo
 * (multilingual/v3 falam pt-BR com qualquer voz premade; a curadoria é de
 * TIMBRE). `match` casa com o nome oficial no GET /v1/voices — os voice_ids
 * reais vêm da API na hora do seed, nunca hardcoded.
 */
const CURATED_VOICES: ReadonlyArray<{
  match: string;
  name: string;
  gender: string;
  style: string;
}> = [
  { match: 'laura', name: 'Laura — Animada', gender: 'female', style: 'animada' },
  { match: 'sarah', name: 'Sarah — Apresentadora', gender: 'female', style: 'institucional' },
  { match: 'george', name: 'George — Locutor Grave', gender: 'male', style: 'locutor' },
  { match: 'charlie', name: 'Charlie — Descontraído', gender: 'male', style: 'descontraído' },
  { match: 'alice', name: 'Alice — Clara e Confiante', gender: 'female', style: 'confiante' },
  { match: 'brian', name: 'Brian — Institucional', gender: 'male', style: 'institucional' },
];

/**
 * Voz do módulo de comerciais (plano §4/§5.3): catálogo curado (voice_catalog,
 * tabela COMPARTILHADA — entity extraída para src/shared/voice/), preview de
 * TTS com cache por hash e teto diário.
 *
 * DECISÕES DOCUMENTADAS:
 * - Cache do preview: hash local sha256(voiceId|texto) como NOME DO ARQUIVO em
 *   uploads/commercials/voice-previews/ — o TtsCacheService do animations não
 *   é acessível (mora em modules/animations, boundary de lint) e mover uma
 *   cadeia de cache inteira por causa de um preview seria peso demais; arquivo
 *   existente = cache hit, sem tabela nova.
 * - Contagem diária: em system_settings (UMA chave por usuário com
 *   {date, count}, resetada quando o dia vira) — sobrevive a restart e vale
 *   entre processos, o que contagem em memória não dá; leitura via getFresh
 *   (o cache de 10s do get subestimaria a contagem em cliques rápidos).
 *   Cache hit NÃO conta no teto (não gasta API).
 */
@Injectable()
export class McVoicesService {
  private readonly logger = new Logger(McVoicesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly elevenLabs: ElevenLabsProvider,
    private readonly settings: SystemSettingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Seed idempotente do voice_catalog: SÓ roda com a tabela vazia; resolve os
   * voice_ids reais no GET /v1/voices da ElevenLabs. Falha de API não derruba
   * o boot — loga e tenta na próxima subida (a tabela segue vazia).
   */
  async seedIfEmpty(): Promise<void> {
    const repo = this.dataSource.getRepository(VoiceCatalogEntry);
    try {
      if ((await repo.count()) > 0) return;
      const voices = await this.elevenLabs.listVoices();
      if (voices.length === 0) {
        this.logger.warn('Seed do voice_catalog: API não retornou vozes — nada inserido.');
        return;
      }
      const rows = this.pickCuratedVoices(voices);
      if (rows.length === 0) {
        this.logger.warn('Seed do voice_catalog: nenhuma voz premade utilizável — nada inserido.');
        return;
      }
      await repo.save(rows);
      this.logger.log(`voice_catalog populado com ${rows.length} vozes ElevenLabs premade.`);
    } catch (err) {
      this.logger.warn(`Seed do voice_catalog falhou (segue vazio): ${(err as Error).message}`);
    }
  }

  /** Catálogo curado habilitado — o que a UI de escolha de voz do kit lista. */
  async list(): Promise<VoiceCatalogEntry[]> {
    return this.dataSource.getRepository(VoiceCatalogEntry).find({
      where: { enabled: true },
      order: { sort: 'ASC', name: 'ASC' },
    });
  }

  /**
   * Resolve o identificador vindo do cliente para o voice_id REAL da
   * ElevenLabs, aceitando tanto o id da linha do catálogo (o que a UI envia)
   * quanto o próprio providerVoiceId (compatibilidade com integrações/API).
   * Também é a guarda de curadoria: voz fora do catálogo habilitado → 422
   * (sem isso, qualquer voice_id da ElevenLabs viraria gasto de TTS).
   * Bug de origem: a ElevenLabs responde HTTP 400 "invalid_uid" para o UUID
   * do catálogo — era o erro do preview na primeira tentativa real da UI.
   */
  async resolveProviderVoiceId(idOrProviderId: string): Promise<string> {
    const repo = this.dataSource.getRepository(VoiceCatalogEntry);
    // A coluna `id` é uuid: consultar {id: 'FGY2...'} com um providerVoiceId
    // não-UUID faz o Postgres estourar no cast ANTES de avaliar o OR
    // ("invalid input syntax for type uuid" — pego em produção real). Só
    // incluímos o ramo do id quando o input TEM formato de UUID.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrProviderId,
    );
    const entry = await repo.findOne({
      where: isUuid
        ? [
            { id: idOrProviderId, enabled: true },
            { providerVoiceId: idOrProviderId, enabled: true },
          ]
        : [{ providerVoiceId: idOrProviderId, enabled: true }],
    });
    if (!entry) {
      throw new HttpException(
        {
          code: 'VOICE_NOT_IN_CATALOG',
          message: 'Voz não encontrada no catálogo — escolha uma voz da lista.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return entry.providerVoiceId;
  }

  /**
   * Preview de TTS: eleven_v3 com fallback multilingual_v2 (plano §5.3),
   * cache por hash, teto de 5/usuário/dia (cache hit não conta).
   */
  async preview(userId: string, dto: VoicePreviewDto): Promise<{ url: string; cached: boolean }> {
    const text = dto.text.trim();
    const providerVoiceId = await this.resolveProviderVoiceId(dto.voiceId);
    const hash = createHash('sha256').update(`${providerVoiceId}|${text}`).digest('hex');
    const relative = `/uploads/commercials/voice-previews/${hash}.mp3`;
    const absolute = this.uploadsAbsolute(relative);

    if (await this.fileExists(absolute)) {
      return { url: relative, cached: true };
    }

    await this.assertDailyLimit(userId);

    let audio: Buffer;
    try {
      audio = await this.elevenLabs.synthesize({
        text,
        voiceId: providerVoiceId,
        modelId: VOICE_PREVIEW_MODEL,
      });
    } catch (err) {
      // Terminal no v3 (modelo indisponível na conta, voz incompatível…) →
      // tenta o multilingual_v2. Transiente já foi re-tentado no provider.
      if (!(err instanceof TerminalProviderError)) throw err;
      this.logger.warn(`Preview com ${VOICE_PREVIEW_MODEL} falhou (${err.message}) — fallback.`);
      audio = await this.elevenLabs.synthesize({
        text,
        voiceId: providerVoiceId,
        modelId: VOICE_PREVIEW_FALLBACK_MODEL,
      });
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, audio);
    await this.bumpDailyCount(userId);
    return { url: relative, cached: false };
  }

  // ─────────────────────────────── internos ───────────────────────────────

  /** Casa a curadoria com as vozes reais; completa com premade restantes até 6. */
  private pickCuratedVoices(voices: ElevenLabsVoice[]): Array<Partial<VoiceCatalogEntry>> {
    const premade = voices.filter((v) => !v.category || v.category === 'premade');
    const pool = premade.length > 0 ? premade : voices;
    const used = new Set<string>();
    const rows: Array<Partial<VoiceCatalogEntry>> = [];

    for (const curated of CURATED_VOICES) {
      const found = pool.find(
        (v) => v.name?.toLowerCase().startsWith(curated.match) && !used.has(v.voice_id),
      );
      if (!found) continue;
      used.add(found.voice_id);
      rows.push({
        providerVoiceId: found.voice_id,
        name: curated.name,
        language: 'pt-BR',
        gender: curated.gender,
        style: curated.style,
        enabled: true,
        sort: rows.length,
      });
    }
    // Conta sem alguma voz da curadoria? Completa com outras premade até 6,
    // com o nome original — melhor um catálogo cheio do que um buraco na UI.
    for (const voice of pool) {
      if (rows.length >= CURATED_VOICES.length) break;
      if (used.has(voice.voice_id)) continue;
      used.add(voice.voice_id);
      rows.push({
        providerVoiceId: voice.voice_id,
        name: voice.name,
        language: 'pt-BR',
        gender: voice.labels?.gender ?? null,
        style: voice.labels?.use_case ?? null,
        enabled: true,
        sort: rows.length,
      });
    }
    return rows;
  }

  private settingsKey(userId: string): string {
    return `mc_voice_previews:${userId}`;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async assertDailyLimit(userId: string): Promise<void> {
    const entry = await this.settings.getFresh<{ date: string; count: number }>(
      this.settingsKey(userId),
    );
    const count = entry?.date === this.today() ? entry.count : 0;
    if (count >= VOICE_PREVIEW_DAILY_LIMIT) {
      throw new HttpException(
        {
          code: 'VOICE_PREVIEW_LIMIT',
          message: `Limite de ${VOICE_PREVIEW_DAILY_LIMIT} previews de voz por dia atingido. Tente novamente amanhã.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async bumpDailyCount(userId: string): Promise<void> {
    const key = this.settingsKey(userId);
    const entry = await this.settings.getFresh<{ date: string; count: number }>(key);
    const count = entry?.date === this.today() ? entry.count : 0;
    await this.settings.set(key, { date: this.today(), count: count + 1 });
  }

  private uploadsAbsolute(relativeUrl: string): string {
    const uploadsDir = path.resolve(this.config.get<string>('UPLOAD_DEST', './uploads'));
    return path.join(uploadsDir, relativeUrl.replace(/^\/uploads\//, ''));
  }

  private async fileExists(absolute: string): Promise<boolean> {
    try {
      await fs.access(absolute);
      return true;
    } catch {
      return false;
    }
  }
}
