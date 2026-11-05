// Login com o Cognito managed login usando Authorization Code + PKCE.
// Não usa client secret (app client público do tipo SPA).
// O ID token fica no sessionStorage e some quando a aba é fechada.
// Não guardamos refresh token: quando o ID token expira (1 h por padrão),
// o usuário entra de novo.

import { config } from '../config.js';

const TOKEN_KEY = 'xyz.idToken';
const VERIFIER_KEY = 'xyz.pkceVerifier';
const STATE_KEY = 'xyz.oauthState';
const CLOCK_SKEW_MS = 60_000;

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64UrlEncode(new Uint8Array(digest));
}

function decodeJwtPayload(token) {
  const part = token.split('.')[1];
  if (!part) throw new Error('Token inválido.');
  const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function login() {
  const verifier = randomString(48);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.cognitoClientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge_method: 'S256',
    code_challenge: await sha256Base64Url(verifier),
  });
  window.location.assign(`${config.cognitoDomain}/oauth2/authorize?${params}`);
}

// Trata o retorno do Cognito (?code=...&state=...). Retorna true se havia um retorno para tratar.
export async function handleRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return false;

  // Limpa a URL antes de qualquer coisa para o code não ficar no histórico.
  window.history.replaceState({}, document.title, url.pathname);

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  if (error) {
    throw new Error(`Falha no login: ${url.searchParams.get('error_description') || error}`);
  }
  if (!expectedState || url.searchParams.get('state') !== expectedState || !verifier) {
    throw new Error('Retorno de login inválido. Tente entrar de novo.');
  }

  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.cognitoClientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`Não foi possível concluir o login (HTTP ${response.status}).`);
  }
  const tokens = await response.json();
  if (!tokens.id_token) throw new Error('O Cognito não devolveu o ID token.');
  sessionStorage.setItem(TOKEN_KEY, tokens.id_token);
  return true;
}

// Retorna { idToken, claims } ou null se não houver sessão válida.
export function getSession() {
  const idToken = sessionStorage.getItem(TOKEN_KEY);
  if (!idToken) return null;
  try {
    const claims = decodeJwtPayload(idToken);
    if (!claims.exp || claims.exp * 1000 - CLOCK_SKEW_MS < Date.now()) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return { idToken, claims };
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function logout() {
  clearSession();
  const params = new URLSearchParams({
    client_id: config.cognitoClientId,
    logout_uri: config.logoutUri,
  });
  window.location.assign(`${config.cognitoDomain}/logout?${params}`);
}
