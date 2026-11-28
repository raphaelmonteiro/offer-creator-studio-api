import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { TRANSLATION_CEILING } from './config/openai-product-ceilings';
import {
  getProductAiConfig,
  ProductAiFeatureConfig,
} from './config/openai-product-features.config';
import { PixabayCategory } from './dto/image-search-request.dto';
import { ImageSearchResponseDto, PixabayImageDto } from './dto/image-search-response.dto';
import { PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT } from './prompts/image-search.prompts';
import { fetchWithTimeout } from './utils/fetch-with-timeout.util';
import { callProductChat } from './utils/ai-product-chat.util';
import { AiUsageCollector, AiUsageOptions } from './utils/ai-usage';

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
  private readonly feature: ProductAiFeatureConfig;

  constructor(private readonly configService: ConfigService) {
    this.feature = getProductAiConfig(configService).translation;

    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async searchImages(
    rawName: string,
    category?: PixabayCategory,
    options: AiUsageOptions = {},
  ): Promise<ImageSearchResponseDto> {
    options.usage?.declareModel(this.feature.model);
    const apiKey = this.configService.get<string>('PIXABAY_API_KEY');
    if (!apiKey) {
      this.logger.error('PIXABAY_API_KEY não configurada');
      throw new Error('PIXABAY_API_KEY não configurada');
    }

    const normalizedTerm = this.normalizeProductName(rawName);
    const searchTerm = await this.translateToEnglish(normalizedTerm, options.usage);
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

  private async translateToEnglish(term: string, usage?: AiUsageCollector): Promise<string> {
    if (!this.openai) {
      return term;
    }

    try {
      const response = await callProductChat({
        openai: this.openai,
        logger: this.logger,
        usage,
        feature: 'image-search.translate-term',
        spec: {
          model: this.feature.model,
          effort: 'none',
          temperature: 0,
          timeoutMs: this.feature.timeoutMs,
          ...TRANSLATION_CEILING,
        },
        messages: [
          { role: 'system', content: PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT },
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
}
