import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { runLocalTsc } from './run-local-tsc.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');
const workerPath = path.join(__dirname, 'selfplay-worker.mjs');
const outputDir = path.join(repoRoot, 'training-output');
const policyModulePath = path.join(repoRoot, 'src', 'trainedPolicy.ts');
const runtimeDir = path.join(repoRoot, '.tmp-training-runtime');
const args = process.argv.slice(2);

const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
};

const hasArg = (name) => args.includes(name);

const hours = Number(getArg('--hours', 0));
const budgetMinutes = Number(getArg('--minutes', hours > 0 ? hours * 60 : 30));
const population = Number(getArg('--population', 10));
const eliteCount = Number(getArg('--elite', 3));
const hallOfFameSize = Number(getArg('--hall-of-fame', 3));
const gamesPerSeat = Number(getArg('--games-per-seat', 10));
const maxSteps = Number(getArg('--max-steps', 5000));
const concurrency = Math.max(1, Number(getArg('--concurrency', Math.max(2, Math.min(os.cpus().length, 6)))));
const outputName = getArg('--output', 'engine-selfplay-report.json');

const DEFAULT_POLICY = {
  aggression: 1.05,
  control: 0.95,
  drawBias: 0.75,
  mistakeRate: 0.025,
  landLimit: 4.7,
  counterBias: 1.05,
  stealBias: 1.0,
  attackBias: 1.08,
  blockBias: 1.0
};

const BASELINES = {
  medium: {
    aggression: 1.0,
    control: 0.55,
    drawBias: 0.5,
    mistakeRate: 0.12,
    landLimit: 4.2,
    counterBias: 0.9,
    stealBias: 0.95,
    attackBias: 0.95,
    blockBias: 0.95
  },
  hard_reference: {
    aggression: 1.15,
    control: 0.85,
    drawBias: 0.65,
    mistakeRate: 0.03,
    landLimit: 4.8,
    counterBias: 1.1,
    stealBias: 1.1,
    attackBias: 1.05,
    blockBias: 1.05
  }
};

const LIMITS = {
  aggression: [0.2, 2.4],
  control: [0.1, 2.4],
  drawBias: [0.1, 2.2],
  mistakeRate: [0, 0.2],
  landLimit: [2.5, 6],
  counterBias: [0.2, 2.5],
  stealBias: [0.2, 2.5],
  attackBias: [0.2, 2.5],
  blockBias: [0.2, 2.5]
};

const metricKeys = Object.keys(DEFAULT_POLICY);

const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));
const normalizePolicy = (policy) => Object.fromEntries(metricKeys.map((key) => [key, clamp(policy[key] ?? DEFAULT_POLICY[key], LIMITS[key])]));
const randomBetween = (min, max) => min + Math.random() * (max - min);

const mutate = (policy, scale = 1) => normalizePolicy({
  aggression: policy.aggression + (Math.random() - 0.5) * 0.35 * scale,
  control: policy.control + (Math.random() - 0.5) * 0.35 * scale,
  drawBias: policy.drawBias + (Math.random() - 0.5) * 0.25 * scale,
  mistakeRate: policy.mistakeRate + (Math.random() - 0.5) * 0.02 * scale,
  landLimit: policy.landLimit + (Math.random() - 0.5) * 0.5 * scale,
  counterBias: policy.counterBias + (Math.random() - 0.5) * 0.35 * scale,
  stealBias: policy.stealBias + (Math.random() - 0.5) * 0.35 * scale,
  attackBias: policy.attackBias + (Math.random() - 0.5) * 0.35 * scale,
  blockBias: policy.blockBias + (Math.random() - 0.5) * 0.35 * scale
});

const crossover = (left, right) => normalizePolicy(Object.fromEntries(metricKeys.map((key) => {
  const alpha = 0.35 + Math.random() * 0.3;
  return [key, left[key] * alpha + right[key] * (1 - alpha)];
})));

const randomPolicy = () => normalizePolicy({
  aggression: randomBetween(...LIMITS.aggression),
  control: randomBetween(...LIMITS.control),
  drawBias: randomBetween(...LIMITS.drawBias),
  mistakeRate: randomBetween(...LIMITS.mistakeRate),
  landLimit: randomBetween(...LIMITS.landLimit),
  counterBias: randomBetween(...LIMITS.counterBias),
  stealBias: randomBetween(...LIMITS.stealBias),
  attackBias: randomBetween(...LIMITS.attackBias),
  blockBias: randomBetween(...LIMITS.blockBias)
});

const samePolicy = (left, right) => metricKeys.every((key) => Math.abs((left[key] ?? 0) - (right[key] ?? 0)) < 1e-9);

const readExistingChampion = () => {
  if (!fs.existsSync(policyModulePath)) return normalizePolicy(DEFAULT_POLICY);
  const raw = fs.readFileSync(policyModulePath, 'utf8');
  const match = raw.match(/export const trainedPolicy = ([\s\S]*);/);
  if (!match) return normalizePolicy(DEFAULT_POLICY);
  const parsed = JSON.parse(match[1]);
  return normalizePolicy({ ...DEFAULT_POLICY, ...(parsed.weights || {}) });
};

const prepareRuntime = () => {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const tscArgs = [
    'src/game/engine.ts',
    'src/trainedPolicy.ts',
    '--outDir', runtimeDir,
    '--module', 'ESNext',
    '--target', 'ES2020',
    '--moduleResolution', 'Node',
    '--skipLibCheck'
  ];

  runLocalTsc(repoRoot, tscArgs);

  fs.writeFileSync(path.join(runtimeDir, 'trainedPolicy'), "export * from './trainedPolicy.js';\n");
};

const runWorker = (candidate, benchmarks) => new Promise((resolve, reject) => {
  const worker = new Worker(workerPath, {
    workerData: {
      runtimeDir,
      candidate,
      benchmarks,
      gamesPerSeat,
      maxSteps
    }
  });

  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) => {
    if (code !== 0) reject(new Error(`Worker exited with ${code}`));
  });
});

const runInPool = async (items, fn, limit) => {
  const results = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
};

const pickParents = (evaluated) => {
  const slice = evaluated.slice(0, Math.max(2, Math.min(5, evaluated.length)));
  return [slice[Math.floor(Math.random() * slice.length)].policy, slice[Math.floor(Math.random() * slice.length)].policy];
};

const buildBenchmarks = (champion, hallOfFame) => {
  const hall = hallOfFame.slice(0, hallOfFameSize).map((entry, index) => ({
    name: `hall_${index + 1}`,
    weights: entry.policy,
    weight: 1.8 - index * 0.2
  }));

  return [
    { name: 'champion', weights: champion, weight: 3 },
    { name: 'hard_reference', weights: BASELINES.hard_reference, weight: 1.4 },
    { name: 'medium_reference', weights: BASELINES.medium, weight: 1.0 },
    ...hall
  ];
};

const writeArtifacts = (report, champion) => {
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, outputName);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(
    policyModulePath,
    `export const trainedPolicy = ${JSON.stringify({
      source: 'engine-genetic-selfplay',
      generatedAt: report.generatedAt,
      budgetMinutes,
      gamesPerSeat,
      generations: report.generations,
      championScore: report.bestScore,
      weights: champion
    }, null, 2)};\n`
  );
  return reportPath;
};

const main = async () => {
  prepareRuntime();
  const startedAt = Date.now();
  const deadline = startedAt + budgetMinutes * 60 * 1000;
  let champion = readExistingChampion();
  let bestScore = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let totalEvaluations = 0;
  const history = [];
  const hallOfFame = [];

  console.log(`starting engine genetic self-play for ${budgetMinutes} minute(s)`);
  console.log(`population=${population} elite=${eliteCount} gamesPerSeat=${gamesPerSeat} concurrency=${concurrency}`);

  while (Date.now() < deadline) {
    generation += 1;
    const progress = (Date.now() - startedAt) / Math.max(1, deadline - startedAt);
    const mutationScale = Math.max(0.25, 1 - progress * 0.65);

    const seeds = [champion];
    while (seeds.length < population) {
      if (seeds.length === 1) {
        seeds.push(mutate(champion, mutationScale));
        continue;
      }

      if (Math.random() < 0.18) {
        seeds.push(randomPolicy());
        continue;
      }

      const hallSeed = hallOfFame.length > 0 && Math.random() < 0.35
        ? hallOfFame[Math.floor(Math.random() * hallOfFame.length)].policy
        : champion;

      seeds.push(mutate(crossover(champion, hallSeed), mutationScale));
    }

    const uniquePopulation = seeds.filter((policy, index) => index === seeds.findIndex((other) => samePolicy(other, policy)));
    const benchmarks = buildBenchmarks(champion, hallOfFame);

    const evaluated = await runInPool(uniquePopulation, async (policy) => {
      const result = await runWorker(policy, benchmarks);
      return {
        policy,
        score: result.aggregate.weightedScore,
        overallWinRate: result.aggregate.overallWinRate,
        failures: result.aggregate.failures,
        benchmarkResults: result.benchmarkResults
      };
    }, concurrency);

    totalEvaluations += evaluated.length;
    evaluated.sort((left, right) => right.score - left.score);
    const winner = evaluated[0];

    if (winner.score > bestScore) {
      bestScore = winner.score;
      champion = winner.policy;
    }

    hallOfFame.unshift({
      generation,
      score: winner.score,
      winRate: winner.overallWinRate,
      policy: winner.policy
    });
    while (hallOfFame.length > hallOfFameSize) hallOfFame.pop();

    history.push({
      generation,
      elapsedMinutes: Number(((Date.now() - startedAt) / 60000).toFixed(2)),
      bestScore: winner.score,
      championScore: bestScore,
      bestWinRate: winner.overallWinRate,
      candidateCount: evaluated.length,
      bestPolicy: winner.policy,
      benchmarks: winner.benchmarkResults,
      topPolicies: evaluated.slice(0, Math.min(eliteCount, evaluated.length)).map((entry) => ({
        score: entry.score,
        overallWinRate: entry.overallWinRate,
        failures: entry.failures,
        policy: entry.policy
      }))
    });

    const report = {
      generatedAt: new Date().toISOString(),
      budgetMinutes,
      gamesPerSeat,
      population,
      eliteCount,
      hallOfFameSize,
      concurrency,
      maxSteps,
      generations: generation,
      totalEvaluations,
      bestScore,
      champion,
      hallOfFame,
      history
    };

    const reportPath = writeArtifacts(report, champion);
    console.log(
      `generation ${generation} | best score ${winner.score.toFixed(2)} | champion ${bestScore.toFixed(2)} | win rate ${(winner.overallWinRate * 100).toFixed(1)}% | checkpoint ${reportPath}`
    );

    if (Date.now() >= deadline) break;

    const elites = evaluated.slice(0, Math.min(eliteCount, evaluated.length)).map((entry) => entry.policy);
    while (elites.length < eliteCount) elites.push(mutate(champion, mutationScale));
    champion = elites[0] || champion;
  }

  const finalReportPath = path.join(outputDir, outputName);
  console.log(`finished training | generations=${generation} evaluations=${totalEvaluations}`);
  console.log(`best policy written to ${policyModulePath}`);
  console.log(`full report written to ${finalReportPath}`);
  console.log('champion weights:', champion);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
