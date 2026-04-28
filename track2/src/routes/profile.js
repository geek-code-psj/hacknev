'use strict';
const express = require('express');
const { validate: isUUID } = require('uuid');
const { buildProfileFromSeed } = require('../profiler');
const store = require('../memory/store');
const { tenancyCheck } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

/**
 * GET /users/:userId/profile
 * Returns behavioral profile — generated from seed data + stored memory.
 */
router.get('/', tenancyCheck, (req, res) => {
  const { traceId } = req;
  const { userId }  = req.params;

  if (!isUUID(userId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid userId', traceId });
  }

  // Try stored profile first (may have been enriched by coaching sessions)
  let profile = store.getProfile(userId);
  if (!profile) {
    profile = buildProfileFromSeed(userId);
    if (!profile) {
      return res.status(404).json({ error: 'PROFILE_NOT_FOUND', message: 'No profile found for this user.', traceId });
    }
    store.putProfile(userId, profile);
  }

  return res.json(profile);
});

/**
 * POST /users/:userId/profile — trigger profile generation/refresh
 */
router.post('/', tenancyCheck, (req, res) => {
  const { userId } = req.params;
  const profile = buildProfileFromSeed(userId);
  if (!profile) {
    return res.status(404).json({ error: 'PROFILE_NOT_FOUND', message: 'User not found in seed data.', traceId: req.traceId });
  }
  store.putProfile(userId, profile);
  return res.json(profile);
});

module.exports = router;
