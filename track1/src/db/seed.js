'use strict';
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const pool = require('./pool');

async function seed() {
  const csvPath = path.join(__dirname, '../../data/seed.csv');
  if (!fs.existsSync(csvPath)) {
    console.log(JSON.stringify({ event: 'seed_skip', reason: 'no seed file' }));
    return;
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, cast: true });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    let skipped  = 0;

    // Batch inserts - 50 rows per query for better performance
    const BATCH_SIZE = 50;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const values = [];
      const params = [];

      for (const r of batch) {
        const offset = params.length + 1;
        params.push(
          r.tradeId, r.userId, r.sessionId, r.asset, r.assetClass, r.direction,
          r.entryPrice,
          r.exitPrice === '' || r.exitPrice == null ? null : r.exitPrice,
          r.quantity,
          r.entryAt,
          r.exitAt === '' || r.exitPrice == null ? null : r.exitAt,
          r.status,
          r.outcome === '' ? null : r.outcome,
          r.pnl === '' || r.pnl == null ? null : r.pnl,
          r.planAdherence === '' || r.planAdherence == null ? null : r.planAdherence,
          r.emotionalState === '' ? null : r.emotionalState,
          r.entryRationale === '' ? null : r.entryRationale,
          String(r.revengeFlag).toLowerCase() === 'true'
        );
        values.push(`($${offset},$${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11},$${offset+12},$${offset+13},$${offset+14},$${offset+15},$${offset+16},$${offset+17})`);
      }

      const { rowCount } = await client.query(
        `INSERT INTO trades (
          "tradeId","userId","sessionId",asset,"assetClass",direction,
          "entryPrice","exitPrice",quantity,"entryAt","exitAt",status,
          outcome,pnl,"planAdherence","emotionalState","entryRationale","revengeFlag"
        ) VALUES ${values.join(', ')}
        ON CONFLICT ("tradeId") DO NOTHING`,
        params
      );

      inserted += rowCount;
      skipped += batch.length - rowCount;
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({ event: 'seed_complete', inserted, skipped, total: rows.length }));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed };

if (require.main === module) {
  seed().then(() => process.exit(0)).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
