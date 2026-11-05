import { Inject, Injectable, Logger } from '@nestjs/common';
import { LocalTarget } from '../domain/scene-operation.classifier';
import { RegionSpec } from '../domain/scene-shapes';
import { Rect, SceneElement } from '../domain/scene.types';
import { SCENE_IMAGE_PROVIDER, SceneImageProvider } from '../providers/scene-image-provider';
import { CROP_TOO_SMALL_REPLY, editReply, NO_CHANGE_REPLY } from '../scene-texts';
import { EditResult, PreparedEdit, SceneImageService } from '../services/scene-image.service';
import { RecomposeMismatchError } from '../services/scene-recompose';
import { SceneVisionService } from '../services/scene-vision.service';
import { SceneCallRunner } from './scene-call-runner';
import { buildEditPrompt } from './scene-prompt';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/** Retângulo normalizado de um elemento (centro, largura e proporção), preso à cena. */
export function elementRect(
  el: SceneElement,
  ctx: Pick<TurnContext, 'widthPx' | 'heightPx'>,
): Rect {
  const h = (el.w * ctx.widthPx) / el.aspect / ctx.heightPx;
  const x = Math.max(0, el.x - el.w / 2);
  const y = Math.max(0, el.y - h / 2);
  return { x, y, w: Math.min(el.w, 1 - x), h: Math.min(h, 1 - y) };
}

/** Forma que o servidor rasteriza: o retângulo, a zona, a máscara do pincel/laço ou a caixa do elemento. */
export function regionSpecOf(target: LocalTarget, ctx: TurnContext): RegionSpec | null {
  if (target.kind === 'rect') return { kind: 'rect', rect: target.rect };
  if (target.kind === 'mask') return target.mask;
  if (target.kind === 'zone') return { kind: 'zone', zone: target.zone };
  const element = ctx.parent?.elements.find((e) => e.id === target.elementId);
  return element ? { kind: 'rect', rect: elementRect(element, ctx) } : null;
}

const INTERSECT = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Elementos que já fazem parte da imagem (sol, nuvem) e estão na região: o nome entra no pedido. */
function knownElementNames(ctx: TurnContext, region: Rect | null): string[] {
  if (!region) return [];
  return (ctx.parent?.elements ?? [])
    .filter(
      (e) => (e.kind === 'sun' || e.kind === 'cloud') && INTERSECT(elementRect(e, ctx), region),
    )
    .map((e) => e.name);
}

/**
 * `local_edit` (e "remover", que é uma edição local): recorta a região com margem, edita o recorte
 * com a máscara (M3), recompõe sobre a master anterior com recuo e feather, confere o exterior byte a
 * byte e responde pela visão antes/depois. Etapas com nome: `preparing` → `editing` → `blending` →
 * `checking` → `saving`.
 */
@Injectable()
export class SceneEditHandler implements TurnHandler {
  private readonly logger = new Logger(SceneEditHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    private readonly images: SceneImageService,
    private readonly vision: SceneVisionService,
    @Inject(SCENE_IMAGE_PROVIDER) private readonly provider: SceneImageProvider,
  ) {}

  async run(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    const plan = ctx.plan;
    if (plan?.operation !== 'local_edit') return state.fail(ctx, 'PROVIDER_ERROR');
    const master = await this.support.readMaster(ctx);
    const spec = regionSpecOf(plan.target, ctx);
    if (!master || !spec) {
      this.logger.error(`Master ou alvo ausente na edição (versão ${ctx.versionId})`);
      return state.fail(ctx, 'PROVIDER_ERROR');
    }
    const prepared = await this.images.prepareEdit({ master, region: spec, zones: ctx.zones });
    if (prepared.plan.belowMinArea) return state.reject(ctx, CROP_TOO_SMALL_REPLY);
    if (!(await state.advance(ctx, 'editing'))) return;
    const prompt = buildEditPrompt({
      request: plan.instruction,
      remove: plan.remove,
      knownElements: knownElementNames(ctx, ctx.requestedRegion),
    });
    const raw = await this.callModel(ctx, prepared, prompt);
    if (!raw) return;
    if (!(await state.advance(ctx, 'blending'))) return;
    const edit = await this.recompose(ctx, prepared, raw);
    if (!edit) return;
    if (!(await state.advance(ctx, 'checking'))) return;
    await this.respond(ctx, edit, plan.instruction);
  }

  private async callModel(
    ctx: TurnContext,
    prepared: PreparedEdit,
    prompt: string,
  ): Promise<Buffer | null> {
    const size = `${prepared.plan.sendW}x${prepared.plan.sendH}`;
    const paintMask =
      this.provider.name === 'mock' ? await this.images.shapeMask(prepared) : undefined;
    const result = await this.calls.imageCall(ctx, {
      kind: 'edit',
      model: this.support.model(),
      size,
      run: () =>
        this.provider.edit({
          model: this.support.model(),
          prompt,
          size,
          quality: this.support.editQuality(),
          correlationId: ctx.correlationId,
          image: prepared.imagePng,
          mask: prepared.maskPng,
          ...(paintMask ? { paintMask } : {}),
        }),
    });
    return result?.buffer ?? null;
  }

  /** A conferência byte a byte falhando é `RECOMPOSE_MISMATCH`; a chamada paga já está gravada. */
  private async recompose(
    ctx: TurnContext,
    prepared: PreparedEdit,
    raw: Buffer,
  ): Promise<EditResult | null> {
    try {
      return await this.images.completeEdit(prepared, raw);
    } catch (error) {
      if (!(error instanceof RecomposeMismatchError)) throw error;
      this.logger.error(`RECOMPOSE_MISMATCH (versão ${ctx.versionId}): ${error.message}`);
      await this.support.state.fail(ctx, 'RECOMPOSE_MISMATCH');
      return null;
    }
  }

  /** Resposta pela visão (se sobrar chamada e o modelo não devolveu a mesma área); senão pelas métricas. */
  private async respond(ctx: TurnContext, edit: EditResult, request: string): Promise<void> {
    let facts: { changed: string; satisfied: 'sim' | 'parcial' | 'nao' } | null = null;
    if (!edit.noChange) {
      const call = await this.calls.visionCall(ctx, {
        model: this.vision.model(),
        run: () =>
          this.vision.assess({
            request,
            before: edit.beforePng,
            after: edit.afterPng,
            correlationId: ctx.correlationId,
          }),
      });
      if (call.status === 'over') return;
      if (call.status === 'ok' && call.value.ok) facts = call.value;
    }
    await this.support.finishWithImage(ctx, edit.finalPng, {
      reply: edit.noChange ? NO_CHANGE_REPLY : editReply(facts),
      ...(facts?.satisfied === 'nao' ? { notApplied: { changed: facts.changed } } : {}),
      metrics: {
        ...edit.metrics,
        noChange: edit.noChange,
        crop: edit.plan,
        vision: facts ? { satisfied: facts.satisfied } : null,
      },
      // Elemento selecionado: a região alterada é a caixa dele (rect, zona e forma já a gravam ao enfileirar).
      ...(ctx.requestedRegion ? {} : { requestedRegion: this.elementBox(ctx) }),
    });
  }

  private elementBox(ctx: TurnContext): Rect | null {
    const element = ctx.parent?.elements.find((e) => e.id === ctx.targetElementId);
    return element ? elementRect(element, ctx) : null;
  }
}
