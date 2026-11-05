// Upload direto para o S3 com URLs assinadas.
// - Arquivo pequeno: um único PUT.
// - Arquivo grande: multipart. Cada parte sobe com sua própria URL assinada,
//   várias em paralelo, e no fim a API fecha o upload no S3.
// O arquivo nunca passa pelo API Gateway nem pela Lambda.

import { config } from '../config.js';
import { api } from './api.js';

class UploadError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'UploadError';
    this.retryable = retryable;
  }
}

// PUT com XMLHttpRequest porque o fetch não informa progresso de envio.
// Resolve com o ETag devolvido pelo S3.
function putWithProgress(url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(body.size);
        resolve(xhr.getResponseHeader('ETag'));
        return;
      }
      const retryable = xhr.status >= 500 || xhr.status === 429;
      reject(new UploadError(`O S3 recusou o envio (HTTP ${xhr.status}).`, { retryable }));
    };
    xhr.onerror = () => reject(new UploadError('Falha de rede ao enviar para o S3.', { retryable: true }));
    xhr.ontimeout = () => reject(new UploadError('Tempo esgotado ao enviar para o S3.', { retryable: true }));
    xhr.send(body);
  });
}

async function withRetry(fn, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function uploadSingle(file, plan, onProgress) {
  await putWithProgress(plan.url, file, file.type, (loaded) => onProgress(loaded / file.size));
}

async function uploadMultipart(file, plan, onProgress) {
  const { docId, uploadId, partSize, parts } = plan;
  const loadedByPart = new Map();
  const reportProgress = () => {
    let total = 0;
    for (const loaded of loadedByPart.values()) total += loaded;
    onProgress(Math.min(total / file.size, 1));
  };

  const completed = [];
  let nextIndex = 0;
  let failed = false;

  async function worker() {
    try {
      await runParts();
    } catch (err) {
      failed = true; // Faz os outros workers pararem de pegar partes novas.
      throw err;
    }
  }

  async function runParts() {
    while (!failed && nextIndex < parts.length) {
      const { partNumber, url } = parts[nextIndex];
      nextIndex += 1;
      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));

      const etag = await withRetry(() => {
        loadedByPart.set(partNumber, 0);
        return putWithProgress(url, blob, null, (loaded) => {
          loadedByPart.set(partNumber, loaded);
          reportProgress();
        });
      }, config.partAttempts);

      if (!etag) {
        throw new UploadError(
          'O S3 não expôs o header ETag. Confira o CORS do bucket (ExposeHeaders: ETag).',
        );
      }
      completed.push({ PartNumber: partNumber, ETag: etag });
    }
  }

  const workers = Math.min(config.uploadConcurrency, parts.length);
  await Promise.all(Array.from({ length: workers }, worker));

  completed.sort((a, b) => a.PartNumber - b.PartNumber);
  await api.completeUpload(docId, uploadId, completed);
}

// onProgress recebe um número entre 0 e 1. Retorna o docId criado.
export async function uploadFile(file, onProgress = () => {}) {
  const plan = await api.createUpload(file);
  if (plan.mode === 'single') {
    await uploadSingle(file, plan, onProgress);
  } else if (plan.mode === 'multipart') {
    await uploadMultipart(file, plan, onProgress);
  } else {
    throw new UploadError('Resposta inesperada da API de upload.');
  }
  onProgress(1);
  return plan.docId;
}
