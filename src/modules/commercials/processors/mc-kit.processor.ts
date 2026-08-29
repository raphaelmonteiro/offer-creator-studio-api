import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import OpenAI from 'openai';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  GeminiImageProvider,
  sniffImageMime,
} from '../../../shared/providers/gemini-image.provider';
import { TransientProviderError, withRetry } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import {
  buildKitReferencePrompt,
  isKitReferenceSlot,
  KIT_REFERENCE_SLOT_COUNT,
  KIT_REFERENCE_SLOTS,
  KitCanonicalDesc,
  KitReferenceSlot,
  parseCanonicalDesc,
} from '../domain/kit-prompts';
import { assertKitTransition, McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';

/**
 * Mínimo de referências para o kit valer a revisão (plano §4): com menos de 2
 * o grid não sustenta consistência entre cenas e o kit falha inteiro.
 */
export const MIN_KIT_REFERENCES = 2;

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
 * MC_KIT_PROVIDER=mock (default em dev): descrição fixa + 4 PNGs sintéticos
 * via sharp — pipeline inteiro sem gastar API. 'gemini' liga o real.
 *
 * ESTORNO: n/a — o kit NÃO reserva créditos na v0 (plano §4: custo de
 * onboarding absorvido, ~US$1–3/mascote); em falha não há o que devolver.
 */
@Injectable()
export class McKitProcessor {
  private readonly logger = new Logger(McKitProcessor.name);
  private readonly openai: OpenAI | null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly gemini: GeminiImageProvider,
    private readonly mascots: MascotsService,
    private readonly config: ConfigService,
  ) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async process({ kitId, slot }: { kitId: string; slot?: number }): Promise<void> {
    const kit = await this.dataSource.getRepository(McCharacterKit).findOneBy({ id: kitId });
    if (!kit) return;
    if (slot != null) {
      await this.regenerateSlot(kit, slot);
      return;
    }
    // Idempotência: job duplicado/expirado que re-entra com o kit já fora de
    // 'generating' vira no-op (mesma disciplina CAS do McScriptProcessor).
    if (kit.status !== McKitStatus.GENERATING) return;

    let mascotImage: Buffer;
    try {
      mascotImage = await this.loadMascotImage(kit);
    } catch (err) {
      await this.failKit(kit, 'mascot_image_unavailable', (err as Error).message);
      return;
    }

    // (a) descrição canônica — pré-requisito dos prompts das referências;
    // falhou aqui, o kit falha (nada foi gasto com imagens ainda).
    let desc: KitCanonicalDesc;
    try {
      desc = await this.generateCanonicalDesc(mascotImage);
    } catch (err) {
      this.logger.error(`Kit ${kit.id}: descrição canônica falhou: ${(err as Error).message}`);
      await this.failKit(kit, 'canonical_desc_failed', (err as Error).message);
      return;
    }

    // (b) 4 referências — falha individual registra evento e SEGUE (plano §4).
    const okAssetIds: string[] = [];
    const failures: Array<{ slot: number; error: string }> = [];
    for (let s = 0; s < KIT_REFERENCE_SLOT_COUNT; s++) {
      const refSlot = s as KitReferenceSlot;
      try {
        okAssetIds.push(await this.generateAndSaveReference(kit, refSlot, desc, mascotImage));
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
            detail: { slot: refSlot, error: message.slice(0, 300) },
          }),
        );
      }
    }

    if (okAssetIds.length < MIN_KIT_REFERENCES) {
      await this.failKit(
        kit,
        'kit_generation_failed',
        `Apenas ${okAssetIds.length} de ${KIT_REFERENCE_SLOT_COUNT} referências geradas (mínimo ${MIN_KIT_REFERENCES})`,
        { failures },
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
      await this.commercials.appendEvent(manager, {
        userId: kit.userId,
        refKind: 'kit',
        refId: kit.id,
        kind: 'transition',
        fromStatus: McKitStatus.GENERATING,
        toStatus: McKitStatus.REVIEW,
        detail: { referenceCount: okAssetIds.length, failures: failures.length },
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

  private async regenerateSlot(kit: McCharacterKit, slot: number): Promise<void> {
    if (!isKitReferenceSlot(slot)) return;
    if (kit.status !== McKitStatus.REVIEW) return; // gate: só durante a revisão

    const desc = this.parseCanonicalDesc(kit.canonicalDesc);
    try {
      const mascotImage = await this.loadMascotImage(kit);
      const newAssetId = await this.generateAndSaveReference(kit, slot, desc, mascotImage);
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
        await manager.update(McCharacterKit, { id: kit.id }, { referenceAssetIds: nextIds });
        if (previous) await manager.softDelete(AnimationAsset, previous.id);
        await this.commercials.appendEvent(manager, {
          userId: kit.userId,
          refKind: 'kit',
          refId: kit.id,
          kind: 'reference_regenerated',
          detail: { slot, assetId: newAssetId, replacedAssetId: previous?.id ?? null },
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

  /** (a) Descrição canônica: JSON {traits, colors[], style, doNots[]} (plano §4 "mascot bible"). */
  private async generateCanonicalDesc(mascotImage: Buffer): Promise<KitCanonicalDesc> {
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
    const dataUri = `data:${sniffImageMime(mascotImage)};base64,${mascotImage.toString('base64')}`;
    const response = await withRetry(async () => {
      try {
        return await this.openai!.chat.completions.create({
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
              content:
                'You describe brand mascots for faithful reproduction by image models. ' +
                'Separate WHAT THE CHARACTER IS from WHAT IT IS HOLDING:\n' +
                '- "traits": inherent features only — species, anatomy, proportions, fur/skin, ' +
                'facial features, clothing and worn items (apron, scarf, badge, hat).\n' +
                '- "accessories": removable props the character carries or holds in the ' +
                'reference art (shopping basket, box, phone, tray, bag, product). These are ' +
                'NOT part of the character — never list them in "traits" or "doNots".\n' +
                '- "colors": dominant colors, hex codes when possible.\n' +
                '- "style": the visual style.\n' +
                '- "doNots": identity rules that must never change (species, outfit colors, ' +
                'proportions). Never write a doNot that requires keeping an accessory.\n' +
                'Write these fields in English (they feed image models). Then fill "pt" with ' +
                'the Brazilian Portuguese translation of traits, accessories, style and doNots, ' +
                'in the SAME order and with the SAME number of items — it is what the user reads.',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Describe this mascot character for a character reference sheet.',
                },
                { type: 'image_url', image_url: { url: dataUri } },
              ],
            },
          ],
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 429 || (status != null && status >= 500)) {
          throw new TransientProviderError(`HTTP ${status}`);
        }
        throw err;
      }
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Resposta vazia do modelo de visão');
    const parsed = JSON.parse(raw) as KitCanonicalDesc;
    if (!Array.isArray(parsed.traits) || typeof parsed.style !== 'string') {
      throw new Error('Descrição canônica em formato inesperado');
    }
    return parsed;
  }

  /** (b) Gera a imagem do slot, grava em uploads/commercials/kits/{kitId}/ e cria o media asset. */
  private async generateAndSaveReference(
    kit: McCharacterKit,
    slot: KitReferenceSlot,
    desc: KitCanonicalDesc | null,
    mascotImage: Buffer,
  ): Promise<string> {
    const prompt = buildKitReferencePrompt(slot, desc);
    const image =
      this.provider() === 'mock'
        ? await this.mockReferenceImage(slot)
        : await this.gemini.generateImage({
            prompt,
            referenceImages: [mascotImage],
            aspectRatio: '1:1',
          });

    const fileUrl = await this.saveFile(kit.id, `ref-${slot}-${Date.now()}.png`, image);
    const asset = await this.dataSource.getRepository(AnimationAsset).save({
      userId: kit.userId,
      kind: 'kit_reference' as const,
      status: 'ready' as const,
      name: `Kit ${KIT_REFERENCE_SLOTS[slot]} — ${kit.id.slice(0, 8)}`,
      origin: 'ai_generated' as const,
      fileUrl,
      mimeType: 'image/png',
      fileSize: String(image.length),
      metadata: {
        kitId: kit.id,
        slot,
        provider: this.provider(),
        // 1500 e não 500: com a ficha embutida, as regras que mais importam na
        // auditoria (acessórios proibidos, ajustes do usuário) vinham depois do
        // corte antigo e o metadata não servia para conferir o que foi enviado.
        prompt: prompt.slice(0, 1500),
      },
    });
    return asset.id;
  }

  /** PNG sintético (sem custo): fundo colorido + rótulo do slot, via sharp. */
  private async mockReferenceImage(slot: KitReferenceSlot): Promise<Buffer> {
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

  /** Imagem do mascote (recorte, senão a fonte) lida do bucket local. */
  private async loadMascotImage(kit: McCharacterKit): Promise<Buffer> {
    const mascot = await this.mascots.findOne(kit.userId, kit.mascotId);
    const imageUrl = mascot.cutoutUrl ?? mascot.sourceImageUrl;
    if (!imageUrl) throw new Error('Mascote sem imagem utilizável (recorte ou fonte)');
    const buffer = await this.readUploadsFile(imageUrl);
    if (!buffer) throw new Error('Arquivo de imagem do mascote não encontrado no disco');
    return buffer;
  }

  private parseCanonicalDesc(raw: string | null): KitCanonicalDesc | null {
    return parseCanonicalDesc(raw);
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
