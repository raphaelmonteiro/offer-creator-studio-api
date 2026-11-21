import { llmCostUsd, LlmUsage } from '../openai-llm-pricing';

/**
 * Uso de uma invocação de feature de IA de produto (contrato interno aditivo, D-12 e D-13): é o que o job do
 * Encarte Pro (changes 28 e 29) soma para `costUsd` e `models`. Não vai no corpo de nenhuma rota HTTP.
 */
export interface AiInvocationUsage {
  /** Primeiro modelo da invocação (o da feature, mesmo sem chamada: cache, flag desligada, sem chave). */
  model: string | null;
  /** Todos os modelos vistos, sem repetição, na ordem em que apareceram (um coletor pode somar várias features). */
  models: string[];
  /** Chamadas à OpenAI que terminaram (com ou sem `usage` na resposta). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Soma pela tabela de preços; 0 sem chamada; `null` se alguma chamada não tem preço ou veio sem `usage`. */
  costUsd: number | null;
}

/** Opções aditivas das assinaturas dos serviços: quem não passa `usage` recebe o resultado de hoje. */
export interface AiUsageOptions {
  usage?: AiUsageCollector;
}

const MICRO = 1_000_000;

/**
 * Coletor entregue pelo chamador. Soma as chamadas bem-sucedidas da invocação: lotes, nova tentativa por JSON
 * inválido, item a item e segunda passada da foto. Chamada que falhou com resposta de erro do provedor não entra (o log
 * registra a falha). Chamada abortada no meio (sinal do chamador ou prazo da própria chamada) ou ainda em andamento
 * quando se lê o uso pode ter sido cobrada sem devolver `usage`: entra como chamada sem uso, e o custo fica nulo
 * (desconhecido), nunca a soma das que terminaram (D-orq-1). Um mesmo coletor pode somar várias invocações.
 */
export class AiUsageCollector {
  private readonly seenModels: string[] = [];
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private costKnown = true;
  private inFlight = 0;

  /** Registra o modelo da feature antes de qualquer chamada, para a invocação sem chamada também o trazer. */
  declareModel(model: string): void {
    this.noteModel(model);
  }

  /** Registra uma chamada que terminou com sucesso. */
  record(model: string, usage: LlmUsage | null | undefined): void {
    this.noteModel(model);
    this.calls += 1;
    const cost = llmCostUsd(model, usage);
    if (cost === null) this.costKnown = false;
    else this.costUsd += cost;
    if (!usage) return;
    this.inputTokens += usage.prompt_tokens ?? usage.input_tokens ?? 0;
    this.outputTokens += usage.completion_tokens ?? usage.output_tokens ?? 0;
  }

  /**
   * Corre uma chamada paga e a registra: resposta com `usage` entra com ele; erro de `wasAborted` (a chamada foi
   * abortada no meio) entra como chamada sem uso; qualquer outro erro não entra. Enquanto a chamada não termina, o custo
   * do `snapshot` já é desconhecido: quem lê o uso com ela em andamento (lote que falhou ou passou do prazo e a
   * abandonou) não sabe o que ela vai custar.
   */
  async track<R extends { usage?: LlmUsage | null }>(
    model: string,
    run: () => Promise<R>,
    wasAborted: (error: unknown) => boolean = () => false,
  ): Promise<R> {
    this.noteModel(model);
    this.inFlight += 1;
    try {
      const response = await run();
      this.record(model, response.usage);
      return response;
    } catch (error) {
      if (wasAborted(error)) this.record(model, null);
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  snapshot(): AiInvocationUsage {
    return {
      model: this.seenModels[0] ?? null,
      models: [...this.seenModels],
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd:
        this.costKnown && this.inFlight === 0 ? Math.round(this.costUsd * MICRO) / MICRO : null,
    };
  }

  private noteModel(model: string): void {
    if (!this.seenModels.includes(model)) this.seenModels.push(model);
  }
}
