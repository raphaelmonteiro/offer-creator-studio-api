import { exampleAiRequest } from '../domain/structure-ai-request.testutil';
import { sanitizeSuggestion } from '../domain/structure-suggestion-sanitize';
import { sanitizeContext } from '../domain/structure-suggestion-sanitize.testutil';
import { exampleRequest } from '../domain/structure-suggestion.testutil';
import type {
  RawStructureSuggestion,
  StructureRequest,
} from '../domain/structure-suggestion.types';
import { MockFlyerProStructureAi } from './flyer-pro-structure-ai.mock';
import type { StructureResponsesClient } from './flyer-pro-structure-ai.real';

/** Ajudantes dos testes do provedor real (só testes): o cliente da OpenAI simulado e as respostas de `/responses`. */

/** Uma saída válida do modelo para o encarte de exemplo: Carnes na capa e a PICANHA em destaque. */
export const VALID_OUTPUT: RawStructureSuggestion = {
  summary: 'Carnes abre o encarte com a picanha em destaque.',
  campaign: { kind: 'none', label: '' },
  sections: [
    { id: 's2', page: 1, reason: 'Carnes tem a oferta mais forte.', items: null, itemsReason: '' },
    { id: 's1', page: null, reason: 'Perecível: fica na capa.', items: null, itemsReason: '' },
    { id: 's3', page: 2, reason: '', items: null, itemsReason: '' },
  ],
  heroes: [{ item: 'p04', size: '2x1', reason: 'Preço de/por com foto.' }],
  unsuggest: [],
};

/** A saída válida com campos trocados ou acrescidos (o JSON que o cliente simulado devolve em `responsesResult`). */
export const outputWith = (over: Record<string, unknown>) =>
  JSON.stringify({ ...VALID_OUTPUT, ...over });

/** O tamanho do `usage` do exemplo de custo: 3.700 tokens de entrada e 2.800 de saída. */
export const USAGE = { input_tokens: 3700, output_tokens: 2800 };

/** A resposta de `/responses` com o texto da mensagem; `over` troca o `status` ou o `usage`. */
export function responsesResult(
  text: string,
  over: { status?: string; usage?: object | null } = {},
) {
  return {
    status: over.status ?? 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    ...(over.usage === null ? {} : { usage: over.usage ?? USAGE }),
  };
}

/** A resposta válida, com a saída de `VALID_OUTPUT` serializada. */
export const validResult = () => responsesResult(JSON.stringify(VALID_OUTPUT));

/** O cliente simulado: devolve (ou lança) o que o teste manda, e guarda o corpo e as opções de cada chamada. */
export function fakeResponsesClient(outcome: unknown = validResult()) {
  const create = jest.fn((_body: unknown, _options: unknown) =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
  );
  const client = { responses: { create } } as unknown as StructureResponsesClient;
  return { client, create };
}

/** O provedor simulado sem espera real: o `sleep` é um espião que resolve na hora. */
export function makeMock() {
  const sleep = jest.fn().mockResolvedValue(undefined);
  return { mock: new MockFlyerProStructureAi(sleep), sleep };
}

/** A resposta do simulado para o retrato (e o nome do encarte, com os marcadores), já saneada como a rota a entrega. */
export async function suggestionFor(name: string, request: StructureRequest = exampleRequest()) {
  const { mock } = makeMock();
  const { suggestion } = await mock.suggest(exampleAiRequest({ documentName: name, request }), {
    timeoutMs: 25_000,
  });
  return sanitizeSuggestion(suggestion, sanitizeContext(request));
}
