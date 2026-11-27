import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { withOpenAiRetry } from '../../../shared/providers/openai-errors';
import { getOpenAiModelConfig } from '../../ai/config/openai-models.config';
import { callProductChat } from '../../ai/utils/ai-product-chat.util';
import { sceneSourceHash } from '../domain/mc-script-v2';
import { SCENE_DERIVATION_CALL } from '../domain/mc-text-calls';
import { McSceneDerived, McScript, McScriptScene } from '../domain/mc-types';

/** Consumidor da derivação PT → EN no log (`AI operation started|finished|failed`). */
const SCENE_DERIVATION_FEATURE = 'commercials.scene-derivation';

/** Saída estrita da derivação: os dois textos em inglês. */
const SCENE_TRANSLATION_FORMAT: OpenAI.ResponseFormatJSONSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'scene_translation',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        initialFrameEn: { type: ['string', 'null'] },
        actionPromptEn: { type: 'string' },
      },
      required: ['initialFrameEn', 'actionPromptEn'],
    },
  },
};

const SCENE_TRANSLATION_SYSTEM_PROMPT =
  'Translate Brazilian Portuguese scene directions into concise English prompts for ' +
  'image and video generation engines. Keep the meaning EXACTLY; do not add actions, ' +
  'objects, text or brands. "initialFrameEn" describes the static starting image; ' +
  '"actionPromptEn" describes ONE continuous physical motion in descriptive imperative. ' +
  'If initialFrame is empty, return null for initialFrameEn.';

/**
 * Derivação PT → EN da intenção editorial (ADR-001 §3.2 / plano P1).
 *
 * A intenção em português é a fonte; o inglês é uma DERIVAÇÃO versionada por
 * `sourceHash`. Este service preenche `scene.derived` para toda cena cuja
 * derivação está pendente (nova, editada ou de outra revisão). Quando o
 * tradutor não está disponível (provider mock, sem chave, erro), aplica o
 * fallback PT EXPLÍCITO (`lang: 'pt'`): o motor recebe o texto em português e
 * o manifesto registra isso — nunca uma EN antiga de outra intenção.
 *
 * MC_TRANSLATION_PROVIDER=openai usa o modelo rápido (OPENAI_FAST_TEXT_MODEL,
 * default gpt-6-luna); qualquer outro valor = fallback pt.
 */
@Injectable()
export class McTranslationService {
  private readonly logger = new Logger(McTranslationService.name);
  /** Cliente do SDK, criado na primeira derivação (a chave é lida na hora, como antes). */
  private openai: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  provider(): string {
    return process.env.MC_TRANSLATION_PROVIDER || 'mock';
  }

  /** Cenas com derivação pendente recebem `derived` novo; as demais ficam intactas. */
  async deriveScript(script: McScript): Promise<{ script: McScript; translated: number }> {
    let translated = 0;
    const scenes: McScriptScene[] = [];
    for (const scene of script.scenes) {
      const hash = sceneSourceHash(scene);
      if (scene.derived && scene.derived.sourceHash === hash) {
        scenes.push(scene);
        continue;
      }
      scenes.push({ ...scene, derived: await this.derive(scene, hash) });
      translated += 1;
    }
    return { script: { ...script, scenes }, translated };
  }

  private async derive(scene: McScriptScene, sourceHash: string): Promise<McSceneDerived> {
    const at = new Date().toISOString();
    // Cena sem ação (talk_tile sem gesto, D6): nada a traduzir — derivação pt
    // vazia explícita, sem gastar chamada.
    if (!scene.actionPrompt?.trim() && !scene.initialFrame?.trim()) {
      return {
        sourceHash,
        initialFrameEn: null,
        actionPromptEn: null,
        lang: 'pt',
        provider: 'none',
        at,
      };
    }
    if (this.provider() !== 'openai') {
      return {
        sourceHash,
        initialFrameEn: null,
        actionPromptEn: null,
        lang: 'pt',
        provider: this.provider(),
        at,
      };
    }
    try {
      const out = await this.translateOpenAi(scene);
      return {
        sourceHash,
        initialFrameEn: out.initialFrameEn,
        actionPromptEn: out.actionPromptEn,
        lang: 'en',
        provider: `openai:${out.model}`,
        at,
      };
    } catch (err) {
      this.logger.warn(
        `Tradução da cena ${scene.sceneId ?? scene.idx} falhou (${(err as Error).message}) — fallback pt explícito.`,
      );
      return {
        sourceHash,
        initialFrameEn: null,
        actionPromptEn: null,
        lang: 'pt',
        provider: 'openai:fallback_pt',
        at,
      };
    }
  }

  private async translateOpenAi(
    scene: McScriptScene,
  ): Promise<{ initialFrameEn: string | null; actionPromptEn: string; model: string }> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY ausente');
    const model = getOpenAiModelConfig(this.config).fastTextModel;
    const openai = (this.openai ??= new OpenAI({ apiKey }));
    // 429 de taxa e 5xx repetem; prazo estourado não (a cena cai no fallback pt, como numa falha de hoje).
    const response = await withOpenAiRetry(
      () =>
        callProductChat({
          openai,
          logger: this.logger,
          feature: SCENE_DERIVATION_FEATURE,
          spec: { model, ...SCENE_DERIVATION_CALL },
          responseFormat: SCENE_TRANSLATION_FORMAT,
          messages: [
            {
              role: 'system',
              content: SCENE_TRANSLATION_SYSTEM_PROMPT,
            },
            {
              role: 'user',
              content: JSON.stringify({
                initialFrame: scene.initialFrame ?? '',
                actionPrompt: scene.actionPrompt,
              }),
            },
          ],
        }),
      { retryConnectionErrors: false },
    );
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('resposta sem conteúdo');
    const parsed = JSON.parse(content) as {
      initialFrameEn?: string | null;
      actionPromptEn?: string;
    };
    const actionPromptEn = parsed.actionPromptEn?.trim();
    if (!actionPromptEn) throw new Error('tradução vazia');
    return {
      initialFrameEn: parsed.initialFrameEn?.trim() || null,
      actionPromptEn,
      model,
    };
  }
}
