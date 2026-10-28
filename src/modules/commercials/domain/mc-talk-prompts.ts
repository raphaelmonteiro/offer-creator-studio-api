/**
 * Prompt do step `talk` (change video-formatos-personagem, D1/D7): o motor de
 * fala recebe SÓ o tile de fala + áudio + este texto curto. O texto pede pose
 * neutra de frente no início e no fim (reduz o corte entre falas consecutivas
 * na composição), plano médio estático sem câmera, e proíbe texto, placas e
 * legendas. Função pura: mudar o texto = bump de `MC_BUILDER_VERSIONS_V2.talk`
 * (o prompt resolvido também entra no hash do step).
 */
export const TALK_PROMPT_SUFFIX =
  'The character faces the camera and speaks with the mouth moving in sync with the speech. ' +
  'Start and end in a neutral, front-facing resting pose. Static medium shot, no camera motion, ' +
  'no zoom, no pan. Keep the plain solid background unchanged. Keep exactly the same character ' +
  'design, colors and proportions throughout. Absolutely no text anywhere in the frame: no ' +
  'captions, no subtitles, no signs, no banners, no price tags, no logos other than the ' +
  "character's own design.";

/** Modo sem fundo (video-mascote-transparente, D13): a cor-chave vai no prompt; o corpo muda o plano. */
export interface TalkPromptCutout {
  keyColor: string;
  framing: 'busto' | 'corpo';
}

const KEY_COLOR_NAMES: Record<string, string> = { '#00B140': 'green', '#0047BB': 'blue' };

/** Sufixo do modo sem fundo: fundo-chave chapado, plano com a figura inteira (corpo), proibição de texto até na roupa. */
function cutoutSuffix(cutout: TalkPromptCutout): string {
  const colorName = KEY_COLOR_NAMES[cutout.keyColor.toUpperCase()] ?? 'flat';
  let suffix = TALK_PROMPT_SUFFIX.replace(
    'Keep the plain solid background unchanged.',
    `Keep the plain solid ${colorName} background exactly the same flat color in every frame, ` +
      'with no shadow, gradient, vignette, floor, reflection or camera light change on it.',
  ).replace(
    "no logos other than the character's own design.",
    "no logos other than the character's own design, including on the clothing.",
  );
  if (cutout.framing === 'corpo') {
    suffix = suffix.replace(
      'Static medium shot',
      'Static shot that keeps the whole figure in frame',
    );
  }
  return suffix;
}

/** Versão do texto da variante contínua (video-fala-continua, D7); mudar o texto = subir aqui. */
export const MC_TALK_PROMPT_CONTINUOUS_VERSION = 1;

const REST_POSE_SENTENCE = 'Start and end in a neutral, front-facing resting pose.';
const CONTINUOUS_SENTENCE =
  'The character speaks several sentences in one continuous take: keep the same pose, body ' +
  'position and framing from the first to the last frame, with small natural gestures; never ' +
  'reset or change pose between sentences.';

/**
 * Gesto opcional da fala (EN efetivo ou pt) + sufixo fixo; sem gesto, só o sufixo. Sem `cutout`
 * e sem `continuous` o texto é o de sempre, byte a byte (hash de todo `talk` existente intacto).
 * `continuous` (modo de fala contínua, D7) troca a frase da pose neutra no início/fim — que CAUSA o
 * salto entre trechos — pela da tomada contínua, mantendo as proibições de texto e logo.
 */
export function buildTalkPrompt(
  motion?: string | null,
  cutout?: TalkPromptCutout | null,
  opts: { continuous?: boolean } = {},
): string {
  const base = cutout ? cutoutSuffix(cutout) : TALK_PROMPT_SUFFIX;
  const suffix = opts.continuous ? base.replace(REST_POSE_SENTENCE, CONTINUOUS_SENTENCE) : base;
  const action = (motion ?? '').trim().replace(/\s+/g, ' ');
  if (!action) return suffix;
  const withStop = /[.!?]$/.test(action) ? action : `${action}.`;
  return `${withStop} ${suffix}`;
}
