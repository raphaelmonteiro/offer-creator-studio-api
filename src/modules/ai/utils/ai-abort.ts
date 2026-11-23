/**
 * Opção aditiva das chamadas de IA de produto (change 29): o `signal` é repassado ao SDK da OpenAI, e a chamada em
 * andamento é cancelada de fato quando ele é abortado (o job do Encarte Pro aborta a chamada que passou do prazo do lote,
 * para ela não seguir paga). Sem a opção, tudo igual a hoje. As rotas síncronas `/ai/*` nunca a passam.
 */
export interface AiAbortOptions {
  signal?: AbortSignal;
}
