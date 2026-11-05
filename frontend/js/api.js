// Cliente da API (API Gateway atrás do CloudFront em /api/*).
// O ID token vai no header Authorization, sem o prefixo "Bearer",
// que é o formato esperado pelo Cognito Authorizer de REST API.

import { config } from '../config.js';
import { getSession } from './auth.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(method, path, body) {
  const session = getSession();
  if (!session) throw new ApiError(401, 'Sua sessão expirou. Entre novamente.');

  const headers = { Authorization: session.idToken };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${config.apiBasePath}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Falha de rede ao chamar a API.');
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Resposta não JSON (ex.: erro do CloudFront). Tratada abaixo.
  }

  if (!response.ok) {
    if (response.status === 401) throw new ApiError(401, 'Sua sessão expirou. Entre novamente.');
    throw new ApiError(response.status, data?.message || `Erro ${response.status} ao chamar a API.`);
  }
  return data;
}

export const api = {
  createUpload(file) {
    return request('POST', '/uploads', {
      fileName: file.name,
      contentType: file.type,
      size: file.size,
    });
  },

  completeUpload(docId, uploadId, parts) {
    return request('POST', `/uploads/${encodeURIComponent(docId)}/complete`, { uploadId, parts });
  },

  listDocuments(cursor) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return request('GET', `/documents${query}`);
  },

  getDocumentUrl(docId) {
    return request('GET', `/documents/${encodeURIComponent(docId)}`);
  },
};
