import { readFileSync } from 'fs';
import { join } from 'path';
import { callsImage } from '../domain/scene-director-decision';
import { directorPlan } from '../testing/scene-director-fixtures';
import { DirectorContext } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { runDirector } from './scene-director-run';

/**
 * Regressão sem custo (task 1.44, c): os 120 desfechos reais do Diretor, medidos nas tasks 1.42 e 1.43, reaplicados
 * por `runDirector` com o modelo simulado. O modelo devolve as tentativas gravadas, em ordem, e repete a última. O
 * esperado é o `desfecho` gravado: plano que hoje recusa ou pergunta e não recusava é falha. Não troque o esperado
 * para o teste passar.
 */
interface Attempt {
  refusal: 'painted_text' | 'painted_price' | 'painted_logo' | null;
  turn: string;
  will: boolean;
  chg: string;
  put: string;
  reply: string;
}
interface Sample {
  origem: string;
  frase: string;
  rep: number;
  desfecho: 'imagem' | 'resposta';
  chamadas: number;
  tentativas: Attempt[];
}

const samples: Sample[] = JSON.parse(
  readFileSync(join(__dirname, '../domain/__fixtures__/director-plans-1.42-1.43.json'), 'utf8'),
);

const planOf = (attempt: Attempt): string =>
  JSON.stringify(
    directorPlan({
      turn_kind: attempt.turn as never,
      will_change_image: attempt.will,
      what_to_change: attempt.chg,
      what_to_put: attempt.put,
      reply: attempt.reply,
      refusal: attempt.refusal,
    }),
  );

function simulatedDirector(attempts: Attempt[]): SceneDirectorService {
  let call = 0;
  const run = jest.fn(async () => {
    const attempt = attempts[Math.min(call, attempts.length - 1)];
    call += 1;
    return { ok: true as const, text: planOf(attempt), costUsd: 0, requestId: null, latencyMs: 1 };
  });
  return { run } as unknown as SceneDirectorService;
}

const contextOf = (message: string): DirectorContext => ({
  text: message,
  image: null,
  script: { message } as DirectorContext['script'],
  clientMessages: [message],
  briefItems: [],
});

describe('Regressão do Diretor com os planos reais das tasks 1.42 e 1.43', () => {
  it('tem os 120 desfechos guardados, em 127 chamadas', () => {
    expect(samples).toHaveLength(120);
    expect(samples.reduce((sum, s) => sum + s.tentativas.length, 0)).toBe(127);
  });

  it.each(
    samples.map(
      (sample) => [`${sample.origem} "${sample.frase}" rep ${sample.rep}`, sample] as const,
    ),
  )('%s: o desfecho gravado se repete', async (_title, sample) => {
    const director = simulatedDirector(sample.tentativas);
    const { outcome, calls } = await runDirector(director, {
      context: contextOf(sample.frase),
      correlationId: 'regressao',
    });
    expect(outcome.kind).toBe('plan');
    if (outcome.kind !== 'plan') return;
    expect(outcome.plan.turn_kind).not.toBe('recusa_pintado');
    expect(callsImage(outcome.plan)).toBe(sample.desfecho === 'imagem');
    // Sem `written_content` (D-47) o plano que o campo invalidava passa na 1ª chamada: nunca mais chamadas que o gravado.
    expect(calls.length).toBeLessThanOrEqual(sample.chamadas);
  });
});
