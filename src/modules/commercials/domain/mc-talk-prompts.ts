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

/** Gesto opcional da fala (EN efetivo ou pt) + sufixo fixo; sem gesto, só o sufixo. */
export function buildTalkPrompt(motion?: string | null): string {
  const action = (motion ?? '').trim().replace(/\s+/g, ' ');
  if (!action) return TALK_PROMPT_SUFFIX;
  const withStop = /[.!?]$/.test(action) ? action : `${action}.`;
  return `${withStop} ${TALK_PROMPT_SUFFIX}`;
}
