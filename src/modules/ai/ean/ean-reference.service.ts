import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import OpenAI from 'openai';
import { DataSource } from 'typeorm';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { tabelaExiste } from './ean-candidate.service';
import { custoDe } from './ean-judge.service';
import { EanReference } from './entities/ean-reference.entity';
import type { EanReferenceRecord, ReferenceSource } from './ean-match.types';

/** Uma consulta "none" (nada encontrado) só é refeita depois disso. */
const NONE_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const COSMOS_URL = 'https://api.cosmos.bluesoft.com.br/gtins';
const COSMOS_QUOTA_KEY = 'ean_cosmos_quota';
const FETCH_TIMEOUT_MS = 10_000;
/** Custo fixo da ferramenta de busca web por chamada (US$10 / 1k), mais tokens. */
const WEB_SEARCH_CALL_USD = 0.01;

export interface ReferenceResult {
  reference: EanReferenceRecord;
  costUsd: number;
}

interface FonteResultado {
  source: Exclude<ReferenceSource, 'none'>;
  name: string | null;
  brand: string | null;
  quantity: string | null;
  imageUrl: string | null;
  raw: unknown;
}

/**
 * Descrição e foto OFICIAIS de um EAN, em cascata de custo:
 * `off_products` (local, grátis) → Cosmos (se `COSMOS_API_TOKEN`) → busca web
 * via LLM, aceita só se a página citada contiver o GTIN.
 *
 * É a peça que resolve a ambiguidade: a descrição do ERP é abreviada
 * ("CRISTALCUCAR", "SF EDITION MACA"), a oficial não.
 */
@Injectable()
export class EanReferenceService {
  private readonly logger = new Logger(EanReferenceService.name);
  private readonly cosmosToken: string | null;
  private readonly cosmosDailyQuota: number;
  private readonly webEnabled: boolean;
  private readonly webModel: string;
  private readonly openai: OpenAI | null;
  private offDisponivel: boolean | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SystemSettingsService,
    configService: ConfigService,
  ) {
    this.cosmosToken = configService.get<string>('COSMOS_API_TOKEN') || null;
    const quota = Number.parseInt(configService.get<string>('COSMOS_DAILY_QUOTA', '200'), 10);
    this.cosmosDailyQuota = Number.isFinite(quota) && quota >= 0 ? quota : 200;
    this.webEnabled = configService.get<string>('EAN_WEB_REFERENCE_ENABLED', 'true') !== 'false';
    // Modelo rápido por padrão: o texto das páginas encontradas entra como
    // tokens de entrada (medido: ~US$0,075/consulta com gpt-4o), e a precisão
    // não depende do modelo — o GTIN é conferido na página pelo backend.
    this.webModel = configService.get<string>(
      'EAN_WEB_REFERENCE_MODEL',
      configService.get<string>('OPENAI_FAST_TEXT_MODEL', 'gpt-4o-mini'),
    );
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async resolver(ean: string): Promise<ReferenceResult> {
    const cache = await this.dataSource.getRepository(EanReference).findOne({ where: { ean } });
    if (
      cache &&
      (cache.source !== 'none' || Date.now() - cache.fetchedAt.getTime() < NONE_RETRY_MS)
    ) {
      return { reference: paraRegistro(cache), costUsd: 0 };
    }

    let custo = 0;
    const fontes: Array<() => Promise<{ r: FonteResultado | null; costUsd: number }>> = [
      async () => ({ r: await this.daOff(ean), costUsd: 0 }),
      async () => ({ r: await this.doCosmos(ean), costUsd: 0 }),
      () => this.daWeb(ean),
    ];

    for (const fonte of fontes) {
      let achado: FonteResultado | null = null;
      try {
        const { r, costUsd } = await fonte();
        custo += costUsd;
        achado = r;
      } catch (err) {
        this.logger.warn(`Referência de ${ean}: fonte falhou — ${(err as Error).message}`);
      }
      if (achado && achado.name) {
        await this.salvar(ean, achado);
        return { reference: { ean, ...semRaw(achado) }, costUsd: custo };
      }
    }

    await this.salvar(ean, null);
    return {
      reference: { ean, source: 'none', name: null, brand: null, quantity: null, imageUrl: null },
      costUsd: custo,
    };
  }

  /** Dump local da Open Food Facts; o GTIN é o próprio registro. */
  async daOff(ean: string): Promise<FonteResultado | null> {
    if (this.offDisponivel === null)
      this.offDisponivel = await tabelaExiste(this.dataSource, 'off_products');
    if (!this.offDisponivel) return null;
    const variantes = [...new Set([ean, ean.replace(/^0+/, ''), ean.padStart(13, '0')])];
    const rows: Array<{
      gtin: string;
      product_name: string | null;
      brand_raw: string | null;
      quantity_raw: string | null;
      image_url: string | null;
    }> = await this.dataSource.query(
      `SELECT gtin, product_name, brand_raw, quantity_raw, image_url
         FROM off_products WHERE gtin = ANY($1) LIMIT 1`,
      [variantes],
    );
    const r = rows[0];
    if (!r || !r.product_name) return null;
    return {
      source: 'off',
      name: r.product_name,
      brand: r.brand_raw,
      quantity: r.quantity_raw,
      imageUrl: r.image_url,
      raw: r,
    };
  }

  /** Bluesoft Cosmos — só com token configurado e dentro da cota diária. */
  async doCosmos(ean: string): Promise<FonteResultado | null> {
    if (!this.cosmosToken) return null;
    if (!(await this.consumirCotaCosmos())) {
      this.logger.warn('Cota diária do Cosmos esgotada; pulando fonte');
      return null;
    }

    const res = await fetch(`${COSMOS_URL}/${ean.replace(/^0+(?=\d{13})/, '')}.json`, {
      headers: { 'X-Cosmos-Token': this.cosmosToken, 'User-Agent': 'Cosmos-API-Request' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('Cosmos respondeu 429 (limite de requisições)');
    if (!res.ok) throw new Error(`Cosmos respondeu ${res.status}`);

    const body = (await res.json()) as {
      description?: string;
      brand?: { name?: string };
      thumbnail?: string;
      net_weight?: number;
    };
    if (!body.description) return null;
    return {
      source: 'cosmos',
      name: body.description,
      brand: body.brand?.name ?? null,
      quantity: null,
      imageUrl: body.thumbnail ?? null,
      raw: body,
    };
  }

  private async consumirCotaCosmos(): Promise<boolean> {
    const hoje = new Date().toISOString().slice(0, 10);
    const atual = (await this.settings.getFresh<{ date: string; used: number }>(
      COSMOS_QUOTA_KEY,
    )) ?? {
      date: hoje,
      used: 0,
    };
    const usado = atual.date === hoje ? atual.used : 0;
    if (usado >= this.cosmosDailyQuota) return false;
    await this.settings.set(COSMOS_QUOTA_KEY, { date: hoje, used: usado + 1 });
    return true;
  }

  /**
   * Busca web assistida por LLM. O modelo pode confundir produtos parecidos,
   * então o resultado só vale se a página citada contiver o GTIN exato — o
   * backend baixa a página e confere, sem confiar no que o modelo diz.
   */
  async daWeb(ean: string): Promise<{ r: FonteResultado | null; costUsd: number }> {
    if (!this.webEnabled || !this.openai) return { r: null, costUsd: 0 };

    const resp = await this.openai.responses.create({
      model: this.webModel,
      tools: [{ type: 'web_search' }],
      input: promptBuscaWeb(ean),
    });
    const costUsd =
      WEB_SEARCH_CALL_USD +
      custoDe(this.webModel, {
        prompt_tokens: resp.usage?.input_tokens ?? 0,
        completion_tokens: resp.usage?.output_tokens ?? 0,
      } as OpenAI.CompletionUsage);

    const dados = extrairJson(resp.output_text ?? '');
    if (!dados || !dados.found || !dados.name) return { r: null, costUsd };

    // Fontes a conferir: as que o modelo indicou e as que a ferramenta de
    // busca citou de fato. PDF fica de fora (o GTIN vem comprimido e não dá
    // para conferir sem extrator de PDF).
    const fontes = fontesParaConferir(dados, citacoesDe(resp));
    let confirmada: string | null = null;
    for (const url of fontes) {
      if (await paginaContemGtin(url, ean)) {
        confirmada = url;
        break;
      }
    }
    if (!confirmada) {
      this.logger.log(
        `Referência web de ${ean} descartada: GTIN não confirmado em ${fontes.length} fonte(s)`,
      );
      return { r: null, costUsd };
    }
    dados.sourceUrl = confirmada;
    return {
      r: {
        source: 'web',
        name: dados.name,
        brand: dados.brand ?? null,
        quantity: dados.quantity ?? null,
        imageUrl: dados.imageUrl ?? null,
        raw: dados,
      },
      costUsd,
    };
  }

  private async salvar(ean: string, r: FonteResultado | null): Promise<void> {
    await this.dataSource.getRepository(EanReference).save({
      ean,
      source: r?.source ?? 'none',
      name: r?.name ?? null,
      brand: r?.brand ?? null,
      quantity: r?.quantity ?? null,
      imageUrl: r?.imageUrl ?? null,
      raw: r?.raw ?? null,
    });
  }
}

export function promptBuscaWeb(ean: string): string {
  return [
    `Encontre o produto de varejo cujo código de barras GTIN/EAN é exatamente ${ean}.`,
    'Use apenas páginas que mostrem esse código exato (varejistas, fabricantes, bases de GTIN).',
    'Não adivinhe a partir de produtos parecidos. Se não achar o código exato, responda found=false.',
    'Prefira páginas HTML de produto (lojas, supermercados, fabricante) a catálogos em PDF.',
    'Responda SOMENTE com um JSON, sem texto em volta:',
    '{"found": boolean, "name": string|null, "brand": string|null, "quantity": string|null,',
    ' "imageUrl": string|null, "sources": [string]}',
    'name = nome completo com marca, variante/sabor e quantidade.',
    'sources = até 3 URLs completas (https://...) de páginas onde o código aparece escrito.',
  ].join('\n');
}

interface RespostaWeb {
  found?: boolean;
  name?: string | null;
  brand?: string | null;
  quantity?: string | null;
  imageUrl?: string | null;
  sources?: unknown;
  /** Preenchido pelo backend com a fonte que confirmou o GTIN. */
  sourceUrl?: string | null;
}

const MAX_FONTES = 4;

/** URLs citadas pela ferramenta de busca na resposta (anotações `url_citation`). */
export function citacoesDe(resp: unknown): string[] {
  const out: string[] = [];
  const output = (
    resp as {
      output?: Array<{ content?: Array<{ annotations?: Array<{ type?: string; url?: string }> }> }>;
    }
  )?.output;
  for (const item of output ?? []) {
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) {
        if (a.type === 'url_citation' && a.url) out.push(a.url);
      }
    }
  }
  return out;
}

/** Junta as fontes do modelo e as citações, só http(s), sem PDF, sem repetir. */
export function fontesParaConferir(dados: RespostaWeb, citacoes: string[]): string[] {
  const doModelo = Array.isArray(dados.sources) ? dados.sources : [];
  const todas = [...doModelo, ...citacoes, dados.sourceUrl]
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\/\S+$/i.test(u) && !/\.pdf($|[?#])/i.test(u));
  return [...new Set(todas)].slice(0, MAX_FONTES);
}

export function extrairJson(texto: string): RespostaWeb | null {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    return JSON.parse(texto.slice(ini, fim + 1)) as RespostaWeb;
  } catch {
    return null;
  }
}

/** Baixa a página e procura o GTIN (com ou sem zeros à esquerda) no conteúdo. */
export async function paginaContemGtin(url: string, ean: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; chroma-ean-check)' },
    });
    if (!res.ok) return false;
    const html = (await res.text()).replace(/[\s.\-]/g, '');
    const semZeros = ean.replace(/^0+/, '');
    return html.includes(semZeros);
  } catch {
    return false;
  }
}

function paraRegistro(r: EanReference): EanReferenceRecord {
  return {
    ean: r.ean,
    source: r.source,
    name: r.name,
    brand: r.brand,
    quantity: r.quantity,
    imageUrl: r.imageUrl,
  };
}

function semRaw(r: FonteResultado): Omit<EanReferenceRecord, 'ean'> {
  return {
    source: r.source,
    name: r.name,
    brand: r.brand,
    quantity: r.quantity,
    imageUrl: r.imageUrl,
  };
}
