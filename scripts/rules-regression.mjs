import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');
const runtimeDir = path.join(repoRoot, '.tmp-rules-runtime');

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

  if (process.platform === 'win32') {
    const tscCmd = path.join(repoRoot, 'node_modules', '.bin', 'tsc.cmd');
    execFileSync('cmd.exe', ['/c', tscCmd, ...tscArgs], { cwd: repoRoot, stdio: 'inherit' });
  } else {
    const tscCmd = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
    execFileSync(tscCmd, tscArgs, { cwd: repoRoot, stdio: 'inherit' });
  }

  fs.writeFileSync(path.join(runtimeDir, 'trainedPolicy'), "export * from './trainedPolicy.js';\n");
};

compileRuntime();

const engine = await import(new URL(`file:///${path.join(runtimeDir, 'game', 'engine.js').replace(/\\/g, '/')}`));
const {
  CARDS,
  DANDAN_NAME,
  checkHasActions,
  createGameReducer,
  initialState,
  isActivatable
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

const getBlueSources = (card) => {
  if (!card.isLand) return 0;
  if (card.name === 'Haunted Fengraf') return 0;
  if (['The Surgical Bay', 'Svyelunite Temple', 'Lonely Sandbar', 'Remote Isle'].includes(card.name)) return 1;
  return card.type.includes('Island') ? 1 : 0;
};

const getBlueRequirement = (manaCost) => (manaCost.match(/\{U\}/g) || []).length;

const makeCard = (template, overrides = {}) => ({
  ...template,
  id: overrides.id || `${template.name}-${Math.random().toString(36).slice(2, 10)}`,
  tapped: false,
  summoningSickness: template.isLand ? false : true,
  attacking: false,
  blocking: false,
  isSwamp: false,
  owner: null,
  landType: template.type.includes('Island') ? 'Island' : null,
  blueSources: getBlueSources(template),
  blueRequirement: getBlueRequirement(template.manaCost),
  dandanLandType: 'Island',
  enchantedId: null,
  controlledByAuraId: null,
  ...overrides
});

const makeState = (overrides = {}) => ({
  ...structuredClone(initialState),
  started: true,
  phase: 'main1',
  turn: 'player',
  priority: 'player',
  stack: [],
  graveyard: [],
  log: [],
  deck: [],
  pendingAction: null,
  pendingTargetSelection: null,
  stackResolving: false,
  player: { life: 20, hand: [], board: [], landsPlayed: 0 },
  ai: { life: 20, hand: [], board: [], landsPlayed: 0 },
  ...overrides
});

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('mulligan stops at seven', () => {
  let state = reducer(initialState, { type: 'START_GAME', mode: 'player', difficulty: 'medium' });
  for (let i = 0; i < 8; i++) state = reducer(state, { type: 'MULLIGAN' });
  expect(state.mulliganCount === 7, `expected mulliganCount 7, got ${state.mulliganCount}`);
  const handSnapshot = state.player.hand.map((card) => card.id).join(',');
  const afterExtra = reducer(state, { type: 'MULLIGAN' });
  expect(afterExtra.mulliganCount === 7, 'mulligan count advanced past seven');
  expect(afterExtra.player.hand.map((card) => card.id).join(',') === handSnapshot, 'extra mulligan changed hand after the cap');
});

test('Haunted Fengraf sacrifices itself and can return Dandan', () => {
  const fengraf = makeCard(CARDS.FENGRAF, { id: 'fengraf-1' });
  const islandA = makeCard(CARDS.ISLAND_1, { id: 'island-a' });
  const islandB = makeCard(CARDS.ISLAND_2, { id: 'island-b' });
  const islandC = makeCard(CARDS.ISLAND_3, { id: 'island-c' });
  const graveDandan = makeCard(CARDS.DANDAN, { id: 'grave-dandan', owner: 'player' });

  let state = makeState({
    player: {
      life: 20,
      hand: [],
      board: [fengraf, islandA, islandB, islandC],
      landsPlayed: 0
    },
    graveyard: [graveDandan]
  });

  expect(isActivatable(fengraf, state, 'player'), 'Fengraf should be activatable with Dandan in the graveyard');
  state = reducer(state, { type: 'PROMPT_ACTIVATE_LAND', cardId: fengraf.id, cardName: fengraf.name });
  expect(state.pendingAction?.type === 'ACTIVATE_LAND', 'Fengraf activation prompt did not open');
  state = reducer(state, { type: 'SUBMIT_PENDING_ACTION' });

  expect(!state.player.board.some((card) => card.id === fengraf.id), 'Fengraf stayed on the battlefield');
  expect(state.graveyard.some((card) => card.id === fengraf.id), 'Fengraf was not sacrificed to the graveyard');
  expect(state.player.hand.some((card) => card.id === graveDandan.id), 'Dandan was not returned to hand');
  expect(!state.graveyard.some((card) => card.id === graveDandan.id), 'Returned Dandan stayed in the graveyard');
});

test('Halimar Depths reorder persists chosen top-to-bottom order', () => {
  const halimar = makeCard(CARDS.HALIMAR, { id: 'halimar-1' });
  const topA = makeCard(CARDS.BRAINSTORM, { id: 'top-a' });
  const topB = makeCard(CARDS.PREDICT, { id: 'top-b' });
  const topC = makeCard(CARDS.DAYS_UNDOING, { id: 'top-c' });

  let state = makeState({
    deck: [topA, topB, topC],
    player: {
      life: 20,
      hand: [halimar],
      board: [],
      landsPlayed: 0
    }
  });

  state = reducer(state, { type: 'PLAY_LAND', player: 'player', cardId: halimar.id });
  expect(state.pendingAction?.type === 'HALIMAR_DEPTHS', 'Halimar Depths did not open reorder action');
  expect(state.pendingAction.cards.map((card) => card.id).join(',') === 'top-c,top-b,top-a', 'Unexpected initial Halimar reveal order');

  state = reducer(state, { type: 'REORDER_HALIMAR', from: 0, to: 2 });
  state = reducer(state, { type: 'SUBMIT_PENDING_ACTION' });

  const topThree = state.deck.slice(-3).map((card) => card.id).reverse();
  expect(topThree.join(',') === 'top-b,top-a,top-c', `Unexpected Halimar top order: ${topThree.join(',')}`);
});

test('cycling lands prompt for play or cycle when both are legal', () => {
  const sandbar = makeCard(CARDS.SANDBAR, { id: 'sandbar-1' });
  const island = makeCard(CARDS.ISLAND_1, { id: 'cycle-island' });

  const state = makeState({
    player: {
      life: 20,
      hand: [sandbar],
      board: [island],
      landsPlayed: 0
    }
  });

  const next = reducer(state, { type: 'PROMPT_HAND_LAND_ACTION', cardId: sandbar.id });
  expect(next.pendingAction?.type === 'HAND_LAND_ACTION', 'Cycling land prompt did not open');
  expect(next.pendingAction.canPlay === true, 'Cycling land prompt lost the play option');
  expect(next.pendingAction.canCycle === true, 'Cycling land prompt lost the cycle option');
});

test('cycling from the prompt actually resolves, taps mana, and draws', () => {
  const sandbar = makeCard(CARDS.SANDBAR, { id: 'sandbar-cycle' });
  const island = makeCard(CARDS.ISLAND_1, { id: 'cycle-fuel' });
  const drawCard = makeCard(CARDS.BRAINSTORM, { id: 'draw-after-cycle', owner: 'player' });

  let state = makeState({
    deck: [drawCard],
    player: {
      life: 20,
      hand: [sandbar],
      board: [island],
      landsPlayed: 0
    }
  });

  state = reducer(state, { type: 'PROMPT_HAND_LAND_ACTION', cardId: sandbar.id });
  expect(state.pendingAction?.type === 'HAND_LAND_ACTION', 'Cycle prompt did not open before cycling');
  state = reducer(state, { type: 'CYCLE_CARD', player: 'player', cardId: sandbar.id });

  expect(state.pendingAction === null, 'Cycle prompt stayed open after cycling');
  expect(state.player.board.some((card) => card.id === island.id && card.tapped), 'Cycling did not tap the mana source');
  expect(state.graveyard.some((card) => card.id === sandbar.id), 'Cycled land did not go to the graveyard');
  expect(!state.player.hand.some((card) => card.id === sandbar.id), 'Cycled land stayed in hand');
  expect(state.player.hand.some((card) => card.id === drawCard.id), 'Cycling did not draw a replacement card');
});

test('Svyelunite Temple sacrifices for {U}{U} and that mana can be spent this phase', () => {
  const temple = makeCard(CARDS.TEMPLE, { id: 'temple-1' });
  const chart = makeCard(CARDS.CHART, { id: 'chart-1', owner: 'player' });

  let state = makeState({
    player: {
      life: 20,
      hand: [chart],
      board: [temple],
      landsPlayed: 0
    }
  });

  expect(isActivatable(temple, state, 'player'), 'Temple should be activatable while untapped');
  state = reducer(state, { type: 'PROMPT_ACTIVATE_LAND', cardId: temple.id, cardName: temple.name });
  expect(state.pendingAction?.type === 'ACTIVATE_LAND', 'Temple activation prompt did not open');
  state = reducer(state, { type: 'SUBMIT_PENDING_ACTION' });

  expect(!state.player.board.some((card) => card.id === temple.id), 'Temple stayed on the battlefield after activation');
  expect(state.graveyard.some((card) => card.id === temple.id), 'Temple was not sacrificed');
  expect(state.floatingMana.player.total === 2 && state.floatingMana.player.blue === 2, 'Temple did not create {U}{U} floating mana');

  state = reducer(state, { type: 'CAST_SPELL', player: 'player', cardId: chart.id });

  expect(state.stack.some((entry) => entry.card.id === chart.id), 'Floating Temple mana could not cast Chart a Course');
  expect(state.floatingMana.player.total === 0 && state.floatingMana.player.blue === 0, 'Floating Temple mana was not spent by the cast');
});

test('Control Magic leaves with the enchanted Dandan when state-based actions kill it', () => {
  const aura = makeCard(CARDS.CONTROL_MAGIC, { id: 'aura-1', owner: 'player', enchantedId: 'stolen-dandan' });
  const stolenDandan = makeCard(CARDS.DANDAN, {
    id: 'stolen-dandan',
    owner: 'ai',
    summoningSickness: false,
    controlledByAuraId: aura.id
  });

  const state = makeState({
    player: {
      life: 20,
      hand: [],
      board: [stolenDandan, aura],
      landsPlayed: 0
    },
    ai: { life: 20, hand: [], board: [], landsPlayed: 0 }
  });

  const next = reducer(state, { type: 'NEXT_PHASE', silentPhaseSound: true });
  expect(!next.player.board.some((card) => card.id === stolenDandan.id), 'State-based actions did not remove the stolen Dandan');
  expect(!next.player.board.some((card) => card.id === aura.id), 'Control Magic stayed on the battlefield after its Dandan died');
  expect(next.graveyard.some((card) => card.id === stolenDandan.id), 'Dead Dandan did not reach the graveyard');
  expect(next.graveyard.some((card) => card.id === aura.id), 'Control Magic did not reach the graveyard');
});

test('Capture of Jingzhou adds an extra turn without skipping the current main phase', () => {
  const islands = [
    makeCard(CARDS.ISLAND_1, { id: 'i1' }),
    makeCard(CARDS.ISLAND_1, { id: 'i2' }),
    makeCard(CARDS.ISLAND_1, { id: 'i3' }),
    makeCard(CARDS.ISLAND_1, { id: 'i4' }),
    makeCard(CARDS.ISLAND_2, { id: 'i5' })
  ];
  const dandan = makeCard(CARDS.DANDAN, { id: 'dandan-1', summoningSickness: false });
  const capture = makeCard(CARDS.CAPTURE, { id: 'capture-1', owner: 'player' });
  const brainstorm = makeCard(CARDS.BRAINSTORM, { id: 'brainstorm-1', owner: 'player' });
  const enemyIsland = makeCard(CARDS.ISLAND_3, { id: 'enemy-island' });

  let state = makeState({
    player: {
      life: 20,
      hand: [capture, brainstorm],
      board: [...islands, dandan],
      landsPlayed: 0
    },
    ai: {
      life: 20,
      hand: [],
      board: [enemyIsland],
      landsPlayed: 0
    }
  });

  state = reducer(state, { type: 'CAST_SPELL', player: 'player', cardId: capture.id });
  state = reducer(state, { type: 'PASS_PRIORITY', player: 'ai' });
  state = reducer(state, { type: 'PASS_PRIORITY', player: 'player' });
  expect(state.stackResolving === true, 'Capture did not move to stack resolution');
  state = reducer(state, { type: 'RESOLVE_TOP_STACK' });

  expect(state.turn === 'player', 'Current turn changed when Capture resolved');
  expect(state.phase === 'main1', `Capture should leave the player in main1, got ${state.phase}`);
  expect(state.extraTurns.player === 1, `Capture did not add an extra turn, got ${state.extraTurns.player}`);
  expect(state.priority === 'player', 'Player did not regain priority after Capture resolved');
  expect(state.player.hand.some((card) => card.id === brainstorm.id), 'Post-Capture follow-up spell disappeared');
});

test('opponent skipped attack still gives the player an end-step instant window', () => {
  const island = makeCard(CARDS.ISLAND_1, { id: 'eot-island' });
  const brainstorm = makeCard(CARDS.BRAINSTORM, { id: 'eot-brainstorm', owner: 'player' });

  let state = makeState({
    turn: 'ai',
    phase: 'main2',
    priority: 'ai',
    player: {
      life: 20,
      hand: [brainstorm],
      board: [island],
      landsPlayed: 0
    },
    ai: {
      life: 20,
      hand: [],
      board: [],
      landsPlayed: 0
    }
  });

  state = reducer(state, { type: 'NEXT_PHASE' });

  expect(state.phase === 'cleanup', `Expected cleanup/end-step window, got ${state.phase}`);
  expect(state.turn === 'ai', 'Turn changed before the opponent end-step window');
  expect(state.priority === 'player', 'Priority did not pass to the player at opponent end step');
  expect(checkHasActions(state, 'player'), 'Player should have actions at opponent end step');

  state = reducer(state, { type: 'CAST_SPELL', player: 'player', cardId: brainstorm.id });

  expect(state.stack.some((entry) => entry.card.id === brainstorm.id), 'Player could not cast an instant at opponent end step');
  expect(state.turn === 'ai' && state.phase === 'cleanup', 'Casting an end-step instant changed the turn or phase incorrectly');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`All ${tests.length} regression checks passed.`);
}
