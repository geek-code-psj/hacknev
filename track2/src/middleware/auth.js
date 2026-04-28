'use strict';
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const SECRET = process.env.JWT_SECRET || '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

function authMiddleware(req, res, next) {
  req.traceId   = uuidv4();
  req.startTime = Date.now();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header.', traceId: req.traceId });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    if (!payload.sub || !payload.role) throw new Error('Missing claims');
    req.user = { userId: payload.sub, role: payload.role, name: payload.name };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'JWT has expired.', traceId: req.traceId });
    }
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid JWT.', traceId: req.traceId });
  }
}

function tenancyCheck(req, res, next) {
  const { userId } = req.params;
  if (userId && req.user.userId !== userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId: req.traceId });
  }
  next();
}

module.exports = { authMiddleware, tenancyCheck };
