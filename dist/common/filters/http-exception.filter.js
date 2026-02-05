"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpExceptionFilter = void 0;
const common_1 = require("@nestjs/common");
let HttpExceptionFilter = class HttpExceptionFilter {
    catch(exception, host) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();
        const request = ctx.getRequest();
        let status = common_1.HttpStatus.INTERNAL_SERVER_ERROR;
        let errorResponse = {
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Erro interno do servidor',
            },
        };
        if (process.env.NODE_ENV !== 'production') {
            console.error('Error details:', exception);
            if (exception instanceof Error) {
                console.error('Error stack:', exception.stack);
            }
        }
        if (exception instanceof common_1.HttpException) {
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
            }
            else if (typeof exceptionResponse === 'object') {
                const exResponse = exceptionResponse;
                errorResponse = {
                    success: false,
                    error: {
                        code: exResponse.code || this.getErrorCode(status),
                        message: exResponse.message || exResponse.error || 'Erro na requisição',
                        details: exResponse.details || exResponse.message,
                    },
                };
            }
        }
        else if (exception instanceof Error) {
            const errorMessage = exception.message;
            if (errorMessage.includes("Unexpected token '-', \"------WebK\"") ||
                errorMessage.includes('is not valid JSON') ||
                (errorMessage.includes('Unexpected token') && errorMessage.includes('------WebK'))) {
                errorResponse = {
                    success: false,
                    error: {
                        code: 'MULTIPART_VALIDATION_ERROR',
                        message: 'Erro ao processar requisição multipart. Certifique-se de usar multipart/form-data.',
                        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
                    },
                };
                status = common_1.HttpStatus.BAD_REQUEST;
            }
            else if (errorMessage.includes('value too long') || errorMessage.includes('exceeds maximum')) {
                errorResponse = {
                    success: false,
                    error: {
                        code: 'PAYLOAD_TOO_LARGE',
                        message: 'O payload é muito grande. Tente reduzir o tamanho das imagens.',
                        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
                    },
                };
                status = common_1.HttpStatus.PAYLOAD_TOO_LARGE;
            }
            else if (errorMessage.includes('invalid input syntax') || errorMessage.includes('JSON')) {
                errorResponse = {
                    success: false,
                    error: {
                        code: 'INVALID_JSON',
                        message: 'Erro ao processar JSON. Verifique o formato dos dados.',
                        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
                    },
                };
                status = common_1.HttpStatus.BAD_REQUEST;
            }
            else {
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
    getErrorCode(status) {
        const codes = {
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
};
exports.HttpExceptionFilter = HttpExceptionFilter;
exports.HttpExceptionFilter = HttpExceptionFilter = __decorate([
    (0, common_1.Catch)()
], HttpExceptionFilter);
//# sourceMappingURL=http-exception.filter.js.map