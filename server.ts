import 'dotenv/config';
import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { getUsersByFlat, setContributionCount, upsertUser } from './lib/store';
import type { StoredUser } from './lib/store';
import * as spotify from './lib/spotify';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_FLAT_CODE = process.env.FLAT_CODE || 'riasa-apt-12';

app.use(express.json());
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/api/config', (_req, res) => {
  res.json({
    defaultFlatCode: DEFAULT_FLAT_CODE,
    scopes: ['user-read-recently-played', 'user-top-read', 'playlist-modify-public', 'playlist-modify-private'],
  });
});

app.get('/api/flat', (req, res) => {
  const flatCode = (req.query.flat as string) || DEFAULT_FLAT_CODE;
  const users = getUsersByFlat(flatCode);
  res.json({
    flatCode,
    members: users.map((user) => ({
      userId: user.userId,
      displayName: user.displayName,
      lastJoined: user.lastJoined,
      contributionCount: user.contributionCount,
    })),
  });
});

app.get('/login', (req, res) => {
  const flatCode = (req.query.flat as string) || DEFAULT_FLAT_CODE;
  const authUrl = spotify.getAuthorizationUrl(flatCode);
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const flatCode = (req.query.state as string) || DEFAULT_FLAT_CODE;
  if (!code) {
    res.status(400).send('Missing authorization code.');
    return;
  }

  try {
    const tokenData = await spotify.exchangeCode(code);
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    if (!refreshToken) {
      throw new Error('Spotify did not return a refresh token.');
    }
    const profile = await spotify.getProfileFromAccessToken(accessToken);
    const nowIso = new Date().toISOString();
    upsertUser({
      flatCode,
      userId: profile.id,
      displayName: profile.display_name || profile.id,
      accessToken,
      refreshToken,
      tokenExpiry: Date.now() + tokenData.expires_in * 1000,
      lastJoined: nowIso,
    });
    const storedUser = getUsersByFlat(flatCode).find((u) => u.userId === profile.id);
    if (storedUser) {
      await gatherUserListening(storedUser); // refresh contribution count
    }
    res.cookie('flatmix_user', `${flatCode}:${profile.id}`, {
      httpOnly: false,
      sameSite: 'lax',
    });
    res.redirect(`/?flat=${encodeURIComponent(flatCode)}&joined=1`);
  } catch (error) {
    console.error('Callback error', error);
    res.status(500).send('Failed to complete Spotify authentication.');
  }
});

app.get('/build', async (req, res) => {
  const flatCode = (req.query.flat as string) || DEFAULT_FLAT_CODE;
  const cookieValue = req.cookies?.flatmix_user as string | undefined;
  if (!cookieValue) {
    res.status(401).json({ error: 'Join the flat before building a playlist.' });
    return;
  }
  const [cookieFlat, builderUserId] = cookieValue.split(':');
  if (!builderUserId || (cookieFlat && cookieFlat !== flatCode)) {
    res.status(403).json({ error: 'You do not have access to this flat.' });
    return;
  }
  const users = getUsersByFlat(flatCode);
  if (!users.length) {
    res.status(400).json({ error: 'No members have joined this flat yet.' });
    return;
  }
  const builder = users.find((u) => u.userId === builderUserId);
  if (!builder) {
    res.status(401).json({ error: 'Rejoin Flat Mix to refresh your session.' });
    return;
  }

  try {
    const result = await buildFlatPlaylist(flatCode, builder, users);
    res.json(result);
  } catch (error) {
    console.error('Build playlist error', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

interface UserListeningData {
  user: StoredUser;
  recent: { track: spotify.SpotifyTrack; played_at: string }[];
  topShort: spotify.SpotifyTrack[];
  topMedium: spotify.SpotifyTrack[];
  features: Map<string, spotify.SpotifyAudioFeatures>;
  recentWindowIds: Set<string>;
  contributionIds: Set<string>;
  trackDetails: Map<string, spotify.SpotifyTrack>;
}

async function gatherUserListening(user: StoredUser): Promise<UserListeningData> {
  const recent = await spotify.getRecentlyPlayed(user).catch(() => []);
  const topShort = await spotify.getTopTracks(user, 'short_term').catch(() => []);
  const topMedium = await spotify.getTopTracks(user, 'medium_term').catch(() => []);

  const contributionIds = new Set<string>();
  const trackDetails = new Map<string, spotify.SpotifyTrack>();
  const recentWindowIds = new Set<string>();
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

  for (const item of recent) {
    if (!item.track?.id) continue;
    contributionIds.add(item.track.id);
    trackDetails.set(item.track.id, item.track);
    if (new Date(item.played_at).getTime() >= twoWeeksAgo) {
      recentWindowIds.add(item.track.id);
    }
  }

  for (const track of topShort) {
    if (!track?.id) continue;
    contributionIds.add(track.id);
    trackDetails.set(track.id, track);
  }

  for (const track of topMedium) {
    if (!track?.id) continue;
    contributionIds.add(track.id);
    if (!trackDetails.has(track.id)) {
      trackDetails.set(track.id, track);
    }
  }

  const features = contributionIds.size
    ? new Map((await spotify.getAudioFeatures(user, Array.from(contributionIds))).map((f) => [f.id, f]))
    : new Map();

  setContributionCount(user.flatCode, user.userId, contributionIds.size);

  return {
    user,
    recent,
    topShort,
    topMedium,
    features,
    recentWindowIds,
    contributionIds,
    trackDetails,
  };
}

interface CandidateTrack {
  id: string;
  track: spotify.SpotifyTrack;
  listeners: Set<string>;
  features?: spotify.SpotifyAudioFeatures;
  score: number;
}

type FeatureKey = Exclude<keyof spotify.SpotifyAudioFeatures, 'id'>;

interface BuildResult {
  playlistUrl: string;
  trackCount: number;
  warnings: string[];
  debug: {
    centroid: Record<string, number>;
    selectedTrackIds: string[];
  };
}

async function buildFlatPlaylist(flatCode: string, builder: StoredUser, users: StoredUser[]): Promise<BuildResult> {
  const warnings: string[] = [];
  const candidatesMap = new Map<string, CandidateTrack>();
  const featuresMap = new Map<string, spotify.SpotifyAudioFeatures>();
  const userData: UserListeningData[] = [];
  const userRecentMap = new Map<string, Set<string>>();
  const userDisplayMap = new Map<string, string>();

  for (const user of users) {
    try {
      const data = await gatherUserListening(user);
      userData.push(data);
      userRecentMap.set(user.userId, data.recentWindowIds);
      userDisplayMap.set(user.userId, user.displayName);
      for (const [id, track] of data.trackDetails.entries()) {
        const existing = candidatesMap.get(id);
        if (existing) {
          existing.listeners.add(user.userId);
        } else {
          const candidate: CandidateTrack = {
            id,
            track,
            listeners: new Set([user.userId]),
            score: 0,
          };
          const feature = data.features.get(id);
          if (feature) {
            candidate.features = feature;
          }
          candidatesMap.set(id, candidate);
        }
        if (!featuresMap.has(id) && data.features.has(id)) {
          featuresMap.set(id, data.features.get(id)!);
        }
      }
      for (const [id, feature] of data.features.entries()) {
        if (!featuresMap.has(id)) {
          featuresMap.set(id, feature);
        }
      }
    } catch (error) {
      console.warn(`Skipping user ${user.displayName}:`, error);
      warnings.push(`Skipped ${user.displayName} due to Spotify API error.`);
      setContributionCount(user.flatCode, user.userId, 0);
    }
  }

  const activeUsers = userData.map((d) => d.user);
  if (!activeUsers.length) {
    throw new Error('Unable to gather listening data for any members.');
  }

  if (!activeUsers.some((u) => u.userId === builder.userId)) {
    throw new Error('Cannot build playlist because your Spotify session expired. Please rejoin Flat Mix.');
  }

  if (activeUsers.length < 3) {
    warnings.push(`Only ${activeUsers.length} member(s) contributed to this mix.`);
  }

  for (const candidate of candidatesMap.values()) {
    const feature = featuresMap.get(candidate.id);
    if (feature) {
      candidate.features = feature;
    }
  }

  const scoredCandidates = scoreCandidates(Array.from(candidatesMap.values()), activeUsers.length);
  const selection = selectTracks(scoredCandidates, userRecentMap, 50, userDisplayMap);

  const playlistName = `Flat Mix – ${new Date().toISOString().slice(0, 10)} (${flatCode})`;
  const description = 'Auto-built from everyone\'s recent/top listening. Generated by Flat Mix.';
  const playlist = await spotify.createPlaylist(builder, builder.userId, playlistName, description, false);
  const uris = selection.selected.map((c) => c.track.uri).filter(Boolean);
  await spotify.addTracksToPlaylist(builder, playlist.id, uris);

  return {
    playlistUrl: playlist.external_url,
    trackCount: selection.selected.length,
    warnings: [...warnings, ...selection.warnings],
    debug: {
      centroid: selection.centroid,
      selectedTrackIds: selection.selected.map((c) => c.id),
    },
  };
}

function scoreCandidates(candidates: CandidateTrack[], totalUsers: number): CandidateTrack[] {
  const featureKeys: FeatureKey[] = [
    'danceability',
    'energy',
    'valence',
    'tempo',
    'acousticness',
    'instrumentalness',
    'liveness',
    'speechiness',
  ];

  const candidatesWithFeatures = candidates.filter(
    (candidate): candidate is CandidateTrack & { features: spotify.SpotifyAudioFeatures } => Boolean(candidate.features)
  );

  const normalizedFeatures = candidatesWithFeatures.map((candidate) => ({
    id: candidate.id,
    values: featureKeys.map((key) => normalizeFeature(key, candidate.features[key])),
  }));

  const centroidValues = featureKeys.map((_, index) => {
    if (!normalizedFeatures.length) return 0.5;
    let sum = 0;
    for (const item of normalizedFeatures) {
      const value = item.values[index] ?? 0;
      sum += value;
    }
    return sum / normalizedFeatures.length;
  });

  const distanceMap = new Map<string, number>();
  for (const item of normalizedFeatures) {
    let sumSquares = 0;
    for (let idx = 0; idx < featureKeys.length; idx += 1) {
      const centroid = centroidValues[idx] ?? 0;
      const rawValue = item.values[idx];
      const value = rawValue === undefined ? centroid : rawValue;
      const diff = value - centroid;
      sumSquares += diff * diff;
    }
    const distance = Math.sqrt(sumSquares);
    distanceMap.set(item.id, distance);
  }

  let maxDistance = 0;
  for (const value of distanceMap.values()) {
    if (value > maxDistance) {
      maxDistance = value;
    }
  }
  if (maxDistance === 0) {
    maxDistance = 1;
  }

  for (const candidate of candidates) {
    const popularityNorm = candidate.track.popularity / 100;
    const listeners = candidate.listeners.size;
    const listenerFactor = listeners <= 1 ? 0.6 : 0.6 + 0.4 * ((listeners - 1) / Math.max(1, totalUsers - 1));
    const popularityScore = popularityNorm * listenerFactor;
    const distance = distanceMap.get(candidate.id);
    const featureScore = distance !== undefined ? 1 - distance / maxDistance : 0.5;
    candidate.score = 0.5 * popularityScore + 0.5 * featureScore;
  }

  return candidates;
}

function normalizeFeature(key: FeatureKey, value: number): number {
  if (key === 'tempo') {
    return Math.min(value / 200, 1);
  }
  return value;
}

function selectTracks(
  candidates: CandidateTrack[],
  userRecentMap: Map<string, Set<string>>,
  limit: number,
  userDisplayMap: Map<string, string>
): {
  selected: CandidateTrack[];
  warnings: string[];
  centroid: Record<string, number>;
} {
  const warnings: string[] = [];
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selectedIds = new Set<string>();
  const artistCounts = new Map<string, number>();
  const candidateById = new Map(sorted.map((c) => [c.id, c]));

  const tryAdd = (candidate: CandidateTrack): boolean => {
    if (!candidate || selectedIds.has(candidate.id)) {
      return false;
    }
    const canUse = candidate.track.artists.every((artist) => (artistCounts.get(artist.id) || 0) < 2);
    if (!canUse) {
      return false;
    }
    selectedIds.add(candidate.id);
    for (const artist of candidate.track.artists) {
      artistCounts.set(artist.id, (artistCounts.get(artist.id) || 0) + 1);
    }
    return true;
  };

  for (const [userId, recentIds] of userRecentMap.entries()) {
    let added = 0;
    if (recentIds.size === 0) {
      warnings.push(`No recent tracks within two weeks for ${userDisplayMap.get(userId) || userId}.`);
      continue;
    }
    for (const candidate of sorted) {
      if (!recentIds.has(candidate.id)) continue;
      if (tryAdd(candidate)) {
        added += 1;
      }
      if (added >= 2) break;
    }
    if (added < 2) {
      warnings.push(
        `Only ${added} recent track${added === 1 ? '' : 's'} included for ${userDisplayMap.get(userId) || userId}.`
      );
    }
  }

  for (const candidate of sorted) {
    if (selectedIds.size >= limit) break;
    tryAdd(candidate);
  }

  const selectedCandidates = [...selectedIds]
    .map((id) => candidateById.get(id)!)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const topTen = selectedCandidates.slice(0, 10);
  const rest = selectedCandidates.slice(10);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = rest[i];
    const swap = rest[j];
    if (!temp || !swap) {
      continue;
    }
    rest[i] = swap;
    rest[j] = temp;
  }
  const finalSelection = [...topTen, ...rest].slice(0, limit);

  const centroid = computeCentroid(finalSelection);

  return { selected: finalSelection, warnings, centroid };
}

function computeCentroid(candidates: CandidateTrack[]): Record<string, number> {
  const featureKeys: FeatureKey[] = [
    'danceability',
    'energy',
    'valence',
    'tempo',
    'acousticness',
    'instrumentalness',
    'liveness',
    'speechiness',
  ];

  const withFeatures = candidates.filter(
    (candidate): candidate is CandidateTrack & { features: spotify.SpotifyAudioFeatures } => Boolean(candidate.features)
  );

  if (!withFeatures.length) {
    return Object.fromEntries(featureKeys.map((key) => [key, 0]));
  }

  const totals = featureKeys.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {} as Record<FeatureKey, number>);

  for (const candidate of withFeatures) {
    for (const key of featureKeys) {
      totals[key] += candidate.features[key];
    }
  }

  const averages = featureKeys.reduce((acc, key) => {
    acc[key] = totals[key] / withFeatures.length;
    return acc;
  }, {} as Record<FeatureKey, number>);

  return averages as Record<string, number>;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Flat Mix server listening on port ${PORT}`);
  });
}

export default app;
