import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';

/**
 * A tiny S3-compatible server for tests: path-style PUT, GET and HEAD of
 * objects, in process, on 127.0.0.1 and a free port. It checks the AWS
 * Signature Version 4 of every request (the shape of `Authorization` and
 * `x-amz-date`, and the signature itself against a known secret), and the body
 * of a PUT against `x-amz-content-sha256`, and it can be told to fail in the
 * ways real servers do.
 */

/** The credentials the mock accepts. They are made up. */
export const TEST_ACCESS_KEY_ID = 'TESTACCESSKEYID01';
export const TEST_SECRET_ACCESS_KEY = 'testsecretaccesskeyvalue0123456789ABCDEF';

/**
 * @typedef {object} RecordedRequest
 * @property {string} method
 * @property {string} path
 * @property {http.IncomingHttpHeaders} headers
 * @property {{ accessKeyId: string, date: string, region: string, signedHeaders: string[], signature: string } | null} auth
 * @property {boolean} signatureValid
 * @property {string} problem Why the signature was refused; empty when it is valid.
 * @property {number} bodyLength
 */

/**
 * What a fault does to the next matching request.
 *
 * @typedef {object} Fault
 * @property {number} [status] Answer with this status.
 * @property {Record<string, string>} [headers] Extra headers of the answer.
 * @property {string} [body] The body of the answer.
 * @property {boolean} [reset] Close the connection without an answer.
 * @property {boolean} [hang] Never answer.
 * @property {boolean} [truncate] For a GET: send the headers of the whole object and only half of its body, then close the connection.
 */

/**
 * @param {Buffer | string} data
 * @returns {string}
 */
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/**
 * @param {Buffer | string} key
 * @param {string} data
 * @returns {Buffer}
 */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * Checks the signature of a request.
 *
 * @param {http.IncomingMessage} request
 * @param {string} pathname
 * @param {string} search
 * @returns {{ auth: RecordedRequest['auth'], valid: boolean, problem: string }}
 */
function checkSignature(request, pathname, search) {
  const header = request.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(header);
  if (match === null) return { auth: null, valid: false, problem: 'the Authorization header is missing or not AWS4-HMAC-SHA256 with Credential, SignedHeaders and Signature' };
  const [, accessKeyId, day, region, signed, signature] = match;
  const auth = { accessKeyId, date: day, region, signedHeaders: signed.split(';'), signature };
  const datetime = request.headers['x-amz-date'];
  if (typeof datetime !== 'string' || !/^\d{8}T\d{6}Z$/.test(datetime) || !datetime.startsWith(day)) {
    return { auth, valid: false, problem: 'x-amz-date is missing or malformed' };
  }
  if (accessKeyId !== TEST_ACCESS_KEY_ID) return { auth, valid: false, problem: 'unknown access key id' };
  if (!auth.signedHeaders.includes('host') || !auth.signedHeaders.includes('x-amz-date') || !auth.signedHeaders.includes('x-amz-content-sha256')) {
    return { auth, valid: false, problem: 'host, x-amz-date and x-amz-content-sha256 must be signed' };
  }
  const payloadHash = request.headers['x-amz-content-sha256'];
  if (typeof payloadHash !== 'string') return { auth, valid: false, problem: 'x-amz-content-sha256 is missing' };
  const canonicalHeaders = auth.signedHeaders.map((name) => `${name}:${String(request.headers[name] ?? '').trim()}`).join('\n');
  const canonical = [request.method ?? '', pathname, search.replace(/^\?/, ''), `${canonicalHeaders}\n`, signed, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${TEST_SECRET_ACCESS_KEY}`, day), region), 's3'), 'aws4_request');
  const expected = hmac(key, toSign).toString('hex');
  return expected === signature ? { auth, valid: true, problem: '' } : { auth, valid: false, problem: 'the signature does not match' };
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {string}
 */
const errorXml = (code, message) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

/**
 * Starts the mock.
 *
 * @param {{ bucket?: string }} [options]
 */
export async function startMockS3({ bucket = 'my-media' } = {}) {
  /** @type {Map<string, Buffer>} Objects by their path, `/bucket/prefix/originals/key`. */
  const objects = new Map();
  /** @type {RecordedRequest[]} */
  const requests = [];
  /** @type {{ method: string, fault: Fault }[]} */
  const faults = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mock');
    const method = request.method ?? '';
    /** @type {Buffer[]} */
    const chunks = [];
    try {
      for await (const chunk of request) chunks.push(chunk);
    } catch {
      return; // the client cut the upload off
    }
    const body = Buffer.concat(chunks);
    const checked = checkSignature(request, url.pathname, url.search);
    requests.push({ method, path: url.pathname, headers: request.headers, auth: checked.auth, signatureValid: checked.valid, problem: checked.problem, bodyLength: body.length });

    /**
     * @param {number} status
     * @param {string} [text]
     * @param {Record<string, string>} [headers]
     */
    const reply = (status, text = '', headers = {}) => {
      response.writeHead(status, { 'content-length': Buffer.byteLength(text), ...headers });
      response.end(method === 'HEAD' ? undefined : text);
    };

    const index = faults.findIndex((entry) => entry.method === method);
    if (index !== -1) {
      const { fault } = faults.splice(index, 1)[0];
      if (fault.hang) return;
      if (fault.reset) {
        request.socket.destroy();
        return;
      }
      if (fault.truncate) {
        const object = objects.get(url.pathname) ?? Buffer.alloc(0);
        response.writeHead(200, { 'content-length': object.length });
        response.write(object.subarray(0, Math.floor(object.length / 2)));
        setTimeout(() => request.socket.destroy(), 20);
        return;
      }
      reply(fault.status ?? 500, fault.body ?? errorXml('InternalError', 'injected'), fault.headers ?? {});
      return;
    }

    if (!checked.valid) {
      reply(403, errorXml('SignatureDoesNotMatch', checked.problem));
      return;
    }
    if (!url.pathname.startsWith(`/${bucket}/`)) {
      reply(404, errorXml('NoSuchBucket', 'The specified bucket does not exist'));
      return;
    }
    if (method === 'PUT') {
      if (sha256Hex(body) !== request.headers['x-amz-content-sha256']) {
        reply(400, errorXml('XAmzContentSHA256Mismatch', 'The provided x-amz-content-sha256 header does not match what was computed.'));
        return;
      }
      objects.set(url.pathname, body);
      reply(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      const object = objects.get(url.pathname);
      if (object === undefined) {
        reply(404, errorXml('NoSuchKey', 'The specified key does not exist.'));
        return;
      }
      response.writeHead(200, { 'content-length': object.length, 'content-type': 'application/octet-stream' });
      response.end(method === 'HEAD' ? undefined : object);
      return;
    }
    reply(405, errorXml('MethodNotAllowed', 'only PUT, GET and HEAD'));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    /** The address to configure as the endpoint. */
    url: `http://127.0.0.1:${address.port}`,
    bucket,
    objects,
    requests,
    /**
     * @param {string} key
     * @param {string} [prefix] Folder-like prefix, without slashes at the ends.
     * @returns {string} The path of the object.
     */
    pathOf(key, prefix = '') {
      return `/${bucket}/${prefix === '' ? '' : `${prefix}/`}originals/${key}`;
    },
    /**
     * Makes the next requests with this method fail, one fault per request.
     *
     * @param {string} method
     * @param {...Fault} list
     */
    fail(method, ...list) {
      for (const fault of list) faults.push({ method, fault });
    },
    /** Closes the server and every connection, so that a test process can end. */
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
