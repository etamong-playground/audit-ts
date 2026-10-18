export type AuditActor = {
  id: string;
  type: 'user' | 'service' | 'job' | 'anonymous';
  key_id?: string;
};

export type DurableEvent = {
  schema_version: 1;
  event_id: string;
  operation_id: string;
  service: string;
  environment: string;
  occurred_at: string;
  actor: AuditActor;
  initiator?: AuditActor;
  action: string;
  target_type: string;
  target_id: string;
  result: 'ok' | 'denied' | 'error' | 'pending' | 'unknown';
  ref?: string;
  reason_code?: string;
  changes?: { field: string; before?: string; after?: string }[];
};

const utf8 = new TextEncoder();

const goJSON = (value: unknown): string => JSON.stringify(value)
  .replace(/[<>&]/g, (character) => String.fromCharCode(92) + ({ '<': 'u003c', '>': 'u003e', '&': 'u0026' }[character]))
  .replaceAll(String.fromCharCode(0x2028), String.fromCharCode(92) + 'u2028')
  .replaceAll(String.fromCharCode(0x2029), String.fromCharCode(92) + 'u2029');

const validUnicode = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

const text = (value: unknown, required = true): value is string =>
  typeof value === 'string' && validUnicode(value) && utf8.encode(value).length <= 512 &&
  !value.includes('\0') && (!required || value.trim().length > 0);

const keys = (value: object, allowed: string[], required: string[] = []) => {
  if (!value || typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid audit record');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.includes(key)) throw new Error('Unsupported audit field');
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid audit field');
  }
  if (required.some((key) => !Object.hasOwn(value, key))) throw new Error('Missing audit field');
};

const actor = (value: AuditActor) => {
  if (!value || typeof value !== 'object') throw new Error('Invalid audit actor');
  keys(value, ['id', 'type', 'key_id'], ['id', 'type']);
  if (!text(value.id) || !['user', 'service', 'job', 'anonymous'].includes(value.type) ||
    (value.key_id !== undefined && !text(value.key_id, false)) ||
    (value.type === 'user' && !text(value.key_id))) throw new Error('Invalid audit actor');
};

const validateOccurrence = (occurrence: string): void => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(occurrence) ||
    !Number.isFinite(Date.parse(occurrence))) throw new Error('Invalid audit occurrence');
  const parts = occurrence.slice(0, 19).split(/[-T:]/).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day ||
    hour! > 23 || minute! > 59 || second! > 59) throw new Error('Invalid audit occurrence');
};

export const eventJSON = (event: DurableEvent): string => {
  if (!event || typeof event !== 'object') throw new Error('Invalid audit event');
  keys(event, ['schema_version', 'event_id', 'operation_id', 'service', 'environment', 'occurred_at',
    'actor', 'initiator', 'action', 'target_type', 'target_id', 'result', 'ref', 'reason_code', 'changes'],
    ['schema_version', 'event_id', 'operation_id', 'service', 'environment', 'occurred_at', 'actor', 'action', 'target_type', 'target_id', 'result']);
  if (event.schema_version !== 1) throw new Error('Invalid audit schema');
  validateOccurrence(event.occurred_at);
  for (const field of ['event_id', 'operation_id', 'service', 'environment', 'action', 'target_type', 'target_id'] as const) {
    if (!text(event[field])) throw new Error('Invalid audit identifier');
  }
  actor(event.actor);
  if (event.initiator !== undefined) actor(event.initiator);
  if (!['ok', 'denied', 'error', 'pending', 'unknown'].includes(event.result)) throw new Error('Invalid audit result');
  if ((event.ref !== undefined && !text(event.ref, false)) ||
    (event.reason_code !== undefined && !text(event.reason_code, false))) throw new Error('Invalid audit reference');
  if (event.changes !== undefined) {
    if (!Array.isArray(event.changes) || event.changes.length > 100) throw new Error('Invalid audit changes');
    for (const change of event.changes) {
      if (!change || typeof change !== 'object') throw new Error('Invalid audit change');
      keys(change, ['field', 'before', 'after'], ['field']);
      if (!text(change.field) || [change.before, change.after].some((v) =>
        v !== undefined && (typeof v !== 'string' || !validUnicode(v) || v.includes('\0')))) throw new Error('Invalid audit change');
    }
  }
  const result = goJSON(event);
  if (utf8.encode(result).length > 65536) throw new Error('Audit event exceeds 64 KiB');
  return result;
};

export const eventID = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const actorID = async (key: Uint8Array, issuer: string, subject: string): Promise<string> => {
  if (key.length < 32 || !issuer || !subject) throw new Error('Audit identity requires a dedicated key and principal');
  const signingKey = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', signingKey, utf8.encode(goJSON([issuer, subject])));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const expiresAt = (occurrence: string): string => {
  validateOccurrence(occurrence);
  const date = new Date(occurrence);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid audit occurrence');
  if (date.getUTCMonth() === 1 && date.getUTCDate() === 29) date.setUTCDate(28);
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  const fraction = /\.(\d+)(?:Z|[+-])/.exec(occurrence)?.[1];
  return date.toISOString().replace(/\.\d{3}Z$/, fraction ? `.${fraction}Z` : 'Z');
};

export const expiryMilliseconds = (occurrence: string): number => {
  const expiry = expiresAt(occurrence);
  const remainder = /\.(\d+)(?:Z|[+-])/.exec(expiry)?.[1]?.slice(3) ?? '';
  return Date.parse(expiry) + (/[1-9]/.test(remainder) ? 1 : 0);
};
