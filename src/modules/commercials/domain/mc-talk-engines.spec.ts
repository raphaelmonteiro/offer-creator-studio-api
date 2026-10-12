import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import {
  isAllowedFalVideoUrl,
  KLING_ACTION_MODEL,
  KLING_ACTION_USD_PER_S,
  KLING_AVATAR_MODEL,
  KLING_AVATAR_PRO_MODEL,
  KLING_AVATAR_USD_PER_S,
  MC_TALK_ENGINE_DEFAULTS,
  mcQueueForStep,
  mcTalkEngines,
  mcUsdPerSecond,
  mcUsdPerSecondForModel,
  MINIMAX_H3_LIPSYNC_MODEL,
  parseTalkEngine,
  talkEngineFor,
  talkEngineKeyFor,
  talkFallbackEngineKey,
} from './mc-pipeline.config';
import {
  assertTalkAudioWithinEngineLimit,
  buildTalkSubmitInput,
  isTalkEngineAvailabilityError,
  isTalkEngineKey,
  MC_PREMIUM_MIN_LONG_SIDE_PX,
  OMNIHUMAN_V15_MODEL,
  omnihumanResolution,
  premiumResolutionApplies,
  premiumResolutionOk,
  resolveTalkEngine,
  talkEngineFamily,
  talkEngineMaxAudioS,
  talkEngineSnapshot,
  talkFallbackEngine,
} from './mc-talk-engines';
import {
  classifyMcError,
  MC_CLIP_LOW_RESOLUTION_ERROR_CODE,
  mcShouldRegenerateQuality,
  MC_CLIP_TEXT_ERROR_CODE,
} from './mc-error-classes';
import { buildTalkPrompt, TALK_PROMPT_SUFFIX } from './mc-talk-prompts';
import { McStepType } from './mc-types';

describe('motores de fala por tier e origem (design D2, tarefa 3.2)', () => {
  describe('parseTalkEngine — "modelo|usdPorSegundo|maxChunkS"', () => {
    it('vazio devolve o default (cópia, não a referência)', () => {
      const parsed = parseTalkEngine('', MC_TALK_ENGINE_DEFAULTS.premium);
      expect(parsed).toEqual(MC_TALK_ENGINE_DEFAULTS.premium);
      expect(parsed).not.toBe(MC_TALK_ENGINE_DEFAULTS.premium);
      expect(parseTalkEngine(undefined, MC_TALK_ENGINE_DEFAULTS.logo)).toEqual(
        MC_TALK_ENGINE_DEFAULTS.logo,
      );
    });

    it('lê os três campos com espaços em volta', () => {
      expect(parseTalkEngine(' fal-ai/x/y | 0.2 | 30 ', MC_TALK_ENGINE_DEFAULTS.economico)).toEqual(
        { model: 'fal-ai/x/y', usdPerSecond: 0.2, maxChunkS: 30 },
      );
    });

    it('campos ausentes caem no default; modelo em branco, tarifa ou limite inválidos são erro de config', () => {
      expect(parseTalkEngine('fal-ai/x/y', MC_TALK_ENGINE_DEFAULTS.economico)).toEqual({
        model: 'fal-ai/x/y',
        usdPerSecond: KLING_AVATAR_USD_PER_S,
        maxChunkS: 15,
      });
      expect(() => parseTalkEngine('|0.1|15', MC_TALK_ENGINE_DEFAULTS.economico)).toThrow(
        /modelo em branco/,
      );
      expect(() => parseTalkEngine('m|abc|15', MC_TALK_ENGINE_DEFAULTS.economico)).toThrow(
        /tarifa inválida/,
      );
      expect(() => parseTalkEngine('m|-1|15', MC_TALK_ENGINE_DEFAULTS.economico)).toThrow(
        /tarifa inválida/,
      );
      expect(() => parseTalkEngine('m|0.1|0', MC_TALK_ENGINE_DEFAULTS.economico)).toThrow(
        /maxChunkS inválido/,
      );
    });

    it('mcTalkEngines lê as três variáveis do env (defaults do .env.example quando vazias)', () => {
      expect(mcTalkEngines({})).toEqual(MC_TALK_ENGINE_DEFAULTS);
      const engines = mcTalkEngines({
        MC_TALK_ENGINE_ECONOMICO: 'fal-ai/kling-video/ai-avatar/v2/standard|0.0562|15',
        MC_TALK_ENGINE_PREMIUM: 'fal-ai/bytedance/omnihuman/v1.5|0.16|30',
        MC_TALK_ENGINE_LOGO: 'minimax/h3-max/lip-sync/image-to-video|0.08|15',
      });
      expect(engines.premium).toEqual({
        model: 'fal-ai/bytedance/omnihuman/v1.5',
        usdPerSecond: 0.16,
        maxChunkS: 30,
      });
      expect(engines.economico.model).toBe(KLING_AVATAR_MODEL);
      expect(engines.logo.model).toBe(MINIMAX_H3_LIPSYNC_MODEL);
    });
  });

  describe('talkEngineFor — tier × modo de identidade', () => {
    it('kit gerado: econômico → Kling Avatar standard; premium → Kling Avatar pro (default)', () => {
      expect(talkEngineFor({ tier: 'economico', identityMode: 'generated' }, {})).toMatchObject({
        key: 'economico',
        model: KLING_AVATAR_MODEL,
        usdPerSecond: 0.0562,
        maxChunkS: 15,
      });
      expect(talkEngineFor({ tier: 'premium', identityMode: 'generated' }, {})).toMatchObject({
        key: 'premium',
        model: KLING_AVATAR_PRO_MODEL,
        usdPerSecond: 0.115,
      });
    });

    it('logo_as_is usa o motor de LOGO em qualquer tier (premium incluído)', () => {
      expect(talkEngineFor({ tier: 'premium', identityMode: 'logo_as_is' }, {})).toMatchObject({
        key: 'logo',
        model: MINIMAX_H3_LIPSYNC_MODEL,
        usdPerSecond: 0.08,
      });
      expect(talkEngineKeyFor({ tier: 'economico', identityMode: 'logo_as_is' })).toBe('logo');
    });

    it('tier/identidade ausentes (projeto anterior à migration) caem no econômico', () => {
      expect(talkEngineKeyFor({ tier: null, identityMode: null })).toBe('economico');
      expect(talkEngineKeyFor({ tier: undefined, identityMode: 'generated' })).toBe('economico');
    });

    it('fallback por indisponibilidade só existe para o motor de logo (→ motor do tier)', () => {
      expect(talkFallbackEngineKey('logo', 'premium')).toBe('premium');
      expect(talkFallbackEngineKey('logo', 'economico')).toBe('economico');
      expect(talkFallbackEngineKey('logo', null)).toBe('economico');
      expect(talkFallbackEngineKey('premium', 'premium')).toBeNull();
      expect(talkFallbackEngineKey('economico', 'economico')).toBeNull();
    });
  });

  describe('tarifa por modelo (telemetria do ingest)', () => {
    it('motores configurados e modelos fixos do pipeline; desconhecido = null', () => {
      const env = { MC_TALK_ENGINE_PREMIUM: 'fal-ai/bytedance/omnihuman/v1.5|0.16|30' };
      expect(mcUsdPerSecondForModel('fal-ai/bytedance/omnihuman/v1.5', env)).toBe(0.16);
      expect(mcUsdPerSecondForModel(KLING_AVATAR_MODEL, env)).toBe(KLING_AVATAR_USD_PER_S);
      expect(mcUsdPerSecondForModel(MINIMAX_H3_LIPSYNC_MODEL, env)).toBe(0.08);
      expect(mcUsdPerSecondForModel(KLING_ACTION_MODEL, env)).toBe(KLING_ACTION_USD_PER_S);
      expect(mcUsdPerSecondForModel('fal-ai/outro/modelo', env)).toBeNull();
      expect(mcUsdPerSecondForModel(null, env)).toBeNull();
    });

    it('custo por clipe = segundos × tarifa do motor (clipe premium de 12 s)', () => {
      const premium = talkEngineFor({ tier: 'premium', identityMode: 'generated' }, {});
      expect(Number((12 * premium.usdPerSecond).toFixed(4))).toBe(1.38);
      const economico = talkEngineFor({ tier: 'economico', identityMode: 'generated' }, {});
      expect(Number((12 * economico.usdPerSecond).toFixed(4))).toBe(0.6744);
      // custo depende dos SEGUNDOS, não do número de clipes: 2×6 s = 1×12 s
      expect(2 * 6 * premium.usdPerSecond).toBeCloseTo(12 * premium.usdPerSecond, 10);
    });

    it('mcUsdPerSecond(talk) usa o motor econômico como fallback por tipo', () => {
      expect(mcUsdPerSecond(McStepType.TALK)).toBe(mcTalkEngines().economico.usdPerSecond);
    });
  });

  describe('adapters de submit por motor', () => {
    const ingredients = {
      imageUrl: 'data:image/png;base64,AAA',
      audioUrl: 'data:audio/mpeg;base64,BBB',
      prompt: 'Waves. Static shot.',
    };

    it('família do modelo: Kling Avatar standard/pro, MiniMax H3 Max, desconhecido', () => {
      expect(talkEngineFamily(KLING_AVATAR_MODEL)).toBe('kling_avatar');
      expect(talkEngineFamily(KLING_AVATAR_PRO_MODEL)).toBe('kling_avatar');
      expect(talkEngineFamily(MINIMAX_H3_LIPSYNC_MODEL)).toBe('minimax_h3');
      expect(talkEngineFamily(OMNIHUMAN_V15_MODEL)).toBe('omnihuman');
      expect(talkEngineFamily('fal-ai/outro/avatar')).toBe('unknown');
    });

    it('Kling Avatar pro: {image_url, audio_url, prompt} — mesmo schema do standard', () => {
      expect(buildTalkSubmitInput(KLING_AVATAR_PRO_MODEL, ingredients)).toEqual({
        image_url: ingredients.imageUrl,
        audio_url: ingredients.audioUrl,
        prompt: 'Waves. Static shot.',
      });
    });

    it('H3 Max: {image_url, audio_url, prompt?, resolution?} — resolução só quando pedida', () => {
      expect(buildTalkSubmitInput(MINIMAX_H3_LIPSYNC_MODEL, ingredients)).toEqual({
        image_url: ingredients.imageUrl,
        audio_url: ingredients.audioUrl,
        prompt: 'Waves. Static shot.',
      });
      expect(
        buildTalkSubmitInput(MINIMAX_H3_LIPSYNC_MODEL, { ...ingredients, resolution: '768P' }),
      ).toMatchObject({ resolution: '768P' });
      // Kling ignora resolução (não faz parte do schema)
      expect(
        buildTalkSubmitInput(KLING_AVATAR_MODEL, { ...ingredients, resolution: '768P' }),
      ).not.toHaveProperty('resolution');
    });

    it('sem prompt não envia a chave; nunca há campo de arte de fundo', () => {
      const input = buildTalkSubmitInput(KLING_AVATAR_MODEL, { ...ingredients, prompt: '  ' });
      expect(input).toEqual({ image_url: ingredients.imageUrl, audio_url: ingredients.audioUrl });
      expect(Object.keys(input).some((k) => /background|art|logo|price/i.test(k))).toBe(false);
    });

    it('erro de disponibilidade: transiente, 404/410/501/503 terminais; nunca content_policy/400', () => {
      expect(isTalkEngineAvailabilityError(new TransientProviderError('HTTP 503'))).toBe(true);
      expect(
        isTalkEngineAvailabilityError(
          new TerminalProviderError('HTTP 404: not found', 'provider_rejected'),
        ),
      ).toBe(true);
      expect(
        isTalkEngineAvailabilityError(
          new TerminalProviderError('HTTP 400: bad input', 'provider_rejected'),
        ),
      ).toBe(false);
      expect(
        isTalkEngineAvailabilityError(new TerminalProviderError('HTTP 422: x', 'content_policy')),
      ).toBe(false);
      expect(isTalkEngineAvailabilityError(new Error('boom'))).toBe(false);
    });
  });

  describe('motor escolhido × motor efetivo no snapshot do step (L4: consistência após fallback)', () => {
    const env = {};
    const premium = { tier: 'premium' as const, identityMode: 'logo_as_is' as const };

    it('resolveTalkEngine: sem snapshot cai na regra D2; snapshot completo prevalece tal qual', () => {
      expect(resolveTalkEngine(null, premium, env)).toMatchObject({
        key: 'logo',
        model: MINIMAX_H3_LIPSYNC_MODEL,
        usdPerSecond: 0.08,
        maxChunkS: 15,
      });
      const full = { key: 'premium', model: 'fal-ai/x/custom', usdPerSecond: 0.2, maxChunkS: 30 };
      expect(resolveTalkEngine(full, premium, env)).toEqual(full);
    });

    it('resolveTalkEngine: snapshot PARCIAL ({key, model}) é completado pela config — nunca tarifa 0', () => {
      expect(
        resolveTalkEngine({ key: 'premium', model: KLING_AVATAR_PRO_MODEL }, premium, env),
      ).toEqual({
        key: 'premium',
        model: KLING_AVATAR_PRO_MODEL,
        usdPerSecond: 0.115,
        maxChunkS: 15,
      });
      // modelo fora da config: tarifa/limite da CHAVE (melhor estimativa), modelo preservado
      expect(resolveTalkEngine({ key: 'logo', model: 'fal-ai/outro/logo' }, premium, env)).toEqual({
        key: 'logo',
        model: 'fal-ai/outro/logo',
        usdPerSecond: 0.08,
        maxChunkS: 15,
      });
      // chave inválida ou modelo em branco: regra D2
      expect(resolveTalkEngine({ key: 'x', model: 'm' }, premium, env).key).toBe('logo');
      expect(resolveTalkEngine({ key: 'premium', model: '  ' }, premium, env).key).toBe('logo');
      expect(isTalkEngineKey('logo')).toBe(true);
      expect(isTalkEngineKey('x')).toBe(false);
    });

    it('talkFallbackEngine: logo → motor do tier com fallbackFrom = modelo de logo; motores de tier não têm fallback', () => {
      const logo = resolveTalkEngine(null, premium, env);
      expect(talkFallbackEngine(logo, 'premium', env)).toEqual({
        key: 'premium',
        model: KLING_AVATAR_PRO_MODEL,
        usdPerSecond: 0.115,
        maxChunkS: 15,
        fallbackFrom: MINIMAX_H3_LIPSYNC_MODEL,
      });
      expect(talkFallbackEngine(logo, 'economico', env)?.model).toBe(KLING_AVATAR_MODEL);
      expect(talkFallbackEngine(logo, null, env)?.key).toBe('economico');
      const tierEngine = resolveTalkEngine(
        null,
        { tier: 'premium', identityMode: 'generated' },
        env,
      );
      expect(talkFallbackEngine(tierEngine, 'premium', env)).toBeNull();
    });

    it('talkEngineSnapshot: sem fallback engine === effectiveEngine (sem fallbackFrom); com fallback, fallbackFrom === engine.model', () => {
      const logo = resolveTalkEngine(null, premium, env);
      const same = talkEngineSnapshot(logo);
      expect(same.effectiveEngine).toEqual(same.engine);
      expect(same.effectiveEngine).not.toHaveProperty('fallbackFrom');
      // efetivo com o MESMO modelo (ex.: registro velho) também não ganha fallbackFrom
      expect(
        talkEngineSnapshot(logo, { ...logo, fallbackFrom: 'lixo' }).effectiveEngine,
      ).not.toHaveProperty('fallbackFrom');
      const fallback = talkFallbackEngine(logo, 'premium', env)!;
      const after = talkEngineSnapshot(logo, fallback);
      expect(after.engine).toMatchObject({ key: 'logo', model: MINIMAX_H3_LIPSYNC_MODEL });
      expect(after.effectiveEngine).toEqual({
        key: 'premium',
        model: KLING_AVATAR_PRO_MODEL,
        usdPerSecond: 0.115,
        maxChunkS: 15,
        fallbackFrom: after.engine.model,
      });
    });
  });

  describe('prompt do talk (D7: pose neutra, plano estático, sem texto)', () => {
    it('gesto + sufixo; sem gesto só o sufixo', () => {
      const prompt = buildTalkPrompt('waves at the start');
      expect(prompt).toMatch(/^waves at the start\. /);
      expect(prompt).toContain('neutral, front-facing resting pose');
      expect(prompt).toContain('Static medium shot, no camera motion');
      expect(prompt).toMatch(/no captions, no subtitles, no signs/);
      expect(buildTalkPrompt('')).toBe(TALK_PROMPT_SUFFIX);
      expect(buildTalkPrompt(null)).toBe(TALK_PROMPT_SUFFIX);
    });
  });

  describe('OmniHuman 1.5 (tarefa 7.1) — adapter, limite por chamada e seleção por config', () => {
    const ingredients = {
      imageUrl: 'data:image/png;base64,AAA',
      audioUrl: 'data:audio/mpeg;base64,BBB',
      prompt: 'Waves. Static shot.',
    };

    it('payload: {image_url, audio_url, prompt, resolution: "1080p"} — resolução SEMPRE explícita, sem máscara', () => {
      const input = buildTalkSubmitInput(OMNIHUMAN_V15_MODEL, ingredients);
      expect(input).toEqual({
        image_url: ingredients.imageUrl,
        audio_url: ingredients.audioUrl,
        prompt: 'Waves. Static shot.',
        resolution: '1080p',
      });
      expect(Object.keys(input).some((k) => /mask|background|art|logo|price/i.test(k))).toBe(false);
      // 720p só quando pedido; enum do H3 (768P) ou lixo caem no 1080p
      expect(
        buildTalkSubmitInput(OMNIHUMAN_V15_MODEL, { ...ingredients, resolution: '720P' }),
      ).toMatchObject({ resolution: '720p' });
      expect(
        buildTalkSubmitInput(OMNIHUMAN_V15_MODEL, { ...ingredients, resolution: '768P' }),
      ).toMatchObject({ resolution: '1080p' });
      // sem prompt: a chave some, a resolução fica
      expect(buildTalkSubmitInput(OMNIHUMAN_V15_MODEL, { ...ingredients, prompt: '' })).toEqual({
        image_url: ingredients.imageUrl,
        audio_url: ingredients.audioUrl,
        resolution: '1080p',
      });
      expect(omnihumanResolution(null)).toBe('1080p');
    });

    it('limite documentado: 30 s a 1080p, 60 s a 720p; demais motores sem limite publicado (null)', () => {
      expect(talkEngineMaxAudioS(OMNIHUMAN_V15_MODEL)).toBe(30);
      expect(talkEngineMaxAudioS(OMNIHUMAN_V15_MODEL, '1080p')).toBe(30);
      expect(talkEngineMaxAudioS(OMNIHUMAN_V15_MODEL, '720p')).toBe(60);
      expect(talkEngineMaxAudioS(KLING_AVATAR_PRO_MODEL)).toBeNull();
      expect(talkEngineMaxAudioS(MINIMAX_H3_LIPSYNC_MODEL)).toBeNull();
    });

    it('guarda do submit: fala > 30 s no OmniHuman 1080p → validação terminal (audio_too_long); ≤ 30 s, 720p até 60 s ou duração desconhecida passam', () => {
      expect(() => assertTalkAudioWithinEngineLimit(OMNIHUMAN_V15_MODEL, 30_000)).not.toThrow();
      let caught: unknown;
      try {
        assertTalkAudioWithinEngineLimit(OMNIHUMAN_V15_MODEL, 30_500);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TerminalProviderError);
      expect((caught as TerminalProviderError).code).toBe('audio_too_long');
      expect((caught as Error).message).toMatch(/30\.5s.*30s/);
      // validação: terminal sem retry, nunca disponibilidade (não dispara fallback)
      expect(classifyMcError(caught)).toBe('validation');
      expect(isTalkEngineAvailabilityError(caught)).toBe(false);
      expect(() =>
        assertTalkAudioWithinEngineLimit(OMNIHUMAN_V15_MODEL, 45_000, '720p'),
      ).not.toThrow();
      expect(() => assertTalkAudioWithinEngineLimit(OMNIHUMAN_V15_MODEL, null)).not.toThrow();
      expect(() => assertTalkAudioWithinEngineLimit(KLING_AVATAR_MODEL, 90_000)).not.toThrow();
    });

    it('MC_TALK_ENGINE_PREMIUM=omnihuman|0.16|30 → kit gerado premium usa o OmniHuman (tarifa 0.16, maxChunkS 30); logo_as_is segue no motor de logo', () => {
      const env = { MC_TALK_ENGINE_PREMIUM: `${OMNIHUMAN_V15_MODEL}|0.16|30` };
      const premium = talkEngineFor({ tier: 'premium', identityMode: 'generated' }, env);
      expect(premium).toEqual({
        key: 'premium',
        model: OMNIHUMAN_V15_MODEL,
        usdPerSecond: 0.16,
        maxChunkS: 30,
      });
      expect(talkEngineFamily(premium.model)).toBe('omnihuman');
      expect(mcUsdPerSecondForModel(OMNIHUMAN_V15_MODEL, env)).toBe(0.16);
      // o maxChunkS da config é o limite que a aprovação usa (fala de 31 s bloqueia)
      expect(31 > premium.maxChunkS).toBe(true);
      expect(premium.maxChunkS).toBeLessThanOrEqual(talkEngineMaxAudioS(premium.model)!);
      expect(talkEngineFor({ tier: 'premium', identityMode: 'logo_as_is' }, env).model).toBe(
        MINIMAX_H3_LIPSYNC_MODEL,
      );
      // snapshot do step com o OmniHuman (env trocado depois) preserva tarifa/limite gravados
      expect(
        resolveTalkEngine(
          { key: 'premium', model: OMNIHUMAN_V15_MODEL, usdPerSecond: 0.16, maxChunkS: 30 },
          { tier: 'premium', identityMode: 'generated' },
          {},
        ),
      ).toEqual({ key: 'premium', model: OMNIHUMAN_V15_MODEL, usdPerSecond: 0.16, maxChunkS: 30 });
    });
  });

  describe('1080p nativo no premium (tarefa 7.2) — regra pura e política do código quality', () => {
    it('a garantia vale para premium com identidade gerada; nunca para logo_as_is nem econômico', () => {
      expect(premiumResolutionApplies({ tier: 'premium', identityMode: 'generated' })).toBe(true);
      expect(premiumResolutionApplies({ tier: 'premium', identityMode: null })).toBe(true);
      expect(premiumResolutionApplies({ tier: 'premium', identityMode: 'logo_as_is' })).toBe(false);
      expect(premiumResolutionApplies({ tier: 'economico', identityMode: 'generated' })).toBe(
        false,
      );
      expect(premiumResolutionApplies({ tier: null, identityMode: 'generated' })).toBe(false);
    });

    it('lado MAIOR ≥ 1080 px (1080×1440, 1920×1080, 810×1080 passam; 720×960 não; desconhecido não comprova)', () => {
      expect(MC_PREMIUM_MIN_LONG_SIDE_PX).toBe(1080);
      expect(premiumResolutionOk(1080, 1440)).toBe(true);
      expect(premiumResolutionOk(1920, 1080)).toBe(true);
      expect(premiumResolutionOk(810, 1080)).toBe(true);
      expect(premiumResolutionOk(720, 960)).toBe(false);
      expect(premiumResolutionOk(1078, 1078)).toBe(false);
      expect(premiumResolutionOk(null, 1440)).toBe(false);
    });

    it('clip_low_resolution é classe quality com UMA regeração (teto 2 execuções); os demais códigos seguem o teto da classe (3)', () => {
      const err = new TerminalProviderError('baixa', MC_CLIP_LOW_RESOLUTION_ERROR_CODE);
      expect(classifyMcError(err)).toBe('quality');
      expect(mcShouldRegenerateQuality(MC_CLIP_LOW_RESOLUTION_ERROR_CODE, 1)).toBe(true);
      expect(mcShouldRegenerateQuality(MC_CLIP_LOW_RESOLUTION_ERROR_CODE, 2)).toBe(false);
      expect(mcShouldRegenerateQuality(MC_CLIP_TEXT_ERROR_CODE, 2)).toBe(true);
      expect(mcShouldRegenerateQuality(MC_CLIP_TEXT_ERROR_CODE, 3)).toBe(false);
    });
  });

  it('o step talk vai para a fila mc.submit e o host do ingest segue restrito à fal', () => {
    expect(mcQueueForStep(McStepType.TALK)).toBe(QUEUES.MC_SUBMIT);
    expect(isAllowedFalVideoUrl('https://v3.fal.media/files/x/clip.mp4')).toBe(true);
    expect(isAllowedFalVideoUrl('https://queue.fal.run/minimax/h3-max/requests/1')).toBe(true);
    expect(isAllowedFalVideoUrl('https://minimax.io/clip.mp4')).toBe(false);
    expect(isAllowedFalVideoUrl('http://v3.fal.media/files/x/clip.mp4')).toBe(false);
  });
});
