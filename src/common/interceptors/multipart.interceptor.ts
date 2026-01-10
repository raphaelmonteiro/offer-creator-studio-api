import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';

@Injectable()
export class MultipartInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const contentType = request.headers['content-type'] || '';

    // If this is a multipart request, modify the body to prevent JSON parsing errors
    if (contentType.includes('multipart/form-data')) {
      // The FileInterceptor will handle the parsing
      // We just need to ensure the body is not parsed as JSON
      // This is handled by NestJS automatically when FileInterceptor is used
    }

    return next.handle();
  }
}
