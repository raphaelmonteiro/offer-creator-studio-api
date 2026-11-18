import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { withTimeout } from '../../../shared/async/with-timeout';
import type { LlmUsage } from '../../ai/openai-llm-pricing';
import { withAiLogging } from '../../ai/utils/ai-telemetry.util';
import { STRUCTURE_AI_CONFIG, StructureAiConfig } from '../config/structure-ai.config';
import { resolvePageCount } from '../domain/flyer-pro-setup-rules';
import {
  flyerProNoItems,
  flyerProStructureAiBusy,
  flyerProStructureAiDisabled,
  flyerProStructureAiFailed,
} from '../domain/flyer-pro.errors';
import { pickDeliberateExamples, type StructureExample } from '../domain/read-structure-example';
import {
  buildStructureAiRequest,
  type StructureAiRequest,
  type StructureAiResult,
} from '../domain/structure-ai-request';
import { buildAliases } from '../domain/structure-suggestion-aliases';
import {
  assertStructureBody,
  assertStructureState,
  categorySections,
} from '../domain/structure-suggestion-rules';
import { sanitizeSuggestion, type SanitizeContext } from '../domain/structure-suggestion-sanitize';
import type {
  SanitizedSuggestion,
  StructureItemRow,
  StructureRequest,
  StructureSuggestionView,
} from '../domain/structure-suggestion.types';
import type { StructureSuggestionDto } from '../dto/structure-suggestion.dto';
import {
  FLYER_PRO_STRUCTURE_AI_PORT,
  FlyerProStructureAiPort,
  StructureAiFailure,
} from '../providers/flyer-pro-structure-ai.port';
import { STRUCTURE_SUGGESTION_PROMPT_VERSION } from '../prompts/structure-suggestion.prompt';
import { readWith } from './flyer-pro-read';
import { FlyerProStructureLimiter, isRefusal } from './flyer-pro-structure-limiter';
import {
  readExampleRows,
  readItemsOf,
  readLiveDocument,
  type StructureDocumentRow,
} from './flyer-pro-structure-suggestion.statements';

/** O que o passo 3 lê do banco para montar o pedido ao provedor. */
interface SuggestionContext {
  document: StructureDocumentRow;
  items: StructureItemRow[];
  examples: StructureExample[];
}

/** Os ids distintos de item do pedido, na ordem em que aparecem. */
const requestedItemIds = (request: StructureRequest): string[] => [
  ...new Set(request.sections.flatMap((section) => section.itemIds)),
];

/**
 * N19: a sugestão de estrutura do encarte. Nunca grava: só lê o encarte, os itens e os encartes anteriores do cliente. Os
 * passos, na ordem do contrato: (1) forma e coerência do retrato; (2) função ligada, provedor disponível e os freios em
 * memória; (3) leitura do encarte, das páginas pelo formato, dos itens e dos exemplos; (4) pedido ao provedor com apelidos;
 * (5) chamada com prazo; (6) saneamento; (8) a sugestão atendida conta no teto e a resposta sai. A vaga em andamento é
 * solta em qualquer fim; a falha do provedor (503) não conta no teto.
 */
@Injectable()
export class FlyerProStructureSuggestionService {
  private readonly logger = new Logger(FlyerProStructureSuggestionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STRUCTURE_AI_CONFIG) private readonly config: StructureAiConfig,
    @Inject(FLYER_PRO_STRUCTURE_AI_PORT) private readonly port: FlyerProStructureAiPort,
    private readonly limiter: FlyerProStructureLimiter,
  ) {}

  async suggest(
    documentId: string,
    body: StructureSuggestionDto,
  ): Promise<StructureSuggestionView> {
    assertStructureBody(body);
    assertStructureState(body);
    this.assertAvailable();
    const token = this.acquire(documentId);
    try {
      return await this.serve(documentId, body);
    } finally {
      this.limiter.release(documentId, token);
    }
  }

  /** Passo 2, antes dos freios: função desligada por variável ou provedor que não pode ser chamado (422). */
  private assertAvailable(): void {
    if (!this.config.enabled) throw flyerProStructureAiDisabled('FLAG');
    const reason = this.port.unavailableReason();
    if (reason) throw flyerProStructureAiDisabled(reason);
  }

  /**
   * Passo 2: a vaga do encarte (429 `IN_FLIGHT`) e depois o teto por hora (429 `HOURLY_LIMIT`, solta a vaga). Devolve o
   * token da vaga, que quem a tomou solta no fim da chamada.
   */
  private acquire(documentId: string): number {
    const slot = this.limiter.tryAcquire(documentId, this.config.timeoutMs);
    if (isRefusal(slot)) throw flyerProStructureAiBusy(slot);
    const limited = this.limiter.checkHourly(documentId, this.config.maxPerHour);
    if (limited) {
      this.limiter.release(documentId, slot.token);
      throw flyerProStructureAiBusy(limited);
    }
    return slot.token;
  }

  private async serve(
    documentId: string,
    request: StructureRequest,
  ): Promise<StructureSuggestionView> {
    const context = await readWith(this.dataSource, undefined, (manager) =>
      this.read(manager, documentId, request),
    );
    const suggestionId = randomUUID();
    const aliases = buildAliases(request.sections, new Set(context.items.map((item) => item.id)));
    const aiRequest = buildStructureAiRequest({
      documentName: context.document.name,
      format: context.document.format,
      request,
      aliases,
      items: context.items,
      examples: context.examples,
      maxHeroes: this.config.maxHeroes,
    });
    const { result, sanitized } = await this.ask(aiRequest, suggestionId, {
      request,
      aliases,
      itemsWithPhoto: new Set(context.items.filter((item) => item.imageUrl).map((item) => item.id)),
      maxHeroes: this.config.maxHeroes,
    });
    this.limiter.recordServed(documentId);
    return {
      suggestionId,
      stateDigest: request.stateDigest,
      source: this.port.source,
      model: result.model,
      promptVersion: STRUCTURE_SUGGESTION_PROMPT_VERSION,
      ...sanitized,
      basedOn: {
        items: context.items.length,
        sections: categorySections(request.sections).length,
        clientFlyers: context.examples.length,
      },
    };
  }

  /**
   * Passo 3, na ordem do contrato: o encarte vivo (404), as páginas pelo formato gravado (422), os itens do pedido que são
   * do encarte (422 `FLYER_PRO_NO_ITEMS`) e, com `EXAMPLES` maior que 0, os exemplos do cliente.
   */
  private async read(
    manager: EntityManager,
    documentId: string,
    request: StructureRequest,
  ): Promise<SuggestionContext> {
    const document = await readLiveDocument(manager, documentId);
    resolvePageCount({
      format: document.format,
      formatChanged: false,
      requested: request.pageCount,
    });
    const ids = requestedItemIds(request);
    const items = ids.length > 0 ? await readItemsOf(manager, documentId, ids) : [];
    if (items.length === 0) throw flyerProNoItems();
    const rows = this.config.examples > 0 ? await readExampleRows(manager, document) : [];
    return { document, items, examples: pickDeliberateExamples(rows, this.config.examples) };
  }

  /**
   * Passos 5 e 6: a chamada ao provedor, com prazo, e o saneamento. Com o provedor real, os dois ficam dentro da mesma linha
   * de log de IA (feature, modelo, tokens, custo pela tabela, `suggestionId` e a contagem do que o saneamento tirou); o
   * simulado não escreve linha de IA. Falha, prazo ou saída inválida do provedor são 503, sem plano de reserva.
   */
  private async ask(
    aiRequest: StructureAiRequest,
    suggestionId: string,
    sanitizeContext: SanitizeContext,
  ): Promise<{ result: StructureAiResult; sanitized: SanitizedSuggestion }> {
    let discarded = 0;
    const call = async () => {
      const result = await this.callWithDeadline(aiRequest);
      const sanitized = sanitizeSuggestion(result.suggestion, sanitizeContext);
      discarded = sanitized.discarded.length;
      // `usage` na raiz: é de onde o log de IA lê os tokens.
      return { result, sanitized, usage: result.usage as LlmUsage | null };
    };
    try {
      if (this.port.source !== 'ai') return await call();
      return await withAiLogging(
        this.logger,
        {
          feature: 'flyer-pro.structure-suggestion',
          endpoint: 'responses',
          model: this.config.model,
          pricing: 'table',
          correlationId: suggestionId,
          finishedFields: () => ({ discarded }),
        },
        call,
      );
    } catch (error) {
      if (!(error instanceof StructureAiFailure)) throw error;
      throw flyerProStructureAiFailed({ reason: error.reason, suggestionId });
    }
  }

  /** O provedor contra o prazo (vale para o simulado também); erro que não é `StructureAiFailure` vale `PROVIDER_ERROR`. */
  private async callWithDeadline(aiRequest: StructureAiRequest): Promise<StructureAiResult> {
    const { timeoutMs } = this.config;
    let outcome: StructureAiResult | 'timeout';
    try {
      outcome = await withTimeout(this.port.suggest(aiRequest, { timeoutMs }), timeoutMs);
    } catch (error) {
      if (error instanceof StructureAiFailure) throw error;
      throw new StructureAiFailure(
        'PROVIDER_ERROR',
        error instanceof Error ? error.message : 'Erro do provedor',
      );
    }
    if (outcome === 'timeout')
      throw new StructureAiFailure('TIMEOUT', 'Prazo da sugestão estourado');
    return outcome;
  }
}
