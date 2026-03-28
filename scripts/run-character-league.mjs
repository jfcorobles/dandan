import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalTsc } from './run-local-tsc.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');
const runtimeDir = path.join(repoRoot, '.tmp-character-runtime');
const outputDir = path.join(repoRoot, 'training-output');
const args = process.argv.slice(2);

const getArg = (name, fallback) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
};

const difficulty = getArg('--difficulty', 'hard');
const gamesPerSeat = Math.max(1, Number(getArg('--games-per-seat', 4)));
const maxSteps = Math.max(100, Number(getArg('--max-steps', 5000)));
const outputName = getArg('--output', `character-league-${difficulty}.json`);
const requestedCharacters = getArg('--characters', '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const compileRuntime = () => {
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

compileRuntime();

const engine = await import(new URL(`file:///${path.join(runtimeDir, 'game', 'engine.js').replace(/\\/g, '/')}`));
const {
  AI_CHARACTERS,
  chooseAiAction,
  createGameReducer,
  getAiCharacter,
  getAiPendingActions,
  getAiPolicyForActor,
  initialState,
  initializeDeck
} = engine;

const effects = {
  initAudio() {},
  playDraw() {},
  playLand() {},
  playCast() {},
  playResolve() {},
  playPhase() {}
};

const reducer = createGameReducer(effects);
const selectedCharacters = requestedCharacters.length > 0
  ? AI_CHARACTERS.filter((character) => requestedCharacters.includes(character.id))
  : AI_CHARACTERS;

if (selectedCharacters.length < 2) {
  throw new Error('character league needs at least 2 characters');
}

const stableClone = (value) => structuredClone(value);
const getPendingActor = (state) => state.pendingAction?.player || 'player';
const summarizeState = (state) => ({
  turn: state.turn,
  phase: state.phase,
  priority: state.priority,
  stackResolving: state.stackResolving,
  pendingAction: state.pendingAction?.type || null,
  playerAiCharacterId: state.playerAiCharacterId || null,
  aiCharacterId: state.aiCharacterId || null,
  player: {
    life: state.player.life,
    hand: state.player.hand.map((card) => card.name),
    board: state.player.board.map((card) => card.name)
  },
  ai: {
    life: state.ai.life,
    hand: state.ai.hand.map((card) => card.name),
    board: state.ai.board.map((card) => card.name)
  }
});

const runSingleGame = (playerCharacterId, aiCharacterId, deck) => {
  let state = stableClone(initialState);
  const dispatch = (action) => {
    state = reducer(state, action);
  };

  dispatch({
    type: 'START_GAME',
    mode: 'ai_vs_ai',
    difficulty,
    playerAiCharacterId: playerCharacterId,
    aiCharacterId,
    deck: stableClone(deck)
  });

  let repeatedNoOpCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (state.winner) {
      return {
        ok: true,
        winner: state.winner,
        steps: step,
        margin: Math.abs(state.player.life - state.ai.life) + Math.abs(state.player.board.length - state.ai.board.length) * 0.25
      };
    }

    if (state.pendingTargetSelection) {
      return { ok: false, winner: 'ai', reason: 'unexpected target selection', state: summarizeState(state), margin: 0 };
    }

    if (state.stackResolving && !state.pendingAction) {
      dispatch({ type: 'RESOLVE_TOP_STACK' });
      continue;
    }

    if (state.pendingAction) {
      const before = JSON.stringify(summarizeState(state));
      const actor = getPendingActor(state);
      const policy = getAiPolicyForActor(state, actor, difficulty);
      const actions = getAiPendingActions(state, policy, actor);
      if (actions.length === 0) {
        return { ok: false, winner: actor === 'player' ? 'ai' : 'player', reason: 'pending action loop', state: summarizeState(state), margin: 0 };
      }
      actions.forEach((action) => dispatch(action));
      repeatedNoOpCount = before === JSON.stringify(summarizeState(state)) ? repeatedNoOpCount + 1 : 0;
      if (repeatedNoOpCount >= 18) {
        return { ok: false, winner: actor === 'player' ? 'ai' : 'player', reason: 'pending action stall', state: summarizeState(state), margin: 0 };
      }
      continue;
    }

    if (!state.priority) {
      return { ok: false, winner: 'ai', reason: 'no priority', state: summarizeState(state), margin: 0 };
    }

    const actingPlayer = state.priority;
    const policy = getAiPolicyForActor(state, actingPlayer, difficulty);
    const before = JSON.stringify(summarizeState(state));
    dispatch(chooseAiAction(state, actingPlayer, difficulty, policy));
    repeatedNoOpCount = before === JSON.stringify(summarizeState(state)) ? repeatedNoOpCount + 1 : 0;
    if (repeatedNoOpCount >= 18) {
      return {
        ok: false,
        winner: actingPlayer === 'player' ? 'ai' : 'player',
        reason: 'ai loop',
        state: summarizeState(state),
        margin: 0
      };
    }
  }

  const playerAdvantage = (state.player.life - state.ai.life)
    + (state.player.board.length - state.ai.board.length) * 0.5
    + (state.player.hand.length - state.ai.hand.length) * 0.25;

  return {
    ok: false,
    winner: playerAdvantage >= 0 ? 'player' : 'ai',
    reason: 'step limit',
    margin: Math.abs(playerAdvantage),
    state: summarizeState(state)
  };
};

const createCharacterStanding = (character) => ({
  id: character.id,
  name: character.name,
  title: character.title,
  games: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  failures: 0,
  totalMargin: 0,
  totalSteps: 0,
  playerSeatGames: 0,
  aiSeatGames: 0,
  playerSeatWins: 0,
  aiSeatWins: 0,
  elo: 1500
});

const standings = Object.fromEntries(selectedCharacters.map((character) => [character.id, createCharacterStanding(character)]));
const pairings = [];

const updateElo = (leftId, rightId, leftScore) => {
  const left = standings[leftId];
  const right = standings[rightId];
  const expectedLeft = 1 / (1 + 10 ** ((right.elo - left.elo) / 400));
  const expectedRight = 1 - expectedLeft;
  const rightScore = 1 - leftScore;
  const k = 24;
  left.elo += k * (leftScore - expectedLeft);
  right.elo += k * (rightScore - expectedRight);
};

const recordGame = (playerCharacterId, aiCharacterId, result) => {
  const playerStanding = standings[playerCharacterId];
  const aiStanding = standings[aiCharacterId];
  playerStanding.games += 1;
  aiStanding.games += 1;
  playerStanding.playerSeatGames += 1;
  aiStanding.aiSeatGames += 1;
  playerStanding.totalMargin += result.margin || 0;
  aiStanding.totalMargin += result.margin || 0;
  playerStanding.totalSteps += result.steps || 0;
  aiStanding.totalSteps += result.steps || 0;
  if (!result.ok) {
    playerStanding.failures += 1;
    aiStanding.failures += 1;
  }

  if (result.winner === 'player') {
    playerStanding.wins += 1;
    playerStanding.playerSeatWins += 1;
    aiStanding.losses += 1;
    updateElo(playerCharacterId, aiCharacterId, 1);
    return;
  }

  if (result.winner === 'ai') {
    aiStanding.wins += 1;
    aiStanding.aiSeatWins += 1;
    playerStanding.losses += 1;
    updateElo(playerCharacterId, aiCharacterId, 0);
    return;
  }

  playerStanding.draws += 1;
  aiStanding.draws += 1;
  updateElo(playerCharacterId, aiCharacterId, 0.5);
};

for (let leftIndex = 0; leftIndex < selectedCharacters.length; leftIndex++) {
  for (let rightIndex = leftIndex + 1; rightIndex < selectedCharacters.length; rightIndex++) {
    const leftCharacter = selectedCharacters[leftIndex];
    const rightCharacter = selectedCharacters[rightIndex];
    const pairing = {
      leftId: leftCharacter.id,
      rightId: rightCharacter.id,
      leftName: leftCharacter.name,
      rightName: rightCharacter.name,
      games: 0,
      leftWins: 0,
      rightWins: 0,
      draws: 0,
      failures: 0,
      totalMargin: 0
    };

    for (let gameIndex = 0; gameIndex < gamesPerSeat; gameIndex++) {
      const deck = initializeDeck();
      const leftSeatResult = runSingleGame(leftCharacter.id, rightCharacter.id, deck);
      pairing.games += 1;
      pairing.totalMargin += leftSeatResult.margin || 0;
      if (!leftSeatResult.ok) pairing.failures += 1;
      if (leftSeatResult.winner === 'player') pairing.leftWins += 1;
      else if (leftSeatResult.winner === 'ai') pairing.rightWins += 1;
      else pairing.draws += 1;
      recordGame(leftCharacter.id, rightCharacter.id, leftSeatResult);

      const rightSeatResult = runSingleGame(rightCharacter.id, leftCharacter.id, deck);
      pairing.games += 1;
      pairing.totalMargin += rightSeatResult.margin || 0;
      if (!rightSeatResult.ok) pairing.failures += 1;
      if (rightSeatResult.winner === 'player') pairing.rightWins += 1;
      else if (rightSeatResult.winner === 'ai') pairing.leftWins += 1;
      else pairing.draws += 1;
      recordGame(rightCharacter.id, leftCharacter.id, rightSeatResult);
    }

    pairing.leftWinRate = pairing.leftWins / Math.max(1, pairing.games);
    pairing.rightWinRate = pairing.rightWins / Math.max(1, pairing.games);
    pairings.push(pairing);
  }
}

const leaderboard = Object.values(standings)
  .map((standing) => ({
    ...standing,
    winRate: standing.wins / Math.max(1, standing.games),
    averageMargin: standing.totalMargin / Math.max(1, standing.games),
    averageSteps: standing.totalSteps / Math.max(1, standing.games)
  }))
  .sort((left, right) => right.elo - left.elo || right.winRate - left.winRate || right.averageMargin - left.averageMargin);

const matrix = selectedCharacters.map((rowCharacter) => ({
  id: rowCharacter.id,
  name: rowCharacter.name,
  versus: Object.fromEntries(selectedCharacters.filter((columnCharacter) => columnCharacter.id !== rowCharacter.id).map((columnCharacter) => {
    const pairing = pairings.find((entry) => (
      (entry.leftId === rowCharacter.id && entry.rightId === columnCharacter.id) ||
      (entry.leftId === columnCharacter.id && entry.rightId === rowCharacter.id)
    ));
    if (!pairing) return [columnCharacter.id, null];
    const rowWins = pairing.leftId === rowCharacter.id ? pairing.leftWins : pairing.rightWins;
    return [columnCharacter.id, rowWins / Math.max(1, pairing.games)];
  }))
}));

const report = {
  generatedAt: new Date().toISOString(),
  difficulty,
  gamesPerSeat,
  maxSteps,
  characters: selectedCharacters.map((character) => ({
    id: character.id,
    name: character.name,
    title: character.title,
    tags: character.tags,
    summary: character.summary
  })),
  leaderboard,
  pairings,
  matrix
};

fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, outputName);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
fs.rmSync(runtimeDir, { recursive: true, force: true });

console.log(`character league complete (${difficulty}, ${gamesPerSeat} games per seat)`);
console.log('');
leaderboard.forEach((entry, index) => {
  console.log(
    `${String(index + 1).padStart(2, ' ')}. ${entry.name.padEnd(14)} `
    + `Elo ${entry.elo.toFixed(1).padStart(6)} `
    + `Win ${String((entry.winRate * 100).toFixed(1)).padStart(5)}% `
    + `Margin ${entry.averageMargin.toFixed(2).padStart(6)} `
    + `W-L ${entry.wins}-${entry.losses}`
  );
});
console.log('');
console.log(`saved report to ${outputPath}`);
