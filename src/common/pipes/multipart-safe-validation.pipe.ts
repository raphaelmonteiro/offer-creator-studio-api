import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  Scope,
  Inject,
} from '@nestjs/common';
import { ValidationPipe, ValidationPipeOptions } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable({ scope: Scope.REQUEST })
export class MultipartSafeValidationPipe implements PipeTransform {
  private validationPipe: ValidationPipe;
  private request: Request;

  constructor(
    @Inject(REQUEST) request: Request,
    options?: ValidationPipeOptions,
  ) {
    this.validationPipe = new ValidationPipe(options);
    this.request = request;
  }

  transform(value: any, metadata: ArgumentMetadata) {
    // Check if this is a multipart/form-data request
    if (this.request?.headers['content-type']?.includes('multipart/form-data')) {
      // Skip validation for multipart requests
      return value;
    }

    // Apply normal validation for other requests
    return this.validationPipe.transform(value, metadata);
  }
}
