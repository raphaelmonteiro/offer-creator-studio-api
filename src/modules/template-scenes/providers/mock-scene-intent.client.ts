import * as fs from 'fs';
import * as path from 'path';
import type { IntentCompletionResult } from '../../ai/openai-intent.service';
import type { SceneIntent } from '../domain/scene-intent';
import { fold } from '../../../shared/text/fold';
import type { SceneIntentCall } from './scene-intent-client';

/** Marcadores no pedido que simulam o modelo de intenção. */
export const MOCK_INTENT_MARKERS = {
  /** `#intencao=<ação>`: devolve essa ação. */
  action: /#intencao=([a-z_]+)/,
  fail: '#falha-intencao',
  invalid: '#intencao-invalida',
} as const;

interface EvalCase {
  message: string;
  marked: boolean;
  expect: SceneIntent;
}

const EVAL_FILE = path.join(__dirname, '..', 'domain', 'scene-intent.eval.json');

function loadEvalCases(): EvalCase[] {
  try {
    return JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8')) as EvalCase[];
  } catch {
    return [];
  }
}

const key = (message: string): string => fold(message).replace(/\s+/g, ' ').trim();

const EMPTY: SceneIntent = {
  action: 'ask_region',
  zone: null,
  object: null,
  subject: null,
  imagePrompt: null,
  relativePlace: false,
  layer: null,
  text: null,
};

/**
 * Intenção de desenvolvimento: sem rede e sem custo e sem regras de texto. Procura a mensagem no conjunto de
 * avaliação (`scene-intent.eval.json`) e devolve a saída esperada; os marcadores `#intencao=<ação>`,
 * `#falha-intencao` e `#intencao-invalida` exercitam as saídas e as falhas; sem casar, `edit` com
 * marcação e `ask_region` sem ela.
 */
export class MockSceneIntentClient {
  private readonly cases = loadEvalCases();

  async classify(input: SceneIntentCall): Promise<IntentCompletionResult> {
    if (input.message.includes(MOCK_INTENT_MARKERS.fail)) {
      throw new Error('Mock: modelo de intenção indisponível');
    }
    const text = input.message.includes(MOCK_INTENT_MARKERS.invalid)
      ? 'não é json'
      : JSON.stringify(this.answer(input));
    return { text, usage: null, requestId: 'mock-intent', latencyMs: 0 };
  }

  private answer(input: SceneIntentCall): SceneIntent {
    const marker = input.message.match(MOCK_INTENT_MARKERS.action);
    if (marker) return this.forAction(marker[1], input.message);
    const wanted = key(input.message);
    const same = this.cases.filter((item) => key(item.message) === wanted);
    const found = same.find((item) => item.marked === input.marked) ?? same[0];
    if (found) return found.expect;
    return { ...EMPTY, action: input.marked ? 'edit' : 'ask_region', imagePrompt: input.message };
  }

  private forAction(action: string, message: string): SceneIntent {
    const clean = message
      .replace(/#[\w=-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const quoted = clean.match(/["“«]([^"”»]+)["”»]/)?.[1];
    return {
      ...EMPTY,
      action: action as SceneIntent['action'],
      subject: action === 'add_element' ? clean : null,
      imagePrompt: clean,
      layer: action.startsWith('layer_')
        ? {
            kind: 'logo',
            name: null,
            side: action === 'layer_move' ? 'toggle' : null,
            direction: action === 'layer_resize' ? 'bigger' : null,
          }
        : null,
      text: action === 'set_text' ? { value: quoted ?? clean, placement: 'none' } : null,
    };
  }
}
