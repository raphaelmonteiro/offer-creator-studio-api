# Backend Copilot Instructions

Project stack:
Node.js + NestJS + TypeORM + PostgreSQL

Architecture:

- domain modules
- controller
- service
- dto
- entities

Rules:

- keep controllers thin
- business logic in services
- use DTO validation decorators
- use pagination pattern already in project
- preserve response envelope
- preserve auth guards and decorators

Prefer:

- reusable services
- transactions when needed
- clean repository queries
- readable code

Avoid:

- duplicated queries
- fat controllers
- bypassing validation
- breaking route contracts

Use strict TypeScript.

Always inspect existing modules before generating code.
