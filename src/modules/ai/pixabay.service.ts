import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { GalleryService } from '../gallery/gallery.service';
import { UploadsService } from '../uploads/uploads.service';
import { getOpenAiModelConfig, OpenAiModelConfig } from './config/openai-models.config';
import { PixabayCategory } from './dto/image-search-request.dto';
import { ImageSearchResponseDto, PixabayImageDto } from './dto/image-search-response.dto';
import { PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT } from './prompts/image-search.prompts';
import { fetchWithTimeout } from './utils/fetch-with-timeout.util';
import { withAiLogging } from './utils/ai-telemetry.util';

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
export class PixabayService {
  private readonly logger = new Logger(PixabayService.name);
  private readonly openai: OpenAI | null;
  private readonly models: OpenAiModelConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
    private readonly galleryService: GalleryService,
  ) {
    this.models = getOpenAiModelConfig(configService);

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
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

    const response = await fetchWithTimeout(`https://pixabay.com/api/?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Pixabay retornou status ${response.status}`);
    }

    const data = (await response.json()) as PixabayResponse;

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
      const fallbackResponse = await fetchWithTimeout(
        `https://pixabay.com/api/?${fallbackParams.toString()}`,
      );
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
    const response = await fetchWithTimeout(imageUrl);
    if (!response.ok) {
      throw new Error(`Falha ao baixar imagem: status ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
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

    await this.galleryService.registerImage({
      filename,
      url: result.url,
      mimeType: contentType.split(';')[0].trim(),
      size: buffer.length,
    });

    return result.url;
  }

  private async translateToEnglish(term: string): Promise<string> {
    if (!this.openai) {
      return term;
    }

    try {
      const response = await withAiLogging(
        this.logger,
        {
          feature: 'image-search.translate-term',
          endpoint: 'chat.completions',
          model: this.models.fastTextModel,
        },
        () =>
          this.openai!.chat.completions.create({
            model: this.models.fastTextModel,
            max_tokens: 32,
            temperature: 0,
            messages: [
              {
                role: 'system',
                content: PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT,
              },
              { role: 'user', content: term },
            ],
          }),
      );
      const translated = response.choices[0]?.message?.content?.trim();
      return translated || term;
    } catch {
      this.logger.warn(`Falha ao traduzir termo "${term}", usando original`);
      return term;
    }
  }

  private normalizeProductName(rawName: string): string {
    let term = rawName.toLowerCase();

    for (const pattern of GENERIC_TERMS) {
      term = term.replace(new RegExp(`\\b${pattern}\\b`, 'g'), '');
    }

    const unitPattern = new RegExp(`\\b(${UNITS.join('|')})\\b`, 'gi');
    term = term.replace(unitPattern, '');
    term = term.replace(/\b\d+([.,]\d+)?\b/g, '');
    term = term.replace(/[^a-záàâãéèêíïóôõöúüçñ0-9\s-]/gi, '');
    term = term.replace(/\s+/g, ' ').trim();

    if (!term) {
      return rawName.trim().slice(0, 30);
    }

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
}
