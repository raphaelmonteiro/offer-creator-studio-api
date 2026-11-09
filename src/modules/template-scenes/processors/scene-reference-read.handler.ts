import { Injectable, Logger } from '@nestjs/common';
import { readRaw, sanitizeConcept } from '../domain/scene-reference-concept';
import { buildConceptPrompt } from '../domain/scene-reference-prompts';
import { conceptReply, summarize } from '../domain/scene-reference-summary';
import { REFERENCE_TEXTS } from '../scene-texts';
import { SceneReferenceVisionService } from '../services/scene-reference-vision.service';
import { SceneCallRunner } from './scene-call-runner';
import { TurnHandler } from './scene-turn-handler';
import { SceneTurnSupport } from './scene-turn-support';
import { TurnContext } from './scene-turn-state';

/**
 * O turno `read_reference` (change add-template-scene-from-reference): uma chamada de visão lê o encarte reduzido e
 * devolve a ficha-conceito; o sanitizador a limpa e o chat recebe o resumo fixo, com a pergunta de confirmação. Nenhuma
 * chamada de imagem. A versão fecha `rejected` (a ficha foi proposta, ou a imagem não é um encarte) ou `failed`
 * (`REFERENCE_READ_FAILED`: visão fora do ar, saída inválida ou arquivo ausente). Sem janela de 5 s nem botão Parar:
 * custa cerca de US$ 0,001 e dura cerca de 3 s. Job repetido, parada e custo são os de qualquer turno
 * (`SceneTurnState`, `SceneCallRunner`).
 */
@Injectable()
export class SceneReferenceReadHandler implements TurnHandler {
  private readonly logger = new Logger(SceneReferenceReadHandler.name);

  constructor(
    private readonly support: SceneTurnSupport,
    private readonly calls: SceneCallRunner,
    private readonly vision: SceneReferenceVisionService,
  ) {}

  async run(ctx: TurnContext): Promise<void> {
    const { state } = this.support;
    const reference = ctx.reference;
    const image = await this.support.readFile(reference?.assetUrl);
    if (!reference || !image) {
      this.logger.error(`Encarte ausente para a leitura (versão ${ctx.versionId})`);
      await state.fail(ctx, 'REFERENCE_READ_FAILED');
      return;
    }
    if (!(await state.advance(ctx, 'reading'))) return;
    const prompt = buildConceptPrompt(
      reference.note && reference.previous
        ? { note: reference.note, previous: reference.previous }
        : undefined,
    );
    const model = this.vision.model();
    const call = await this.calls.visionCall(ctx, {
      model,
      run: () => this.vision.read({ prompt, image, correlationId: ctx.correlationId }),
    });
    if (call.status === 'over') return;
    if (call.status === 'skipped' || !call.value.ok) {
      await state.fail(ctx, 'REFERENCE_READ_FAILED');
      return;
    }
    const { raw } = call.value;
    const reading = readRaw(raw);
    if (reading.kind === 'invalid') {
      await state.fail(ctx, 'REFERENCE_READ_FAILED');
      return;
    }
    if (reading.kind === 'not_flyer') {
      await state.reject(ctx, {
        reply: REFERENCE_TEXTS.notFlyer,
        reference: { state: 'failed', raw, model, prompt },
      });
      return;
    }
    const { concept, removed } = sanitizeConcept(raw);
    const summary = summarize(concept, removed);
    await state.reject(ctx, {
      reply: conceptReply(summary),
      reference: { state: 'proposed', raw, concept, removed, summary, model, prompt },
    });
  }
}
