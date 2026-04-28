'use strict';
const amqp = require('amqplib');

let _channel = null;
let _conn    = null;

const EXCHANGE   = 'nevup.events';
const QUEUE_METRICS  = 'metrics.compute';
const QUEUE_OVERTRADE = 'overtrading.events';

async function connect(retries = 20, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      _conn    = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://nevup:nevup_secret@localhost:5672');
      _channel = await _conn.createChannel();

      await _channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      await _channel.assertQueue(QUEUE_METRICS,   { durable: true });
      await _channel.assertQueue(QUEUE_OVERTRADE, { durable: true });
      // Bind both trade.closed and trade.opened events
      // trade.closed triggers metrics computation
      // trade.opened triggers overtrading detection
      await _channel.bindQueue(QUEUE_METRICS,   EXCHANGE, 'trade.closed');
      await _channel.bindQueue(QUEUE_OVERTRADE, EXCHANGE, 'trade.opened');

      _conn.on('error', () => { _channel = null; _conn = null; });
      console.log(JSON.stringify({ event: 'rabbitmq_connected' }));
      return _channel;
    } catch (err) {
      console.error(JSON.stringify({ event: 'rabbitmq_retry', attempt: i + 1, error: err.message }));
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('Failed to connect to RabbitMQ after retries');
}

function publish(routingKey, payload) {
  if (!_channel) return false;
  try {
    return _channel.publish(
      EXCHANGE, routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' }
    );
  } catch {
    return false;
  }
}

function getChannel() { return _channel; }

function getQueueLag() {
  // Approximation: check if channel is alive
  return _channel ? 0 : -1;
}

module.exports = { connect, publish, getChannel, QUEUE_METRICS, QUEUE_OVERTRADE, EXCHANGE };
