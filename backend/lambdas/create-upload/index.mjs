// Lambda xyz-create-upload
// Rotas (API Gateway REST, integração Lambda proxy, Cognito Authorizer):
//   POST /api/uploads                     -> gera URL(s) assinada(s) para o navegador enviar direto ao S3
//   POST /api/uploads/{docId}/complete    -> fecha um upload multipart
//
// Isolamento: o userId vem SEMPRE do token (claim sub) validado pelo Cognito Authorizer.
// As URLs são assinadas com credenciais do STS cuja session policy só permite
// gravar em <bucket>/<userId>/*. Mesmo que este código monte uma chave errada,
// o S3 recusa qualquer escrita fora do prefixo do usuário.
//
// Variáveis de ambiente:
//   BUCKET_NAME, ACCESS_ROLE_ARN, KMS_KEY_ARN
//   MAX_UPLOAD_BYTES (opcional, padrão 5 GiB)
//   MULTIPART_THRESHOLD_BYTES (opcional, padrão 100 MiB)

import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

const { BUCKET_NAME, ACCESS_ROLE_ARN, KMS_KEY_ARN, AWS_REGION } = process.env;

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const SINGLE_PUT_MAX_BYTES = 5 * GIB; // limite do S3 para PutObject
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 5 * GIB);
const MULTIPART_THRESHOLD_BYTES = Math.min(
  Number(process.env.MULTIPART_THRESHOLD_BYTES ?? 100 * MIB),
  SINGLE_PUT_MAX_BYTES,
);
const MIN_PART_SIZE = 10 * MIB; // o S3 exige no mínimo 5 MiB por parte (exceto a última)
const MAX_PARTS = 10_000;
// Validade das URLs de envio. Credenciais obtidas por role chaining duram no máximo 1 h,
// e a URL assinada para de funcionar quando as credenciais expiram.
const UPLOAD_URL_TTL_SECONDS = 3600;

const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const USER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const DOC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$/;

const sts = new STSClient({});

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) throw new HttpError(400, 'Corpo da requisição vazio.');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Corpo da requisição não é um JSON válido.');
  }
}

function sanitizeFileName(name) {
  const clean = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(-100); // mantém o final, onde fica a extensão
  return clean || 'documento';
}

// Credenciais temporárias que só enxergam o prefixo do usuário.
async function scopedS3(userId, durationSeconds) {
  const sessionPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'WriteOnlyOwnPrefix',
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:AbortMultipartUpload'],
        Resource: `arn:aws:s3:::${BUCKET_NAME}/${userId}/*`,
      },
      {
        Sid: 'KmsForSseKms',
        Effect: 'Allow',
        Action: ['kms:GenerateDataKey', 'kms:Decrypt'],
        Resource: KMS_KEY_ARN,
      },
    ],
  };

  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: ACCESS_ROLE_ARN,
    RoleSessionName: `upload-${userId}`.slice(0, 64), // aparece no CloudTrail
    Policy: JSON.stringify(sessionPolicy),
    DurationSeconds: durationSeconds,
  }));

  return new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
    },
    // Versões recentes do SDK colocam checksum CRC32 nas URLs assinadas e no
    // CreateMultipartUpload. O navegador não envia esse checksum, então desligamos.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function createUpload(userId, body) {
  const { fileName, contentType, size } = body;

  if (!ALLOWED_TYPES[contentType]) {
    throw new HttpError(400, 'Tipo de arquivo não permitido. Envie PDF, PNG ou JPEG.');
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new HttpError(400, 'Tamanho do arquivo inválido.');
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `Arquivo maior que o limite de ${MAX_UPLOAD_BYTES} bytes.`);
  }

  const docId = `${randomUUID()}-${sanitizeFileName(fileName)}`;
  const key = `${userId}/${docId}`;
  const s3 = await scopedS3(userId, UPLOAD_URL_TTL_SECONDS);

  if (size < MULTIPART_THRESHOLD_BYTES) {
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS },
    );
    console.log(JSON.stringify({ action: 'create-upload', mode: 'single', userId, docId, size }));
    return json(200, { mode: 'single', docId, url });
  }

  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS));
  const partCount = Math.ceil(size / partSize);

  const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  }));

  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1;
      const url = await getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: BUCKET_NAME, Key: key, UploadId, PartNumber: partNumber }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
      return { partNumber, url };
    }),
  );

  console.log(JSON.stringify({ action: 'create-upload', mode: 'multipart', userId, docId, size, partCount }));
  return json(200, { mode: 'multipart', docId, uploadId: UploadId, partSize, parts });
}

function parseParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
    throw new HttpError(400, 'Lista de partes inválida.');
  }
  const parsed = parts.map((part) => ({ PartNumber: part?.PartNumber, ETag: part?.ETag }));
  parsed.forEach((part, index) => {
    const validNumber = Number.isInteger(part.PartNumber) && part.PartNumber >= 1 && part.PartNumber <= MAX_PARTS;
    const validEtag = typeof part.ETag === 'string' && part.ETag.length > 0 && part.ETag.length <= 200;
    const ordered = index === 0 || part.PartNumber > parsed[index - 1].PartNumber;
    if (!validNumber || !validEtag || !ordered) throw new HttpError(400, 'Lista de partes inválida.');
  });
  return parsed;
}

async function completeUpload(userId, docId, body) {
  if (!DOC_ID_PATTERN.test(docId ?? '')) throw new HttpError(400, 'docId inválido.');
  const { uploadId } = body;
  if (typeof uploadId !== 'string' || uploadId.length === 0 || uploadId.length > 1024) {
    throw new HttpError(400, 'uploadId inválido.');
  }
  const parts = parseParts(body.parts);

  const key = `${userId}/${docId}`;
  const s3 = await scopedS3(userId, 900);

  try {
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (err) {
    if (err.name === 'NoSuchUpload') throw new HttpError(404, 'Upload não encontrado ou já concluído.');
    if (['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall'].includes(err.name)) {
      throw new HttpError(400, 'Partes do upload inválidas. Envie o arquivo de novo.');
    }
    throw err;
  }

  console.log(JSON.stringify({ action: 'complete-upload', userId, docId, partCount: parts.length }));
  return json(200, { docId });
}

export const handler = async (event) => {
  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId || !USER_ID_PATTERN.test(userId)) {
    return json(401, { message: 'Usuário não autenticado.' });
  }

  try {
    if (event.httpMethod === 'POST' && event.resource === '/api/uploads') {
      return await createUpload(userId, parseBody(event));
    }
    if (event.httpMethod === 'POST' && event.resource === '/api/uploads/{docId}/complete') {
      return await completeUpload(userId, event.pathParameters?.docId, parseBody(event));
    }
    return json(404, { message: 'Rota não encontrada.' });
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { message: err.message });
    console.error(JSON.stringify({ level: 'error', userId, name: err.name, message: err.message }));
    return json(500, { message: 'Erro interno. Tente novamente.' });
  }
};
