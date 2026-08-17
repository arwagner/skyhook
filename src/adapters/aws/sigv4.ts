/**
 * AWS Signature Version 4, by hand.
 *
 * Skyhook takes no runtime dependencies (plan D1), so there is no AWS SDK here to sign requests.
 * This is a deliberate trade and it is recorded as debt in `spec/backlog.md`: the algorithm is
 * fully specified and small, but it is now code we maintain.
 *
 * It fails closed. A signing bug produces a request AWS rejects, never one that reaches data it
 * should not — the signature covers the method, the path, the query, the signed headers and the
 * payload hash, so any mismatch is a refusal rather than a wider grant.
 */

import { createHash, createHmac } from 'node:crypto';

export interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present when credentials come from an assumed role, which is always, for skyhook. */
  readonly sessionToken?: string | undefined;
}

export interface SignableRequest {
  readonly method: string;
  /** Already URI-encoded, beginning with `/`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly host: string;
}

export const EMPTY_PAYLOAD_HASH = sha256Hex('');

/** Returns the headers to send, including `authorization`. Never mutates its input. */
export function signRequest(
  request: SignableRequest,
  credentials: Credentials,
  now: Date,
): Record<string, string> {
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(request.body);

  const headers: Record<string, string> = {
    ...lowercaseKeys(request.headers),
    host: request.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${collapseWhitespace(headers[name] ?? '')}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalQuery = Object.keys(request.query)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(request.query[key] ?? '')}`)
    .join('&');

  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = hmac(signingKey(credentials, dateStamp, request.region, request.service), stringToSign).toString('hex');

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

function signingKey(
  credentials: Credentials,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${credentials.secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function toAmzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/**
 * The S3-flavoured encoding: every byte outside the unreserved set is percent-encoded, and `/`
 * is left alone in paths. `encodeURIComponent` leaves `!'()*` unescaped, which AWS does not, so
 * those are finished off by hand — a mismatch here is a rejected request, not a wrong one.
 */
export function uriEncode(value: string, keepSlashes = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlashes ? encoded.replace(/%2F/g, '/') : encoded;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function lowercaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
