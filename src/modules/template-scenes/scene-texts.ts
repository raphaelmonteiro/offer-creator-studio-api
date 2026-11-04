import { SceneFailureCode } from './domain/scene.types';

/** Mensagens do assistente no chat da cena (pt-BR). */

export const READY_REPLY =
  'Pronto! Gerei a cena no tamanho do formato. Veja a prévia ao lado e use as camadas para o texto e o logo.';

export const CANCELLED_REPLY = 'Geração cancelada.';

const FAILURE_REPLIES: Record<SceneFailureCode, string> = {
  PROVIDER_QUOTA: 'O serviço de imagem está sem saldo. Avise o administrador.',
  PROVIDER_CONTENT_POLICY:
    'O serviço de imagem recusou este pedido pela política de conteúdo. Descreva a cena de outro jeito.',
  PROVIDER_TIMEOUT: 'O serviço de imagem demorou demais para responder. Tente de novo.',
  PROVIDER_ERROR: 'Não consegui gerar a imagem agora. Tente de novo em instantes.',
  JOB_EXPIRED: 'O processamento foi interrompido. Tente de novo.',
  PAID_CALL_LIMIT:
    'Atingi o limite de chamadas ao serviço de imagem para este pedido. Tente de novo com um pedido mais simples.',
};

export function failureReply(code: SceneFailureCode): string {
  return FAILURE_REPLIES[code];
}
