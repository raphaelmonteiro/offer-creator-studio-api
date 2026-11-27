import { chatResponse, installFakeOpenAi, spyOnLogger } from '../../ai/utils/openai-chat.testutil';
import { CAROUSEL_OFFERS } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McProjectStatus, McStepStatus } from '../domain/mc-state-machines';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { newScriptProcessor } from './mc-script.processor.testutil';

/**
 * Apoio dos testes da chamada do diretor nos quatro formatos (change 42, task 1.10): os projetos, as respostas do
 * provedor e o processador com o cliente da OpenAI simulado, usados por `mc-script.processor.director.spec.ts` e
 * `mc-script.processor.director-failures.spec.ts`. Nenhuma chamada paga.
 */
export type DirectorFormat = 'v1' | 'v2' | 'talking_art' | 'offer_carousel' | 'offer_piece';

export const TERRA = 'gpt-6.1-terra';
const PRODUCTS = [{ name: 'Café Pilão', price: '12,90' }];

const PROJECTS: Record<DirectorFormat, Record<string, unknown>> = {
  v1: base({ options: { musicEnabled: false, captionsEnabled: false, products: PRODUCTS } }),
  v2: base({
    pipelineVersion: MC_PIPELINE_V2,
    options: { musicEnabled: false, captionsEnabled: false, products: PRODUCTS },
  }),
  talking_art: base({
    format: 'talking_art',
    pipelineVersion: MC_PIPELINE_V2,
    aspectRatio: '9:16',
    options: { musicEnabled: false, captionsEnabled: false, products: CAROUSEL_OFFERS.slice(0, 4) },
  }),
  offer_carousel: base({
    format: 'offer_carousel',
    pipelineVersion: MC_PIPELINE_V2,
    options: { musicEnabled: false, captionsEnabled: false, products: CAROUSEL_OFFERS.slice(0, 4) },
  }),
  offer_piece: base({
    format: 'offer_piece',
    pipelineVersion: MC_PIPELINE_V2,
    aspectRatio: '9:16',
    options: { musicEnabled: false, captionsEnabled: false, products: PRODUCTS },
    pieceId: 'piece-1',
    pieceSnapshot: fixturePieceDocument(),
  }),
};

function base(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p1',
    userId: 'u1',
    kitId: 'k1',
    tier: 'economico',
    briefing: 'Ofertas da semana',
    targetDurationS: 20,
    reservedCredits: 0,
    consumedCredits: 0,
    ...extra,
  };
}

/** A resposta do provedor de cada formato (o que o `json_schema` do diretor devolve). */
const REPLIES: Record<DirectorFormat, unknown> = {
  v1: {
    scenes: [
      { actionPrompt: 'Mascote acena', dialogue: 'Café Pilão a doze e noventa!', durationS: 6 },
    ],
  },
  v2: {
    scenes: [
      {
        sceneType: 'presenter',
        actionPrompt: 'Mascote acena',
        actionPromptEn: 'The mascot waves',
        initialFrame: 'Mascote na cozinha',
        initialFrameEn: 'The mascot in the kitchen',
        dialogue: 'Café Pilão a doze e noventa!',
        durationS: 6,
        productIndex: 0,
      },
    ],
  },
  talking_art: {
    narration:
      'Chegou a hora das ofertas! Arroz por vinte e quatro reais e noventa centavos. Corre pra loja!',
    citedOfferIndexes: [0],
  },
  offer_carousel: {
    opening: 'Chegou a hora das ofertas!',
    offerLines: [0, 1, 2, 3].map((offerIndex) => ({
      offerIndex,
      text: `Oferta número ${offerIndex}!`,
    })),
    closing: 'Corre pro Mercadão!',
  },
  offer_piece: {
    opening: 'Olá! Ofertas de hoje!',
    offerLines: [0, 1, 2].map((offerIndex) => ({ offerIndex, text: `Item número ${offerIndex}!` })),
    closing: 'Corre pra cá!',
  },
};

export const FORMATS = Object.keys(PROJECTS) as DirectorFormat[];

/** O processador do formato com o cliente simulado respondendo `replies` na ordem (um `Error` rejeita a chamada). */
export function directorRig(
  format: DirectorFormat,
  config: Record<string, string>,
  ...replies: unknown[]
) {
  const harness = newScriptProcessor({ project: PROJECTS[format], tradeName: 'Mercadão', config });
  const create = installFakeOpenAi(harness.processor);
  const logs = spyOnLogger(harness.processor);
  for (const reply of replies) {
    create.mockImplementationOnce(() =>
      reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
    );
  }
  return { harness, processor: harness.processor, create, logs };
}

/** A resposta de sucesso do formato (o JSON de `REPLIES` na forma da `chat.completions`). */
export const okReply = (format: DirectorFormat) =>
  chatResponse({ content: JSON.stringify(REPLIES[format]) });

/** Mensagem gravada no step quando o job falha. */
export function stepFailure(harness: ReturnType<typeof newScriptProcessor>): string {
  const call = harness.transitions.casTransition.mock.calls.find(
    (args) => args[1] === McStep && args[4] === McStepStatus.FAILED,
  );
  return (call?.[5] as { errorMessage: string }).errorMessage;
}

/** O código de erro gravado no projeto quando o job falha. */
export function projectErrorCode(harness: ReturnType<typeof newScriptProcessor>): string {
  const call = harness.transitions.casTransition.mock.calls.find(
    (args) => args[1] === McProject && args[4] === McProjectStatus.FAILED,
  );
  return (call?.[5] as { errorCode: string }).errorCode;
}

/** A linha de log "AI operation finished" do diretor ('' sem ela). */
export function finishedLine(logs: ReturnType<typeof spyOnLogger>): string {
  return logs.lines().find((line) => line.startsWith('AI operation finished')) ?? '';
}

/** `MC_SCRIPT_PROVIDER=openai` e a configuração limpa com a chave de teste, em cada teste do describe que chama isto. */
export function useOpenAiDirectorEnv(config: Record<string, string>): void {
  const originalProvider = process.env.MC_SCRIPT_PROVIDER;
  beforeEach(() => {
    for (const key of Object.keys(config)) delete config[key];
    config.OPENAI_API_KEY = 'sk-test';
    process.env.MC_SCRIPT_PROVIDER = 'openai';
  });
  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = originalProvider;
  });
}
