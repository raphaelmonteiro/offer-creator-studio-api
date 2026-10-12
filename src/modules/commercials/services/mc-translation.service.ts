import { Injectable, Logger } from '@nestjs/common';
import { sceneSourceHash } from '../domain/mc-script-v2';
import { McSceneDerived, McScript, McScriptScene } from '../domain/mc-types';

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
 * default gpt-4o-mini); qualquer outro valor = fallback pt.
 */
@Injectable()
export class McTranslationService {
  private readonly logger = new Logger(McTranslationService.name);

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
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY ausente');
    const model = process.env.OPENAI_FAST_TEXT_MODEL || 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: {
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
        },
        messages: [
          {
            role: 'system',
            content:
              'Translate Brazilian Portuguese scene directions into concise English prompts for ' +
              'image and video generation engines. Keep the meaning EXACTLY; do not add actions, ' +
              'objects, text or brands. "initialFrameEn" describes the static starting image; ' +
              '"actionPromptEn" describes ONE continuous physical motion in descriptive imperative. ' +
              'If initialFrame is empty, return null for initialFrameEn.',
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
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${body?.error?.message ?? ''}`);
    const content = body.choices?.[0]?.message?.content;
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
