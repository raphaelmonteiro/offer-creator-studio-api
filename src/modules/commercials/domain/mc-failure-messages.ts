import { CHARACTER_CUTOUT_FAILED } from './mc-cutout-issue';
import {
  MC_CLIP_LOW_RESOLUTION_ERROR_CODE,
  MC_CLIP_LOW_RESOLUTION_FINAL_ERROR_CODE,
  MC_QUALITY_ERROR_CODES,
  MC_RENDER_INTERRUPTED_ERROR_CODE,
} from './mc-error-classes';

/**
 * Catálogo fechado de motivos de falha em pt-BR (change video-worker-confiabilidade, design B2):
 * o `errorMessage` de projeto e cena vem daqui, nunca da mensagem crua do fornecedor (que fica
 * só no step e no evento, para o administrador). Texto nunca cita fornecedor, saldo, status HTTP
 * nem corpo. Código novo emitido por outra change precisa de entrada aqui (teste da 1.5).
 */
export type McErrorAction = 'refazer' | 'tentar_mais_tarde' | 'ajustar_cena' | null;

export interface McFailurePresentation {
  code: string;
  message: string | null;
  action: McErrorAction;
  /** O texto pt-BR já vem gravado de função do domínio (ex.: recorte reprovado): não substituir. */
  passthrough: boolean;
}

export const MC_FAILURE_GENERIC_MESSAGE = 'Algo deu errado na produção do vídeo. Tente refazer.';
/** Texto fixado pelo desenvolvedor (P-27): igual para vídeo e voz; não expõe saldo nem fornecedor. */
export const MC_FAILURE_UNAVAILABLE_MESSAGE =
  'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.';
const LOW_RESOLUTION_MESSAGE =
  'O estúdio não entregou a qualidade mínima do modo premium nesta cena. Tente de novo ou duplique o vídeo no modo econômico.';

interface CatalogEntry {
  message: string;
  action: McErrorAction;
}

/** Códigos da classe `quality`: normalmente aceitos pelo ingest; se chegarem à UI, o texto é de qualidade. */
const QUALITY_ENTRIES: Record<string, CatalogEntry> = Object.fromEntries(
  MC_QUALITY_ERROR_CODES.map((code): [string, CatalogEntry] => [
    code,
    code === MC_CLIP_LOW_RESOLUTION_ERROR_CODE
      ? { message: LOW_RESOLUTION_MESSAGE, action: 'refazer' }
      : {
          message: 'O vídeo desta cena não passou na checagem de qualidade. Tente de novo.',
          action: 'refazer',
        },
  ]),
);

const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  ...QUALITY_ENTRIES,
  quota: { message: MC_FAILURE_UNAVAILABLE_MESSAGE, action: 'tentar_mais_tarde' },
  // Chave do fornecedor inválida (Q4): mesmo texto da cota (P-27), sem revelar a causa ao cliente.
  provider_auth: { message: MC_FAILURE_UNAVAILABLE_MESSAGE, action: 'tentar_mais_tarde' },
  provider_transient: {
    message:
      'O serviço de produção do vídeo está fora do ar no momento. Tente de novo em alguns minutos.',
    action: 'refazer',
  },
  provider_timeout: {
    message: 'O estúdio demorou demais para responder. Tente de novo em alguns minutos.',
    action: 'refazer',
  },
  provider_response_lost: {
    message: 'A conexão com o estúdio caiu durante a gravação. Tente de novo.',
    action: 'refazer',
  },
  missing_input_asset: {
    message: 'Um arquivo da gravação não foi encontrado. Use "Refazer" para gravar de novo.',
    action: 'refazer',
  },
  content_policy: {
    message:
      'O estúdio recusou o conteúdo desta cena. Ajuste a fala ou a ação da cena e tente de novo.',
    action: 'ajustar_cena',
  },
  provider_rejected: {
    message:
      'O estúdio não aceitou o pedido desta cena. Tente de novo; se continuar, fale com o suporte.',
    action: 'refazer',
  },
  // fala contínua (video-fala-continua, D6): pré-condições do trecho, sem nome de fornecedor
  chunk_join_frame_missing: {
    message:
      'A imagem de ligação entre os trechos do vídeo não foi encontrada. Use "Refazer" para gravar de novo.',
    action: 'refazer',
  },
  audio_too_large: {
    message: 'A fala desta gravação ficou longa demais. Encurte o texto e tente de novo.',
    action: 'ajustar_cena',
  },
  invalid_provider_output: {
    message: 'O estúdio devolveu um resultado inválido. Tente de novo.',
    action: 'refazer',
  },
  [MC_CLIP_LOW_RESOLUTION_FINAL_ERROR_CODE]: { message: LOW_RESOLUTION_MESSAGE, action: 'refazer' },
  // render do F2/peça interrompido (corrigir-render-remotion-epipe): sem Remotion, Chromium nem pilha
  [MC_RENDER_INTERRUPTED_ERROR_CODE]: {
    message:
      'A montagem do vídeo foi interrompida antes de terminar. Use "Refazer" para montar de novo; se continuar, fale com o suporte.',
    action: 'refazer',
  },
  script_failed: {
    message: 'Não foi possível criar o roteiro do vídeo. Crie o vídeo de novo.',
    action: null,
  },
  not_implemented: { message: 'Este formato de vídeo ainda não está disponível.', action: null },
};

/** Códigos com entrada própria no catálogo (a lista fechada; o resto cai no texto genérico). */
export const MC_FAILURE_CATALOG_CODES: readonly string[] = [
  ...Object.keys(CATALOG),
  CHARACTER_CUTOUT_FAILED,
];

/** `null` só se `errorCode` é nulo/vazio. Código fora do catálogo (inclui `*_failed`) → texto genérico + `refazer`. */
export function mcFailurePresentation(
  errorCode: string | null | undefined,
): McFailurePresentation | null {
  if (!errorCode) return null;
  if (errorCode === CHARACTER_CUTOUT_FAILED) {
    return { code: errorCode, message: null, action: null, passthrough: true };
  }
  const entry = CATALOG[errorCode];
  return {
    code: errorCode,
    message: entry?.message ?? MC_FAILURE_GENERIC_MESSAGE,
    action: entry ? entry.action : 'refazer',
    passthrough: false,
  };
}

/** Texto a GRAVAR em `errorMessage` do projeto/cena na falha terminal (300 caracteres no máximo). */
export function storedFailureMessage(errorCode: string, rawMessage: string): string {
  const presentation = mcFailurePresentation(errorCode);
  if (presentation?.passthrough) return rawMessage.slice(0, 300);
  return presentation?.message ?? MC_FAILURE_GENERIC_MESSAGE;
}

/**
 * Campos de falha que a API devolve: recomputados do `errorCode`, nunca o texto gravado
 * (linhas antigas guardam mensagem crua em inglês). Exceção: `passthrough` devolve o gravado.
 */
export function presentFailure(
  errorCode: string | null | undefined,
  storedMessage: string | null | undefined,
): { errorMessage: string | null; errorAction: McErrorAction } {
  const presentation = mcFailurePresentation(errorCode);
  if (!presentation) return { errorMessage: null, errorAction: null };
  if (presentation.passthrough) {
    return {
      errorMessage: storedMessage || MC_FAILURE_GENERIC_MESSAGE,
      errorAction: presentation.action,
    };
  }
  return { errorMessage: presentation.message, errorAction: presentation.action };
}
