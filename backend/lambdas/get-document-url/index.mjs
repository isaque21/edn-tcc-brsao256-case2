// Lambda xyz-get-document-url
// Rotas (API Gateway REST, integração Lambda proxy, Cognito Authorizer):
//   GET /api/documents            -> lista os documentos do usuário (paginado por ?cursor=)
//   GET /api/documents/{docId}    -> devolve uma URL assinada de leitura (5 min)
//
// Isolamento: o userId vem SEMPRE do token (claim sub). A chave é montada aqui,
// nunca recebida do cliente, e as credenciais do STS só leem <bucket>/<userId>/*.
//
// Variáveis de ambiente: BUCKET_NAME, ACCESS_ROLE_ARN, KMS_KEY_ARN

import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { BUCKET_NAME, ACCESS_ROLE_ARN, KMS_KEY_ARN, AWS_REGION } = process.env;

const DOWNLOAD_URL_TTL_SECONDS = 300;
const SESSION_DURATION_SECONDS = 900; // mínimo aceito pelo STS
const PAGE_SIZE = 1000;
const ARCHIVE_CLASSES = new Set(['GLACIER', 'DEEP_ARCHIVE']);

const USER_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const DOC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9._-]{1,100}$/;
const UUID_PREFIX_LENGTH = 37; // "<uuid>-"

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

// Credenciais temporárias que só leem o prefixo do usuário.
async function scopedS3(userId) {
  const sessionPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadOnlyOwnPrefix',
        Effect: 'Allow',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${BUCKET_NAME}/${userId}/*`,
      },
      {
        Sid: 'ListOnlyOwnPrefix',
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${BUCKET_NAME}`,
        Condition: { StringLike: { 's3:prefix': `${userId}/*` } },
      },
      {
        Sid: 'KmsDecrypt',
        Effect: 'Allow',
        Action: 'kms:Decrypt',
        Resource: KMS_KEY_ARN,
      },
    ],
  };

  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: ACCESS_ROLE_ARN,
    RoleSessionName: `read-${userId}`.slice(0, 64), // aparece no CloudTrail
    Policy: JSON.stringify(sessionPolicy),
    DurationSeconds: SESSION_DURATION_SECONDS,
  }));

  return new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function listDocuments(userId, cursor) {
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) {
    throw new HttpError(400, 'Cursor inválido.');
  }
  const prefix = `${userId}/`;
  const s3 = await scopedS3(userId);

  const result = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: prefix,
    MaxKeys: PAGE_SIZE,
    ContinuationToken: cursor || undefined,
  }));

  const items = (result.Contents ?? [])
    .map((object) => {
      const docId = object.Key.slice(prefix.length);
      const storageClass = object.StorageClass ?? 'STANDARD';
      return {
        docId,
        fileName: docId.slice(UUID_PREFIX_LENGTH) || docId,
        size: object.Size,
        lastModified: object.LastModified?.toISOString() ?? null,
        storageClass,
        archived: ARCHIVE_CLASSES.has(storageClass),
      };
    })
    .filter((item) => DOC_ID_PATTERN.test(item.docId))
    .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));

  console.log(JSON.stringify({ action: 'list-documents', userId, count: items.length }));
  return json(200, { items, nextCursor: result.IsTruncated ? result.NextContinuationToken : null });
}

async function getDocumentUrl(userId, docId) {
  if (!DOC_ID_PATTERN.test(docId ?? '')) throw new HttpError(400, 'docId inválido.');
  const key = `${userId}/${docId}`;
  const s3 = await scopedS3(userId);

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  } catch (err) {
    // Sem permissão de listar a chave exata, o S3 responde 403 para objeto inexistente.
    const status = err.$metadata?.httpStatusCode;
    if (status === 404 || status === 403) throw new HttpError(404, 'Documento não encontrado.');
    throw err;
  }

  const restored = head.Restore?.includes('ongoing-request="false"');
  if (ARCHIVE_CLASSES.has(head.StorageClass) && !restored) {
    throw new HttpError(409, 'Documento arquivado (mais de 1 ano). Ele precisa ser restaurado antes da leitura.');
  }

  const fileName = docId.slice(UUID_PREFIX_LENGTH);
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: `inline; filename="${fileName}"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );

  console.log(JSON.stringify({ action: 'get-document-url', userId, docId }));
  return json(200, { url, expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

export const handler = async (event) => {
  const userId = event.requestContext?.authorizer?.claims?.sub;
  if (!userId || !USER_ID_PATTERN.test(userId)) {
    return json(401, { message: 'Usuário não autenticado.' });
  }

  try {
    if (event.httpMethod === 'GET' && event.resource === '/api/documents') {
      return await listDocuments(userId, event.queryStringParameters?.cursor);
    }
    if (event.httpMethod === 'GET' && event.resource === '/api/documents/{docId}') {
      return await getDocumentUrl(userId, event.pathParameters?.docId);
    }
    return json(404, { message: 'Rota não encontrada.' });
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { message: err.message });
    console.error(JSON.stringify({ level: 'error', userId, name: err.name, message: err.message }));
    return json(500, { message: 'Erro interno. Tente novamente.' });
  }
};
