import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SpellCheckProductDto } from './dto/spell-check-request.dto';
import { CorrectionDto, SpellCheckResponseDto } from './dto/spell-check-response.dto';
import { ImageSearchResponseDto, PixabayImageDto } from './dto/image-search-response.dto';
import { UploadsService } from '../uploads/uploads.service';
import { GalleryService } from '../gallery/gallery.service';
import { PixabayCategory } from './dto/image-search-request.dto';
import { FormatDto, ChatMessageDto } from './dto/template-generate-request.dto';
import { TemplateGenerateResponseDto } from './dto/template-generate-response.dto';

const BATCH_SIZE = 10;

const SYSTEM_PROMPT = `Você é um revisor ortográfico especializado em textos de produtos para encartes de supermercado em português brasileiro.

Analise os textos fornecidos e identifique erros ortográficos, gramaticais ou de digitação.

Regras:
- Corrija apenas erros claros de ortografia, acentuação, gramática ou digitação.
- NÃO altere nomes de marcas, nomes próprios ou siglas comerciais.
- NÃO altere valores numéricos, unidades de medida ou códigos.
- NÃO faça sugestões estilísticas — apenas corrija erros objetivos.
- Retorne SOMENTE os campos que possuem erro. Campos corretos devem ser omitidos.
- Responda SEMPRE em JSON com a estrutura exata abaixo, sem texto adicional.

Estrutura esperada:
{
  "corrections": [
    {
      "productId": "<id do produto>",
      "field": "<name | observation | badgeText>",
      "original": "<texto original>",
      "suggestion": "<texto corrigido>"
    }
  ]
}

Se não houver erros em nenhum produto, retorne: { "corrections": [] }`;

const UNITS = [
  'kg',
  'g',
  'mg',
  'ml',
  'lt',
  'un',
  'pct',
  'cx\\.',
  'cx',
  'unid',
  'unidade',
  'pack',
  'fardo',
];
const GENERIC_TERMS = ['tipo\\s+\\d+', 'especial', 'premium', 'tradicional'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

const TEMPLATE_SYSTEM_PROMPT = `Você é um designer especialista em templates para encartes promocionais de supermercado em português brasileiro.
Você entende profundamente como encartes de mercado funcionam visualmente — como os do QRofertas, Aprimora, Bume e similares.

## O QUE É UM TEMPLATE DE ENCARTE

Um template de encarte de supermercado é dividido em 3 partes que formam UM ÚNICO design coeso:

HEADER (topo): Banner principal do encarte. Contém nome da loja, logo, slogan, tema da promoção (ex: "OFERTA DA SEMANA", "PÁSCOA 2025"). É a parte mais visualmente rica — pode ter imagens temáticas, gradientes vibrantes, decorações. Objetivo: impactar e identificar a loja.

BODY (meio): Fundo da área de produtos. Os cards de produto (fotos, preços, nomes) ficam sobre este fundo. Existem dois estilos válidos — o usuario pode pedir um ou o outro:
  ESTILO NEUTRO: cor sólida clara ou gradiente suave (branco, creme, tom pastel). Os cards se destacam com clareza. Bom para templates clean/minimalistas.
  ESTILO IMERSIVO: usa a mesma imagem tematica do header como fundo do body (ex: textura de chocolate, fundo de floresta, textura de madeira). Cria harmonia total pois o encarte inteiro tem a mesma identidade visual. Os cards brancos flutuam sobre o fundo tematico. Este estilo é muito usado em encartes profissionais de supermercado.
  PADRAO: use o estilo imersivo quando o tema for forte (Pascoa, Natal, Black Friday, etc) e o usuario nao especificar. Use neutro quando o usuario pedir "clean", "simples", "minimalista".

FOOTER (rodapé): Fechamento do encarte. Contém informações práticas: endereço da loja, telefone, horário, validade das ofertas, redes sociais. Fundo usa a mesma cor escura dominante do header para fechar o design com harmonia.

## PRINCIPIO DE HARMONIA — MAIS IMPORTANTE

Pense no template como UM UNICO layout antes de decompor em 3 partes:
1. Defina uma PALETA de 2-3 cores principais
2. Defina um TEMA visual e uma imagem central (ex: pascoa de chocolate = tons marrons/dourados + textura de chocolate derretido)
3. Header: maxima expressao do tema, texto impactante
4. Body (estilo imersivo): mesma textura/imagem do header como fundo, com imageOpacity entre 70-90 para os cards nao ficarem pesados demais
5. Footer: cor solida escura da paleta, texto claro com informacoes praticas

Resultado esperado: quem olha o encarte ve UMA identidade visual, nao 3 pecas separadas.

## EXEMPLOS DE HARMONIA CORRETA (estilo imersivo — padrao profissional)

Pascoa de Chocolate:
- Paleta: marrom chocolate (#3B1A08), dourado (#D97706), creme (#FEF3C7)
- Header: imagem de chocolate derretido com texto "PASCOA DE OFERTAS" em letras douradas/3D
- Body: MESMA imagem de fundo de chocolate, imageOpacity: 80
- Footer: marrom muito escuro (#1C0A03), texto creme/dourado

Pascoa colorida:
- Paleta: laranja (#EA580C), lilas (#7C3AED), amarelo (#FEF08A)
- Header: imagem com coelhos, ovos coloridos, fundo laranja, texto "PASCOA" vibrante
- Body: MESMA imagem de fundo com ovos/coelhos, imageOpacity: 75
- Footer: laranja escuro (#9A3412), texto branco

Natal:
- Paleta: vermelho (#991B1B), dourado (#B45309), verde escuro (#14532D)
- Header: imagem de pinheiro nevado com elementos natalinos, texto "NATAL DE OFERTAS" dourado
- Body: MESMA textura natalina como fundo, imageOpacity: 70
- Footer: vermelho escuro (#7F1D1D), texto dourado

Black Friday:
- Paleta: preto (#0F172A), amarelo (#EAB308)
- Header: fundo preto com elementos geometricos, texto "BLACK FRIDAY" amarelo impactante
- Body: fundo preto solido ou imageOpacity: 85 com a mesma textura
- Footer: preto puro, texto amarelo

## FORMATO DO TEMPLATE

O template deve ser retornado SEMPRE em JSON com esta estrutura exata:

{
  "assistantMessage": "<mensagem em português explicando o que foi criado/alterado>",
  "configuration": {
    "header": {
      "id": "header",
      "name": "Header",
      "widthCm": <artWidthCm fornecido>,
      "heightCm": <headerHeightCm fornecido>,
      "background": <CanvasBackground>,
      "elements": [<CanvasElement>]
    },
    "footer": {
      "id": "footer",
      "name": "Footer",
      "widthCm": <artWidthCm fornecido>,
      "heightCm": <footerHeightCm fornecido>,
      "background": <CanvasBackground>,
      "elements": [<CanvasElement>]
    },
    "bodyBackground": <CanvasBackground>
  }
}

## TIPOS DE DADOS

### CanvasBackground
Escolha um dos três tipos:

Solido:   { "type": "solid", "color": "#RRGGBB" }

Gradiente: {
  "type": "gradient",
  "gradientStart": "#RRGGBB",
  "gradientEnd": "#RRGGBB",
  "gradientAngle": 0-360
}

Imagem gerada pela IA: {
  "type": "image",
  "imageUrl": "GENERATE: <prompt em ingles descrevendo a imagem>",
  "imageSize": "cover",
  "imagePosition": "center",
  "imageOpacity": 100
}

### TextElement
{
  "id": "<uuid unico>",
  "type": "text",
  "x": <pixels>,
  "y": <pixels>,
  "width": <pixels>,
  "height": <pixels>,
  "zIndex": <1-10>,
  "content": "<texto>",
  "fontSize": <numero>,
  "fontFamily": "Arial",
  "fontWeight": "normal|bold",
  "fontStyle": "normal|italic",
  "color": "#RRGGBB",
  "textAlign": "left|center|right",
  "lineHeight": 1.2,
  "letterSpacing": 0,
  "textTransform": "none|uppercase|lowercase",
  "backgroundColor": null,
  "padding": null,
  "borderRadius": null
}

### ImageElement
{
  "id": "<uuid unico>",
  "type": "image",
  "x": <pixels>,
  "y": <pixels>,
  "width": <pixels>,
  "height": <pixels>,
  "zIndex": <1-10>,
  "src": "GENERATE: <prompt em ingles>" ou "<URL existente>",
  "opacity": 1,
  "objectFit": "cover|contain",
  "borderRadius": 0
}

## SISTEMA DE COORDENADAS

As coordenadas (x, y, width, height) sao em PIXELS considerando escala de 37.795px por cm (96dpi).

Dimensoes calculadas a partir dos valores de formato fornecidos:
- Largura total do canvas: artWidthCm x 37.795
- Altura do header: headerHeightCm x 37.795
- Altura do footer: footerHeightCm x 37.795

Posicione todos os elementos dentro dos limites de sua secao.

## REGRAS DE GERACAO DE IMAGENS

Use GENERATE no header (background tematico principal) e, no estilo imersivo, use o MESMO prompt no bodyBackground para criar continuidade visual.
Nao use GENERATE no footer — o footer usa cor solida escura.

Prompts para GENERATE devem ser em INGLES, com estilo adequado para encarte de supermercado:
- Inclua "supermarket flyer", "promotional banner", "marketing material" no prompt para contextualizar
- Especifique o estilo: "flat design", "watercolor", "illustrated", "photorealistic"
- Especifique que deve ser adequado como fundo: "banner background", "seamless pattern", "decorative background"
- Exemplos:
  - "GENERATE: Easter supermarket flyer banner background, colorful Easter eggs and chocolate bunnies, pastel colors pink purple yellow, flat design illustration, promotional material"
  - "GENERATE: Christmas supermarket promotional banner background, pine branches snowflakes red and gold, festive pattern, flat design"
  - "GENERATE: Black Friday supermarket banner background, geometric shapes yellow and black, modern bold design, promotional material"

## REGRAS DE REFINAMENTO — CRITICO

Quando houver um [CONTEXTO DO TEMPLATE ATUAL] na conversa, ele representa o estado exato do template em edição.

REGRA ABSOLUTA: Quando o usuario pedir alteracoes em partes especificas, copie o JSON das partes NAO mencionadas EXATAMENTE como estao no contexto, sem nenhuma modificacao.

Exemplos:
- Usuario pede "ajuste o body e o footer" -> copie o header inteiro do contexto sem alterar nada, modifique apenas footer e bodyBackground
- Usuario pede "mude apenas o header" -> copie footer e bodyBackground do contexto sem tocar, modifique apenas header
- Usuario pede "altere a cor do texto do footer" -> copie header e bodyBackground inteiros do contexto, modifique somente o elemento de texto no footer

Outras regras:
- Nunca reinvente secoes que nao foram pedidas — copie do contexto literalmente
- Por padrao, preserve URLs CDN existentes (http/https) — nao use GENERATE para imagens que ja foram geradas
- EXCECAO: se o usuario pedir explicitamente para alterar ou substituir uma imagem especifica (ex: "mude o coelho para um coelho de chocolate", "troque a imagem do header", "regenere o fundo"), use GENERATE com o novo prompt descrevendo a imagem desejada. Neste caso substitua apenas aquela src/imageUrl especifica, mantendo todos os outros campos do elemento iguais (posicao, tamanho, opacidade, etc.)
- Se o usuario pedir nova imagem em um local novo, use o placeholder GENERATE normalmente
- Se nao houver contexto anterior (primeira mensagem), crie tudo do zero

## REGRAS GERAIS

- Use cores vibrantes e adequadas para material promocional de supermercado
- Textos devem ser legíveis — bom contraste com o fundo
- O body (bodyBackground) é o fundo das áreas de produtos — use cores neutras ou suaves
- Responda sempre em português no assistantMessage
- NUNCA inclua campos extras fora do schema definido
- IDs dos elementos devem ser únicos (use formato "el-<número>")`;

const GENERATE_PREFIX = 'GENERATE:';

interface PixabayHit {
  id: number;
  previewURL: string;
  webformatURL: string;
  largeImageURL: string;
  webformatWidth: number;
  webformatHeight: number;
}

interface PixabayResponse {
  hits: PixabayHit[];
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly openai: OpenAI | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
    private readonly galleryService: GalleryService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY não configurada — chamadas à IA irão falhar');
      this.openai = null;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async spellCheck(products: SpellCheckProductDto[]): Promise<SpellCheckResponseDto> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    const allItems: Array<{ productId: string; field: string; text: string }> = [];

    for (const product of products) {
      if (product.name?.trim()) {
        allItems.push({ productId: product.id, field: 'name', text: product.name });
      }
      if (product.observation?.trim()) {
        allItems.push({ productId: product.id, field: 'observation', text: product.observation });
      }
      if (product.badgeText?.trim()) {
        allItems.push({ productId: product.id, field: 'badgeText', text: product.badgeText });
      }
    }

    const batches: Array<typeof allItems> = [];
    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
      batches.push(allItems.slice(i, i + BATCH_SIZE));
    }

    const batchResults = await Promise.all(batches.map((batch) => this.checkBatch(batch)));

    const corrections = batchResults.flat();
    return { corrections };
  }

  async searchImages(rawName: string, category?: PixabayCategory): Promise<ImageSearchResponseDto> {
    const apiKey = this.configService.get<string>('PIXABAY_API_KEY');
    if (!apiKey) {
      this.logger.error('PIXABAY_API_KEY não configurada');
      throw new Error('PIXABAY_API_KEY não configurada');
    }

    const normalizedTerm = this.normalizeProductName(rawName);
    const searchTerm = await this.translateToEnglish(normalizedTerm);

    const selectedCategory = category ?? 'food';

    const params = new URLSearchParams({
      key: apiKey,
      q: searchTerm,
      image_type: 'photo',
      category: selectedCategory,
      per_page: '10',
      order: 'popular',
      safesearch: 'true',
    });

    const response = await fetch(`https://pixabay.com/api/?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Pixabay retornou status ${response.status}`);
    }

    const data = (await response.json()) as PixabayResponse;

    // If selected category returned nothing, retry without category constraint
    let hits = data.hits ?? [];
    if (hits.length === 0) {
      const fallbackParams = new URLSearchParams({
        key: apiKey,
        q: searchTerm,
        image_type: 'photo',
        per_page: '5',
        order: 'popular',
        safesearch: 'true',
      });
      const fallbackResponse = await fetch(`https://pixabay.com/api/?${fallbackParams.toString()}`);
      if (fallbackResponse.ok) {
        const fallbackData = (await fallbackResponse.json()) as PixabayResponse;
        hits = fallbackData.hits ?? [];
      }
    }

    const images: PixabayImageDto[] = hits.slice(0, 3).map((hit) => ({
      pixabayId: hit.id,
      thumbnailUrl: hit.previewURL,
      previewUrl: hit.webformatURL,
      fullUrl: hit.largeImageURL,
      width: hit.webformatWidth,
      height: hit.webformatHeight,
    }));

    return { searchTerm: normalizedTerm, images };
  }

  async downloadAndSaveImage(imageUrl: string, productName: string): Promise<string> {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Falha ao baixar imagem: status ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
      throw new Error('Imagem excede o limite de 10MB');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error('Imagem excede o limite de 10MB');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const ext =
      this.extensionFromMimeType(contentType) || this.extensionFromUrl(imageUrl) || '.jpg';
    const slug = this.slugify(productName);
    const filename = `${slug}-${Date.now()}${ext}`;

    const fakeFile = {
      buffer,
      originalname: filename,
      size: buffer.length,
      mimetype: contentType,
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const result = await this.uploadsService.uploadFile(fakeFile, 'products');

    // Register in gallery so it appears in the image library
    await this.galleryService.registerImage({
      filename: filename,
      url: result.url,
      mimeType: contentType.split(';')[0].trim(),
      size: buffer.length,
    });

    return result.url;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async translateToEnglish(term: string): Promise<string> {
    if (!this.openai) {
      return term; // fallback: search as-is
    }
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 32,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `You are a supermarket stock photo search assistant. Your job is to convert Brazilian Portuguese product names into the best English search query to find a clear product photo on Pixabay.

Rules:
- Translate to the internationally recognized English name, NOT a transliteration. Example: "picanha" → "beef rump cap", "frango" → "chicken", "feijão" → "black beans".
- Use 2-4 words maximum.
- Add a useful visual descriptor when it helps (raw, fresh, sliced, whole, grilled, packaged).
- Prefer generic ingredient names that stock photo sites index well.
- Return ONLY the search query. No punctuation, no explanation.

Examples:
picanha → raw beef rump cap
frango inteiro → whole raw chicken
leite integral → whole milk bottle
arroz branco → white rice bowl
queijo mussarela → mozzarella cheese
refrigerante cola → cola soda can
óleo de soja → soybean oil bottle
feijão preto → black beans`,
          },
          { role: 'user', content: term },
        ],
      });
      const translated = response.choices[0]?.message?.content?.trim();
      return translated || term;
    } catch {
      this.logger.warn(`Falha ao traduzir termo "${term}", usando original`);
      return term;
    }
  }

  private normalizeProductName(rawName: string): string {
    let term = rawName.toLowerCase();

    // Remove generic type patterns like "tipo 1", "tipo 2"
    for (const pattern of GENERIC_TERMS) {
      term = term.replace(new RegExp(`\\b${pattern}\\b`, 'g'), '');
    }

    // Remove units of measure
    const unitPattern = new RegExp(`\\b(${UNITS.join('|')})\\b`, 'gi');
    term = term.replace(unitPattern, '');

    // Remove standalone numbers
    term = term.replace(/\b\d+([.,]\d+)?\b/g, '');

    // Remove special characters (keep letters, numbers, spaces, hyphens)
    term = term.replace(/[^a-záàâãéèêíïóôõöúüçñ0-9\s-]/gi, '');

    // Collapse extra spaces
    term = term.replace(/\s+/g, ' ').trim();

    if (!term) {
      return rawName.trim().slice(0, 30);
    }

    // Keep at most 3 words
    const words = term.split(' ').filter(Boolean);
    return words.slice(0, 3).join(' ');
  }

  private slugify(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private extensionFromMimeType(mimeType: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
    };
    const base = mimeType.split(';')[0].trim();
    return map[base] ?? '';
  }

  private extensionFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i);
      return match ? `.${match[1].toLowerCase()}` : '';
    } catch {
      return '';
    }
  }

  private async checkBatch(
    items: Array<{ productId: string; field: string; text: string }>,
  ): Promise<CorrectionDto[]> {
    const userPrompt =
      'Analise os seguintes itens e retorne apenas os que possuem erros ortográficos:\n\n' +
      JSON.stringify(items, null, 2);

    const response = await this.openai!.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      max_tokens: 2048,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) {
      throw new Error('Resposta vazia da IA');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('JSON inválido retornado pela IA');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('corrections' in parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).corrections)
    ) {
      throw new Error('Estrutura inesperada retornada pela IA');
    }

    return (parsed as { corrections: unknown[] }).corrections.map((item) => {
      const c = item as Record<string, unknown>;
      return {
        productId: String(c.productId ?? ''),
        field: c.field as CorrectionDto['field'],
        original: String(c.original ?? ''),
        suggestion: String(c.suggestion ?? ''),
      };
    });
  }

  // ─── Feature 4: Template Generation ─────────────────────────────────────────

  async generateTemplate(
    format: FormatDto,
    messages: ChatMessageDto[],
  ): Promise<TemplateGenerateResponseDto> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    // Build messages array for GPT-4o
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: TEMPLATE_SYSTEM_PROMPT },
      // Inject format info as first user context message
      {
        role: 'user',
        content: `Formato selecionado: ${format.type}\n- artWidthCm: ${format.artWidthCm}\n- artHeightCm: ${format.artHeightCm}\n- headerHeightCm: ${format.headerHeightCm}\n- footerHeightCm: ${format.footerHeightCm}\n\nCanvas width: ${(format.artWidthCm * 37.795).toFixed(0)}px | Header height: ${(format.headerHeightCm * 37.795).toFixed(0)}px | Footer height: ${(format.footerHeightCm * 37.795).toFixed(0)}px`,
      },
      { role: 'assistant', content: 'Entendido. Aguardo sua descrição do template.' },
    ];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        openaiMessages.push({ role: 'assistant', content: msg.content });
        continue;
      }

      // User message — may include reference images
      if (msg.images && msg.images.length > 0) {
        const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
          { type: 'text', text: msg.content },
          ...msg.images.map(
            (dataUrl): OpenAI.Chat.ChatCompletionContentPart => ({
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'low' },
            }),
          ),
        ];
        openaiMessages.push({ role: 'user', content: contentParts });
      } else {
        openaiMessages.push({ role: 'user', content: msg.content });
      }
    }

    // Call GPT-4o
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      messages: openaiMessages,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error('Resposta vazia do GPT-4o');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('JSON inválido retornado pelo GPT-4o');
    }

    const result = parsed as Record<string, unknown>;
    if (
      typeof result.assistantMessage !== 'string' ||
      typeof result.configuration !== 'object' ||
      result.configuration === null
    ) {
      throw new Error('Estrutura inválida retornada pelo GPT-4o');
    }

    const configuration = result.configuration as Record<string, unknown>;

    // Resolve GENERATE: placeholders with DALL-E 3
    let imagesGenerated = false;
    await this.resolvePlaceholders(configuration, () => {
      imagesGenerated = true;
    });

    // Validate final configuration
    this.validateConfiguration(configuration);

    return {
      assistantMessage: result.assistantMessage as string,
      configuration,
      imagesGenerated,
    };
  }

  private async resolvePlaceholders(obj: unknown, onGenerated: () => void): Promise<void> {
    if (typeof obj === 'string') return;
    if (Array.isArray(obj)) {
      await Promise.all(obj.map((item) => this.resolvePlaceholders(item, onGenerated)));
      return;
    }
    if (typeof obj !== 'object' || obj === null) return;

    const record = obj as Record<string, unknown>;
    const promises: Promise<void>[] = [];

    for (const key of Object.keys(record)) {
      const value = record[key];

      if (typeof value === 'string' && value.startsWith(GENERATE_PREFIX)) {
        const prompt =
          value.slice(GENERATE_PREFIX.length).trim() || 'promotional supermarket background';
        promises.push(
          this.generateAndUploadImage(prompt)
            .then((url) => {
              record[key] = url;
              onGenerated();
            })
            .catch((err) => {
              this.logger.error(`DALL-E 3 falhou para key "${key}": ${err?.message}`);
              record[key] = '';
            }),
        );
      } else {
        promises.push(this.resolvePlaceholders(value, onGenerated));
      }
    }

    await Promise.all(promises);
  }

  private async generateAndUploadImage(prompt: string): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const response = await this.openai.images.generate({
      model: 'dall-e-3',
      prompt,
      size: '1024x1024',
      quality: 'standard',
      n: 1,
    });

    const tempUrl = response.data[0]?.url;
    if (!tempUrl) throw new Error('DALL-E 3 não retornou URL');

    // Download the temporary URL
    const fetchResponse = await fetch(tempUrl);
    if (!fetchResponse.ok)
      throw new Error(`Falha ao baixar imagem DALL-E: ${fetchResponse.status}`);

    const arrayBuffer = await fetchResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const slug = this.slugify(prompt.slice(0, 40));
    const filename = `ai-${slug}-${Date.now()}.jpg`;

    const fakeFile = {
      buffer,
      originalname: filename,
      size: buffer.length,
      mimetype: 'image/jpeg',
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const result = await this.uploadsService.uploadFile(fakeFile, 'templates');
    return result.url;
  }

  // ─── Feature 5 — Template Image Generator ───────────────────────────────────

  async generateTemplateImage(
    format: { type: string; printWidthCm: number; printHeightCm: number },
    messages: {
      role: 'user' | 'assistant';
      content: string;
      imageUrl?: string;
      images?: string[];
    }[],
  ): Promise<{ imageUrl: string; assistantMessage: string; promptUsed: string }> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) throw new Error('Nenhuma mensagem do usuário encontrada');

    // Find the last assistant message that has an imageUrl (for iterative editing)
    const lastAssistantWithImage = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.imageUrl);

    // Reference images attached by the user in the last message
    const userReferenceImages = lastUserMessage.images ?? [];
    const isRefinement = !!lastAssistantWithImage;

    // ── Step 1: Vision analysis of reference images ──────────────────────────
    // When reference images are provided, use GPT-4o Vision to extract a
    // precise technical description BEFORE crafting the generation prompt.
    // This is far more reliable than passing the images as vague "context".
    let referenceStyleDescription = '';
    if (userReferenceImages.length > 0) {
      type VisionPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

      const visionContent: VisionPart[] = [
        {
          type: 'text',
          text: `You are an expert visual design analyst. Analyze the provided image(s) with extreme technical precision.

For EACH image describe ALL of the following in English:
1. HEADER AREA (top 30%): Every visual element present, their 3D style/quality, exact colors, lighting direction, depth/shadow treatment, decorative items (name each: bunnies, eggs, ribbons, chocolate, sparkles, etc.)
2. RENDER STYLE: Specify exactly — photorealistic 3D render, clay-style 3D, flat illustration, watercolor, etc.
3. COLOR PALETTE: List the 4–6 dominant colors with descriptions (e.g. "deep chocolate brown #3B1A08", "vibrant orange #EA5C0A", "metallic gold #D4A017")
4. BACKGROUND: Color, texture, gradient, bokeh dots, spotlights — describe precisely
5. ATMOSPHERE: Lighting mood (dramatic, warm, festive), shadows, glow effects
6. COMPOSITION: Where are the key elements positioned? Are they centered, scattered, layered in depth?
7. STYLE KEYWORDS: List 8–10 technical prompt keywords that best capture this visual style

Be extremely specific. This analysis will be used as the direct source for an image generation prompt.`,
        },
        ...userReferenceImages.slice(0, 3).map((img) => ({
          type: 'image_url' as const,
          image_url: { url: img, detail: 'high' as const },
        })),
      ];

      const visionResponse = (await this.openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 700,
        temperature: 0.1,
        messages: [{ role: 'user', content: visionContent }],
      } as Parameters<
        typeof this.openai.chat.completions.create
      >[0])) as OpenAI.Chat.ChatCompletion;

      referenceStyleDescription = visionResponse.choices[0]?.message?.content?.trim() ?? '';
      this.logger.log(`Reference analysis extracted (${referenceStyleDescription.length} chars)`);
    }

    // ── Step 2: Translate + enrich the user's PT message into an EN prompt ───
    // When reference images were analyzed, inject the analysis directly into
    // the system prompt so the output prompt is grounded in exact visual facts.
    // When reference images are present (even on refinement), always use
    // images.generate — images.edit is only for small targeted changes.
    const useEditEndpoint = isRefinement && userReferenceImages.length === 0;

    const translationSystemPrompt = useEditEndpoint
      ? `You are a supermarket flyer image prompt engineer.
The user wants to make a TARGETED edit to an existing promotional flyer background image.

CRITICAL RULES FOR EDIT INSTRUCTIONS:
1. Start your instruction with "PRESERVE EVERYTHING EXACTLY AS IS. ONLY change:"
2. Describe ONLY the specific change the user requested — nothing else
3. Be extremely precise: specify location, what to remove/add/modify
4. Explicitly forbid changing background, colors, composition, style, other elements
5. End with: "Do NOT alter the background, color scheme, overall composition, or any other element."

Return ONLY the English edit instruction, nothing else.`
      : referenceStyleDescription
        ? `You are a supermarket flyer image prompt engineer.
The user sent reference image(s). A detailed visual analysis has been performed:

=== REFERENCE IMAGE ANALYSIS ===
${referenceStyleDescription}
=== END OF ANALYSIS ===

YOUR TASK: Write a single-image generation prompt that:
1. Replicates the exact visual style, render quality, color palette, and atmosphere described above
2. Incorporates the user's specific request: "${lastUserMessage.content}"
3. The image will be divided into 3 vertical zones:
   - TOP 28%: header — rich, thematic, high-detail visuals matching the reference style
   - MIDDLE 60%: body — same style but slightly subdued/darker so white product cards are readable
   - BOTTOM 12%: footer — darkest tone from the palette for text overlay
4. NO text, NO logos, NO brand names in the image
5. Smooth visual continuity between zones
6. End prompt with: "promotional flyer background, no text, no logos, seamless vertical composition"

Return ONLY the English generation prompt, nothing else.`
        : `You are a supermarket flyer image prompt engineer.
Convert the user's Portuguese description into a detailed English prompt for generating a promotional flyer background image.

The image will be divided into 3 vertical zones after generation:
- TOP 28%: header — rich, thematic, impactful visuals
- MIDDLE 60%: body — subtle texture/pattern, dark enough for white product cards to float on top
- BOTTOM 12%: footer — darker tone for text overlay

Rules:
- Style: vibrant Brazilian supermarket promotional flyer, bold colors, professional marketing material
- NO text, NO logos, NO brand names in the image
- Smooth visual continuity between all three zones
- The middle zone must be a subdued/darker version of the top theme (not a different design)
- Specify art style: flat design illustration, watercolor, photorealistic, 3D render, etc.
- Add relevant thematic elements (e.g. Easter: chocolate eggs, bunnies, spring flowers)
- End prompt with: "promotional flyer background, no text, no logos, seamless zones from top to bottom"

Return ONLY the English prompt, nothing else.`;

    const translationResponse = (await this.openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      temperature: 0.2,
      messages: [
        { role: 'system', content: translationSystemPrompt },
        { role: 'user', content: lastUserMessage.content },
      ],
    } as Parameters<typeof this.openai.chat.completions.create>[0])) as OpenAI.Chat.ChatCompletion;

    const enrichedPrompt = translationResponse.choices[0]?.message?.content?.trim();
    if (!enrichedPrompt) throw new Error('Falha ao traduzir prompt');

    this.logger.log(`Image prompt: ${enrichedPrompt.slice(0, 120)}…`);

    // ── Step 3: pick the best supported size ────────────────────────────────
    // gpt-image-1 supports: 1024x1024, 1024x1536, 1536x1024, auto
    const ratio = format.printWidthCm / format.printHeightCm;
    let size: '1024x1024' | '1536x1024' | '1024x1536';
    if (ratio > 1.3) {
      size = '1536x1024'; // landscape
    } else if (ratio < 0.77) {
      size = '1024x1536'; // portrait
    } else {
      size = '1024x1024'; // square / near-square
    }

    // ── Step 4: generate or edit the image ─────────────────────────────────
    // Use images.edit ONLY for small targeted refinements (no reference images).
    // Use images.generate for: first generation, reference-guided style changes,
    // or any request where the user attached reference images.
    let tempUrl: string;

    if (useEditEndpoint && lastAssistantWithImage!.imageUrl) {
      // Small targeted edit — download existing image and edit it
      const existingImageResponse = await fetch(lastAssistantWithImage!.imageUrl);
      if (!existingImageResponse.ok) {
        throw new Error('Falha ao baixar imagem anterior para edição');
      }
      const existingBuffer = Buffer.from(await existingImageResponse.arrayBuffer());

      const { toFile } = await import('openai');
      const imageFile = await toFile(existingBuffer, 'template.png', { type: 'image/png' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const editResponse = (await (this.openai.images.edit as any)({
        model: 'gpt-image-1',
        image: imageFile,
        prompt: enrichedPrompt,
        size,
        n: 1,
      })) as { data: { b64_json?: string; url?: string }[] };

      const b64 = editResponse.data[0]?.b64_json;
      if (!b64) throw new Error('gpt-image-1 edit não retornou imagem');
      tempUrl = `data:image/png;base64,${b64}`;
    } else {
      // Full generation — first time, reference-guided, or style-level change
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const genResponse = (await (this.openai.images.generate as any)({
        model: 'gpt-image-1',
        prompt: enrichedPrompt,
        size,
        n: 1,
      })) as { data: { b64_json?: string; url?: string }[] };

      const b64 = genResponse.data[0]?.b64_json;
      const url = genResponse.data[0]?.url;

      if (b64) {
        tempUrl = `data:image/png;base64,${b64}`;
      } else if (url) {
        tempUrl = url;
      } else {
        throw new Error('gpt-image-1 não retornou imagem');
      }
    }

    // Step 4: download (if URL) and upload to our bucket
    let buffer: Buffer;
    let mimetype = 'image/png';

    if (tempUrl.startsWith('data:')) {
      const [header, b64data] = tempUrl.split(',');
      mimetype = header.split(':')[1].split(';')[0];
      buffer = Buffer.from(b64data, 'base64');
    } else {
      const fetchResponse = await fetch(tempUrl);
      if (!fetchResponse.ok)
        throw new Error(`Falha ao baixar imagem gerada: ${fetchResponse.status}`);
      mimetype = fetchResponse.headers.get('content-type') || 'image/png';
      buffer = Buffer.from(await fetchResponse.arrayBuffer());
    }

    const ext = mimetype.includes('jpeg') ? '.jpg' : '.png';
    const slug = this.slugify(format.type);
    const filename = `ai-template-${slug}-${Date.now()}${ext}`;

    const fakeFile = {
      buffer,
      originalname: filename,
      size: buffer.length,
      mimetype,
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const uploaded = await this.uploadsService.uploadFile(fakeFile, 'templates');

    // Step 5: generate a friendly PT response message
    const replyResponse = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 150,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            'Você é um assistente de design de encartes. Responda em português brasileiro de forma breve e animada, confirmando o que foi criado/alterado. Máximo 2 frases.',
        },
        {
          role: 'user',
          content: isRefinement
            ? `O usuário pediu: "${lastUserMessage.content}". A imagem foi editada conforme solicitado.`
            : `O usuário pediu: "${lastUserMessage.content}". Um template foi gerado com o tema solicitado.`,
        },
      ],
    });

    const assistantMessage =
      replyResponse.choices[0]?.message?.content?.trim() ||
      (isRefinement ? 'Imagem atualizada conforme solicitado!' : 'Template gerado com sucesso!');

    return {
      imageUrl: uploaded.url,
      assistantMessage,
      promptUsed: enrichedPrompt,
    };
  }

  private validateConfiguration(config: Record<string, unknown>): void {
    const requiredSectionFields = ['id', 'name', 'widthCm', 'heightCm', 'background', 'elements'];

    for (const section of ['header', 'footer'] as const) {
      const s = config[section] as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') {
        throw new Error(`Seção "${section}" ausente na configuration`);
      }
      for (const field of requiredSectionFields) {
        if (!(field in s)) {
          throw new Error(`Campo obrigatório "${field}" ausente na seção "${section}"`);
        }
      }
      // Validate elements
      if (!Array.isArray(s.elements)) {
        throw new Error(`"elements" deve ser um array na seção "${section}"`);
      }
      for (const el of s.elements as unknown[]) {
        const elem = el as Record<string, unknown>;
        for (const f of ['id', 'type', 'x', 'y', 'width', 'height', 'zIndex']) {
          if (!(f in elem)) {
            throw new Error(`Elemento sem campo obrigatório "${f}" na seção "${section}"`);
          }
        }
      }
    }

    // Ensure no unresolved GENERATE: placeholders remain
    const json = JSON.stringify(config);
    if (json.includes(GENERATE_PREFIX)) {
      throw new Error('Placeholders GENERATE: não resolvidos na configuration final');
    }
  }
}
