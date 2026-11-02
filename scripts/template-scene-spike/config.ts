import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import type { UsageRaw } from './types';

export const SCRIPTS_DIR = path.resolve(__dirname, '..');
export const BACKEND_DIR = path.resolve(SCRIPTS_DIR, '..');
export const OUT_ROOT = path.join(SCRIPTS_DIR, 'out', 'template-scene-spike');
export const PRICES_PATH = path.join(SCRIPTS_DIR, 'template-scene-spike.prices.json');
export const CASES_PATH = path.join(SCRIPTS_DIR, 'template-scene-spike.cases.json');

export interface SpikeConfig {
  budgetUsd: number;
  initialReserveUsd: number;
  maxCallUsd: number;
  imageModel: string;
  quality: string;
  visionModel: string;
  openaiKey: string;
  replicateToken: string;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} inválida: ${raw}`);
  return value;
}

/** Lê `backend/.env` (sem sobrescrever o ambiente) e monta a configuração. Não lê `OPENAI_IMAGE_*`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpikeConfig {
  if (env === process.env) dotenv.config({ path: path.join(BACKEND_DIR, '.env') });
  return {
    budgetUsd: num(env, 'SPIKE_BUDGET_USD', 100),
    initialReserveUsd: num(env, 'SPIKE_INITIAL_RESERVE_USD', 2),
    maxCallUsd: num(env, 'SPIKE_MAX_CALL_USD', 3),
    imageModel: env.SPIKE_IMAGE_MODEL?.trim() || 'gpt-image-2.5-sunburst',
    quality: env.SPIKE_IMAGE_QUALITY?.trim() || 'high',
    visionModel: env.SPIKE_VISION_MODEL?.trim() || 'gpt-4o',
    openaiKey: env.OPENAI_API_KEY?.trim() || '',
    replicateToken: env.REPLICATE_API_TOKEN?.trim() || '',
  };
}

export interface ImagePriceEntry {
  perMillionTokens: { imageInput: number; textInput: number; imageOutput: number };
  sources: string[];
  consultedAt: string;
}
export interface TextPriceEntry {
  perMillionTokens: { textInput: number; textOutput: number };
  sources: string[];
  consultedAt: string;
}
export interface RunPriceEntry {
  perRunUsd: number;
  sources: string[];
  consultedAt: string;
}

export interface PriceEntryRaw {
  perMillionTokens?: Record<string, number>;
  perRunUsd?: number;
  sources?: string[];
  consultedAt?: string;
}

export interface Prices {
  entries: Record<string, PriceEntryRaw>;
}

export function loadPrices(file: string = PRICES_PATH): Prices {
  if (!fs.existsSync(file)) throw new Error(`Arquivo de preços ausente: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Prices;
}

function entryOrThrow(prices: Prices, key: string): PriceEntryRaw {
  const entry = prices.entries[key];
  const hasSource = Array.isArray(entry?.sources) && entry.sources.length > 0 && entry.consultedAt;
  if (!entry || !hasSource) {
    throw new Error(`Preço ausente ou sem fonte e data no arquivo de preços: entrada "${key}"`);
  }
  return entry;
}

export function imagePrice(prices: Prices, model: string, quality: string): ImagePriceEntry {
  const entry = entryOrThrow(prices, model);
  const p = entry.perMillionTokens;
  if (!p || p.imageInput == null || p.textInput == null || p.imageOutput == null) {
    throw new Error(
      `Preço ausente para ${model} / ${quality}: faltam imageInput, textInput ou imageOutput`,
    );
  }
  return entry as unknown as ImagePriceEntry;
}

export function visionPrice(prices: Prices, model: string): TextPriceEntry {
  const entry = entryOrThrow(prices, model);
  if (entry.perMillionTokens?.textInput == null || entry.perMillionTokens?.textOutput == null) {
    throw new Error(`Preço ausente para ${model}: faltam textInput ou textOutput`);
  }
  return entry as unknown as TextPriceEntry;
}

export function replicatePrice(prices: Prices): RunPriceEntry {
  const entry = entryOrThrow(prices, 'replicate:851-labs/background-remover');
  if (entry.perRunUsd == null)
    throw new Error('Preço ausente: replicate:851-labs/background-remover');
  return entry as unknown as RunPriceEntry;
}

/** Custo da chamada de imagem a partir do `usage`; null se o `usage` não vier (o chamador cobra a reserva). */
export function imageCostUsd(price: ImagePriceEntry, usage: UsageRaw | undefined): number | null {
  if (!usage || usage.output_tokens == null) return null;
  const details = usage.input_tokens_details;
  const imageIn = details?.image_tokens ?? usage.input_tokens ?? 0;
  const textIn = details?.text_tokens ?? 0;
  const p = price.perMillionTokens;
  return (
    (imageIn * p.imageInput + textIn * p.textInput + usage.output_tokens * p.imageOutput) / 1e6
  );
}

export function visionCostUsd(price: TextPriceEntry, usage: UsageRaw | undefined): number | null {
  if (!usage || usage.prompt_tokens == null) return null;
  const p = price.perMillionTokens;
  return (usage.prompt_tokens * p.textInput + (usage.completion_tokens ?? 0) * p.textOutput) / 1e6;
}
