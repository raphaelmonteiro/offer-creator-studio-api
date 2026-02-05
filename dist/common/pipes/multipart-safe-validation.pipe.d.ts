import { PipeTransform, ArgumentMetadata } from '@nestjs/common';
import { ValidationPipeOptions } from '@nestjs/common';
import { Request } from 'express';
export declare class MultipartSafeValidationPipe implements PipeTransform {
    private validationPipe;
    private request;
    constructor(request: Request, options?: ValidationPipeOptions);
    transform(value: any, metadata: ArgumentMetadata): any;
}
