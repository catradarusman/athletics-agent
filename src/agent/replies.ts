// ─── Higher voice ──────────────────────────────────────────────────────────────
// all lowercase. no periods at end of last line. the last line carries weight.
// the bot counts. it doesn't motivate.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString();
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function commitmentCreated(p: {
  template:       string;
  duration:       number;
  requiredProofs: number;
  amount:         number;
  firstDeadline:  string;
}): string {
  return [
    `locked in. ${p.template} — ${p.duration} days, ${p.requiredProofs} proofs needed.`,
    `pledge: ${fmt(p.amount)} $HIGHER.`,
    `first proof due by ${p.firstDeadline}.`,
    `cast your work in /higher-athletics. i'm watching`,
  ].join('\n');
}

export function proofValid(p: {
  current:  number;
  total:    number;
  daysLeft: number;
}): string {
  return `✓ ${p.current}/${p.total}. ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`;
}

export function proofInvalid(): string {
  return [
    `couldn't verify this one. show the work — photo, screenshot, specifics.`,
    `then cast again`,
  ].join('\n');
}

export function proofDuplicate(): string {
  return [
    `already counted something like this.`,
    `show a different session`,
  ].join('\n');
}

export function status(p: {
  current:  number;
  total:    number;
  daysLeft: number;
  amount:   number;
  onTrack:  boolean;
}): string {
  const pace = p.onTrack ? 'on pace' : 'behind. pick it up';
  return [
    `${p.current}/${p.total} proofs. ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} remaining. pledge: ${fmt(p.amount)} $HIGHER.`,
    pace,
  ].join('\n');
}

export function poolInfo(p: {
  poolBalance:  number;
  activeCount:  number;
}): string {
  return [
    `pool: ${fmt(p.poolBalance)} $HIGHER.`,
    `${p.activeCount} active commitment${p.activeCount === 1 ? '' : 's'}`,
  ].join('\n');
}

export function commitmentPassed(p: {
  current:      number;
  total:        number;
  payout:       number;
  claimDetails?: string;
}): string {
  const claim = p.claimDetails ?? 'call claim() on the contract';
  return [
    `✓ ${p.current}/${p.total}. done.`,
    `${fmt(p.payout)} $HIGHER ready to claim.`,
    claim,
  ].join('\n');
}

export function commitmentFailed(p: {
  current: number;
  total:   number;
  amount:  number;
}): string {
  return [
    `${p.current}/${p.total}. fell short.`,
    `${fmt(p.amount)} $HIGHER to the pool`,
  ].join('\n');
}

export function reminderGentle(p: {
  current:  number;
  total:    number;
  daysLeft: number;
}): string {
  return `${p.current}/${p.total}. ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}. keep moving`;
}

export function reminderUrgent(p: {
  needed: number;
  hours:  number;
}): string {
  return [
    `${p.needed} more proof${p.needed === 1 ? '' : 's'}.`,
    `${p.hours} hours. this is it`,
  ].join('\n');
}

export function weeklyUpdate(p: {
  poolBalance: number;
  active:      number;
  passed:      number;
  failed:      number;
}): string {
  return [
    `pool: ${fmt(p.poolBalance)} $HIGHER`,
    `${p.active} active | ${p.passed} completed | ${p.failed} failed`,
    `higher`,
  ].join('\n');
}

export function noActiveCommitment(): string {
  return [
    `no active commitment found. start one:`,
    `@higherathletics commit [template] [tier]`,
    `templates: sprint, monthly-grind, builders-block, beast-mode`,
    `tiers: starter (1k), standard (5k), serious (10k), allin (25k)`,
  ].join('\n');
}
