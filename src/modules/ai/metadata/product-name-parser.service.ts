import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { getOpenAiModelConfig, OpenAiModelConfig } from '../config/openai-models.config';
import { withAiLogging } from '../utils/ai-telemetry.util';
import { parseMetadataLenient, ProductMetadata } from './product-metadata.schema';
import { TaxonomyService } from './taxonomy/taxonomy.service';

const MODEL_VERSION = 'name-parse-v1-2026-06';
const CACHE_MAX_ENTRIES = 2000;
// Cada produto produz ~250-400 tokens de saída (schema completo + few-shots
// ricos). Com BATCH_SIZE=8 e max_tokens=8000, mantemos margem confortável
// (~3000 tokens) sem truncar o JSON no meio.
const BATCH_SIZE = 8;
const MAX_OUTPUT_TOKENS = 8000;

interface ParseInput {
  name: string;
  categoryHint?: string | null;
}

// Heuristics to reject a `categoryHint` that's actually a polluted product name
// (a real symptom of the client's spreadsheets — see feature10 doc).
const UNIT_TOKENS = /\b(kg|g|ml|l|m|un|und|cada|pct|fd|caixa|cx)\b/i;
const NUMERIC = /\d/;

@Injectable()
export class ProductNameParserService {
  private readonly logger = new Logger(ProductNameParserService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;
  private readonly enabled: boolean;
  private readonly cache = new Map<string, ProductMetadata>();

  constructor(
    private readonly configService: ConfigService,
    private readonly taxonomy: TaxonomyService,
  ) {
    this.models = getOpenAiModelConfig(configService);
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.enabled = configService.get<string>('AI_NAME_PARSER_ENABLED', 'true') !== 'false';
  }

  isEnabled(): boolean {
    return this.enabled && this.openai !== null;
  }

  modelVersion(): string {
    return MODEL_VERSION;
  }

  async parseNames(inputs: ParseInput[]): Promise<(ProductMetadata | null)[]> {
    if (!this.isEnabled() || inputs.length === 0) {
      return inputs.map(() => null);
    }

    const normalized = inputs.map((input) => this.normalizeInput(input));
    const results: (ProductMetadata | null)[] = new Array(inputs.length).fill(null);
    const toFetch: { index: number; key: string; payload: ParseInput }[] = [];

    for (let i = 0; i < normalized.length; i++) {
      const { key, payload } = normalized[i];
      const cached = this.cache.get(key);
      if (cached) {
        results[i] = cached;
      } else {
        toFetch.push({ index: i, key, payload });
      }
    }

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const slice = toFetch.slice(i, i + BATCH_SIZE);
      let parsedBatch = await this.callLlm(slice.map((s) => s.payload));

      // Fallback: if every item in the batch came back null (almost always
      // means the JSON was truncated or invalid), retry item-by-item. Costs a
      // bit more but guarantees we don't lose a whole 8-item batch.
      const everyNull = parsedBatch.every((p) => p === null);
      if (everyNull && slice.length > 1) {
        this.logger.warn(`Batch de ${slice.length} retornou tudo null; tentando item a item.`);
        parsedBatch = [];
        for (const item of slice) {
          const [single] = await this.callLlm([item.payload]);
          parsedBatch.push(single ?? null);
        }
      }

      for (let j = 0; j < slice.length; j++) {
        const parsed = parsedBatch[j] ?? null;
        results[slice[j].index] = parsed;
        if (parsed) {
          this.rememberInCache(slice[j].key, parsed);
        }
      }
    }

    return results;
  }

  async parseSingle(input: ParseInput): Promise<ProductMetadata | null> {
    const [result] = await this.parseNames([input]);
    return result ?? null;
  }

  private normalizeInput(input: ParseInput): {
    key: string;
    payload: ParseInput;
  } {
    const name = input.name.trim().replace(/\s+/g, ' ');
    const rawHint = (input.categoryHint ?? '').trim();
    const looksPolluted =
      rawHint.length > 0 &&
      (NUMERIC.test(rawHint) || UNIT_TOKENS.test(rawHint) || rawHint.split(' ').length > 4);
    const cleanHint = looksPolluted ? null : rawHint || null;
    const key = `${name.toLowerCase()}|${(cleanHint ?? '').toLowerCase()}`;
    return {
      key,
      payload: { name, categoryHint: cleanHint },
    };
  }

  private rememberInCache(key: string, metadata: ProductMetadata): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, metadata);
  }

  private async callLlm(inputs: ParseInput[]): Promise<(ProductMetadata | null)[]> {
    if (!this.openai) return inputs.map(() => null);

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(inputs);

    try {
      const response = (await withAiLogging(
        this.logger,
        {
          feature: 'product-name-parser.batch',
          endpoint: 'chat.completions',
          model: this.models.fastTextModel,
        },
        () =>
          this.openai!.chat.completions.create({
            model: this.models.fastTextModel,
            temperature: 0.1,
            max_tokens: MAX_OUTPUT_TOKENS,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
      )) as OpenAI.Chat.ChatCompletion;

      const raw = response.choices[0]?.message?.content ?? '';
      if (!raw.trim()) return inputs.map(() => null);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.warn(`Parser de nome devolveu JSON inválido: ${raw.slice(0, 200)}`);
        return inputs.map(() => null);
      }

      const items =
        (parsed as { results?: unknown[] })?.results &&
        Array.isArray((parsed as { results: unknown[] }).results)
          ? (parsed as { results: unknown[] }).results
          : [];

      const out: (ProductMetadata | null)[] = new Array(inputs.length).fill(null);
      for (let i = 0; i < Math.min(items.length, inputs.length); i++) {
        out[i] = parseMetadataLenient(items[i], {
          source: 'name-parse',
          modelVersion: MODEL_VERSION,
        });
      }
      return out;
    } catch (error) {
      this.logger.warn(`Falha ao chamar parser de nomes: ${(error as Error).message}`);
      return inputs.map(() => null);
    }
  }

  private buildSystemPrompt(): string {
    return [
      'Você é um normalizador de catálogo de supermercado brasileiro. Recebe nomes',
      'crus de produtos (do jeito que o dono da loja digita na planilha) e devolve',
      'metadados estruturados em JSON. Os nomes têm abreviações, promoções embutidas',
      'e às vezes listam alternativas com "OU".',
      '',
      'Regras inegociáveis:',
      '- Retorne JSON estrito com {"results": [...]} na MESMA ordem dos inputs.',
      '- NÃO invente EAN/SKU. Deixe null sempre — eles não aparecem em nome de planilha.',
      '- Categoria: escolha um id da lista abaixo. Se nada encaixar, use 999.',
      '- Quando o nome traz "X OU Y" (ex.: "PERDIGÃO OU SADIA", "TRAD OU DEF"),',
      '  produza UMA entrada em alternatives[] para cada opção (mesma posição = mesmo',
      '  produto físico; alternatives diferentes = marcas/variantes intercambiáveis).',
      '- Promo embutida ("LEVE 12 PAGUE 11"): vai para claims[] como "leve N pague M"',
      '  e em pack.promoCount = N. NÃO confunda com quantity — "leve 12" é contagem',
      '  promocional, não métrica do produto. Se nada indica a quantidade real do pack,',
      '  deixe pack.count = 1.',
      '- Preço entre parênteses ("( CLIENTE S) 8,99") deve sair do title e ser descartado.',
      '- Métrica composta: "TP 1 5KG" significa "tipo 1, 5kg" → quantity 5kg.',
      '- Sem marca visível ("BANANA NANICA KG", "PÃO FRANCÊS KG"): alternatives com',
      '  brand=null e categoria forte.',
      '- title: nome canônico em maiúsculas, sem promo, sem preço-cliente, sem alternativas.',
      '- fieldConfidence: 0..1 por campo. Campos null devem ter confiança 0.',
      '',
      'Abreviações comuns que você DEVE expandir mentalmente:',
      '  BISC=biscoito, LING=linguiça, MAC INST=macarrão instantâneo, HAMB=hambúrguer,',
      '  SAB/SABO=sabonete, LIMP=limpador, CONG=congelado, DEF=defumado, TEMP=temperado,',
      '  TRAD=tradicional, REF=refinado, TP=tipo, HIG=higiênico, AMAC=amaciante,',
      '  PCT=pacote, FD=fardo, IQF=congelamento rápido, C/100UNI=com 100 unidades, PTC=pacote,',
      '  COND=condensado, INT/INTEG=integral, ALV=alvejante, ABS/ABSORV=absorvente,',
      '  DESINF=desinfetante, DESOD=desodorante, CREM DENT=creme dental, PAP HIG=papel higiênico.',
      '',
      'Pistas fortes de categoria (use estas marcas para inferir a categoria correta',
      'mesmo quando a abreviação seria ambígua):',
      '  ABSORVENTES (Perfumaria > Absorventes): Always, Intimus, Sempre Livre, Carefree,',
      '    Mili, Modess, Cottonbaby, Sym, Definity, Ladysoft, Naturalmente, Poise, ISACARE.',
      '    "tripla proteção", "noturno", "com abas", "sem abas", "interno", "extra suave",',
      '    "adapt", "proteção total" — TUDO isso são variantes de ABSORVENTE FEMININO,',
      '    NUNCA produto infantil/papinha. id=308.',
      '  ALVEJANTES (Limpeza > Alvejantes e tira-manchas): Vanish, Cândida (alvejante),',
      '    Brilhante, Plush Oxy, Ypê Tixan. "oxi action", "tira-manchas", "branqueador" → id=290.',
      '    Água sanitária pura (Qboa, Cândida normal) vai para id=283.',
      '  ARROZ (Mercearia > Arroz id=101): Camil, Granado, Bonachão, Dona Mili, Bom de Gosto,',
      '    Guacira, Tio João, Prato Fino, Solito, Kicaldo.',
      '  CHOCOLATES (Biscoitos e snacks > Chocolates e barras id=148): Lacta, Nestlé,',
      '    Garoto, Hershey’s, Trento, Bis, Talento.',
      '  CERVEJAS (Bebidas > Cervejas id=166): Skol, Brahma, Heineken, Antarctica, Itaipava,',
      '    Original, Stella, Corona.',
      '',
      'Exemplos few-shot:',
      '',
      'Input: "STEAK DE FRANGO 100G PERDIGÃO OU SADIA" (categoryHint: "REFRIGERADOS")',
      'Output: {',
      '  "title": "STEAK DE FRANGO 100G",',
      '  "category": {"id":222,"path":["Açougue","Frango"]},',
      '  "quantity": {"value":100,"unit":"g"},',
      '  "packageType": "pacote",',
      '  "pack": {"count":1},',
      '  "alternatives": [',
      '    {"brand":"Perdigão","subBrand":null,"variant":null},',
      '    {"brand":"Sadia","subBrand":null,"variant":null}',
      '  ],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.95,"quantity":0.9,"category":0.85,"alternatives":0.9},',
      '  "warnings": []',
      '}',
      '',
      'Input: "PAPEL HIG STYLUS LEVE 12 PAGUE 11 20M FD"',
      'Output: {',
      '  "title": "PAPEL HIGIÊNICO STYLUS 20M",',
      '  "category": {"id":306,"path":["Perfumaria e higiene","Papel higiênico"]},',
      '  "quantity": {"value":20,"unit":"m"},',
      '  "packageType": "fardo",',
      '  "pack": {"count":12,"promoCount":12},',
      '  "alternatives": [{"brand":"Stylus","subBrand":null,"variant":null}],',
      '  "ean": null, "sku": null,',
      '  "claims": ["leve 12 pague 11"], "promo": "leve 12 pague 11", "dominantColors": [],',
      '  "fieldConfidence": {"title":0.9,"category":0.95,"quantity":0.9,"pack":0.9,"alternatives":0.9},',
      '  "warnings": []',
      '}',
      '',
      'Input: "HAMB MISTO PERDIGÃO 672G TRAD OU DEF"',
      'Output: {',
      '  "title": "HAMBÚRGUER MISTO PERDIGÃO 672G",',
      '  "category": {"id":200,"path":["Congelados","Hambúrguer congelado"]},',
      '  "quantity": {"value":672,"unit":"g"},',
      '  "packageType": "pacote",',
      '  "pack": {"count":1},',
      '  "alternatives": [',
      '    {"brand":"Perdigão","subBrand":null,"variant":"Tradicional"},',
      '    {"brand":"Perdigão","subBrand":null,"variant":"Defumado"}',
      '  ],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.9,"category":0.85,"quantity":0.95,"alternatives":0.9},',
      '  "warnings": []',
      '}',
      '',
      'Input: "AMACIANTE YPE ACONCHEGO 2L ( CLIENTE S) 8,99"',
      'Output: {',
      '  "title": "AMACIANTE YPÊ ACONCHEGO 2L",',
      '  "category": {"id":282,"path":["Limpeza","Amaciante de roupas"]},',
      '  "quantity": {"value":2,"unit":"l"},',
      '  "packageType": "garrafa",',
      '  "pack": {"count":1},',
      '  "alternatives": [{"brand":"Ypê","subBrand":"Aconchego","variant":null}],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.95,"category":0.95,"quantity":0.95,"alternatives":0.9},',
      '  "warnings": ["preço-cliente embutido removido do título"]',
      '}',
      '',
      'Input: "INTIMUS TRIPLA PROTECAO 32UN (PRECO PROMO) 13,99"',
      'Output: {',
      '  "title": "ABSORVENTE INTIMUS TRIPLA PROTEÇÃO 32UN",',
      '  "category": {"id":308,"path":["Perfumaria e higiene","Absorventes e protetores"]},',
      '  "quantity": {"value":32,"unit":"un"},',
      '  "packageType": "pacote",',
      '  "pack": {"count":32},',
      '  "alternatives": [{"brand":"Intimus","subBrand":null,"variant":"Tripla Proteção"}],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.95,"category":0.98,"quantity":0.95,"alternatives":0.95},',
      '  "warnings": ["preço-cliente embutido removido do título"]',
      '}',
      '',
      'Input: "ALV VANISH OXI ACTION 500G"',
      'Output: {',
      '  "title": "ALVEJANTE VANISH OXI ACTION 500G",',
      '  "category": {"id":290,"path":["Limpeza","Alvejantes e tira-manchas"]},',
      '  "quantity": {"value":500,"unit":"g"},',
      '  "packageType": "pacote",',
      '  "pack": {"count":1},',
      '  "alternatives": [{"brand":"Vanish","subBrand":"Oxi Action","variant":null}],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.95,"category":0.95,"quantity":0.95,"alternatives":0.95},',
      '  "warnings": []',
      '}',
      '',
      'Input: "ARROZ CAMIL TP 1 5KG"',
      'Output: {',
      '  "title": "ARROZ CAMIL TIPO 1 5KG",',
      '  "category": {"id":101,"path":["Mercearia","Arroz"]},',
      '  "quantity": {"value":5,"unit":"kg"},',
      '  "packageType": "pacote",',
      '  "pack": {"count":1},',
      '  "alternatives": [{"brand":"Camil","subBrand":null,"variant":"Tipo 1"}],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.95,"category":0.98,"quantity":0.95,"alternatives":0.95},',
      '  "warnings": []',
      '}',
      '',
      'Input: "PÃO FRANCÊS KG" (categoryHint: "PADARIA")',
      'Output: {',
      '  "title": "PÃO FRANCÊS",',
      '  "category": {"id":260,"path":["Padaria","Pão francês e similares"]},',
      '  "quantity": {"value":1,"unit":"kg"},',
      '  "packageType": "unidade",',
      '  "pack": null,',
      '  "alternatives": [{"brand":null,"subBrand":null,"variant":null}],',
      '  "ean": null, "sku": null,',
      '  "claims": [], "promo": null, "dominantColors": [],',
      '  "fieldConfidence": {"title":0.95,"category":0.95,"quantity":0.7},',
      '  "warnings": []',
      '}',
      '',
      'Categorias disponíveis (id|caminho):',
      this.taxonomy.promptList(),
    ].join('\n');
  }

  private buildUserPrompt(inputs: ParseInput[]): string {
    const lines = inputs.map((input, i) => {
      const hint = input.categoryHint ? ` (categoryHint: "${input.categoryHint}")` : '';
      return `${i + 1}. "${input.name}"${hint}`;
    });
    return [
      'Parseie cada nome abaixo. Devolva JSON: {"results": [<obj na ordem dos itens>]}.',
      'Cada objeto deve seguir o schema dos exemplos.',
      '',
      ...lines,
    ].join('\n');
  }
}
