import { Inject, Injectable, Logger } from '@nestjs/common';
import { LocalTarget, SceneClassification } from '../domain/scene-operation.classifier';
import { RegionSpec } from '../domain/scene-shapes';
import { ZONE_LABEL } from '../domain/scene-target-source';
import { elementRect } from '../domain/scene-element-rect';
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
      integrateLayer: plan.integrateLayer?.name,
    });
    const raw = await this.callModel(ctx, prepared, prompt);
    if (!raw) return;
    if (!(await state.advance(ctx, 'blending'))) return;
    const edit = await this.recompose(ctx, prepared, raw);
    if (!edit) return;
    if (!(await state.advance(ctx, 'checking'))) return;
    await this.respond(ctx, edit, plan);
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
  private async respond(
    ctx: TurnContext,
    edit: EditResult,
    plan: Extract<SceneClassification, { operation: 'local_edit' }>,
  ): Promise<void> {
    const request = plan.instruction;
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
      reply: edit.noChange ? NO_CHANGE_REPLY : editReply(facts, 'area', this.areaLabel(ctx, plan)),
      ...(facts?.satisfied === 'nao' ? { notApplied: { changed: facts.changed } } : {}),
      ...this.withoutIntegratedLayer(ctx, plan, edit.noChange),
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

  /** Nome da área entendida para a resposta: a zona, a marcada ou a camada. */
  private areaLabel(
    ctx: TurnContext,
    plan: Extract<SceneClassification, { operation: 'local_edit' }>,
  ): string {
    const { target } = plan;
    if (target.kind === 'zone') return ZONE_LABEL[target.zone];
    if (target.kind === 'element') {
      return ctx.parent?.elements.find((e) => e.id === target.elementId)?.name ?? 'a camada';
    }
    return 'a marcada';
  }

  /** Integrada ao fundo, a camada sai da versão (não se `noChange`: nada foi pintado). */
  private withoutIntegratedLayer(
    ctx: TurnContext,
    plan: Extract<SceneClassification, { operation: 'local_edit' }>,
    noChange: boolean,
  ): { elements?: SceneElement[] } {
    if (!plan.integrateLayer || noChange) return {};
    const { elementId } = plan.integrateLayer;
    return { elements: (ctx.parent?.elements ?? []).filter((e) => e.id !== elementId) };
  }

  private elementBox(ctx: TurnContext): Rect | null {
    const element = ctx.parent?.elements.find((e) => e.id === ctx.targetElementId);
    return element ? elementRect(element, ctx) : null;
  }
}
