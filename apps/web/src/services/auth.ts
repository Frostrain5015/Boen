// 博文 Boen — Frost ID OAuth 2.1 认证
// authorize 是浏览器顶层跳转，走公网 Frost ID；
// token / userinfo / revoke 一律经由 Boen 自己的后端（同源 /api/auth/*）在服务端完成，
// 既避免跨域 CORS，也让 client_secret 只留在服务端（与 PP Typeset 等同生态客户端一致）。

const FROST_ID_BASE = import.meta.env.VITE_FROST_ID_URL ?? 'https://frostrain.tech';
const CLIENT_ID = import.meta.env.VITE_FROST_ID_CLIENT_ID ?? 'boen-client';
const REDIRECT_URI = `${window.location.origin}/auth/callback`;

/** Frost ID 用户信息 */
export interface FrostUser {
  sub: string;
  preferred_username: string;
  username: string;
  email: string;
  email_verified: boolean;
  picture?: string;
}

/** PKCE 参数 */
interface PkceParams {
  codeVerifier: string;
  state: string;
  nonce: string;
}

/** 生成随机字符串 */
function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

/** SHA256 哈希 */
async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

/** Base64URL 编码 */
function base64urlencode(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 生成 PKCE 参数 */
async function generatePkceParams(): Promise<PkceParams> {
  const codeVerifier = generateRandomString(128);
  const state = generateRandomString(32);
  const nonce = generateRandomString(32);
  return { codeVerifier, state, nonce };
}

/** 保存 PKCE 参数到 sessionStorage */
function savePkceParams(params: PkceParams) {
  sessionStorage.setItem('boen_oauth_pkce', JSON.stringify(params));
}

/** 从 sessionStorage 读取 PKCE 参数 */
function loadPkceParams(): PkceParams | null {
  const raw = sessionStorage.getItem('boen_oauth_pkce');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PkceParams;
  } catch {
    return null;
  }
}

/** 清除 PKCE 参数 */
function clearPkceParams() {
  sessionStorage.removeItem('boen_oauth_pkce');
}

/** 保存 access token（sessionStorage：关闭标签页即失效） */
export function saveToken(token: string) {
  sessionStorage.setItem('boen_access_token', token);
}

/** 获取 access token */
export function getToken(): string | null {
  return sessionStorage.getItem('boen_access_token');
}

/** 清除 token */
export function clearToken() {
  sessionStorage.removeItem('boen_access_token');
}

/** 检查是否已登录 */
export function isAuthenticated(): boolean {
  return !!getToken();
}

/** 发起 Frost ID 登录 */
export async function loginWithFrostId() {
  const pkce = await generatePkceParams();
  savePkceParams(pkce);

  const codeChallenge = base64urlencode(await sha256(pkce.codeVerifier));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    state: pkce.state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce: pkce.nonce,
  });

  window.location.href = `${FROST_ID_BASE}/oauth/authorize?${params.toString()}`;
}

/** 处理 OAuth 回调 */
export async function handleOAuthCallback(url: string): Promise<boolean> {
  const parsedUrl = new URL(url);
  const code = parsedUrl.searchParams.get('code');
  const state = parsedUrl.searchParams.get('state');
  const error = parsedUrl.searchParams.get('error');

  if (error) {
    throw new Error(`OAuth error: ${error}`);
  }

  if (!code) {
    return false;
  }

  const pkce = loadPkceParams();
  if (!pkce) {
    throw new Error('PKCE parameters not found');
  }

  if (state !== pkce.state) {
    throw new Error('State mismatch');
  }

  // 交换 token：交给 Boen 后端在服务端完成（携带 client_secret + code_verifier）
  const tokenResponse = await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      codeVerifier: pkce.codeVerifier,
      redirectUri: REDIRECT_URI,
    }),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errorData}`);
  }

  const tokenData = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw new Error('Token exchange failed: no access_token');
  }
  saveToken(tokenData.access_token);
  clearPkceParams();

  return true;
}

/** 获取当前用户信息 */
export async function getCurrentUser(): Promise<FrostUser | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const response = await fetch('/api/auth/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      if (response.status === 401) {
        clearToken();
      }
      return null;
    }

    return (await response.json()) as FrostUser;
  } catch {
    return null;
  }
}

/** 登出 */
export async function logout() {
  const token = getToken();
  if (token) {
    // 尝试撤销 token（经 Boen 后端服务端撤销）
    try {
      await fetch('/api/auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      // 忽略撤销失败
    }
  }
  clearToken();
  window.location.reload();
}
