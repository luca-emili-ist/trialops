// Shared JSON Schema validator (Ajv 2020-12) for request bodies and structured protocol content.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { HttpError } from '../errors.ts';

export const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

export function check<T>(validate: ValidateFunction, data: unknown, what: string): T {
  if (!validate(data)) throw new HttpError(422, 'invalid_content', `${what}: ${ajv.errorsText(validate.errors, { dataVar: what })}`);
  return data as T;
}
