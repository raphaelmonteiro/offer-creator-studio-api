module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // Descartes intencionais são idiomáticos no projeto: `const { password, ...rest }`
    // para tirar a senha da resposta e `_` para posições ignoradas.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
  overrides: [
    // Boundary de módulos (plano-comerciais §11): animations e commercials
    // NUNCA se importam diretamente — a infraestrutura comum vive em
    // src/shared/. A pasta commercials ainda não existe; a regra já fica
    // pronta para quando o módulo nascer.
    {
      files: ['src/modules/commercials/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/modules/animations/**', '**/animations/**', '**/animations'],
                message:
                  'commercials não importa de modules/animations — infraestrutura comum vive em src/shared/ (plano-comerciais §11).',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/modules/animations/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/modules/commercials/**', '**/commercials/**', '**/commercials'],
                message:
                  'animations não importa de modules/commercials — infraestrutura comum vive em src/shared/ (plano-comerciais §11).',
              },
            ],
          },
        ],
      },
    },
  ],
};
