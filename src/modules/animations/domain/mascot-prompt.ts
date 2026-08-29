/**
 * Construtor de prompt para animar mascote via image-to-video
 * (docs/tdd-animar-mascote-i2v.md §6).
 *
 * É o núcleo da feature. O texto do usuário **nunca vai sozinho** ao modelo: o
 * que separa "o mascote acenou" de "virou outro personagem" é o bloco de
 * preservação de identidade, que é fixo e está sempre presente.
 *
 * A armadilha que este módulo resolve (§7.1): "preserve a identidade" e "remova
 * os objetos das mãos" se contradizem se forem enviadas com o mesmo peso —
 * reconstruir uma mão *é* redesenhar. Por isso o prompt separa explicitamente o
 * que é **inegociável** do que é **exceção autorizada**, e a exceção só aparece
 * quando o usuário pede.
 *
 * Módulo puro: sem Nest, sem I/O, sem provider. Entra a configuração, saem duas
 * strings.
 */

export const MASCOT_PRESETS = [
  'wave',
  'talk',
  'dance',
  'celebrate',
  'walk',
  'idle',
  'custom',
] as const;
export type MascotPreset = (typeof MASCOT_PRESETS)[number];

export const MOTION_INTENSITIES = ['subtle', 'medium', 'strong'] as const;
export type MotionIntensity = (typeof MOTION_INTENSITIES)[number];

/** §7.2: transparência fica fora desta entrega — só original ou cor sólida. */
export const BACKGROUND_MODES = ['original', 'solid'] as const;
export type BackgroundMode = (typeof BACKGROUND_MODES)[number];

export const PRESET_LABELS_PT: Record<MascotPreset, string> = {
  wave: 'Dar tchau',
  talk: 'Falar',
  dance: 'Dançar',
  celebrate: 'Comemorar',
  walk: 'Caminhar',
  idle: 'Piscar e respirar',
  custom: 'Movimento personalizado',
};

export interface MascotPromptOptions {
  preset: MascotPreset;
  /** Texto livre do usuário. Combina com o preset, não o substitui. */
  userPrompt?: string;
  motionIntensity: MotionIntensity;
  durationS: number;
  /** Câmera parada. Default do produto: true. */
  fixedCamera?: boolean;
  /** Exceção autorizada: só quando o usuário pede (§7.1). */
  removeHandheldObjects?: boolean;
  backgroundMode?: BackgroundMode;
  backgroundColor?: string;
}

export interface BuiltMascotPrompt {
  prompt: string;
  negativePrompt: string;
}

interface PresetSpec {
  action: string;
  /** Ajustes que o preset impõe por cima da escolha do usuário. */
  forceFixedCamera?: boolean;
  forceIntensity?: MotionIntensity;
  suggestRemoveHandheldObjects?: boolean;
}

const PRESET_SPECS: Record<MascotPreset, PresetSpec> = {
  wave: {
    action:
      'The mascot raises one free hand and waves it side to side in a natural, friendly motion, ' +
      'smiling and looking towards the camera. The body may sway slightly with the gesture.',
    forceFixedCamera: true,
    suggestRemoveHandheldObjects: true,
  },
  talk: {
    action:
      'The mascot talks to the camera: the mouth opens and closes naturally, the head and eyes ' +
      'move with small expressive shifts, and the hands make discreet accompanying gestures. ' +
      'No speech bubble, no captions, no text of any kind.',
    forceFixedCamera: true,
  },
  dance: {
    action:
      'The mascot dances in place with rhythmic motion of the arms, legs and torso, staying ' +
      'balanced and centred in the frame.',
  },
  celebrate: {
    action:
      'The mascot celebrates: both arms rise, the expression turns joyful and the body lifts ' +
      'slightly with the gesture.',
  },
  walk: {
    action:
      'The mascot walks with a natural stride, legs and arms alternating in a believable gait, ' +
      'staying fully inside the frame.',
  },
  idle: {
    action:
      'The mascot stays still and alive: slow breathing in the shoulders and chest, occasional ' +
      'natural blinking, and almost no other movement.',
    forceIntensity: 'subtle',
    forceFixedCamera: true,
  },
  custom: {
    action: '',
  },
};

const INTENSITY_TEXT: Record<MotionIntensity, string> = {
  subtle: 'subtle and restrained — small amplitude, slow and calm',
  medium: 'moderate and natural — clearly visible but never exaggerated',
  strong: 'energetic and lively, while still physically plausible',
};

/**
 * Bloco IMUTÁVEL. Nenhuma opção do formulário pode removê-lo ou enfraquecê-lo —
 * é a única defesa contra o modelo trocar o personagem.
 */
const PRESERVATION_BLOCK = [
  'Character preservation requirements (highest priority, never override):',
  '- Preserve the exact identity and visual design of the mascot in the reference image.',
  '- Preserve the face, facial features, hairstyle, clothing, colours and body proportions.',
  '- Preserve every logo, symbol, badge and uniform detail exactly as drawn, undistorted and readable.',
  '- Preserve the original illustration style and line work.',
  '- Preserve worn accessories such as caps, hats, bags, backpacks, glasses and shoes.',
  '- The character must stay recognisable as the same character in every single frame.',
  '- Do not redesign, restyle, replace or substitute the character.',
].join('\n');

const OUTPUT_BLOCK = [
  'Output requirements:',
  '- Clean animation with stable character appearance across all frames.',
  '- Temporal consistency: no flickering, no morphing, no popping details.',
  '- Keep the whole character inside the frame; never crop the head, hands or feet.',
  '- No extra characters, no random objects, no text, no captions, no watermark.',
  '- No sudden camera cuts and no abrupt zoom.',
].join('\n');

/**
 * Instrução de remoção de objetos. Só entra quando pedido — e é escrita como
 * **exceção explícita** ao bloco de preservação, para o modelo não interpretar
 * "não redesenhe" e "reconstrua as mãos" como ordens conflitantes.
 */
const REMOVE_PROPS_BLOCK = [
  'Hands and props (authorised exception to the preservation rules above):',
  '- Remove all objects currently held in the hands of the mascot.',
  '- Reconstruct both hands naturally and keep them empty for the entire animation.',
  '- The removed objects must not reappear in any frame.',
  '- This exception applies ONLY to handheld objects and to the hands that held them.',
  '- Worn accessories (cap, hat, bag, backpack, glasses, clothing) must still be preserved.',
].join('\n');

const KEEP_PROPS_BLOCK = [
  'Hands and props:',
  '- Keep every object the mascot is holding, unchanged and in the same hand.',
  '- Keep the hands anatomically correct: five fingers, no extra or missing digits.',
].join('\n');

/** Modos de falha conhecidos de i2v (§6.2). */
const NEGATIVE_TERMS = [
  'different character',
  'character redesign',
  'identity change',
  'face change',
  'different clothing',
  'incorrect colors',
  'distorted logo',
  'unreadable logo',
  'extra fingers',
  'missing fingers',
  'extra arms',
  'extra legs',
  'duplicated limbs',
  'deformed hands',
  'deformed face',
  'flickering',
  'frame inconsistency',
  'morphing',
  'random objects',
  'random text',
  'subtitles',
  'watermark',
  'camera shake',
  'sudden zoom',
  'cropped body',
  'cut off head',
  'low resolution',
  'blur',
  'compression artifacts',
];

const clean = (value?: string): string => (value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Monta o prompt técnico e o negative prompt.
 *
 * Ordem dos blocos importa: ação primária primeiro (é o que o usuário quer),
 * preservação logo em seguida (é o que não pode ser violado), e o resto depois.
 */
export function buildMascotPrompt(options: MascotPromptOptions): BuiltMascotPrompt {
  const spec = PRESET_SPECS[options.preset] ?? PRESET_SPECS.custom;
  const userPrompt = clean(options.userPrompt);

  // preset e texto livre se somam; nenhum dos dois cala o outro
  const action = [spec.action, userPrompt].filter(Boolean).join(' ');
  const intensity = spec.forceIntensity ?? options.motionIntensity;
  const fixedCamera = spec.forceFixedCamera ?? options.fixedCamera ?? true;

  const blocks: string[] = [
    'Animate the mascot from the supplied reference image.',
    '',
    'Primary action:',
    action || 'Keep the mascot alive with a subtle idle motion.',
    '',
    PRESERVATION_BLOCK,
    '',
    [
      'Motion requirements:',
      `- Motion intensity: ${INTENSITY_TEXT[intensity]}.`,
      `- Duration: about ${options.durationS} seconds.`,
      `- Camera: ${
        fixedCamera
          ? 'completely static, locked off, no pan, no zoom, no handheld movement'
          : 'may follow the character gently, without shake or abrupt moves'
      }.`,
      '- Keep body movement physically coherent and anatomically plausible.',
      '- Use smooth transitions and stable temporal consistency between frames.',
    ].join('\n'),
    '',
    options.removeHandheldObjects ? REMOVE_PROPS_BLOCK : KEEP_PROPS_BLOCK,
    '',
    [
      'Background:',
      options.backgroundMode === 'solid'
        ? `- Replace the background with a flat solid ${options.backgroundColor ?? '#FFFFFF'} colour, evenly lit and free of gradients, shadows or texture.`
        : '- Keep the original background of the reference image unchanged.',
    ].join('\n'),
    '',
    OUTPUT_BLOCK,
  ];

  return {
    prompt: blocks.join('\n').trim(),
    negativePrompt: NEGATIVE_TERMS.join(', '),
  };
}

/**
 * O preset apenas SUGERE remover os objetos das mãos; quem decide é o usuário.
 * A UI usa isto para marcar o checkbox por padrão, nunca para forçar.
 */
export function presetSuggestsRemovingProps(preset: MascotPreset): boolean {
  return Boolean(PRESET_SPECS[preset]?.suggestRemoveHandheldObjects);
}

export function isMascotPreset(value: unknown): value is MascotPreset {
  return typeof value === 'string' && (MASCOT_PRESETS as readonly string[]).includes(value);
}
