import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  Type,
} from '@nestjs/common';
import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class ConditionalValidationPipe implements PipeTransform {
  private validationPipe: ValidationPipe;

  constructor(options?: ValidationPipeOptions) {
    this.validationPipe = new ValidationPipe(options);
  }

  transform(value: any, metadata: ArgumentMetadata) {
    // Get the request object from the metadata
    const request = metadata.data as any;
    
    // If we have access to the request, check content-type
    if (request && typeof request === 'object' && 'headers' in request) {
      const contentType = (request as Request).headers['content-type'];
      
      // Skip validation for multipart/form-data
      if (contentType && contentType.includes('multipart/form-data')) {
        return value;
      }
    }

    // For body validation, check if we can access the request through the value
    // This is a workaround since we don't have direct access to the request in the pipe
    // The ValidationPipe will handle the validation, but we need to catch errors for multipart
    
    // Try to use the validation pipe, but catch errors related to JSON parsing
    try {
      return this.validationPipe.transform(value, metadata);
    } catch (error: any) {
      // If error is about JSON parsing and looks like multipart, skip validation
      if (
        error?.message?.includes('Unexpected token') ||
        error?.message?.includes('is not valid JSON')
      ) {
        // This might be a multipart request, return value as-is
        return value;
      }
      throw error;
    }
  }
}
