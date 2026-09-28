import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import OpenAI from 'openai';
import * as path from 'path';
import * as sharp from 'sharp';
import { getOpenAiModelConfig } from '../config/openai-models.config';
import {
  buildEanJudgeSystemPrompt,
  buildEanJudgeUserText,
  EAN_JUDGE_PROMPT_VERSION,
  JudgeOutputSchema,
  JudgeVariant,
} from '../prompts/ean-judge.prompts';
import { withAiLogging } from '../utils/ai-telemetry.util';
import type { EanCandidateRecord, EanReferenceRecord, JudgmentRecord } from './ean-match.types';

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FETCH_TIMEOUT_MS = 10_000;
/** Lado maior da miniatura enviada: `low` custa 85 tokens fixos; `high` escala com o tamanho. */
const SIZE_LOW = 512;
const SIZE_HIGH = 1024;

/** Preço por 1M tokens (entrada, saída). Modelo desconhecido cai no do gpt-4o. */
const PRICES: Record<string, [number, number]> = {
  'gpt-4o': [2.5, 10],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1': [2, 8],
  'gpt-4.1-mini': [0.4, 1.6],
};

export interface JudgeInput {
  itemId: string;
  ean: string;
  descricao: string;
  reference: EanReferenceRecord | null;
  candidatas: EanCandidateRecord[];
}

/** Imagem já carregada, reaproveitada pelos dois juízes do mesmo item. */
interface ImagemPronta {
  imageId: string | null;
  dataUrl: string;
}

/**
 * Juiz multimodal (design §6). Cada chamada de `julgar` faz UM julgamento;
 * o pipeline chama A e B e compara.
 */
@Injectable()
export class EanJudgeService {
  private readonly logger = new Logger(EanJudgeService.name);
  private readonly openai: OpenAI | null;
  private readonly modelA: string;
  private readonly modelB: string;
  private readonly maxRetries: number;
  private readonly uploadDest: string;

  constructor(configService: ConfigService) {
    const models = getOpenAiModelConfig(configService);
    this.modelA = configService.get<string>('EAN_JUDGE_MODEL_A') || models.textModel;
    this.modelB = configService.get<string>('EAN_JUDGE_MODEL_B') || this.modelA;
    const r = Number.parseInt(configService.get<string>('EAN_JUDGE_MAX_RETRIES', '1'), 10);
    this.maxRetries = Number.isFinite(r) && r >= 0 ? Math.min(r, 3) : 1;
    this.uploadDest = path.resolve(configService.get<string>('UPLOAD_DEST', './uploads'));
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  isEnabled(): boolean {
    return this.openai !== null;
  }

  /**
   * Identidade do juiz: modelos + versão do prompt. A calibração vale só
   * para esta identidade — trocar qualquer parte desliga o auto-aceite.
   */
  version(): string {
    const base = `${EAN_JUDGE_PROMPT_VERSION}|A=${this.modelA}|B=${this.modelB}`;
    return `${EAN_JUDGE_PROMPT_VERSION}:${createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
  }

  /** Carrega referência + candidatas uma vez; os dois juízes reusam. */
  async prepararImagens(input: JudgeInput): Promise<{
    referencia: ImagemPronta | null;
    candidatas: ImagemPronta[];
    detail: 'low' | 'high';
  }> {
    const detail = precisaAltaResolucao(input.candidatas) ? 'high' : 'low';
    const lado = detail === 'high' ? SIZE_HIGH : SIZE_LOW;
    const [referencia, ...candidatas] = await Promise.all([
      input.reference?.imageUrl
        ? this.carregar(input.reference.imageUrl, lado)
        : Promise.resolve(null),
      ...input.candidatas.map((c) => this.carregar(c.url, lado)),
    ]);
    const prontas: ImagemPronta[] = [];
    input.candidatas.forEach((c, i) => {
      const dataUrl = candidatas[i];
      if (dataUrl) prontas.push({ imageId: c.imageId, dataUrl });
      else this.logger.warn(`Candidata ${c.imageId} sem imagem legível; fica fora do julgamento`);
    });
    return {
      referencia: referencia ? { imageId: null, dataUrl: referencia } : null,
      candidatas: prontas,
      detail,
    };
  }

  /**
   * Um julgamento. A ordem das candidatas é embaralhada de forma
   * determinística por (item, juiz): A e B nunca veem a mesma ordem, e o
   * resultado é reprodutível. A resposta é traduzida de letra para id.
   */
  async julgar(
    variant: JudgeVariant,
    input: JudgeInput,
    imagens: Awaited<ReturnType<EanJudgeService['prepararImagens']>>,
  ): Promise<JudgmentRecord> {
    const model = variant === 'A' ? this.modelA : this.modelB;
    const base: Omit<JudgmentRecord, 'decision' | 'imageIds' | 'labelReadout' | 'reason'> = {
      judge: variant,
      model,
      costUsd: 0,
    };
    if (!this.openai) {
      return {
        ...base,
        decision: 'none',
        imageIds: [],
        labelReadout: [],
        reason: '',
        error: 'OpenAI não configurada',
      };
    }

    const ordem = embaralhar(imagens.candidatas, `${input.itemId}:${variant}`);
    const letraParaId = new Map(ordem.map((img, i) => [LETRAS[i], img.imageId as string]));
    const texto = buildEanJudgeUserText({
      ean: input.ean,
      descricaoErp: input.descricao,
      referencia: input.reference,
      temFotoReferencia: Boolean(imagens.referencia),
      letras: [...letraParaId.keys()],
    });

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: texto }];
    if (imagens.referencia) {
      content.push({
        type: 'image_url',
        image_url: { url: imagens.referencia.dataUrl, detail: imagens.detail },
      });
    }
    ordem.forEach((img, i) => {
      content.push({ type: 'text', text: `Candidata ${LETRAS[i]}:` });
      content.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: imagens.detail } });
    });

    let custo = 0;
    let ultimoErro = '';
    for (let tentativa = 0; tentativa <= this.maxRetries; tentativa++) {
      const resp = (await withAiLogging(
        this.logger,
        {
          feature: 'ean-judge',
          endpoint: 'chat.completions',
          model,
          mode: `${variant}/${imagens.detail}`,
        },
        () =>
          this.openai!.chat.completions.create({
            model,
            temperature: 0,
            max_tokens: 700,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: buildEanJudgeSystemPrompt(variant) },
              { role: 'user', content },
            ],
          }),
      )) as OpenAI.Chat.ChatCompletion;
      custo += custoDe(model, resp.usage);

      const parsed = interpretar(resp.choices[0]?.message?.content ?? '', letraParaId);
      if ('erro' in parsed) {
        ultimoErro = parsed.erro;
        this.logger.warn(`Juiz ${variant} (${input.ean}) saída inválida: ${parsed.erro}`);
        continue;
      }
      return { ...base, ...parsed, costUsd: custo };
    }

    return {
      ...base,
      decision: 'none',
      imageIds: [],
      labelReadout: [],
      reason: '',
      costUsd: custo,
      error: ultimoErro || 'saída inválida',
    };
  }

  /**
   * Lê de UPLOAD_DEST quando a URL aponta para /uploads/ (prod é HTTP puro e
   * a URL gravada usa o IP público); senão baixa. Reduz para `lado` px.
   */
  private async carregar(url: string, lado: number): Promise<string | null> {
    try {
      let bytes: Buffer | null = null;
      const pathname = safePathname(url);
      if (pathname?.startsWith('/uploads/')) {
        const arquivo = path.join(this.uploadDest, pathname.replace(/^\/uploads\//, ''));
        if (arquivo.startsWith(this.uploadDest)) {
          bytes = await fs.readFile(arquivo).catch(() => null);
        }
      }
      if (!bytes) {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return null;
        bytes = Buffer.from(await res.arrayBuffer());
      }
      const jpeg = await sharp(bytes)
        .flatten({ background: '#ffffff' })
        .resize(lado, lado, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch (err) {
      this.logger.warn(`Não carreguei ${url}: ${(err as Error).message}`);
      return null;
    }
  }
}

/**
 * Alta resolução só quando duas candidatas têm o mesmo nome-base (fotos
 * quase iguais, rótulo pequeno decide). Nos outros casos `low` basta e custa
 * uma fração.
 */
export function precisaAltaResolucao(candidatas: EanCandidateRecord[]): boolean {
  const bases = candidatas.map((c) => nomeBase(c.filename));
  return new Set(bases).size < bases.length;
}

export function nomeBase(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/\b(novo|nova|novos|novas|\d{1,3})\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Embaralhamento determinístico (Fisher–Yates com semente do hash). */
export function embaralhar<T>(itens: T[], semente: string): T[] {
  const out = [...itens];
  let h = createHash('sha256').update(semente).digest().readUInt32BE(0);
  const rand = () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function interpretar(
  raw: string,
  letraParaId: Map<string, string>,
): Pick<JudgmentRecord, 'decision' | 'imageIds' | 'labelReadout' | 'reason'> | { erro: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { erro: 'não é JSON' };
  }
  const r = JudgeOutputSchema.safeParse(json);
  if (!r.success) return { erro: r.error.issues.map((i) => i.message).join('; ') };

  const desconhecida = [...r.data.images, ...r.data.labels.map((l) => l.image)].find(
    (l) => !letraParaId.has(l),
  );
  if (desconhecida) return { erro: `letra inexistente: ${desconhecida}` };

  const escolhidas = new Set(r.data.images);
  return {
    decision: r.data.decision,
    imageIds: r.data.images.map((l) => letraParaId.get(l)!),
    labelReadout: r.data.labels
      .filter((l) => escolhidas.has(l.image))
      .map((l) => ({
        imageId: letraParaId.get(l.image)!,
        brand: l.brand,
        variant: l.variant,
        quantity: l.quantity,
      })),
    reason: r.data.reason,
  };
}

export function custoDe(model: string, usage: OpenAI.CompletionUsage | undefined): number {
  if (!usage) return 0;
  const chave = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  const [pin, pout] = PRICES[chave ?? 'gpt-4o'];
  return (usage.prompt_tokens * pin + usage.completion_tokens * pout) / 1_000_000;
}

function safePathname(url: string): string | null {
  try {
    return new URL(url, 'http://local').pathname;
  } catch {
    return null;
  }
}
