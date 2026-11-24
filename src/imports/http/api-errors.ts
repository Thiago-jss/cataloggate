import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ReviewConflict } from '../../catalog/application/catalog-review';
import { RoleNotPermitted } from '../../identity/actor';
import {
  IdempotencyConflict,
  ImportNotFound,
  InconsistentReport,
  ReportNotAvailable,
  SupplierNotFound,
} from '../application/import-errors';

type Failure = { status: number; code: string; message: string };

function bodyParserFailure(error: unknown): Failure | undefined {
  if (!(error instanceof Error) || !('type' in error)) return undefined;
  switch (error.type) {
    case 'entity.too.large':
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The JSON body exceeds 128 KiB' };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return { status: 415, code: 'UNSUPPORTED_ENCODING', message: 'Unsupported JSON encoding' };
    case 'entity.parse.failed':
    case 'request.aborted':
    case 'request.size.invalid':
      return { status: 400, code: 'BAD_REQUEST', message: 'Invalid JSON request body' };
  }
  return undefined;
}

function knownFailure(error: unknown): Failure | undefined {
  const parserFailure = bodyParserFailure(error);
  if (parserFailure) return parserFailure;
  if (error instanceof RoleNotPermitted)
    return { status: 403, code: 'FORBIDDEN', message: 'Role not permitted for this operation' };
  if (error instanceof ReviewConflict)
    return { status: 409, code: error.code, message: 'Catalog review precondition not satisfied' };
  if (error instanceof SupplierNotFound)
    return { status: 404, code: 'SUPPLIER_NOT_FOUND', message: 'Unknown supplier' };
  if (error instanceof ImportNotFound)
    return { status: 404, code: 'IMPORT_NOT_FOUND', message: 'Unknown import' };
  if (error instanceof IdempotencyConflict)
    return {
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Key already used for a different batch',
    };
  if (error instanceof ReportNotAvailable)
    return {
      status: 409,
      code: 'REPORT_NOT_AVAILABLE',
      message: 'The import has no completed report',
    };
  if (error instanceof InconsistentReport)
    return {
      status: 503,
      code: 'REPORT_UNAVAILABLE',
      message: 'Report is temporarily unavailable',
    };
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 401)
      return { status, code: 'UNAUTHORIZED', message: 'Valid bearer credential required' };
    if (status === 400) return { status, code: 'BAD_REQUEST', message: error.message };
    if (status === 413)
      return { status, code: 'PAYLOAD_TOO_LARGE', message: 'The JSON body exceeds 128 KiB' };
    if (status === 404) return { status, code: 'NOT_FOUND', message: 'Route not found' };
    if (status >= 400 && status < 500)
      return { status, code: 'HTTP_ERROR', message: 'Request rejected' };
  }
  return undefined;
}

@Catch()
export class ApiErrors implements ExceptionFilter {
  private readonly logger = new Logger('ApiErrors');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const failure = knownFailure(error);
    if (failure) {
      if (failure.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
      response.status(failure.status).json(failure);
      return;
    }
    this.logger.error({
      event: 'request_failed',
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    const unexpected = { status: 500, code: 'INTERNAL_ERROR', message: 'Unexpected server error' };
    response.status(unexpected.status).json(unexpected);
  }
}
