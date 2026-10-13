/** An error whose message is safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional machine-readable code, sent as `{error, code}`. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message = 'bad request'): HttpError => new HttpError(400, message);
export const notFound = (message = 'not found'): HttpError => new HttpError(404, message);
export const forbidden = (message = 'forbidden'): HttpError => new HttpError(403, message);
export const unauthorized = (): HttpError => new HttpError(401, 'unauthorized');
export const conflict = (message: string): HttpError => new HttpError(409, message);
export const tooMany = (message = 'too many requests'): HttpError => new HttpError(429, message);
export const upgradeRequired = (): HttpError => new HttpError(402, 'site limit reached', 'upgrade_required');
/** A payment-provider (Stripe) failure; details are logged, never sent to the client. */
export const badGateway = (): HttpError => new HttpError(502, 'payment provider unavailable, try again later');
