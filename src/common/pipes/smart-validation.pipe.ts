import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
} from '@nestjs/common';
import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

@Injectable()
export class SmartValidationPipe extends ValidationPipe {
  constructor(options?: ValidationPipeOptions) {
    super(options);
  }

  transform(value: any, metadata: ArgumentMetadata) {
    // First check: if body is a string that looks like multipart boundary
    if (metadata.type === 'body' && typeof value === 'string') {
      if (value.startsWith('------WebKitFormBoundary') || value.startsWith('------')) {
        // This is multipart data, skip validation
        return value;
      }
    }

    // Skip validation if body looks like multipart (starts with boundary)
    if (metadata.type === 'body' && typeof value === 'string') {
      if (value.startsWith('------WebKitFormBoundary') || value.startsWith('------')) {
        // This is multipart data, skip validation
        return value;
      }
    }

    // Skip validation if body is empty object (might be multipart being processed)
    if (metadata.type === 'body' && value && typeof value === 'object') {
      if (Object.keys(value).length === 0) {
        // Empty body might mean multipart is being processed
        return value;
      }
    }

    // Try to apply validation, but catch JSON parsing errors for multipart requests
    try {
      return super.transform(value, metadata);
    } catch (error: any) {
      // If error is about JSON parsing (likely multipart request), skip validation
      if (
        error?.message?.includes('Unexpected token') ||
        error?.message?.includes('is not valid JSON') ||
        (error?.response?.message?.includes('Unexpected token') &&
          error?.response?.message?.includes('------WebK'))
      ) {
        // This is likely a multipart request, return value as-is
        return value;
      }
      // Re-throw other errors
      throw error;
    }
  }
}
