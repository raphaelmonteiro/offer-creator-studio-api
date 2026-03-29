import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { SpellCheckProductDto } from './dto/spell-check-request.dto';
import { CorrectionDto, SpellCheckResponseDto } from './dto/spell-check-response.dto';
import { ImageSearchResponseDto, PixabayImageDto } from './dto/image-search-response.dto';
import { UploadsService } from '../uploads/uploads.service';

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

const UNITS = ['kg', 'g', 'mg', 'ml', 'lt', 'un', 'pct', 'cx\\.', 'cx', 'unid', 'unidade', 'pack', 'fardo'];
const GENERIC_TERMS = ['tipo\\s+\\d+', 'especial', 'premium', 'tradicional'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

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

  async searchImages(rawName: string): Promise<ImageSearchResponseDto> {
    const apiKey = this.configService.get<string>('PIXABAY_API_KEY');
    if (!apiKey) {
      this.logger.error('PIXABAY_API_KEY não configurada');
      throw new Error('PIXABAY_API_KEY não configurada');
    }

    const searchTerm = this.normalizeProductName(rawName);

    const params = new URLSearchParams({
      key: apiKey,
      q: searchTerm,
      image_type: 'photo',
      per_page: '3',
      lang: 'pt',
      safesearch: 'true',
    });

    const response = await fetch(`https://pixabay.com/api/?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Pixabay retornou status ${response.status}`);
    }

    const data = (await response.json()) as PixabayResponse;

    const images: PixabayImageDto[] = (data.hits ?? []).slice(0, 3).map((hit) => ({
      pixabayId: hit.id,
      thumbnailUrl: hit.previewURL,
      previewUrl: hit.webformatURL,
      fullUrl: hit.largeImageURL,
      width: hit.webformatWidth,
      height: hit.webformatHeight,
    }));

    return { searchTerm, images };
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
    const ext = this.extensionFromMimeType(contentType) || this.extensionFromUrl(imageUrl) || '.jpg';
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
    return result.url;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

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
}
