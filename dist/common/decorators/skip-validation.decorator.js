"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkipValidation = exports.SKIP_VALIDATION_KEY = void 0;
const common_1 = require("@nestjs/common");
exports.SKIP_VALIDATION_KEY = 'skipValidation';
const SkipValidation = () => (0, common_1.SetMetadata)(exports.SKIP_VALIDATION_KEY, true);
exports.SkipValidation = SkipValidation;
//# sourceMappingURL=skip-validation.decorator.js.map