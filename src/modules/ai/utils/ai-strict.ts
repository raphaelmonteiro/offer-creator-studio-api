/**
 * Opção aditiva das buscas de foto (change 28): com `strict`, a falha da chamada ao provedor sobe classificada
 * (`TransientProviderError` ou `TerminalProviderError`) em vez de virar `null` ou lista vazia. Sem ela, tudo igual a
 * hoje. Só o job do Encarte Pro a passa; as rotas síncronas `/ai/*` nunca.
 */
export interface AiStrictOptions {
  strict?: boolean;
}
