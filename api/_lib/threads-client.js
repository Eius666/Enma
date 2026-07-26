'use strict';

// Threads API client (Meta Graph API v1.0 for Threads).
// Docs: https://developers.facebook.com/docs/threads/posts
//
// Required env vars:
//   THREADS_ACCESS_TOKEN — long-lived user access token
//   THREADS_USER_ID      — numeric Threads user ID (from /me endpoint)
//
// Rate limits: 25 posts per 24h (Meta enforced).
// Publishing flow: create container → wait 3 s → publish container.

const THREADS_API      = 'https://graph.threads.net/v1.0';
const MAX_POSTS_PER_DAY = 25;
const PUBLISH_DELAY_MS  = 3_000;

function isConfigured() {
  return !!(process.env.THREADS_ACCESS_TOKEN && process.env.THREADS_USER_ID);
}

async function apiCall(path, method = 'GET', params = {}) {
  const token  = process.env.THREADS_ACCESS_TOKEN;
  const url    = new URL(`${THREADS_API}${path}`);

  if (method === 'GET') {
    url.searchParams.set('access_token', token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (data.error) throw new Error(`Threads API: ${data.error.message} (code ${data.error.code})`);
    return data;
  }

  // POST
  url.searchParams.set('access_token', token);
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Threads API: ${data.error.message} (code ${data.error.code})`);
  return data;
}

async function getRemainingQuota() {
  const userId = process.env.THREADS_USER_ID;
  const data   = await apiCall(`/${userId}/threads_publishing_limit`, 'GET', {
    fields: 'config,quota_usage',
  });
  const quota = data.data?.[0];
  if (!quota) return { remaining: MAX_POSTS_PER_DAY, used: 0 };
  const used = quota.quota_usage || 0;
  return {
    remaining: MAX_POSTS_PER_DAY - used,
    used,
    limit: MAX_POSTS_PER_DAY,
  };
}

async function createMediaContainer(text, imageUrl = null) {
  const userId = process.env.THREADS_USER_ID;
  const params = {
    media_type: imageUrl ? 'IMAGE' : 'TEXT',
    text,
  };
  if (imageUrl) params.image_url = imageUrl;

  const data = await apiCall(`/${userId}/threads`, 'POST', params);
  if (!data.id) throw new Error('Threads: createMediaContainer returned no id');
  return data.id;
}

async function publishMediaContainer(containerId) {
  const userId = process.env.THREADS_USER_ID;
  const data   = await apiCall(`/${userId}/threads_publish`, 'POST', {
    creation_id: containerId,
  });
  if (!data.id) throw new Error('Threads: publishMediaContainer returned no id');
  return data.id;
}

async function publish(text, imageUrl = null) {
  if (!isConfigured()) throw new Error('Threads not configured (missing env vars)');

  const quota = await getRemainingQuota();
  if (quota.remaining <= 0) {
    throw new Error(`Threads daily limit reached (${MAX_POSTS_PER_DAY}/day, used: ${quota.used})`);
  }

  const containerId = await createMediaContainer(text, imageUrl);

  // Meta requires a short delay between container creation and publishing
  await new Promise(r => setTimeout(r, PUBLISH_DELAY_MS));

  return publishMediaContainer(containerId);
}

module.exports = {
  isConfigured,
  publish,
  getRemainingQuota,
  createMediaContainer,
  publishMediaContainer,
};
