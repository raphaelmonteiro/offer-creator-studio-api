import { HttpRejectionKind } from '../provider-errors';

/**
 * Corpos de erro dos fornecedores (design B1 da change video-worker-confiabilidade).
 * `origin`: `real` = capturado em produção; `docs` = documentação pública da API;
 * `fake` = servidor falso do QA; `control` = hipótese de controle. Só o fal 403 de
 * saldo é real. Corpo real novo entra aqui como fixture, sem gasto de API.
 */
export interface ProviderErrorFixture {
  name: string;
  provider: 'fal' | 'elevenlabs';
  status: number;
  body: string;
  origin: 'real' | 'docs' | 'fake' | 'control';
  expected: HttpRejectionKind;
}

const eleven = (status: string, message: string) => JSON.stringify({ detail: { status, message } });

export const PROVIDER_ERROR_FIXTURES: readonly ProviderErrorFixture[] = [
  {
    name: 'fal 403 saldo esgotado',
    provider: 'fal',
    status: 403,
    body: '{"detail":"User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing."}',
    origin: 'real',
    expected: 'quota',
  },
  {
    name: 'fal 403 conta bloqueada por outro motivo',
    provider: 'fal',
    status: 403,
    body: '{"detail":"User is locked. Reason: Account suspended."}',
    origin: 'control',
    expected: 'quota',
  },
  {
    name: 'fal 403 genérico (sem marcador de saldo)',
    provider: 'fal',
    status: 403,
    body: '{"detail":"Forbidden"}',
    origin: 'control',
    expected: 'provider_rejected',
  },
  {
    name: 'fal 401 chave inválida',
    provider: 'fal',
    status: 401,
    body: '{"detail":"Invalid key"}',
    origin: 'fake',
    expected: 'provider_rejected',
  },
  {
    name: 'fal 400 entrada inválida',
    provider: 'fal',
    status: 400,
    body: '{"detail":"image_url is required"}',
    origin: 'control',
    expected: 'provider_rejected',
  },
  {
    name: 'fal 422 validação/política',
    provider: 'fal',
    status: 422,
    body: '{"detail":[{"loc":["body","prompt"],"msg":"field required","type":"value_error.missing"}]}',
    origin: 'control',
    expected: 'content_policy',
  },
  {
    name: 'fal 429 limite de taxa',
    provider: 'fal',
    status: 429,
    body: '{"detail":"Too many requests"}',
    origin: 'control',
    expected: 'transient',
  },
  {
    name: 'fal 503 fora do ar',
    provider: 'fal',
    status: 503,
    body: '{"detail":"Service Unavailable"}',
    origin: 'fake',
    expected: 'transient',
  },
  {
    name: 'ElevenLabs 401 quota_exceeded',
    provider: 'elevenlabs',
    status: 401,
    body: eleven(
      'quota_exceeded',
      'This request exceeds your quota of 10000. You have 12 credits remaining, while 150 credits are required for this request.',
    ),
    origin: 'docs',
    expected: 'quota',
  },
  {
    name: 'ElevenLabs 402 payment_required',
    provider: 'elevenlabs',
    status: 402,
    body: eleven('payment_required', 'Payment required'),
    origin: 'docs',
    expected: 'quota',
  },
  {
    name: 'ElevenLabs 401 invalid_api_key',
    provider: 'elevenlabs',
    status: 401,
    body: eleven('invalid_api_key', 'Invalid API key'),
    origin: 'docs',
    expected: 'provider_rejected',
  },
  {
    name: 'ElevenLabs 429 too_many_concurrent_requests',
    provider: 'elevenlabs',
    status: 429,
    body: eleven('too_many_concurrent_requests', 'Too many concurrent requests'),
    origin: 'docs',
    expected: 'transient',
  },
  {
    name: 'ElevenLabs 400 max_character_limit_exceeded',
    provider: 'elevenlabs',
    status: 400,
    body: eleven('max_character_limit_exceeded', 'Text too long'),
    origin: 'docs',
    expected: 'provider_rejected',
  },
];
