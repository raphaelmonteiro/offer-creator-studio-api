export class TemplateGenerateResponseDto {
  assistantMessage: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configuration: Record<string, any>;
  imagesGenerated: boolean;
}
