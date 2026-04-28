#!/usr/bin/env node
'use strict';
/**
 * NevUp Track 2 — Behavioral Pathology Classification Evaluation Harness
 *
 * Usage: node src/eval/run_eval.js
 *        node src/eval/run_eval.js --output eval_report.json
 *
 * Reads nevup_seed_dataset.json, runs the profiler against each trader,
 * compares detected pathologies to ground-truth labels, and prints a
 * per-class classification report with precision, recall, and F1.
 */
const fs   = require('fs');
const path = require('path');
const { buildProfileFromSeed } = require('../profiler');

const SEED_PATH = path.join(__dirname, '../../data/seed.json');

const ALL_PATHOLOGIES = [
  'revenge_trading', 'overtrading', 'fomo_entries', 'plan_non_adherence',
  'premature_exit', 'loss_running', 'session_tilt', 'time_of_day_bias',
  'position_sizing_inconsistency',
];

function evaluate() {
  const data    = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const traders = data.traders;

  // Per-class tracking
  const metrics = {};
  for (const p of ALL_PATHOLOGIES) {
    metrics[p] = { tp: 0, fp: 0, fn: 0, tn: 0 };
  }

  const traderResults = [];

  for (const trader of traders) {
    const profile    = buildProfileFromSeed(trader.userId);
    const predicted  = new Set((profile?.dominantPathologies || []).map(p => p.pathology));
    const groundTruth = new Set(trader.groundTruthPathologies || []);

    for (const p of ALL_PATHOLOGIES) {
      const isPredicted = predicted.has(p);
      const isTrue      = groundTruth.has(p);

      if (isPredicted && isTrue)   metrics[p].tp++;
      else if (isPredicted && !isTrue) metrics[p].fp++;
      else if (!isPredicted && isTrue) metrics[p].fn++;
      else metrics[p].tn++;
    }

    traderResults.push({
      name:         trader.name,
      userId:       trader.userId,
      groundTruth:  [...groundTruth],
      predicted:    [...predicted],
      correct:      [...predicted].filter(p => groundTruth.has(p)),
      falsePositives: [...predicted].filter(p => !groundTruth.has(p)),
      missed:       [...groundTruth].filter(p => !predicted.has(p)),
    });
  }

  // Compute per-class P/R/F1
  const classReport = {};
  let macroP = 0, macroR = 0, macroF1 = 0, count = 0;

  for (const p of ALL_PATHOLOGIES) {
    const { tp, fp, fn } = metrics[p];
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall    = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1        = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    classReport[p] = { precision: round(precision), recall: round(recall), f1: round(f1), tp, fp, fn };
    macroP  += precision; macroR += recall; macroF1 += f1; count++;
  }

  const macroAvg = {
    precision: round(macroP / count),
    recall:    round(macroR / count),
    f1:        round(macroF1 / count),
  };

  // Overall accuracy
  const allTP = Object.values(metrics).reduce((s, m) => s + m.tp, 0);
  const allFP = Object.values(metrics).reduce((s, m) => s + m.fp, 0);
  const allFN = Object.values(metrics).reduce((s, m) => s + m.fn, 0);
  const allTN = Object.values(metrics).reduce((s, m) => s + m.tn, 0);
  const accuracy = (allTP + allTN) / (allTP + allFP + allFN + allTN);

  const report = {
    meta: {
      runAt:       new Date().toISOString(),
      traderCount: traders.length,
      pathologies: ALL_PATHOLOGIES.length,
      accuracy:    round(accuracy),
    },
    macroAverage: macroAvg,
    perClass:     classReport,
    perTrader:    traderResults,
  };

  // Print human-readable report
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' NevUp Track 2 — Behavioral Classification Eval Report');
  console.log('══════════════════════════════════════════════════════');
  console.log(`\nTraders: ${traders.length} | Overall Accuracy: ${(accuracy*100).toFixed(1)}%`);
  console.log(`\nMacro Average: Precision=${macroAvg.precision} Recall=${macroAvg.recall} F1=${macroAvg.f1}\n`);
  console.log('Per-Pathology Results:');
  console.log('─'.repeat(72));
  console.log(pad('Pathology', 36) + pad('Precision', 12) + pad('Recall', 10) + pad('F1', 8) + 'TP/FP/FN');
  console.log('─'.repeat(72));
  for (const [p, m] of Object.entries(classReport)) {
    console.log(pad(p, 36) + pad(m.precision, 12) + pad(m.recall, 10) + pad(m.f1, 8) + `${m.tp}/${m.fp}/${m.fn}`);
  }
  console.log('─'.repeat(72));
  console.log('\nPer-Trader Results:');
  for (const t of traderResults) {
    const status = t.missed.length === 0 && t.falsePositives.length === 0 ? '✓' : '✗';
    console.log(`  ${status} ${t.name.padEnd(16)} GT: [${t.groundTruth.join(', ')||'none'}] | Pred: [${t.predicted.join(', ')||'none'}]`);
    if (t.falsePositives.length > 0) console.log(`      FP: ${t.falsePositives.join(', ')}`);
    if (t.missed.length > 0)         console.log(`      FN: ${t.missed.join(', ')}`);
  }
  console.log('\n');

  // Optionally write JSON report
  const outputArg = process.argv.find(a => a.startsWith('--output=') || a === '--output');
  let outputPath  = null;
  if (outputArg === '--output') {
    outputPath = process.argv[process.argv.indexOf('--output') + 1];
  } else if (outputArg?.startsWith('--output=')) {
    outputPath = outputArg.slice(9);
  }

  if (!outputPath) outputPath = path.join(__dirname, '../../data/eval_report.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`Report written to: ${outputPath}\n`);

  return report;
}

function round(n) { return Math.round(n * 1000) / 1000; }
function pad(s, w) { return String(s).padEnd(w); }

evaluate();
