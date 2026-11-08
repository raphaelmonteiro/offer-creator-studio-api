import {
  compositionQuestion,
  contradictionQuestion,
  NO_INSTRUCTION_REPLY,
  EXACT_TEXT_QUESTION,
  NUMBER_QUESTION,
  droppedNote,
} from '../scene-texts';
import { BriefChanges } from '../domain/scene-brief';
import { TemplateScene } from '../entities/template-scene.entity';
import { DirectorOutcome } from './scene-director-run';

/** Texto fixo ao cliente de cada desfecho que termina em pergunta, sem imagem; `null` nos demais. */
export function questionReply(outcome: DirectorOutcome): string | null {
  switch (outcome.kind) {
    case 'composition_question':
      return compositionQuestion(outcome.labels);
    case 'contradiction_question':
      return contradictionQuestion(outcome.lines[0], outcome.lines[1]);
    case 'exact_text_question':
      return EXACT_TEXT_QUESTION;
    case 'number_question':
      return NUMBER_QUESTION;
    case 'instruction_question':
      return NO_INSTRUCTION_REPLY;
    default:
      return null;
  }
}

/** "Tirei da lista: X.": o que o turno desistiu, para o pedido não sumir em silêncio (G9). */
export function droppedNoteOf(scene: TemplateScene, changes: BriefChanges | undefined): string {
  const texts = (changes?.dropped ?? [])
    .map((id) => (scene.brief ?? []).find((item) => item.id === id)?.text)
    .filter((text): text is string => Boolean(text));
  return texts.length ? droppedNote(texts) : '';
}
