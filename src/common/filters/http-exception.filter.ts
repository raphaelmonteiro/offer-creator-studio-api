import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorResponse: any = {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Erro interno do servidor',
      },
    };

    // Log error details in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('Error details:', exception);
      if (exception instanceof Error) {
        console.error('Error stack:', exception.stack);
      }
    }

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        errorResponse = {
          success: false,
          error: {
            code: this.getErrorCode(status),
            message: exceptionResponse,
          },
        };
      } else if (typeof exceptionResponse === 'object') {
        const exResponse = exceptionResponse as any;
        errorResponse = {
          success: false,
          error: {
            code: exResponse.code || this.getErrorCode(status),
            message: exResponse.message || exResponse.error || 'Erro na requisição',
            details: exResponse.details || exResponse.message,
          },
        };
      }
    } else if (exception instanceof Error) {
      // Handle database errors and other unhandled errors
      const errorMessage = exception.message;
      
      // Check if this is a multipart/form-data JSON parsing error
      if (
        errorMessage.includes("Unexpected token '-', \"------WebK\"") ||
        errorMessage.includes('is not valid JSON') ||
        (errorMessage.includes('Unexpected token') && errorMessage.includes('------WebK'))
      ) {
        // This is likely a multipart request being parsed as JSON
        // The FileInterceptor should handle this, so we'll let it pass through
        // by returning a more helpful error
        errorResponse = {
          success: false,
          error: {
            code: 'MULTIPART_VALIDATION_ERROR',
            message: 'Erro ao processar requisição multipart. Certifique-se de usar multipart/form-data.',
            details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
          },
        };
        status = HttpStatus.BAD_REQUEST;
      } else if (errorMessage.includes('value too long') || errorMessage.includes('exceeds maximum')) {
        errorResponse = {
          success: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'O payload é muito grande. Tente reduzir o tamanho das imagens.',
            details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
          },
        };
        status = HttpStatus.PAYLOAD_TOO_LARGE;
      } else if (errorMessage.includes('invalid input syntax') || errorMessage.includes('JSON')) {
        errorResponse = {
          success: false,
          error: {
            code: 'INVALID_JSON',
            message: 'Erro ao processar JSON. Verifique o formato dos dados.',
            details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
          },
        };
        status = HttpStatus.BAD_REQUEST;
      } else {
        errorResponse = {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Erro interno do servidor',
            details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
          },
        };
      }
    }

    response.status(status).json(errorResponse);
  }

  private getErrorCode(status: number): string {
    const codes: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'VALIDATION_ERROR',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_SERVER_ERROR',
    };
    return codes[status] || 'INTERNAL_SERVER_ERROR';
  }
}
