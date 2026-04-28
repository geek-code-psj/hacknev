'use strict';

function logger(req, res, next) {
  res.on('finish', () => {
    const latency = Date.now() - (req.startTime || Date.now());
    console.log(JSON.stringify({
      traceId:    req.traceId || null,
      userId:     req.user?.userId || null,
      method:     req.method,
      path:       req.path,
      latency,
      statusCode: res.statusCode,
    }));
  });
  next();
}

module.exports = { logger };
