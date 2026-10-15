import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, JsonContains } from 'typeorm';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  GEMINI_IMAGE_MODEL,
  geminiBilledFailure,
  GeminiImageProvider,
  GeminiUsage,
  sniffImageMime,
} from '../../../shared/providers/gemini-image.provider';
import { OPENAI_NO_SDK_RETRY, withOpenAiRetry } from '../../../shared/providers/openai-errors';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import {
  buildCanonicalDescSystemPrompt,
  buildCanonicalDescUserPrompt,
  buildKitReferencePrompt,
  isKitReferenceSlot,
  KIT_FRONT_SLOT,
  KIT_REFERENCE_BACKGROUND_DEFAULT,
  KIT_REFERENCE_SLOT_COUNT,
  KIT_REFERENCE_SLOTS,
  KitCanonicalDesc,
  KitReferencePromptOptions,
  KitReferenceSlot,
  parseCanonicalDesc,
} from '../domain/kit-prompts';
import {
  geminiUsage,
  kitFailedCallCost,
  kitProviderCost,
  McKitCostCall,
  McKitProviderCost,
  openAiUsage,
} from '../domain/mc-kit-costs';
import { McKitSource, McKitStyle } from '../domain/mc-kit-identity';
import { McKitMouthGate } from '../domain/mc-mouth-gate';
import { KIT_CANONICAL_DESC_TIMEOUT_MS } from '../domain/mc-pipeline.config';
import { assertKitTransition, McKitStatus } from '../domain/mc-state-machines';
import { computeKitReferenceHash, computeKitReferenceRequestHash } from '../domain/mc-step-hashes';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McEvent } from '../entities/mc-event.entity';
import { McKitCandidate } from '../entities/mc-kit-candidate.entity';
import { McKitReferencesJob } from '../services/mc-kit-candidates.service';
import { costMetadata, MC_KIT_COST_EVENT, recordKitProviderCost } from '../services/mc-kit-costs';
import { McKitViewService } from '../services/mc-kit-view.service';

/** Identidade do kit resolvida para prompt e hash (kits anteriores: mascote, sem estilo, cinza claro). */
type KitIdentity = Required<KitReferencePromptOptions> & {
  style: McKitStyle | null;
  source: McKitSource;
  backgroundColor: string;
};

/**
 * Mínimo de referências para o kit valer a revisão (plano §4): com menos de 2
 * o grid não sustenta consistência entre cenas e o kit falha inteiro.
 */
export const MIN_KIT_REFERENCES = 2;

/** Lado das referências mock derivadas da identidade (as reais do Gemini saem 1:1). */
export const MOCK_REFERENCE_SIZE = 1024;

/**
 * Referência mock a partir da imagem de identidade (ver
 * `McKitProcessor.mockReferenceImage`): puro sharp, lança se a imagem não abre.
 */
export async function mockReferenceFromIdentity(
  slot: KitReferenceSlot,
  identityImage: Buffer,
  backgroundColor: string,
): Promise<Buffer> {
  const size = MOCK_REFERENCE_SIZE;
  // a cor do kit é #RRGGBB; o default legado do prompt ("light gray") não é cor do sharp
  const kitColor = /^#[0-9a-f]{6}$/i.test(backgroundColor.trim())
    ? backgroundColor.trim()
    : '#D3D3D3';
  const flat = await sharp(identityImage).flatten({ background: kitColor }).png().toBuffer();
  const corner = await sharp(flat)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer();
  const background = { r: corner[0], g: corner[1], b: corner[2] };
  const left = Math.round(size * 0.1);
  const top = Math.round(size * 0.12);
  let fitted = sharp(flat).resize(size - 2 * left, size - top, { fit: 'contain', background });
  if (slot === 1) fitted = fitted.flop();
  const body = await fitted.png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background } })
    .composite([{ input: body, left, top }])
    .png()
    .toBuffer();
}

/** Cores de fundo dos PNGs sintéticos do provider mock (1 por slot). */
const MOCK_SLOT_COLORS = ['#4F86C6', '#6BAA75', '#C68C4F', '#A05FB5'] as const;

/**
 * Consumer da fila mc.image para o KIT do personagem (plano §4) — registrado
 * apenas no worker (WORKER_ONLY=true e MC_ENABLED=true, ver
 * CommercialsModule.onModuleInit), mesmo padrão do McScriptProcessor.
 *
 * Fluxo cheio ({kitId}): (a) descrição canônica via OpenAI vision
 * (OPENAI_TEXT_MODEL) — JSON {traits, colors[], style, doNots[]} serializado
 * em mc_character_kits.canonicalDesc; (b) 4 imagens de referência via
 * GeminiImageProvider com a imagem do mascote como referência (prompts fixos
 * em domain/kit-prompts.ts). Falha de UMA imagem não derruba o kit — segue
 * com as demais (mínimo 2; abaixo disso kit 'failed').
 *
 * Regeneração ({kitId, slot}): re-gera só a célula pedida; kit precisa estar
 * em review e permanece em review.
 *
 * Referências refeitas a partir de uma identidade escolhida em REVISÃO
 * ({kitId, fromReview, previous}, publicado por `choose`): a falha NÃO é
 * terminal — o kit volta a `review` com a identidade anterior restaurada,
 * referências e ficha intactas, evento `references_regeneration_failed` (M3).
 * `failed` terminal fica só para a primeira geração.
 *
 * MC_KIT_PROVIDER=mock (default em dev): descrição fixa + 4 referências
 * montadas com sharp a partir da imagem de identidade enviada (o tile sai do
 * personagem real) — pipeline inteiro sem gastar API. 'gemini' liga o real.
 *
 * CUSTO (tarefa 2.6): cada chamada paga (descrição canônica e cada referência
 * pelo modelo EFETIVO) grava um evento `provider_cost` e soma em
 * `mc_character_kits.providerCostUsd` (services/mc-kit-costs.ts); a
 * referência leva o custo também no metadata do asset.
 *
 * IDEMPOTÊNCIA (tarefa 2.6): o pg-boss re-entrega o job expirado com o mesmo
 * id (retryLimit 3) — às vezes com a primeira execução ainda rodando. Por isso:
 * (1) claim em memória por kit/slot (a re-entrega sobreposta no mesmo worker
 * espera a execução em curso, sem gerar de novo, e conclui/falha com ela); (2) a descrição canônica fica no evento de custo com o id do job
 * (`generationKey`) e a re-entrega a reaproveita, sem nova chamada — o que
 * mantém os prompts idênticos; (3) cada referência é gravada assim que nasce,
 * com `requestHash` (kit + slot + hash da requisição, modelo PEDIDO), e a
 * re-entrega pula o slot que já tem referência viva fora do grid atual.
 * A expiração do job (`mcKitReferencesExpireS`) cobre a descrição com as
 * re-tentativas e cada referência com UM timeout: o timeout de uma imagem é
 * terminal (`retryOnTimeout: false`), porque a requisição abortada pode ter
 * sido gerada e cobrada — vira linha de custo ESTIMADA, sem nova chamada.
 * Resposta 200 sem imagem (recusa) também é paga e vira linha de custo.
 *
 * QUOTA: conta sem crédito é terminal — OpenAI `insufficient_quota` na
 * descrição (sem re-tentativa, nem do SDK) e Gemini 402/403 numa referência
 * (os slots restantes não são tentados).
 *
 * ESTORNO: n/a — o kit NÃO reserva créditos na v0 (plano §4: custo de
 * onboarding absorvido, ~US$1–3/mascote); em falha não há o que devolver.
 */
@Injectable()
export class McKitProcessor {
  private readonly logger = new Logger(McKitProcessor.name);
  private readonly openai: OpenAI | null;
  /** Execuções em curso neste processo (`kitId:all` ou `kitId:slot`). */
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly gemini: GeminiImageProvider,
    private readonly mascots: MascotsService,
    private readonly config: ConfigService,
    private readonly view: McKitViewService,
  ) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  /**
   * `jobId` = id do job no pg-boss (o mesmo em toda re-entrega): chave da
   * geração para reaproveitar a descrição canônica já paga. Ausente (testes,
   * chamada direta) = sem reaproveitamento da descrição.
   */
  async process(job: McKitReferencesJob, jobId?: string | null): Promise<void> {
    const claim = `${job.kitId}:${job.slot ?? 'all'}`;
    const running = this.active.get(claim);
    if (running) {
      // Re-entrega com a primeira execução ainda rodando: espera a MESMA
      // execução em vez de voltar já — o job só conclui (ou falha e volta a
      // ser re-tentado) quando o trabalho real terminar. Voltar na hora
      // concluía o job e, se o worker caísse depois, o kit ficava preso em
      // 'generating' sem job para re-tentar.
      this.logger.warn(
        `Kit ${job.kitId}: job ${claim} já em execução neste worker (re-entrega por expiração) — aguardando a execução em curso.`,
      );
      return running;
    }
    const execution = this.run(job, jobId ?? null).finally(() => this.active.delete(claim));
    this.active.set(claim, execution);
    return execution;
  }

  private async run(job: McKitReferencesJob, generationKey: string | null): Promise<void> {
    const { kitId, slot } = job;
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    if (!kit) return;
    if (slot != null) {
      await this.regenerateSlot(kit, slot, generationKey);
      return;
    }
    // Idempotência: job duplicado/expirado que re-entra com o kit já fora de
    // 'generating' vira no-op (mesma disciplina CAS do McScriptProcessor).
    if (kit.status !== McKitStatus.GENERATING) return;
    // Origem logo sem identidade escolhida: as referências só nascem DEPOIS
    // da escolha do candidato (D4) — job perdido/antigo não pode falhar o kit.
    if (kit.source === 'logo' && kit.identityMode === 'generated' && !kit.identityAssetId) {
      this.logger.warn(
        `Kit ${kit.id}: job de referências sem candidato escolhido — ignorado (rodada de candidatos pendente).`,
      );
      return;
    }
    // Logo usado como está: identidade são os pixels do logo; nada a estilizar.
    if (kit.identityMode === 'logo_as_is') {
      this.logger.warn(`Kit ${kit.id}: identidade logo_as_is não gera referências — ignorado.`);
      return;
    }

    let mascotImage: Buffer;
    try {
      mascotImage = await this.loadIdentityImage(kit);
    } catch (err) {
      await this.failGeneration(kit, job, 'mascot_image_unavailable', (err as Error).message);
      return;
    }

    // (a) descrição canônica — pré-requisito dos prompts das referências;
    // falhou aqui, o kit falha (nada foi gasto com imagens ainda).
    let desc: KitCanonicalDesc;
    try {
      desc = await this.resolveCanonicalDesc(kit, mascotImage, generationKey);
    } catch (err) {
      this.logger.error(`Kit ${kit.id}: descrição canônica falhou: ${(err as Error).message}`);
      await this.failGeneration(
        kit,
        job,
        'canonical_desc_failed',
        (err as Error).message,
        providerErrorDetail(err),
      );
      return;
    }

    // (b) 4 referências — falha individual registra evento e SEGUE (plano §4);
    // conta sem crédito (quota) para a geração: os slots restantes falhariam igual.
    const okAssetIds: string[] = [];
    const failures: Array<{ slot: number; error: string }> = [];
    let quota: string | null = null;
    for (let s = 0; s < KIT_REFERENCE_SLOT_COUNT; s++) {
      const refSlot = s as KitReferenceSlot;
      try {
        okAssetIds.push(
          await this.generateAndSaveReference(kit, refSlot, desc, mascotImage, generationKey),
        );
      } catch (err) {
        const message = (err as Error).message ?? 'erro desconhecido';
        this.logger.warn(`Kit ${kit.id}: referência slot ${refSlot} falhou: ${message}`);
        failures.push({ slot: refSlot, error: message });
        await this.dataSource.transaction((m) =>
          this.commercials.appendEvent(m, {
            userId: kit.userId,
            refKind: 'kit',
            refId: kit.id,
            kind: 'reference_failed',
            detail: { slot: refSlot, error: message.slice(0, 300), ...providerErrorDetail(err) },
          }),
        );
        if (err instanceof TerminalProviderError && err.code === 'quota') {
          quota = message;
          break;
        }
      }
    }

    if (okAssetIds.length < MIN_KIT_REFERENCES) {
      await this.failGeneration(
        kit,
        job,
        'kit_generation_failed',
        `Apenas ${okAssetIds.length} de ${KIT_REFERENCE_SLOT_COUNT} referências geradas (mínimo ${MIN_KIT_REFERENCES})`,
        quota ? { failures, providerErrorCode: 'quota' } : { failures },
        okAssetIds,
      );
      return;
    }

    assertKitTransition(McKitStatus.GENERATING, McKitStatus.REVIEW);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        { canonicalDesc: JSON.stringify(desc), referenceAssetIds: okAssetIds },
      );
      if (!won) return;
      // Identidade trocada em revisão (review → generating): as referências
      // antigas saem de cena junto com o grid que as substituiu.
      const previous = (kit.referenceAssetIds ?? []).filter((id) => !okAssetIds.includes(id));
      if (previous.length > 0) await manager.softDelete(AnimationAsset, previous);
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.GENERATING,
        toStatus: McKitStatus.REVIEW,
        detail: {
          referenceCount: okAssetIds.length,
          failures: failures.length,
          identityAssetId: kit.identityAssetId ?? null,
          replacedReferences: previous.length,
        },
      });
      await this.transitions.notify(
        manager,
        kit.userId,
        { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.REVIEW },
        MC_EVENTS_CHANNEL,
      );
    });
  }

  // ───────────────────────── regeneração de 1 célula ─────────────────────────

  private async regenerateSlot(
    kit: McCharacterKit,
    slot: number,
    generationKey: string | null,
  ): Promise<void> {
    if (!isKitReferenceSlot(slot)) return;
    if (kit.status !== McKitStatus.REVIEW) return; // gate: só durante a revisão

    const desc = this.parseCanonicalDesc(kit.canonicalDesc);
    try {
      const mascotImage = await this.loadIdentityImage(kit);
      const newAssetId = await this.generateAndSaveReference(
        kit,
        slot,
        desc,
        mascotImage,
        generationKey,
      );
      await this.dataSource.transaction(async (manager) => {
        // Lock pessimista: duas regens simultâneas (slots diferentes) não podem
        // se atropelar no read-modify-write do array referenceAssetIds.
        const fresh = await manager.findOne(McCharacterKit, {
          where: { id: kit.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!fresh || fresh.status !== McKitStatus.REVIEW) return;
        const assets = await manager.find(AnimationAsset, {
          where: { id: In(fresh.referenceAssetIds) },
        });
        const previous = assets.find((a) => a.metadata?.slot === slot);
        const nextIds = [
          ...fresh.referenceAssetIds.filter((id) => id !== previous?.id),
          newAssetId,
        ];
        // Referência frontal É a identidade do kit de mascote (D1): trocá-la
        // descarta o tile e o veredito de boca gravados para a anterior.
        const identityChanged = slot === KIT_FRONT_SLOT && !fresh.identityAssetId;
        await manager.update(
          McCharacterKit,
          { id: kit.id },
          {
            referenceAssetIds: nextIds,
            ...(identityChanged
              ? { tileAssetId: null, mouthGate: this.withoutIdentityVerdict(fresh) }
              : {}),
          },
        );
        if (previous) await manager.softDelete(AnimationAsset, previous.id);
        if (identityChanged && fresh.tileAssetId) {
          await manager.softDelete(AnimationAsset, fresh.tileAssetId);
        }
        await this.commercials.appendEvent(manager, {
          userId: kit.userId,
          refKind: 'kit',
          refId: kit.id,
          kind: 'reference_regenerated',
          detail: {
            slot,
            assetId: newAssetId,
            replacedAssetId: previous?.id ?? null,
            tileDiscarded: identityChanged ? (fresh.tileAssetId ?? null) : null,
          },
        });
        await this.notifyKit(manager, kit, McKitStatus.REVIEW);
      });
    } catch (err) {
      const message = (err as Error).message ?? 'erro desconhecido';
      this.logger.warn(`Kit ${kit.id}: regeneração do slot ${slot} falhou: ${message}`);
      await this.dataSource.transaction(async (manager) => {
        await this.commercials.appendEvent(manager, {
          userId: kit.userId,
          refKind: 'kit',
          refId: kit.id,
          kind: 'reference_failed',
          detail: { slot, error: message.slice(0, 300), regeneration: true },
        });
        // kit segue em review — o evento avisa a UI para reabilitar o botão
        await this.notifyKit(manager, kit, McKitStatus.REVIEW);
      });
    }
  }

  // ─────────────────────────────── geração ───────────────────────────────

  private provider(): string {
    return process.env.MC_KIT_PROVIDER || 'mock';
  }

  /**
   * Descrição canônica da geração: a já paga nesta geração (re-entrega do
   * MESMO job, `generationKey`, sobre a MESMA imagem de origem) ou uma nova.
   * Reaproveitar não é só economia: a descrição entra no prompt e no
   * `requestHash` das referências — gerada de novo, mudaria o hash e a
   * re-entrega não acharia os slots já pagos.
   */
  private async resolveCanonicalDesc(
    kit: McCharacterKit,
    mascotImage: Buffer,
    generationKey: string | null,
  ): Promise<KitCanonicalDesc> {
    const sourceImageHash = sha256(mascotImage);
    if (generationKey && this.provider() !== 'mock') {
      const reused = await this.findCanonicalDesc(kit.id, generationKey, sourceImageHash);
      if (reused) {
        this.logger.log(
          `Kit ${kit.id}: descrição canônica reaproveitada da execução anterior do job ${generationKey}.`,
        );
        return reused;
      }
    }
    return this.generateCanonicalDesc(mascotImage, kit, { generationKey, sourceImageHash });
  }

  /** Descrição gravada no evento de custo da descrição desta geração (mais recente), ou null. */
  private async findCanonicalDesc(
    kitId: string,
    generationKey: string,
    sourceImageHash: string,
  ): Promise<KitCanonicalDesc | null> {
    const event = await this.dataSource.getRepository(McEvent).findOne({
      where: {
        refKind: 'kit',
        refId: kitId,
        kind: MC_KIT_COST_EVENT,
        detail: JsonContains({ call: 'canonical_desc', generationKey, sourceImageHash }),
      },
      order: { id: 'DESC' },
    });
    // A descrição volta EXATAMENTE como foi recebida (mesma validação da
    // geração, sem a limpeza do parseCanonicalDesc): o prompt — e o
    // requestHash das referências — precisa sair idêntico ao da execução anterior.
    const desc = event?.detail?.desc as KitCanonicalDesc | null | undefined;
    if (!desc || typeof desc !== 'object' || Array.isArray(desc)) return null;
    if (!Array.isArray(desc.traits) || typeof desc.style !== 'string') return null;
    return desc;
  }

  /**
   * (a) Descrição canônica: JSON {traits, colors[], style, doNots[]} (plano §4
   * "mascot bible"). Re-tentativas só pelo `withOpenAiRetry` (SDK sem retry
   * próprio, timeout por chamada): conta sem crédito (`insufficient_quota`) é
   * terminal na primeira resposta; limite de taxa e 5xx re-tentam. O custo é
   * registrado assim que a resposta chega, com a descrição (reaproveitada na
   * re-entrega do job) — mesmo que o JSON venha inválido, a chamada foi paga.
   */
  private async generateCanonicalDesc(
    mascotImage: Buffer,
    kit?: McCharacterKit,
    context: { generationKey?: string | null; sourceImageHash?: string } = {},
  ): Promise<KitCanonicalDesc> {
    if (this.provider() === 'mock') {
      return {
        traits: ['brand mascot (mock description — MC_KIT_PROVIDER=mock)'],
        accessories: ['shopping basket'],
        colors: ['#FFCC00'],
        style: 'cartoon',
        doNots: ['do not change the brand colors'],
        pt: {
          traits: ['mascote da marca (descrição mock — MC_KIT_PROVIDER=mock)'],
          accessories: ['cesta de compras'],
          style: 'cartoon',
          doNots: ['não alterar as cores da marca'],
        },
      };
    }
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY não configurada — necessária para a descrição canônica');
    }
    const model = this.config.get<string>('OPENAI_TEXT_MODEL', 'gpt-4o');
    const mascotName = kit ? await this.mascotNameHint(kit) : null;
    const dataUri = `data:${sniffImageMime(mascotImage)};base64,${mascotImage.toString('base64')}`;
    const openai = this.openai;
    const response = await withOpenAiRetry(() =>
      openai.chat.completions.create(
        {
          model,
          max_tokens: 600,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'kit_canonical_desc_v2',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['traits', 'accessories', 'colors', 'style', 'doNots', 'pt'],
                properties: {
                  traits: { type: 'array', items: { type: 'string' } },
                  accessories: { type: 'array', items: { type: 'string' } },
                  colors: { type: 'array', items: { type: 'string' } },
                  style: { type: 'string' },
                  doNots: { type: 'array', items: { type: 'string' } },
                  // Espelho pt-BR: MESMA ordem e MESMO tamanho dos arrays em
                  // inglês (a UI parea por índice; tamanho diferente = descarta).
                  pt: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['traits', 'accessories', 'style', 'doNots'],
                    properties: {
                      traits: { type: 'array', items: { type: 'string' } },
                      accessories: { type: 'array', items: { type: 'string' } },
                      style: { type: 'string' },
                      doNots: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          messages: [
            {
              role: 'system',
              content: buildCanonicalDescSystemPrompt(),
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: buildCanonicalDescUserPrompt({ name: mascotName }) },
                { type: 'image_url', image_url: { url: dataUri } },
              ],
            },
          ],
        },
        { ...OPENAI_NO_SDK_RETRY, timeout: KIT_CANONICAL_DESC_TIMEOUT_MS },
      ),
    );
    let parsed: KitCanonicalDesc | null = null;
    let invalid: string | null = null;
    try {
      const raw = response.choices[0]?.message?.content;
      if (!raw) throw new Error('Resposta vazia do modelo de visão');
      const candidate = JSON.parse(raw) as KitCanonicalDesc;
      if (!Array.isArray(candidate.traits) || typeof candidate.style !== 'string') {
        throw new Error('Descrição canônica em formato inesperado');
      }
      parsed = candidate;
    } catch (err) {
      invalid = (err as Error).message;
    }
    if (kit) {
      const cost = kitProviderCost({
        call: 'canonical_desc',
        provider: 'openai',
        model: response.model || model,
        usage: openAiUsage(response.usage),
      });
      await this.recordCost(kit, cost, {
        requestedModel: model,
        generationKey: context.generationKey ?? null,
        sourceImageHash: context.sourceImageHash ?? sha256(mascotImage),
        desc: parsed,
      });
    }
    if (!parsed) throw new Error(invalid ?? 'Descrição canônica em formato inesperado');
    return parsed;
  }

  /**
   * (b) Gera a imagem do slot, grava em uploads/commercials/kits/{kitId}/ e
   * cria o media asset. O prompt leva o estilo fixo, a origem e a cor de fundo
   * do kit (D5), e o hash da requisição (D1: "entra no hash do kit") fica no
   * asset (`contentHash` + metadata) para auditoria e reuso.
   *
   * Idempotência (2.6): antes de gerar, procura uma referência VIVA do mesmo
   * kit e slot com o mesmo `requestHash` (requisição com o modelo pedido) fora
   * do grid atual — a que uma execução anterior deste job já pagou — e a
   * devolve sem nova chamada. O asset nasce na mesma transação do registro do
   * custo (evento `provider_cost` + soma no kit), assim que a imagem chega.
   */
  private async generateAndSaveReference(
    kit: McCharacterKit,
    slot: KitReferenceSlot,
    desc: KitCanonicalDesc | null,
    mascotImage: Buffer,
    generationKey: string | null = null,
  ): Promise<string> {
    const identity = this.kitIdentity(kit);
    const prompt = buildKitReferencePrompt(slot, desc, identity);
    const mock = this.provider() === 'mock';
    const sourceImageHash = sha256(mascotImage);
    // Modelo das referências (2.6): GEMINI_IMAGE_MODEL_REFS (ex.: 2.1, mais
    // barato) com o modelo atual na cadeia de fallback do provider; o hash
    // leva o modelo que EFETIVAMENTE gerou, a chave de idempotência o PEDIDO.
    const requestedModel = mock ? 'mock' : this.referencesModel();
    const requestHash = computeKitReferenceRequestHash({
      slot,
      prompt,
      sourceImageHash,
      source: identity.source,
      style: identity.style,
      backgroundColor: identity.backgroundColor,
      requestedModel,
    });
    const done = await this.findGeneratedReference(kit, slot, requestHash);
    if (done) {
      this.logger.log(
        `Kit ${kit.id}: referência do slot ${slot} já gerada (${done.id}) — reaproveitada, sem nova chamada.`,
      );
      return done.id;
    }

    const costContext = { slot, requestedModel, requestHash, generationKey };
    let generated: { image: Buffer; model: string; usage?: GeminiUsage | null };
    if (mock) {
      generated = {
        image: await this.mockReferenceImage(slot, mascotImage, identity.backgroundColor),
        model: 'mock',
        usage: null,
      };
    } else {
      try {
        generated = await this.gemini.generateImageWithModel({
          prompt,
          referenceImages: [mascotImage],
          aspectRatio: '1:1',
          model: requestedModel,
          retryOnTimeout: false,
        });
      } catch (err) {
        await this.recordFailedCallCost(kit, 'reference', err, costContext);
        throw err;
      }
    }
    const image = generated.image;
    const cost: McKitProviderCost | null = mock
      ? null
      : kitProviderCost({
          call: 'reference',
          provider: 'gemini',
          model: generated.model,
          usage: geminiUsage(generated.usage, 1),
        });
    const inputHash = computeKitReferenceHash({
      slot,
      prompt,
      sourceImageHash,
      source: identity.source,
      style: identity.style,
      backgroundColor: identity.backgroundColor,
      model: generated.model,
    });

    let fileUrl: string;
    try {
      fileUrl = await this.saveFile(kit.id, `ref-${slot}-${Date.now()}.png`, image);
    } catch (err) {
      // a imagem foi paga mesmo sem asset: o custo fica registrado
      if (cost) await this.recordCost(kit, cost, { ...costContext, assetId: null });
      throw err;
    }
    return this.dataSource.transaction(async (manager) => {
      const asset = await manager.save(AnimationAsset, {
        userId: kit.userId,
        kind: 'kit_reference' as const,
        status: 'ready' as const,
        name: `Kit ${KIT_REFERENCE_SLOTS[slot]} — ${kit.id.slice(0, 8)}`,
        origin: 'ai_generated' as const,
        fileUrl,
        mimeType: 'image/png',
        fileSize: String(image.length),
        contentHash: inputHash,
        metadata: {
          kitId: kit.id,
          slot,
          provider: this.provider(),
          model: generated.model,
          requestedModel,
          inputHash,
          requestHash,
          generationKey,
          style: identity.style,
          source: identity.source,
          identityAssetId: kit.identityAssetId ?? null,
          // 1500 e não 500: com a ficha embutida, as regras que mais importam na
          // auditoria (acessórios proibidos, ajustes do usuário) vinham depois do
          // corte antigo e o metadata não servia para conferir o que foi enviado.
          prompt: prompt.slice(0, 1500),
          ...costMetadata(cost),
        },
      });
      if (cost) {
        await recordKitProviderCost(manager, this.commercials, kit, cost, {
          ...costContext,
          assetId: asset.id,
        });
      }
      return asset.id;
    });
  }

  /**
   * Referência já paga numa execução anterior deste job: viva (soft-delete
   * fica de fora), do mesmo kit e slot, mesmo `requestHash`, e FORA do grid
   * atual (`referenceAssetIds`) — o grid atual é o da identidade anterior, que
   * a geração vai substituir (e restaurar se falhar), nunca reaproveitado.
   */
  private async findGeneratedReference(
    kit: McCharacterKit,
    slot: KitReferenceSlot,
    requestHash: string,
  ): Promise<AnimationAsset | null> {
    const found = await this.dataSource.getRepository(AnimationAsset).find({
      where: {
        kind: 'kit_reference',
        userId: kit.userId,
        metadata: JsonContains({ kitId: kit.id, slot, requestHash }),
      },
      order: { createdAt: 'DESC' },
    });
    const current = new Set(kit.referenceAssetIds ?? []);
    return (found ?? []).find((asset) => !current.has(asset.id) && !!asset.fileUrl) ?? null;
  }

  /** Registra o custo de uma chamada numa transação própria (sem asset na mesma escrita). */
  private async recordCost(
    kit: McCharacterKit,
    cost: McKitProviderCost,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.transaction((manager) =>
      recordKitProviderCost(manager, this.commercials, kit, cost, context),
    );
  }

  /**
   * Chamada Gemini que falhou DEPOIS de cobrada (200 sem imagem, timeout):
   * registra a linha de custo (sem asset) antes de o erro seguir. Falha no
   * registro só loga — não troca o erro do provider.
   */
  private async recordFailedCallCost(
    kit: McCharacterKit,
    call: McKitCostCall,
    err: unknown,
    context: Record<string, unknown>,
  ): Promise<void> {
    const billing = geminiBilledFailure(err);
    if (!billing) return;
    const cost = kitFailedCallCost({ call, billing, expectedImages: 1 });
    try {
      await this.recordCost(kit, cost, {
        ...context,
        assetId: null,
        ...providerErrorDetail(err),
      });
    } catch (recordErr) {
      this.logger.error(
        `Kit ${kit.id}: custo da chamada ${call} sem resultado não registrado: ${(recordErr as Error).message}`,
      );
    }
  }

  /** Modelo das 4 referências: GEMINI_IMAGE_MODEL_REFS, senão o modelo atual (Nano Banana Pro). */
  private referencesModel(): string {
    return this.config.get<string>('GEMINI_IMAGE_MODEL_REFS')?.trim() || GEMINI_IMAGE_MODEL;
  }

  /** Kits anteriores à change não têm estilo nem cor: valem os defaults do prompt legado. */
  private kitIdentity(kit: McCharacterKit): KitIdentity {
    return {
      style: kit.style ?? null,
      source: kit.source ?? 'mascot',
      backgroundColor: kit.tileBackgroundColor ?? KIT_REFERENCE_BACKGROUND_DEFAULT,
    };
  }

  /**
   * Referência MOCK (sem custo) DERIVADA da imagem de identidade enviada
   * (achado 6 da 3.7): sem isso o tile do kit mock era um círculo sintético e
   * nenhum teste local de fala usava o personagem real. A imagem é achatada
   * sobre a cor do kit, encaixada (contain) num quadro 1024×1024 do mesmo fundo
   * da imagem (cor do canto), deixando 12% de margem no topo e 10% nas laterais,
   * para a caixa do rosto do gate de boca mock (x 0,30–0,70, y 0,15–0,55) cair na
   * parte de cima do personagem e a borda do tile ficar lisa. O perfil (slot 1)
   * sai espelhado, só para as células não serem idênticas. Imagem ilegível →
   * o PNG sintético de antes.
   */
  private async mockReferenceImage(
    slot: KitReferenceSlot,
    identityImage: Buffer,
    backgroundColor: string,
  ): Promise<Buffer> {
    try {
      return await mockReferenceFromIdentity(slot, identityImage, backgroundColor);
    } catch (err) {
      this.logger.warn(
        `Kit mock: identidade ilegível (${(err as Error).message}) — referência sintética no slot ${slot}.`,
      );
      return this.syntheticReferenceImage(slot);
    }
  }

  /** PNG sintético (sem custo): fundo colorido + rótulo do slot, via sharp. */
  private async syntheticReferenceImage(slot: KitReferenceSlot): Promise<Buffer> {
    const color = MOCK_SLOT_COLORS[slot];
    const label = KIT_REFERENCE_SLOTS[slot];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
      `<rect width="512" height="512" fill="${color}"/>` +
      `<circle cx="256" cy="210" r="100" fill="#ffffff" opacity="0.85"/>` +
      `<text x="256" y="400" font-family="sans-serif" font-size="34" fill="#ffffff" text-anchor="middle">${label}</text>` +
      `<text x="256" y="450" font-family="sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">slot ${slot} — mock</text>` +
      `</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  // ─────────────────────────────── suporte ───────────────────────────────

  /**
   * Imagem de origem das referências (2.6): a identidade escolhida
   * (`identityAssetId` — candidato de mascotização ou variante com boca)
   * quando existe; senão a imagem do mascote (recorte, senão a fonte), como
   * sempre. A referência frontal gerada é a identidade canônica do kit de
   * mascote, mas NÃO vira fonte das demais (evita deriva a cada regeneração).
   */
  private async loadIdentityImage(kit: McCharacterKit): Promise<Buffer> {
    if (kit.identityAssetId) {
      const asset = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: kit.identityAssetId });
      if (!asset?.fileUrl) throw new Error('Asset da identidade do kit não encontrado');
      const buffer = await this.readUploadsFile(asset.fileUrl);
      if (!buffer) throw new Error('Arquivo da identidade do kit não encontrado no disco');
      return buffer;
    }
    return this.loadMascotImage(kit);
  }

  /**
   * Nome do mascote/logo como pista da descrição canônica; sem ele a
   * descrição segue só pela imagem (falha aqui nunca derruba o kit).
   */
  private async mascotNameHint(kit: McCharacterKit): Promise<string | null> {
    try {
      const mascot = await this.mascots.findOne(kit.userId, kit.mascotId);
      return typeof mascot?.name === 'string' ? mascot.name : null;
    } catch {
      return null;
    }
  }

  /** Imagem do mascote (recorte, senão a fonte) lida do bucket local. */
  private async loadMascotImage(kit: McCharacterKit): Promise<Buffer> {
    const mascot = await this.mascots.findOne(kit.userId, kit.mascotId);
    const imageUrl = mascot.cutoutUrl ?? mascot.sourceImageUrl;
    if (!imageUrl) throw new Error('Mascote sem imagem utilizável (recorte ou fonte)');
    const buffer = await this.readUploadsFile(imageUrl);
    if (!buffer) throw new Error('Arquivo de imagem do mascote não encontrado no disco');
    return buffer;
  }

  /** Identidade trocada: o veredito de boca e o aceite de risco da anterior caem; o do logo fica. */
  private withoutIdentityVerdict(kit: McCharacterKit): McKitMouthGate | null {
    if (!kit.mouthGate) return null;
    const { identity: _identity, riskAccepted: _risk, ...rest } = kit.mouthGate;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  private parseCanonicalDesc(raw: string | null): KitCanonicalDesc | null {
    return parseCanonicalDesc(raw);
  }

  /** Falha da geração: terminal (`failed`) na primeira; rollback a `review` quando veio de `choose` em revisão. */
  private async failGeneration(
    kit: McCharacterKit,
    job: McKitReferencesJob,
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
    generatedAssetIds: string[] = [],
  ): Promise<void> {
    if (job.fromReview) {
      await this.rollbackToReview(kit, job, code, message, detail, generatedAssetIds);
      return;
    }
    await this.failKit(kit, code, message, detail);
  }

  /**
   * generating → review restaurando a identidade anterior (`previous`):
   * referências e ficha não entram no patch e seguem como estavam; o
   * candidato marcado como escolhido volta a ser o da identidade anterior;
   * as referências parciais desta tentativa são descartadas. O tile tinha
   * sido descartado na escolha — a aprovação o refaz para a identidade
   * restaurada (o veredito de boca restaurado evita nova visão).
   */
  private async rollbackToReview(
    kit: McCharacterKit,
    job: McKitReferencesJob,
    code: string,
    message: string,
    detail: Record<string, unknown>,
    generatedAssetIds: string[],
  ): Promise<void> {
    const previous = job.previous ?? {
      identityAssetId: null,
      identityMode: 'generated' as const,
      mouthGate: null,
    };
    assertKitTransition(McKitStatus.GENERATING, McKitStatus.REVIEW);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        {
          identityAssetId: previous.identityAssetId,
          identityMode: previous.identityMode,
          mouthGate: previous.mouthGate,
        },
      );
      if (!won) return;
      await manager.update(McKitCandidate, { kitId: kit.id, chosen: true }, { chosen: false });
      if (previous.identityAssetId) {
        await manager.update(
          McKitCandidate,
          { kitId: kit.id, assetId: previous.identityAssetId },
          { chosen: true },
        );
      }
      if (generatedAssetIds.length > 0) {
        await manager.softDelete(AnimationAsset, generatedAssetIds);
      }
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'references_regeneration_failed',
        fromStatus: McKitStatus.GENERATING,
        toStatus: McKitStatus.REVIEW,
        detail: {
          errorCode: code,
          errorMessage: message.slice(0, 300),
          attemptedIdentityAssetId: kit.identityAssetId ?? null,
          restoredIdentityAssetId: previous.identityAssetId,
          restoredIdentityMode: previous.identityMode,
          discardedAssets: generatedAssetIds.length,
          ...detail,
        },
      });
      await this.transitions.notify(
        manager,
        kit.userId,
        {
          kind: 'mc_kit',
          kitId: kit.id,
          status: McKitStatus.REVIEW,
          event: 'references_regeneration_failed',
        },
        MC_EVENTS_CHANNEL,
      );
    });
  }

  private async failKit(
    kit: McCharacterKit,
    code: string,
    message: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    assertKitTransition(McKitStatus.GENERATING, McKitStatus.FAILED);
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McCharacterKit,
        kit.id,
        McKitStatus.GENERATING,
        McKitStatus.FAILED,
      );
      if (!won) return;
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.GENERATING,
        toStatus: McKitStatus.FAILED,
        detail: { errorCode: code, errorMessage: message.slice(0, 300), ...detail },
      });
      await this.notifyKit(manager, kit, McKitStatus.FAILED);
    });
  }

  private async notifyKit(
    manager: EntityManager,
    kit: McCharacterKit,
    status: McKitStatus,
  ): Promise<void> {
    await this.transitions.notify(
      manager,
      kit.userId,
      { kind: 'mc_kit', kitId: kit.id, status },
      MC_EVENTS_CHANNEL,
    );
  }

  /** Padrão de gravação do repo (ai-generation.processor.saveFile), na área do commercials. */
  private async saveFile(kitId: string, name: string, data: Buffer): Promise<string> {
    const uploadsDir = this.config.get<string>('UPLOAD_DEST', './uploads');
    const dir = path.join(uploadsDir, 'commercials', 'kits', kitId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), data);
    return `/uploads/commercials/kits/${kitId}/${name}`;
  }

  private async readUploadsFile(url: string): Promise<Buffer | null> {
    const marker = '/uploads/';
    const index = url.indexOf(marker);
    const uploadsPath = url.startsWith('/uploads/') ? url : index >= 0 ? url.slice(index) : null;
    if (!uploadsPath) return null;
    const uploadsDir = path.resolve(this.config.get<string>('UPLOAD_DEST', './uploads'));
    const filePath = path.resolve(uploadsDir, uploadsPath.replace(/^\/uploads\//, ''));
    if (!filePath.startsWith(uploadsDir + path.sep)) return null;
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Código do erro terminal do fornecedor (ex.: `quota`) para o detalhe do evento de falha. */
function providerErrorDetail(err: unknown): Record<string, unknown> {
  return err instanceof TerminalProviderError ? { providerErrorCode: err.code } : {};
}
