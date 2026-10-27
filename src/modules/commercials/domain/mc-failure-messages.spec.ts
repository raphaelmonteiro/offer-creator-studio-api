import { CHARACTER_CUTOUT_FAILED } from './mc-cutout-issue';
import {
  MC_CLIP_LOW_RESOLUTION_FINAL_ERROR_CODE,
  MC_QUALITY_ERROR_CODES,
} from './mc-error-classes';
import {
  MC_FAILURE_CATALOG_CODES,
  MC_FAILURE_GENERIC_MESSAGE,
  mcFailurePresentation,
  presentFailure,
  storedFailureMessage,
} from './mc-failure-messages';

const P27 =
  'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.';

describe('mc-failure-messages — catálogo pt-BR por código (design B2)', () => {
  it('cota usa o texto fixado em P-27 e a ação tentar_mais_tarde', () => {
    expect(mcFailurePresentation('quota')).toMatchObject({
      message: P27,
      action: 'tentar_mais_tarde',
      passthrough: false,
    });
  });

  it('chave inválida do fornecedor (provider_auth) mostra o mesmo texto da cota e tentar_mais_tarde', () => {
    expect(mcFailurePresentation('provider_auth')).toMatchObject({
      message: P27,
      action: 'tentar_mais_tarde',
      passthrough: false,
    });
    expect(MC_FAILURE_CATALOG_CODES).toContain('provider_auth');
  });

  it.each([
    ['provider_transient', /fora do ar/, 'refazer'],
    ['provider_timeout', /demorou demais/, 'refazer'],
    ['provider_response_lost', /conexão/, 'refazer'],
    ['missing_input_asset', /arquivo da gravação não foi encontrado.*Refazer/, 'refazer'],
    ['content_policy', /recusou o conteúdo/, 'ajustar_cena'],
    ['provider_rejected', /não aceitou o pedido/, 'refazer'],
    ['invalid_provider_output', /resultado inválido/, 'refazer'],
    [MC_CLIP_LOW_RESOLUTION_FINAL_ERROR_CODE, /qualidade mínima/, 'refazer'],
    ['script_failed', /roteiro/, null],
    ['not_implemented', /ainda não está disponível/, null],
  ])('%s', (code, text, action) => {
    const p = mcFailurePresentation(code);
    expect(p?.message).toMatch(text);
    expect(p?.action).toBe(action);
  });

  it('código desconhecido e qualquer *_failed → texto genérico + refazer, código original preservado', () => {
    for (const code of ['tts_failed', 'ingest_failed', 'poll_failed', 'codigo_novo']) {
      expect(mcFailurePresentation(code)).toEqual({
        code,
        message: MC_FAILURE_GENERIC_MESSAGE,
        action: 'refazer',
        passthrough: false,
      });
    }
    expect(MC_FAILURE_GENERIC_MESSAGE).toBe('Algo deu errado na produção do vídeo. Tente refazer.');
  });

  it('errorCode nulo ou vazio → null', () => {
    expect(mcFailurePresentation(null)).toBeNull();
    expect(mcFailurePresentation(undefined)).toBeNull();
    expect(mcFailurePresentation('')).toBeNull();
  });

  it('todo código da classe quality e clip_low_resolution_final têm entrada própria', () => {
    for (const code of [...MC_QUALITY_ERROR_CODES, MC_CLIP_LOW_RESOLUTION_FINAL_ERROR_CODE]) {
      expect(MC_FAILURE_CATALOG_CODES).toContain(code);
      expect(mcFailurePresentation(code)?.message).not.toBe(MC_FAILURE_GENERIC_MESSAGE);
    }
  });

  it('nenhum texto cita fornecedor, saldo, status HTTP ou corpo', () => {
    for (const code of MC_FAILURE_CATALOG_CODES) {
      const message = mcFailurePresentation(code)?.message ?? '';
      expect(message).not.toMatch(
        /fal\b|eleven|kling|openai|gemini|saldo|crédito|HTTP|\b[45]\d\d\b/i,
      );
    }
  });

  it('character_cutout_failed é passthrough: o texto pt-BR do domínio do recorte não é trocado', () => {
    expect(mcFailurePresentation(CHARACTER_CUTOUT_FAILED)?.passthrough).toBe(true);
    expect(storedFailureMessage(CHARACTER_CUTOUT_FAILED, 'O recorte falhou em 2 fala(s).')).toBe(
      'O recorte falhou em 2 fala(s).',
    );
    expect(presentFailure(CHARACTER_CUTOUT_FAILED, 'O recorte falhou em 2 fala(s).')).toEqual({
      errorMessage: 'O recorte falhou em 2 fala(s).',
      errorAction: null,
    });
  });

  it('storedFailureMessage nunca devolve a mensagem crua do fornecedor', () => {
    const raw = 'HTTP 403: {"detail":"User is locked. Reason: Exhausted balance"}';
    expect(storedFailureMessage('quota', raw)).toBe(P27);
    expect(storedFailureMessage('tts_failed', raw)).toBe(MC_FAILURE_GENERIC_MESSAGE);
  });

  it('presentFailure recomputa do código e ignora o texto gravado em inglês (linha antiga)', () => {
    expect(presentFailure('provider_rejected', 'HTTP 400: invalid_uid')).toEqual({
      errorMessage: mcFailurePresentation('provider_rejected')?.message,
      errorAction: 'refazer',
    });
    expect(presentFailure(null, 'HTTP 400: sobra antiga')).toEqual({
      errorMessage: null,
      errorAction: null,
    });
  });
});
