import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as sharp from 'sharp';
import {
  SceneGenerateInput,
  SceneGenerateResult,
  SceneImageProvider,
  SceneProviderError,
} from './scene-image-provider';

const DEFAULT_LATENCY_MS = 20_000;
const DEFAULT_SLOW_MS = 3_000;

/** Marcadores no prompt que simulam falha ou lentidão do provedor. */
export const MOCK_MARKERS = {
  quota: '#falha-quota',
  timeout: '#falha-timeout',
  content: '#falha-conteudo',
  slow: '#lento',
} as const;

const FAILURES: ReadonlyArray<[string, SceneProviderError['code'], string]> = [
  [MOCK_MARKERS.quota, 'PROVIDER_QUOTA', 'Mock: conta sem saldo'],
  [MOCK_MARKERS.timeout, 'PROVIDER_TIMEOUT', 'Mock: tempo esgotado'],
  [MOCK_MARKERS.content, 'PROVIDER_CONTENT_POLICY', 'Mock: recusado pela política de conteúdo'],
];

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Cor `#rrggbb` derivada de 3 bytes do hash. */
const color = (hash: Buffer, offset: number): string =>
  `#${[0, 1, 2].map((i) => hash[offset + i].toString(16).padStart(2, '0')).join('')}`;

/**
 * Provedor de desenvolvimento (D-2): sem rede e sem custo. Desenha com `sharp` um gradiente com
 * formas, determinístico pelo hash do prompt, exatamente no tamanho pedido. A latência vem de
 * `TEMPLATE_SCENE_MOCK_LATENCY_MS` (20000; 0 nos testes), e os marcadores `#falha-quota`,
 * `#falha-timeout`, `#falha-conteudo` e `#lento` simulam os caminhos de erro.
 */
@Injectable()
export class MockSceneImageProvider implements SceneImageProvider {
  readonly name = 'mock' as const;

  constructor(
    private readonly config: ConfigService,
    private readonly sleep: (ms: number) => Promise<void> = sleepFor,
  ) {}

  async generate(input: SceneGenerateInput): Promise<SceneGenerateResult> {
    const startedAt = Date.now();
    await this.sleep(this.latencyFor(input.prompt));
    const failure = FAILURES.find(([marker]) => input.prompt.includes(marker));
    if (failure) throw new SceneProviderError(failure[1], failure[2]);

    const hash = createHash('sha256').update(input.prompt).update(input.size).digest();
    const [width, height] = input.size.split('x').map(Number);
    const buffer = await sharp(Buffer.from(this.svg(width, height, hash)))
      .png()
      .toBuffer();
    return {
      buffer,
      usage: null,
      costUsd: 0,
      requestId: `mock-${hash.subarray(0, 4).toString('hex')}`,
      latencyMs: Date.now() - startedAt,
    };
  }

  private latencyFor(prompt: string): number {
    const base = this.numberEnv('TEMPLATE_SCENE_MOCK_LATENCY_MS', DEFAULT_LATENCY_MS);
    if (!prompt.includes(MOCK_MARKERS.slow)) return base;
    return Math.max(base, this.numberEnv('TEMPLATE_SCENE_MOCK_SLOW_MS', DEFAULT_SLOW_MS));
  }

  private numberEnv(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  /** Céu em gradiente, "sol" e "morros" em posições derivadas do hash. */
  private svg(width: number, height: number, hash: Buffer): string {
    const sunX = Math.round(width * (0.2 + (hash[6] / 255) * 0.6));
    const sunY = Math.round(height * (0.12 + (hash[7] / 255) * 0.2));
    const sunR = Math.round(Math.min(width, height) * 0.1);
    const hillY = Math.round(height * (0.7 + (hash[8] / 255) * 0.15));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${color(hash, 0)}"/><stop offset="1" stop-color="${color(hash, 3)}"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  <circle cx="${sunX}" cy="${sunY}" r="${sunR}" fill="${color(hash, 9)}" opacity="0.9"/>
  <ellipse cx="${Math.round(width * 0.3)}" cy="${hillY}" rx="${Math.round(width * 0.7)}" ry="${Math.round(height * 0.18)}" fill="${color(hash, 12)}"/>
  <ellipse cx="${Math.round(width * 0.8)}" cy="${hillY + Math.round(height * 0.05)}" rx="${Math.round(width * 0.6)}" ry="${Math.round(height * 0.16)}" fill="${color(hash, 15)}"/>
</svg>`;
  }
}
