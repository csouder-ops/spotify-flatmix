import 'dotenv/config';
import { setTimeout as wait } from 'timers/promises';
import { URLSearchParams } from 'url';
import { getDecryptedRefreshToken, updateUserTokens } from './store';
import type { StoredUser } from './store';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? '';

if (!CLIENT_ID || !REDIRECT_URI) {
  throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_REDIRECT_URI must be set.');
}

if (!CLIENT_SECRET) {
  throw new Error('SPOTIFY_CLIENT_SECRET must be set for server-side OAuth.');
}

const SCOPES = [
  'user-read-recently-played',
  'user-top-read',
  'playlist-modify-public',
  'playlist-modify-private',
];

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const MAX_RETRIES = 3;

export class SpotifyTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyTokenError';
  }
}

export class SpotifyApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
  }
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export function getAuthorizationUrl(flatCode: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state: flatCode,
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const params = new URLSearchParams(body);
  const response = await fetch(`${AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new SpotifyApiError(response.status, text);
  }

  return (await response.json()) as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function callSpotify<T>(accessToken: string, url: string, options: RequestInit = {}, attempt = 0): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (response.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get('Retry-After') || '1');
    await wait((retryAfter + 0.5) * 1000);
    return callSpotify<T>(accessToken, url, options, attempt + 1);
  }

  if (response.status === 401) {
    throw new SpotifyTokenError('Access token expired');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new SpotifyApiError(response.status, text);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function ensureAccessToken(user: StoredUser): Promise<string> {
  const now = Date.now();
  if (user.tokenExpiry - TOKEN_REFRESH_BUFFER_MS > now) {
    return user.accessToken;
  }

  const refreshToken = getDecryptedRefreshToken(user);
  const tokens = await refreshAccessToken(refreshToken);
  const newExpiry = Date.now() + tokens.expires_in * 1000;
  updateUserTokens({
    flatCode: user.flatCode,
    userId: user.userId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    tokenExpiry: newExpiry,
  });
  user.accessToken = tokens.access_token;
  user.tokenExpiry = newExpiry;
  return user.accessToken;
}

async function spotifyRequest<T>(user: StoredUser, url: string, options: RequestInit = {}): Promise<T> {
  try {
    const accessToken = await ensureAccessToken(user);
    return await callSpotify<T>(accessToken, url, options);
  } catch (error) {
    if (error instanceof SpotifyTokenError) {
      const refreshToken = getDecryptedRefreshToken(user);
      const tokens = await refreshAccessToken(refreshToken);
      const newExpiry = Date.now() + tokens.expires_in * 1000;
      updateUserTokens({
        flatCode: user.flatCode,
        userId: user.userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        tokenExpiry: newExpiry,
      });
      user.accessToken = tokens.access_token;
      user.tokenExpiry = newExpiry;
      return callSpotify<T>(user.accessToken, url, options);
    }
    throw error;
  }
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  popularity: number;
  explicit: boolean;
  artists: { id: string; name: string }[];
}

export interface SpotifyAudioFeatures {
  id: string;
  danceability: number;
  energy: number;
  valence: number;
  tempo: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  speechiness: number;
}

export async function getUserProfile(user: StoredUser): Promise<{ id: string; display_name: string }>
{
  return spotifyRequest(user, `${API_BASE}/me`);
}

export async function getRecentlyPlayed(user: StoredUser): Promise<{ track: SpotifyTrack; played_at: string }[]> {
  const data = await spotifyRequest<{ items: { track: SpotifyTrack; played_at: string }[] }>(
    user,
    `${API_BASE}/me/player/recently-played?limit=50`
  );
  return data.items;
}

export async function getTopTracks(user: StoredUser, timeRange: 'short_term' | 'medium_term'): Promise<SpotifyTrack[]> {
  const data = await spotifyRequest<{ items: SpotifyTrack[] }>(
    user,
    `${API_BASE}/me/top/tracks?time_range=${timeRange}&limit=50`
  );
  return data.items;
}

export async function getAudioFeatures(user: StoredUser, ids: string[]): Promise<SpotifyAudioFeatures[]> {
  const features: SpotifyAudioFeatures[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await spotifyRequest<{ audio_features: SpotifyAudioFeatures[] }>(
      user,
      `${API_BASE}/audio-features?ids=${chunk.join(',')}`
    );
    features.push(...data.audio_features.filter(Boolean) as SpotifyAudioFeatures[]);
  }
  return features;
}

export async function createPlaylist(
  user: StoredUser,
  ownerId: string,
  name: string,
  description: string,
  isPublic: boolean
): Promise<{ id: string; external_url: string }>
{
  const body = JSON.stringify({
    name,
    description,
    public: isPublic,
  });
  const data = await spotifyRequest<{ id: string; external_urls: { spotify: string } }>(user, `${API_BASE}/users/${ownerId}/playlists`, {
    method: 'POST',
    body,
  });
  return { id: data.id, external_url: data.external_urls.spotify };
}

export async function addTracksToPlaylist(user: StoredUser, playlistId: string, uris: string[]): Promise<void> {
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100);
    await spotifyRequest(user, `${API_BASE}/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ uris: chunk }),
    });
  }
}

export async function getProfileFromAccessToken(accessToken: string): Promise<{ id: string; display_name: string }> {
  const response = await fetch(`${API_BASE}/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 401) {
    throw new SpotifyTokenError('Access token invalid');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new SpotifyApiError(response.status, text);
  }

  return (await response.json()) as { id: string; display_name: string };
}
