import { TurnContext } from './scene-turn-state';

/** Uma operação do turno (`generate`, `local_edit`, `set_layer`...): roda inteira, sem lançar depois de uma chamada paga. */
export interface TurnHandler {
  run(ctx: TurnContext): Promise<void>;
}
