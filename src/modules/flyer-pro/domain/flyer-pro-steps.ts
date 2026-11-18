/** As oito etapas do fluxo (`frontend/src/utils/flyerProPrototype/steps.ts:5-14`), na ordem da tela. */
export const FLYER_PRO_STEPS = [
  'setup',
  'products',
  'frame',
  'structure',
  'card',
  'assembly',
  'preflight',
  'export',
] as const;

export type FlyerProStep = (typeof FLYER_PRO_STEPS)[number];

/** Chegar a uma destas etapas congela as páginas (`pagesFrozen`); nenhuma etapa as descongela. */
export const FLYER_PRO_FREEZING_STEPS: readonly FlyerProStep[] = [
  'assembly',
  'preflight',
  'export',
];
