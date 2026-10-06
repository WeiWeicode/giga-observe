/**
 * API Key 產生、驗證與快取（DB_SCHEMA §2.10）
 * 明文只在建立時回傳一次，資料庫只存 SHA-256 雜湊
 */
const crypto = require('crypto');
const mongo = require('../config/mongo');
const redis = require('../config/redis');
const env = require('../config/env');

const CACHE_TTL_SEC = 600; // 10 分鐘

function hashKey(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

/**
 * 產生一組 Key：gno_{projectId}_{serviceId}_{32位亂數}
 */
function generateKey(projectId, serviceId) {
  const random = crypto.randomBytes(16).toString('hex');
  const svc = serviceId || 'global';
  return `gno_${projectId}_${svc}_${random}`;
}

async function createKey({ projectId, serviceId, scopes, label, createdBy }) {
  const plain = generateKey(projectId, serviceId);
  const doc = {
    keyHash: hashKey(plain),
    keyPrefix: plain.slice(0, 12),
    projectId,
    serviceId: serviceId || null,
    scopes,
    label: label || '',
    enabled: true,
    lastUsedAt: null,
    createdAt: new Date(),
    createdBy: createdBy || 'system',
  };
  const result = await mongo.col('api_keys').insertOne(doc);
  return { id: result.insertedId, key: plain, keyPrefix: doc.keyPrefix };
}

/**
 * 驗證 Key，先查 Redis 快取再回落 Mongo
 * @returns {null|{projectId, serviceId, scopes, keyId}}
 */
async function verifyKey(plain) {
  if (!plain) return null;
  const hash = hashKey(plain);

  // 1. Redis 快取
  if (redis.isConnected()) {
    try {
      const cached = await redis.getClient().get(redis.keys.apiKey(hash));
      if (cached) {
        const parsed = JSON.parse(cached);
        return parsed.enabled ? parsed : null;
      }
    } catch (err) {
      // 快取失效不影響驗證，往下走 Mongo
    }
  }

  // 2. Mongo
  if (!mongo.isConnected()) return null;
  const doc = await mongo.col('api_keys').findOne({ keyHash: hash });
  if (!doc || !doc.enabled) return null;

  const auth = {
    keyId: String(doc._id),
    projectId: doc.projectId,
    serviceId: doc.serviceId,
    scopes: doc.scopes,
    enabled: true,
  };

  if (redis.isConnected()) {
    redis.getClient()
      .setex(redis.keys.apiKey(hash), CACHE_TTL_SEC, JSON.stringify(auth))
      .catch(() => {});
  }

  // lastUsedAt 非同步更新，不擋驗證
  mongo.col('api_keys')
    .updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
    .catch(() => {});

  return auth;
}

/**
 * 停用 / 啟用，必須同步清除 Redis 快取（AGENT.md §9.9）
 */
async function setEnabled(keyId, enabled) {
  const { ObjectId } = require('mongodb');
  const doc = await mongo.col('api_keys').findOne({ _id: new ObjectId(keyId) });
  if (!doc) return null;

  await mongo.col('api_keys').updateOne(
    { _id: doc._id },
    { $set: { enabled } }
  );

  await invalidateCache(doc.keyHash);
  return { ...doc, enabled };
}

async function invalidateCache(keyHash) {
  if (!redis.isConnected()) return;
  try {
    await redis.getClient().del(redis.keys.apiKey(keyHash));
  } catch (err) {
    console.warn('[apiKey] 清除快取失敗：', err.message);
  }
}

async function deleteKey(keyId) {
  const { ObjectId } = require('mongodb');
  const doc = await mongo.col('api_keys').findOne({ _id: new ObjectId(keyId) });
  if (!doc) return false;
  await mongo.col('api_keys').deleteOne({ _id: doc._id });
  await invalidateCache(doc.keyHash);
  return true;
}

/**
 * 列出 Key —— 不回明文也不回雜湊
 */
async function listKeys(projectId) {
  const filter = projectId ? { projectId } : {};
  const docs = await mongo.col('api_keys')
    .find(filter)
    .project({ keyHash: 0 })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map((d) => ({
    id: String(d._id),
    keyPrefix: d.keyPrefix,
    projectId: d.projectId,
    serviceId: d.serviceId,
    scopes: d.scopes,
    label: d.label,
    enabled: d.enabled,
    lastUsedAt: d.lastUsedAt,
    createdAt: d.createdAt,
  }));
}

module.exports = {
  hashKey, generateKey, createKey, verifyKey,
  setEnabled, deleteKey, listKeys, invalidateCache,
  CACHE_TTL_SEC,
};
