/** An error whose message is safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
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
