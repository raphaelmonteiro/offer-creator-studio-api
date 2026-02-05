"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConditionalValidationPipe = void 0;
const common_1 = require("@nestjs/common");
const common_2 = require("@nestjs/common");
let ConditionalValidationPipe = class ConditionalValidationPipe {
    constructor(options) {
        this.validationPipe = new common_2.ValidationPipe(options);
    }
    transform(value, metadata) {
        const request = metadata.data;
        if (request && typeof request === 'object' && 'headers' in request) {
            const contentType = request.headers['content-type'];
            if (contentType && contentType.includes('multipart/form-data')) {
                return value;
            }
        }
        try {
            return this.validationPipe.transform(value, metadata);
        }
        catch (error) {
            if (error?.message?.includes('Unexpected token') ||
                error?.message?.includes('is not valid JSON')) {
                return value;
            }
            throw error;
        }
    }
};
exports.ConditionalValidationPipe = ConditionalValidationPipe;
exports.ConditionalValidationPipe = ConditionalValidationPipe = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [Object])
], ConditionalValidationPipe);
//# sourceMappingURL=conditional-validation.pipe.js.map