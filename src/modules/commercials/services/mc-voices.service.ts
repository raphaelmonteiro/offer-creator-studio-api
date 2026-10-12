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
import { applyVoiceVisibility } from '../../../shared/voice/voice-visibility';
import { VoicePreviewDto } from '../dto/voice-preview.dto';
import {
  elevenLabsVoiceSettings,
  mergeVoiceDelivery,
  resolveVoiceDelivery,
  voiceDeliveryKey,
} from '../domain/mc-voice-delivery';

/** Modelo preferido do preview (melhor pt-BR + tags de emoção, plano §5.3) e fallback. */
// multilingual_v2 primeiro: é o modelo que OBEDECE velocidade/expressividade
// (o eleven_v3 ignora `speed`/`style` — medido em 17/09). Mesma cadeia do TTS.
export const VOICE_PREVIEW_MODEL = 'eleven_multilingual_v2';
export const VOICE_PREVIEW_FALLBACK_MODEL = 'eleven_v3';

/** Teto diário de previews por usuário — preview é degustação, não produção (21 vozes cabem num dia). */
export const VOICE_PREVIEW_DAILY_LIMIT = 40;

/**
 * Curadoria: TODAS as vozes premade da conta ElevenLabs com nome pt-BR
 * amigável, gênero e estilo (multilingual/v3 falam pt-BR com qualquer voz
 * premade; a curadoria é de TIMBRE). A ORDEM é a da UI: as mais animadas e
 * enérgicas primeiro (pedido do usuário: varejo quer energia). `match` casa
 * com o nome oficial no GET /v1/voices — os voice_ids reais vêm da API no
 * sync, nunca hardcoded. Vozes da conta fora desta lista (Voice Library,
 * clonadas) entram DEPOIS, com o nome original.
 */
export const CURATED_VOICES: ReadonlyArray<{
  match: string;
  name: string;
  gender: string;
  style: string;
}> = [
  { match: 'liam', name: 'Liam — Jovem e Energético', gender: 'male', style: 'energético' },
  { match: 'laura', name: 'Laura — Animada', gender: 'female', style: 'animada' },
  { match: 'jessica', name: 'Jessica — Alegre e Calorosa', gender: 'female', style: 'alegre' },
  { match: 'charlie', name: 'Charlie — Enérgico e Confiante', gender: 'male', style: 'enérgico' },
  { match: 'bill', name: 'Bill — Locutor de Ofertas', gender: 'male', style: 'propaganda' },
  { match: 'daniel', name: 'Daniel — Locutor de Rádio', gender: 'male', style: 'locutor' },
  { match: 'sarah', name: 'Sarah — Apresentadora', gender: 'female', style: 'institucional' },
  {
    match: 'bella',
    name: 'Bella — Profissional e Calorosa',
    gender: 'female',
    style: 'profissional',
  },
  { match: 'eric', name: 'Eric — Suave e Confiável', gender: 'male', style: 'confiável' },
  { match: 'chris', name: 'Chris — Simpático e Próximo', gender: 'male', style: 'simpático' },
  { match: 'alice', name: 'Alice — Clara e Confiante', gender: 'female', style: 'confiante' },
  { match: 'matilda', name: 'Matilda — Profissional', gender: 'female', style: 'profissional' },
  { match: 'brian', name: 'Brian — Institucional', gender: 'male', style: 'institucional' },
  { match: 'george', name: 'George — Locutor Grave', gender: 'male', style: 'locutor' },
  { match: 'roger', name: 'Roger — Descontraído', gender: 'male', style: 'descontraído' },
  { match: 'will', name: 'Will — Otimista', gender: 'male', style: 'otimista' },
  { match: 'adam', name: 'Adam — Firme e Marcante', gender: 'male', style: 'firme' },
  { match: 'river', name: 'River — Neutro e Informativo', gender: 'neutral', style: 'informativo' },
  { match: 'lily', name: 'Lily — Aveludada', gender: 'female', style: 'aveludada' },
  { match: 'callum', name: 'Callum — Personagem Malandro', gender: 'male', style: 'personagem' },
  { match: 'harry', name: 'Harry — Personagem Guerreiro', gender: 'male', style: 'personagem' },
];

/** Ordem das vozes fora da curadoria (depois de todas as curadas). */
const UNCURATED_SORT_BASE = 100;

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
   * Sincroniza o voice_catalog com a conta ElevenLabs (GET /v1/voices) no boot
   * da API — idempotente e aditivo: insere vozes que faltam, aplica nome/
   * estilo/ordem/`curated` da curadoria às curadas, NUNCA apaga linhas nem
   * mexe em `enabled` (é a chave do admin para tirar uma voz do ar) nem em
   * `ownerUserId`. Kits apontam para o `id` da linha, que é preservado. Falha
   * de API não derruba o boot — loga e tenta na próxima subida.
   *
   * `curated` (D10) é PERSISTIDO: só é promovido a true para as vozes da
   * curadoria; nunca é rebaixado pelo sync, para não desfazer uma promoção
   * manual do admin em voz fora da lista (Voice Library, clone).
   */
  async syncCatalog(): Promise<void> {
    const repo = this.dataSource.getRepository(VoiceCatalogEntry);
    try {
      const voices = await this.elevenLabs.listVoices();
      if (voices.length === 0) {
        this.logger.warn('Sync do voice_catalog: API não retornou vozes — nada alterado.');
        return;
      }
      const existing = await repo.find();
      const byProvider = new Map(existing.map((e) => [e.providerVoiceId, e]));
      const toSave: Array<Partial<VoiceCatalogEntry>> = [];
      let inserted = 0;
      let updated = 0;
      for (const row of this.catalogRows(voices)) {
        const current = byProvider.get(row.providerVoiceId as string);
        if (!current) {
          toSave.push(row);
          inserted += 1;
          continue;
        }
        if (
          row.curated &&
          (current.name !== row.name ||
            current.style !== row.style ||
            current.gender !== row.gender ||
            current.sort !== row.sort ||
            current.curated !== true)
        ) {
          toSave.push({
            ...current,
            name: row.name,
            style: row.style,
            gender: row.gender,
            sort: row.sort,
            curated: true,
          });
          updated += 1;
        }
      }
      if (toSave.length > 0) await repo.save(toSave);
      this.logger.log(
        `voice_catalog sincronizado com a ElevenLabs: ${voices.length} na conta, ${inserted} inseridas, ${updated} atualizadas.`,
      );
    } catch (err) {
      this.logger.warn(
        `Sync do voice_catalog falhou (catálogo inalterado): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Vozes visíveis para o usuário (D10): habilitadas E (curadas OU cujo dono é
   * ele) — o que a UI de escolha de voz do kit lista. Voz de outro dono ou não
   * curada sem dono não aparece.
   */
  async list(userId: string): Promise<VoiceCatalogEntry[]> {
    return this.dataSource.getRepository(VoiceCatalogEntry).find({
      where: applyVoiceVisibility({}, userId),
      order: { sort: 'ASC', name: 'ASC' },
    });
  }

  /**
   * Resolve o identificador vindo do cliente para o voice_id REAL da
   * ElevenLabs, aceitando tanto o id da linha do catálogo (o que a UI envia)
   * quanto o próprio providerVoiceId (compatibilidade com integrações/API).
   * Também é a guarda de curadoria E de tenant: voz fora do catálogo, fora do
   * ar ou invisível para `userId` (de outro dono, não curada sem dono) → 422
   * (sem isso, qualquer voice_id da ElevenLabs viraria gasto de TTS).
   * Bug de origem: a ElevenLabs responde HTTP 400 "invalid_uid" para o UUID
   * do catálogo — era o erro do preview na primeira tentativa real da UI.
   */
  async resolveProviderVoiceId(userId: string, idOrProviderId: string): Promise<string> {
    const repo = this.dataSource.getRepository(VoiceCatalogEntry);
    // A coluna `id` é uuid: consultar {id: 'FGY2...'} com um providerVoiceId
    // não-UUID faz o Postgres estourar no cast ANTES de avaliar o OR
    // ("invalid input syntax for type uuid" — pego em produção real). Só
    // incluímos o ramo do id quando o input TEM formato de UUID.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrProviderId,
    );
    const entry = await repo.findOne({
      where: applyVoiceVisibility(
        isUuid
          ? [{ id: idOrProviderId }, { providerVoiceId: idOrProviderId }]
          : [{ providerVoiceId: idOrProviderId }],
        userId,
      ),
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
   * Preview de TTS: multilingual_v2 com fallback eleven_v3 (plano §5.3),
   * cache por hash, teto de 5/usuário/dia (cache hit não conta).
   */
  async preview(userId: string, dto: VoicePreviewDto): Promise<{ url: string; cached: boolean }> {
    const text = dto.text.trim();
    const providerVoiceId = await this.resolveProviderVoiceId(userId, dto.voiceId);
    // O perfil de entrega entra no cache: mudar velocidade/expressividade gera amostra nova.
    const delivery = mergeVoiceDelivery(resolveVoiceDelivery(process.env), dto.delivery);
    const hash = createHash('sha256')
      .update(`${providerVoiceId}|${voiceDeliveryKey(delivery)}|${text}`)
      .digest('hex');
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
        settings: elevenLabsVoiceSettings(delivery, VOICE_PREVIEW_MODEL),
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
        settings: elevenLabsVoiceSettings(delivery, VOICE_PREVIEW_FALLBACK_MODEL),
      });
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, audio);
    await this.bumpDailyCount(userId);
    return { url: relative, cached: false };
  }

  // ─────────────────────────────── internos ───────────────────────────────

  /**
   * Linhas do catálogo: curadas na ordem da curadoria (com `curated: true`
   * persistido), depois o resto da conta por nome (`curated: false`, sem dono
   * — o sync não sabe para quem um clone foi feito; `ownerUserId` é atribuído
   * fora daqui).
   */
  private catalogRows(voices: ElevenLabsVoice[]): Array<Partial<VoiceCatalogEntry>> {
    const used = new Set<string>();
    const rows: Array<Partial<VoiceCatalogEntry>> = [];

    for (const [index, curated] of CURATED_VOICES.entries()) {
      const found = voices.find(
        (v) => v.name?.toLowerCase().startsWith(curated.match) && !used.has(v.voice_id),
      );
      if (!found) continue;
      used.add(found.voice_id);
      rows.push({
        curated: true,
        providerVoiceId: found.voice_id,
        name: curated.name,
        language: 'pt-BR',
        gender: curated.gender,
        style: curated.style,
        enabled: true,
        sort: index,
      });
    }
    const rest = voices
      .filter((v) => !used.has(v.voice_id))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    for (const [index, voice] of rest.entries()) {
      used.add(voice.voice_id);
      rows.push({
        curated: false,
        providerVoiceId: voice.voice_id,
        name: voice.name,
        language: 'pt-BR',
        gender: voice.labels?.gender ?? null,
        style: voice.labels?.use_case ?? null,
        enabled: true,
        sort: UNCURATED_SORT_BASE + index,
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
