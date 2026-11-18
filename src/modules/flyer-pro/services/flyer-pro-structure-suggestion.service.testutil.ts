import type { DataSource, EntityManager } from 'typeorm';
import type { StructureAiConfig } from '../config/structure-ai.config';
import type { StructureExampleRow } from '../domain/read-structure-example';
import type { StructureAiRequest, StructureAiResult } from '../domain/structure-ai-request';
import { EXAMPLE_ITEMS, exampleRequest } from '../domain/structure-suggestion.testutil';
import type { StructureItemRow, StructureRequest } from '../domain/structure-suggestion.types';
import type { StructureSuggestionDto } from '../dto/structure-suggestion.dto';
import { MockFlyerProStructureAi } from '../providers/flyer-pro-structure-ai.mock';
import type { FlyerProStructureAiPort } from '../providers/flyer-pro-structure-ai.port';
import { FlyerProStructureLimiter } from './flyer-pro-structure-limiter';
import { FlyerProStructureSuggestionService } from './flyer-pro-structure-suggestion.service';
import type { StructureDocumentRow } from './flyer-pro-structure-suggestion.statements';

/** Ajudantes dos unitários da sugestão de estrutura (só testes): o serviço sobre um banco, um provedor e um relógio simulados. */

export const DOCUMENT_ID = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
export const OTHER_DOCUMENT_ID = '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44';
export const CLIENT_ID = 'b02d5a10-3c4e-4f7a-9d21-6e8f0a1b2c3d';

export const CONFIG: StructureAiConfig = {
  enabled: true,
  provider: 'mock',
  model: 'gpt-6-luna',
  effort: 'low',
  timeoutMs: 25_000,
  maxPerHour: 20,
  maxHeroes: 12,
  examples: 3,
};

export const documentRow = (over: Partial<StructureDocumentRow> = {}): StructureDocumentRow => ({
  id: DOCUMENT_ID,
  name: 'Ofertas da semana 47',
  format: '27x40',
  clientId: CLIENT_ID,
  ...over,
});

/** O pedido de exemplo como o DTO o entrega ao serviço. */
export const bodyOf = (over: Partial<StructureRequest> = {}) =>
  exampleRequest(over) as StructureSuggestionDto;

const WRITES = [
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'remove',
  'softRemove',
  'increment',
];

export interface ServiceOptions {
  config?: Partial<StructureAiConfig>;
  /** O encarte lido (`null`: não existe ou foi excluído). */
  document?: StructureDocumentRow | null;
  items?: StructureItemRow[];
  exampleRows?: StructureExampleRow[];
  port?: FlyerProStructureAiPort;
  limiter?: FlyerProStructureLimiter;
}

/** O `manager` só de leitura: qualquer método de escrita que o serviço chamasse apareceria em `writes()`. */
function makeManager(options: ServiceOptions) {
  const manager: Record<string, jest.Mock> = {
    findOne: jest
      .fn()
      .mockResolvedValue(options.document === undefined ? documentRow() : options.document),
    find: jest.fn().mockResolvedValue(options.items ?? EXAMPLE_ITEMS),
    query: jest.fn().mockResolvedValue(options.exampleRows ?? []),
  };
  for (const name of WRITES) manager[name] = jest.fn();
  const writes = () => WRITES.flatMap((name) => manager[name].mock.calls);
  return { manager: manager as unknown as EntityManager, mocks: manager, writes };
}

/** O provedor simulado sem espera real: o `#ia-lenta` usa o `setTimeout` do Jest (relógio falso do teste). */
export const slowAwareMock = () =>
  new MockFlyerProStructureAi((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

/** Provedor de mentira: devolve (ou lança) o que o teste manda e guarda o pedido recebido. */
export function fakePort(
  outcome: StructureAiResult | Error | (() => Promise<StructureAiResult>),
  over: Partial<Pick<FlyerProStructureAiPort, 'source' | 'unavailableReason'>> = {},
) {
  const suggest = jest.fn((_request: StructureAiRequest) => {
    if (outcome instanceof Error) return Promise.reject(outcome);
    return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome);
  });
  const port: FlyerProStructureAiPort = {
    source: 'ai',
    unavailableReason: () => null,
    suggest,
    ...over,
  };
  return { port, suggest };
}

export function makeSuggestionService(options: ServiceOptions = {}) {
  const { manager, mocks, writes } = makeManager(options);
  const dataSource = {
    transaction: jest.fn((level: unknown, work?: (m: EntityManager) => unknown) =>
      (typeof level === 'string' ? work : (level as (m: EntityManager) => unknown))(manager),
    ),
  };
  const limiter = options.limiter ?? new FlyerProStructureLimiter();
  const port = options.port ?? new MockFlyerProStructureAi(() => Promise.resolve());
  const service = new FlyerProStructureSuggestionService(
    dataSource as unknown as DataSource,
    { ...CONFIG, ...options.config },
    port,
    limiter,
  );
  return { service, limiter, mocks, writes, port, dataSource };
}
