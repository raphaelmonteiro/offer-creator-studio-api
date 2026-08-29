import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { TransientProviderError, withRetry } from './provider-errors';

export interface ModerationInput {
  text?: string;
  /** Imagem em base64 (sem prefixo data:) — vira data URI para o omni-moderation. */
  imageBase64?: string;
  /** MIME da imagem (default image/png — nosso formato de recorte). */
  imageMimeType?: string;
}

export interface ModerationResult {
  flagged: boolean;
  /** Categorias sinalizadas (ex.: 'violence', 'sexual/minors'). Vazio quando limpo. */
  categories: string[];
  /** true quando a moderação não rodou (sem OPENAI_API_KEY) — auditável no jsonb. */
  skipped?: boolean;
  /** Resposta crua do provider — persistida nos campos `moderation` jsonb (plano §6.8). */
  raw?: Record<string, unknown>;
}

/**
 * Wrapper do omni-moderation-latest da OpenAI para TEXTO e IMAGEM
 * (plano-comerciais §6.8: moderação ANTES de gastar com providers; resultado
 * auditado em jsonb). Sem OPENAI_API_KEY o resultado é `skipped` (fail-open,
 * só acontece em dev — em produção a key existe); erros 429/5xx são
 * re-tentados e depois PROPAGADOS — quem chama decide se bloqueia o fluxo.
 */
@Injectable()
export class ModerationProvider {
  private readonly logger = new Logger(ModerationProvider.name);
  private readonly openai: OpenAI | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — moderação será pulada (skipped).');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async moderate(input: ModerationInput): Promise<ModerationResult> {
    const parts: OpenAI.Moderations.ModerationMultiModalInput[] = [];
    if (input.text) parts.push({ type: 'text', text: input.text });
    if (input.imageBase64) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${input.imageMimeType ?? 'image/png'};base64,${input.imageBase64}`,
        },
      });
    }
    if (parts.length === 0) return { flagged: false, categories: [] };
    if (!this.openai) return { flagged: false, categories: [], skipped: true };

    const response = await withRetry(async () => {
      try {
        return await this.openai!.moderations.create({
          model: 'omni-moderation-latest',
          input: parts,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 429 || (status != null && status >= 500)) {
          throw new TransientProviderError(`HTTP ${status}`);
        }
        throw err;
      }
    });

    const flagged = response.results.some((r) => r.flagged);
    const categories = [
      ...new Set(
        response.results.flatMap((r) =>
          Object.entries(r.categories ?? {})
            .filter(([, hit]) => hit === true)
            .map(([name]) => name),
        ),
      ),
    ];
    return {
      flagged,
      categories,
      raw: JSON.parse(JSON.stringify(response)) as Record<string, unknown>,
    };
  }
}
