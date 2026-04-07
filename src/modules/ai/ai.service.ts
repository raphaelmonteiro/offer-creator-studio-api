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
import {
  TemplateLayersFormatDto,
  TemplateLayersMessageDto,
  TemplateLayersGenerateResponseDto,
  LayerElementDto,
} from './dto/template-layers-generate.dto';
import {
  ElementAction,
  TemplateElementResponseDto,
} from './dto/template-element-request.dto';

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

const ELEMENT_SYSTEM_PROMPT = `You are a template element assistant for a supermarket flyer builder app.

The user is editing a template in a canvas editor and wants to add, modify or remove individual elements.

IMPORTANT CONTEXT:
- The canvas has 3 sections: header, footer, and body (background only)
- The user is currently viewing the "activeSection" — default to that section unless they specify otherwise
- Coordinates are in pixels at 37.795px per cm (96 DPI)
- Canvas dimensions are provided as format info

You MUST respond with a JSON object containing:
{
  "assistantMessage": "<brief message in Portuguese explaining what was done>",
  "actions": [<array of actions>]
}

AVAILABLE ACTIONS:

1. ADD IMAGE — generates an isolated image (transparent background) and adds it to canvas:
{
  "type": "add-image",
  "section": "header|footer",
  "element": {
    "type": "image",
    "src": "GENERATE: <English prompt for isolated object, transparent background, PNG>",
    "x": <pixels>, "y": <pixels>,
    "width": <pixels>, "height": <pixels>,
    "zIndex": 5,
    "opacity": 1,
    "objectFit": "contain",
    "borderRadius": 0
  }
}

2. ADD TEXT — adds a text element:
{
  "type": "add-text",
  "section": "header|footer",
  "element": {
    "type": "text",
    "content": "<the text>",
    "x": <pixels>, "y": <pixels>,
    "width": <pixels>, "height": <pixels>,
    "zIndex": 5,
    "fontSize": <number>,
    "fontFamily": "Arial",
    "fontWeight": "bold|normal",
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
}

3. UPDATE ELEMENT — modifies properties of an existing element by ID:
{
  "type": "update-element",
  "section": "header|footer",
  "elementId": "<id of existing element>",
  "updates": { "<property>": <new value>, ... }
}
To change an image's source, set "src": "GENERATE: <new prompt>"

4. REMOVE ELEMENT — removes an element by ID:
{
  "type": "remove-element",
  "section": "header|footer",
  "elementId": "<id of existing element>"
}

5. UPDATE BACKGROUND — changes a section's background:
{
  "type": "update-background",
  "section": "header|footer|body",
  "background": {
    "type": "solid|gradient|image",
    ... (same CanvasBackground schema as the template generator)
  }
}
For generated backgrounds use: "imageUrl": "GENERATE: <prompt>"

RULES FOR IMAGE GENERATION PROMPTS:
- For element images (add-image), just describe the object itself. Transparent background is handled automatically by the system.
- Be specific about the object: "3D red megaphone icon, cartoon style" or "golden trophy, metallic render"
- Do NOT include background descriptions in the prompt — the system removes backgrounds automatically
- Do NOT generate full scenes — only isolated objects/icons
- Keep prompts in English

RULES FOR TEXT:
- Use the exact text the user requests — do not change wording
- Choose appropriate fontSize based on element importance (titles: 32-48px, labels: 18-24px, small text: 12-16px)
- Position text logically within the section bounds

RULES FOR POSITIONING:
- Calculate positions relative to the section, not the full canvas
- x=0, y=0 is the top-left of the section
- Consider existing elements to avoid overlaps — check the template context

GENERAL:
- You can return MULTIPLE actions in one response (e.g., add image + add text)
- Always respond in Portuguese in assistantMessage
- If the request is ambiguous, make a reasonable choice and explain in assistantMessage
- If the user asks something unrelated to template editing, respond with an empty actions array and a helpful message`;

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

  // ─── Template Element Assistant (incremental add/edit/remove) ────────────────

  async generateTemplateElement(
    format: FormatDto,
    activeSection: 'header' | 'footer' | 'body',
    messages: ChatMessageDto[],
    templateContext?: Record<string, unknown>,
  ): Promise<TemplateElementResponseDto> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const canvasW = (format.artWidthCm * 37.795).toFixed(0);
    const headerH = (format.headerHeightCm * 37.795).toFixed(0);
    const footerH = (format.footerHeightCm * 37.795).toFixed(0);

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: ELEMENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `Format: ${format.type}, ${format.artWidthCm}×${format.artHeightCm}cm\n` +
          `Canvas: ${canvasW}px wide | Header: ${headerH}px tall | Footer: ${footerH}px tall\n` +
          `Active section: ${activeSection}`,
      },
      { role: 'assistant', content: 'Entendido. Aguardo sua instrução.' },
    ];

    // Inject current template context
    if (templateContext) {
      openaiMessages.push({
        role: 'user',
        content: `[TEMPLATE CONTEXT]\n${JSON.stringify(templateContext, null, 2)}`,
      });
      openaiMessages.push({
        role: 'assistant',
        content: 'Template context loaded. I will use it for positioning and updates.',
      });
    }

    // Append conversation
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        openaiMessages.push({ role: 'assistant', content: msg.content });
        continue;
      }
      if (msg.images && msg.images.length > 0) {
        const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
          { type: 'text', text: msg.content },
          ...msg.images.map(
            (dataUrl): OpenAI.Chat.ChatCompletionContentPart => ({
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'low' },
            }),
          ),
        ];
        openaiMessages.push({ role: 'user', content: parts });
      } else {
        openaiMessages.push({ role: 'user', content: msg.content });
      }
    }

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      messages: openaiMessages,
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error('Resposta vazia do GPT-4o');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('JSON inválido retornado pelo GPT-4o');
    }

    const assistantMessage = (parsed.assistantMessage as string) ?? 'Pronto!';
    const actions = (parsed.actions as ElementAction[]) ?? [];

    // Resolve GENERATE: placeholders in all actions
    for (const action of actions) {
      if (action.element) {
        await this.resolveElementPlaceholders(action.element);
      }
      if (action.updates) {
        await this.resolveElementPlaceholders(action.updates);
      }
      if (action.background) {
        await this.resolveElementPlaceholders(action.background);
      }
    }

    return { assistantMessage, actions };
  }

  /** Resolve GENERATE: placeholders in a flat object (element or background) */
  private async resolveElementPlaceholders(
    obj: Record<string, unknown>,
    transparent = false,
  ): Promise<void> {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.startsWith(GENERATE_PREFIX)) {
        const prompt = val.slice(GENERATE_PREFIX.length).trim();
        try {
          // Use transparent PNG for element images (src), opaque for backgrounds (imageUrl)
          const useTransparent = transparent || key === 'src';
          const url = useTransparent
            ? await this.generateTransparentImage(prompt)
            : await this.generateAndUploadImage(prompt);
          obj[key] = url;
        } catch (err) {
          this.logger.error(`Image generation failed for "${key}": ${(err as Error).message}`);
          obj[key] = '';
        }
      }
    }
  }

  /** Generate an isolated element image with transparent background via gpt-image-1 */
  private async generateTransparentImage(prompt: string): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await (this.openai.images.generate as any)({
      model: 'gpt-image-1',
      prompt: `${prompt}. Isolated object on a completely transparent background, PNG format, no shadows on ground, no floor, no scene.`,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      n: 1,
    })) as { data: { b64_json?: string; url?: string }[] };

    const b64 = response.data[0]?.b64_json;
    if (!b64) throw new Error('gpt-image-1 não retornou imagem');

    const buffer = Buffer.from(b64, 'base64');
    const slug = this.slugify(prompt.slice(0, 40));
    const filename = `ai-element-${slug}-${Date.now()}.png`;

    const fakeFile = {
      buffer,
      originalname: filename,
      size: buffer.length,
      mimetype: 'image/png',
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const result = await this.uploadsService.uploadFile(fakeFile, 'templates');
    return result.url;
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

    // Physical dimensions context — the user's message may reference percentages
    const W = format.printWidthCm;
    const H = format.printHeightCm;
    const dimensionsCtx = `The template is ${W}×${H} cm (width×height).`;

    // Shared rules for all prompt types
    const faithfulnessRules = `
CRITICAL — FAITHFULNESS TO USER REQUEST:
- Translate the user's description FAITHFULLY into English. Do NOT omit, simplify, or summarize.
- If the user specifies zone proportions (e.g. "header 25%", "footer 10%"), USE THOSE EXACT proportions.
- If the user requests specific visual elements (text, objects, textures, icons), include ALL of them in the prompt with their exact placement.
- If the user requests TEXT to appear in the image (e.g. "Promoção", "Preços válidos até…"), include that text VERBATIM in the prompt — the image generator CAN render text.
- Convert percentage heights to visual descriptions using the physical size. E.g. for a ${H}cm-tall template, "25% header" = the top ${(H * 0.25).toFixed(1)}cm.
- If the user does NOT specify proportions, use defaults: header ~25%, body ~65%, footer ~10%.`;

    const translationSystemPrompt = useEditEndpoint
      ? `You are a supermarket flyer image prompt engineer.
${dimensionsCtx}
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
${dimensionsCtx}
The user sent reference image(s). A detailed visual analysis has been performed:

=== REFERENCE IMAGE ANALYSIS ===
${referenceStyleDescription}
=== END OF ANALYSIS ===

YOUR TASK: Write a single-image generation prompt that:
1. Replicates the exact visual style, render quality, color palette, and atmosphere described above
2. Incorporates the user's specific request — translate it FAITHFULLY, keeping ALL requested elements
3. The image has 3 vertical zones. Use the proportions the user specifies, or default to: top 25% header, middle 65% body, bottom 10% footer
4. If the user requests text in the image, include it verbatim
5. Smooth visual continuity between zones
6. End prompt with: "promotional flyer background, seamless vertical composition"
${faithfulnessRules}

Return ONLY the English generation prompt, nothing else.`
        : `You are a supermarket flyer image prompt engineer.
${dimensionsCtx}

Convert the user's Portuguese description into a detailed English prompt for generating a promotional flyer background image.

The image has 3 vertical zones. The user may specify the proportion of each zone — respect their numbers.
If they don't specify, use defaults: top ~25% header, middle ~65% body, bottom ~10% footer.

ZONE GUIDELINES (apply only when the user does NOT override):
- HEADER (top): rich, thematic, impactful visuals, decorative elements
- BODY (middle): calmer continuation of the theme, suitable for product cards overlay
- FOOTER (bottom): darker/solid tone, suitable for text overlay
- Smooth visual continuity — the 3 zones should feel like ONE cohesive image, not 3 separate blocks
- A thick white horizontal line separating zones is OK if the user asks for it
${faithfulnessRules}

STYLE: Brazilian supermarket promotional flyer, professional marketing material.
End prompt with: "promotional flyer background, seamless vertical composition"

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

    // ── Step 3: pick the closest supported size to the format's aspect ratio ─
    // gpt-image-1 supports: 1024x1024 (1.0), 1024x1536 (0.67), 1536x1024 (1.5)
    const ratio = format.printWidthCm / format.printHeightCm;
    const candidates: { size: '1024x1024' | '1024x1536' | '1536x1024'; ratio: number }[] = [
      { size: '1024x1536', ratio: 1024 / 1536 }, // portrait
      { size: '1024x1024', ratio: 1.0 }, // square
      { size: '1536x1024', ratio: 1536 / 1024 }, // landscape
    ];
    const size = candidates.reduce((best, c) =>
      Math.abs(c.ratio - ratio) < Math.abs(best.ratio - ratio) ? c : best,
    ).size;

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
        quality: 'high',
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
        quality: 'high',
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

  // ─── Feature 6 — Template Layers Generator ──────────────────────────────────

  async generateTemplateLayers(
    format: TemplateLayersFormatDto,
    messages: TemplateLayersMessageDto[],
  ): Promise<TemplateLayersGenerateResponseDto> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) throw new Error('Nenhuma mensagem do usuário encontrada');

    const userReferenceImages = lastUserMessage.images ?? [];

    // Current layers state (for refinements — preserves elements not being changed)
    const currentLayers = lastUserMessage.currentLayers ?? { elements: [] };
    const isRefinement = currentLayers.elements.length > 0 || !!currentLayers.background;

    // ── Step 1: Vision analysis of reference images (same as F5) ─────────────
    let referenceStyleDescription = '';
    if (userReferenceImages.length > 0) {
      type VisionPart =
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

      const visionContent: VisionPart[] = [
        {
          type: 'text',
          text: `You are an expert visual design analyst. Analyze the provided image(s) with extreme technical precision.
For EACH image describe: 1) dominant colors (hex if possible), 2) visual style (photorealistic/flat/3D/watercolor), 3) thematic elements present, 4) background texture/pattern, 5) lighting mood, 6) overall composition feel, 7) any decorative elements and their approximate size/position.
Respond in English, structured, max 300 words total.`,
        },
        ...userReferenceImages.map(
          (img): VisionPart => ({
            type: 'image_url',
            image_url: { url: img, detail: 'high' },
          }),
        ),
      ];

      const visionResponse = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 400,
        messages: [{ role: 'user', content: visionContent }],
      });
      referenceStyleDescription = visionResponse.choices[0]?.message?.content?.trim() ?? '';
    }

    // ── Step 2: GPT-4o decides the composition (palette + elements) ──────────
    const canvasWidthPx = Math.round(format.printWidthCm * 37.795);
    const headerHeightPx = Math.round(format.headerHeightCm * 37.795);
    const footerHeightPx = Math.round(format.footerHeightCm * 37.795);

    const compositionSystemPrompt = `You are an expert supermarket flyer template designer.
Your job is to decompose a flyer template into separate visual layers.

The flyer has these pixel dimensions (at 96dpi):
- Canvas width: ${canvasWidthPx}px
- Header height: ${headerHeightPx}px (top section — decorative)
- Footer height: ${footerHeightPx}px (bottom section — solid color bar)
- Body: the remaining middle area (solid color — product cards go here)

You must return a JSON composition with:
1. A color palette (4 colors: primary, secondary, dark, light)
2. A background image description for the HEADER (texture/pattern, NO decorative objects)
3. Up to 4 decorative elements as separate transparent PNG objects for the HEADER or FOOTER
4. A body background (solid color or subtle gradient — NEVER an image — must be readable for white product cards)
5. A footer background (solid dark color)

For each element, specify:
- A short English prompt for generating it as a transparent PNG (isolated object, no background)
- Which section it belongs to: "header" or "footer"
- suggestedPosition: "center" | "right" | "left" | "bottom-left" | "bottom-right" | "top" | "bottom"
- suggestedSizePct: 10-80 (percentage of canvas width the element should occupy)

${referenceStyleDescription ? `Reference style analysis:\n${referenceStyleDescription}\n` : ''}

${
  isRefinement
    ? `This is a REFINEMENT request. Current state:
- Background prompt: "${currentLayers.background?.prompt ?? 'none'}"
- Elements: ${JSON.stringify(currentLayers.elements.map((e) => ({ id: e.id, prompt: e.prompt, section: e.section })))}

Identify what the user wants to change. For unchanged elements, return them with regenerate: false.
For elements to be regenerated or repositioned, set regenerate: true (or positionOnly: true if only moving).`
    : ''
}

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "palette": { "primary": "#hex", "secondary": "#hex", "dark": "#hex", "light": "#hex" },
  "backgroundPrompt": "english prompt for header background texture, no objects, seamless",
  "elements": [
    {
      "id": "el-1",
      "englishPrompt": "isolated object description, transparent background, no shadow",
      "section": "header",
      "suggestedPosition": "right",
      "suggestedSizePct": 40,
      "regenerate": true,
      "positionOnly": false
    }
  ],
  "bodyBackground": { "type": "solid", "color": "#hex" },
  "footerBackground": { "type": "solid", "color": "#hex" },
  "assistantMessagePt": "mensagem em português explicando o que foi criado"
}`;

    const compositionResponse = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1000,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: compositionSystemPrompt },
        { role: 'user', content: lastUserMessage.content },
      ],
    });

    const compositionRaw = compositionResponse.choices[0]?.message?.content?.trim() ?? '{}';
    let composition: {
      palette: { primary: string; secondary: string; dark: string; light: string };
      backgroundPrompt: string;
      elements: {
        id: string;
        englishPrompt: string;
        section: 'header' | 'footer';
        suggestedPosition: string;
        suggestedSizePct: number;
        regenerate?: boolean;
        positionOnly?: boolean;
      }[];
      bodyBackground: {
        type: 'solid' | 'gradient';
        color?: string;
        gradientStart?: string;
        gradientEnd?: string;
        gradientAngle?: number;
      };
      footerBackground: { type: 'solid'; color: string };
      assistantMessagePt: string;
    };

    try {
      composition = JSON.parse(compositionRaw);
    } catch {
      throw new Error('GPT-4o retornou composição inválida (não é JSON)');
    }

    // ── Step 3: Generate background + transparent element PNGs in parallel ────
    // Decide size based on aspect ratio (same logic as F5)
    const ratio = format.printWidthCm / format.printHeightCm;
    let bgSize: '1024x1024' | '1536x1024' | '1024x1536';
    if (ratio > 1.3) bgSize = '1536x1024';
    else if (ratio < 0.77) bgSize = '1024x1536';
    else bgSize = '1024x1024';

    const needsNewBackground =
      !isRefinement ||
      !currentLayers.background ||
      composition.elements.every((e) => e.regenerate !== false); // full redo

    const bgPromise = needsNewBackground
      ? this.generateAndUploadLayerImage(
          `${composition.backgroundPrompt}, promotional flyer header background, no objects, no text, no logos, seamless texture`,
          bgSize,
          format.type,
          'bg',
        )
      : Promise.resolve(currentLayers.background!.imageUrl);

    // Max 4 elements
    const elementsToProcess = composition.elements.slice(0, 4);

    const elementPromises = elementsToProcess.map(async (el) => {
      // If position-only change, preserve existing imageUrl
      if (isRefinement && el.positionOnly) {
        const existing = currentLayers.elements.find((e) => e.id === el.id);
        if (existing) {
          return {
            id: el.id,
            imageUrl: existing.imageUrl,
            prompt: el.englishPrompt,
            section: el.section,
          };
        }
      }
      // If refinement and this element hasn't changed, preserve URL
      if (isRefinement && el.regenerate === false) {
        const existing = currentLayers.elements.find((e) => e.id === el.id);
        if (existing) {
          return {
            id: el.id,
            imageUrl: existing.imageUrl,
            prompt: el.englishPrompt,
            section: el.section,
          };
        }
      }
      // Generate new transparent PNG
      const transparentPrompt = `${el.englishPrompt}, isolated object, transparent background, no shadow, no background, high quality PNG`;
      const imageUrl = await this.generateAndUploadLayerImage(
        transparentPrompt,
        '1024x1024',
        format.type,
        el.id,
        true, // transparent
      );
      return { id: el.id, imageUrl, prompt: el.englishPrompt, section: el.section };
    });

    const [bgUrl, ...generatedElements] = await Promise.all([bgPromise, ...elementPromises]);

    // ── Step 4: Convert suggestedPosition + sizePct → real canvas coordinates ─
    const layerElements: LayerElementDto[] = generatedElements.map((el, idx) => {
      const elDef = elementsToProcess[idx];
      const sectionHeightPx = elDef.section === 'header' ? headerHeightPx : footerHeightPx;
      const w = Math.round((elDef.suggestedSizePct / 100) * canvasWidthPx);
      const h = Math.round(w * 0.8); // default aspect ratio; user can resize

      let x = 0;
      let y = 0;
      switch (elDef.suggestedPosition) {
        case 'center':
          x = Math.round((canvasWidthPx - w) / 2);
          y = Math.round((sectionHeightPx - h) / 2);
          break;
        case 'right':
          x = canvasWidthPx - w;
          y = 0;
          break;
        case 'left':
          x = 0;
          y = 0;
          break;
        case 'bottom-left':
          x = 0;
          y = sectionHeightPx - h;
          break;
        case 'bottom-right':
          x = canvasWidthPx - w;
          y = sectionHeightPx - h;
          break;
        case 'top':
          x = 0;
          y = 0;
          w === canvasWidthPx ? null : (x = Math.round((canvasWidthPx - w) / 2));
          break;
        case 'bottom':
          x = 0;
          y = sectionHeightPx - h;
          break;
        default:
          x = Math.round((canvasWidthPx - w) / 2);
          y = Math.round((sectionHeightPx - h) / 2);
      }

      return {
        id: el.id,
        imageUrl: el.imageUrl,
        prompt: el.prompt,
        x,
        y,
        width: w,
        height: h,
        section: elDef.section,
        zIndex: idx + 1,
      };
    });

    return {
      assistantMessage: composition.assistantMessagePt || 'Template em camadas gerado com sucesso!',
      layers: {
        background: {
          imageUrl: bgUrl,
          prompt: composition.backgroundPrompt,
        },
        elements: layerElements,
      },
      bodyBackground: composition.bodyBackground,
      footerBackground: composition.footerBackground,
    };
  }

  /** Generates an image and uploads to our bucket. Used by Feature 6 for both backgrounds and transparent PNGs. */
  private async generateAndUploadLayerImage(
    prompt: string,
    size: '1024x1024' | '1536x1024' | '1024x1536',
    formatType: string,
    suffix: string,
    transparent = false,
  ): Promise<string> {
    if (!this.openai) throw new Error('OpenAI não configurada');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const genResponse = (await (this.openai.images.generate as any)({
      model: 'gpt-image-1',
      prompt,
      size,
      n: 1,
      ...(transparent ? { background: 'transparent', output_format: 'png' } : {}),
    })) as { data: { b64_json?: string; url?: string }[] };

    const b64 = genResponse.data[0]?.b64_json;
    const url = genResponse.data[0]?.url;

    let buffer: Buffer;
    let mimetype: string;

    if (b64) {
      buffer = Buffer.from(b64, 'base64');
      mimetype = transparent ? 'image/png' : 'image/png';
    } else if (url) {
      const fetchResponse = await fetch(url);
      if (!fetchResponse.ok) throw new Error(`Falha ao baixar imagem: ${fetchResponse.status}`);
      mimetype = fetchResponse.headers.get('content-type') || 'image/png';
      buffer = Buffer.from(await fetchResponse.arrayBuffer());
    } else {
      throw new Error('gpt-image-1 não retornou imagem');
    }

    const ext = transparent ? '.png' : mimetype.includes('jpeg') ? '.jpg' : '.png';
    const slug = this.slugify(formatType);
    const filename = `ai-layer-${slug}-${suffix}-${Date.now()}${ext}`;

    const fakeFile = {
      buffer,
      originalname: filename,
      size: buffer.length,
      mimetype,
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;

    const uploaded = await this.uploadsService.uploadFile(fakeFile, 'templates');
    return uploaded.url;
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
