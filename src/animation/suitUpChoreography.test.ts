import { describe, expect, it } from 'vitest';
import choreSeed from '../audio/choreTimeline.seed.json';
import { ARMOR_PIECES } from '../suit/armorPieces';
import { WAVE_ORDER } from '../suit/waves';
import { isSortedTrack } from './keyframes';
import { SEQUENCE_SEED_DURATION, audioTimelineOffset, HERO_END_CAM } from './sequenceClock';
import {
  buildSuitUpPlan,
  evaluateCamera,
  evaluateSuitUp,
  seedOnset,
  SFX_ONSETS,
} from './suitUpChoreography';

const plan = buildSuitUpPlan();
const clipIds = new Set((choreSeed as { clips: { id: string }[] }).clips.map((c) => c.id));

describe('SFX beat sheet', () => {
  it('pins every beat to a clip in the committed seed', () => {
    for (const o of Object.values(SFX_ONSETS)) {
      expect(clipIds.has(o.clip)).toBe(true);
      // Resolved seed time agrees with the authored fallback (seed unchanged)
      expect(seedOnset(o)).toBeCloseTo(o.fallback, 2);
    }
  });

  it('follows a re-timed clip', () => {
    const clips = (choreSeed as { clips: { id: string; start: number; cropIn: number; pitch: number }[] }).clips.map(
      (c) => (c.id === 'clip-seed-v5-07' ? { ...c, start: c.start + 0.5 } : c),
    );
    expect(buildSuitUpPlan(clips).beats.chestSlam).toBeCloseTo(plan.beats.chestSlam + 0.5, 6);
  });
});

describe('suit-up plan', () => {
  it('fits every piece exactly once, seated on its beat', () => {
    const ids = plan.pieces.map((p) => p.id).sort();
    expect(ids).toEqual(ARMOR_PIECES.map((p) => p.id).sort());
    for (const f of plan.fits) {
      for (const tr of plan.pieces.filter((p) => p.task === f.task)) {
        for (const k of [tr.carry, tr.insert, tr.hinge, tr.twist]) {
          expect(isSortedTrack(k)).toBe(true);
        }
      }
      const lead = evaluateSuitUp(plan, f.contact).pieces.find((p) => p.id === f.pieces[0])!;
      expect(lead.carry).toBe(1);
      expect(lead.insert).toBeCloseTo(0, 2);
    }
  });

  it('orders each robot job: transit → grasp → carry → insert → hold → release', () => {
    for (const f of plan.fits) {
      if (!f.robot) continue;
      const order = [f.depart, f.preGrasp, f.grasp, f.lift, f.stage, f.insert, f.contact, f.release, f.retreat, f.clear];
      for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    }
  });

  it('never double-books a robot', () => {
    for (const r of plan.robots) {
      for (let k = 1; k < r.jobs.length; k++) {
        expect(r.jobs[k].depart).toBeGreaterThanOrEqual(r.jobs[k - 1].clear - 1e-9);
        // Enough time to actually travel to the next cradle
        expect(r.jobs[k].preGrasp - r.jobs[k].depart).toBeGreaterThan(0.3);
      }
    }
  });

  it('builds inside → out: core before pecs, shoulders before biceps', () => {
    const contact = (task: string) => plan.fits.find((f) => f.task === task)!.contact;
    expect(contact('chest.core')).toBeLessThan(contact('pec.L'));
    expect(contact('chest.core')).toBeLessThan(contact('pec.R'));
    for (const s of ['L', 'R']) {
      expect(contact(`pauldron.${s}`)).toBeLessThan(contact(`upperArm.${s}`));
      expect(contact(`upperArm.${s}`)).toBeLessThan(contact(`forearm.${s}`));
      expect(contact(`forearm.${s}`)).toBeLessThan(contact(`gauntlet.${s}`));
    }
  });

  it('rivets land on ratchet clicks, only on seated parts', () => {
    for (const t of plan.tools) {
      expect(t.arrive).toBeLessThan(t.start);
      expect(t.start).toBeLessThan(t.end);
      expect(t.strikes.length).toBeGreaterThan(1);
      const seated = plan.fits.find((f) => (f.pieces as string[]).includes(t.piece))!;
      expect(t.start).toBeGreaterThan(seated.contact);
    }
  });

  it('every arm finishes its work, then stows', () => {
    for (const r of plan.robots) {
      const items = [
        ...r.jobs.map((j) => ({ start: j.depart, end: j.clear })),
        ...r.tools.map((j) => ({ start: j.depart, end: j.clear })),
      ];
      const last = Math.max(...items.map((i) => i.end));
      expect(r.stow[0].t).toBeGreaterThanOrEqual(last);
      expect(evaluateSuitUp(plan, SEQUENCE_SEED_DURATION).robots.find((x) => x.id === r.id)!.stow).toBe(1);
    }
  });

  it('wave starts follow WAVE_ORDER in time', () => {
    expect(plan.waves.map((w) => w.wave)).toEqual(WAVE_ORDER);
    for (let i = 1; i < plan.waves.length; i++) {
      expect(plan.waves[i].t).toBeGreaterThan(plan.waves[i - 1].t);
    }
  });

  it('starts with every part on its cradle in the pre-roll', () => {
    const f = evaluateSuitUp(plan, plan.preRoll);
    expect(plan.preRoll).toBeCloseTo(-audioTimelineOffset(), 6);
    expect(f.pieces.every((p) => p.carry === 0)).toBe(true);
    expect(f.pose.stance).toBe(0);
    expect(f.systems.reactor).toBe(0);
  });

  it('is fully seated, lit and back in the bind pose at the end', () => {
    const f = evaluateSuitUp(plan, SEQUENCE_SEED_DURATION);
    expect(f.final).toBe(true);
    for (const p of f.pieces) {
      expect(p.carry).toBe(1);
      expect(p.insert).toBe(0);
      expect(p.hinge).toBe(0);
      expect(p.twist).toBeCloseTo(0, 6);
    }
    for (const v of Object.values(f.pose)) expect(v).toBeCloseTo(0, 6);
    expect(f.systems).toEqual({ reactor: 1, eyes: 1, repulsors: 1 });
    // Every gripper open again
    for (const r of f.robots) expect(r.gripper).toBe(1);
  });

  it('arms are out for the arm pieces and down for the faceplate', () => {
    expect(evaluateSuitUp(plan, plan.beats.forearmL).pose.stance).toBeCloseTo(1, 3);
    expect(evaluateSuitUp(plan, plan.beats.faceplate).pose.stance).toBeCloseTo(0, 3);
  });

  it('ends the camera on the hero framing', () => {
    const c = evaluateCamera(plan, SEQUENCE_SEED_DURATION);
    for (const k of ['x', 'y', 'z', 'lx', 'ly', 'lz', 'fov'] as const) {
      expect(c[k]).toBeCloseTo(HERO_END_CAM[k], 4);
    }
  });

  it('keeps the camera outside OrbitControls minDistance', () => {
    for (let t = plan.preRoll; t <= SEQUENCE_SEED_DURATION; t += 0.05) {
      const c = evaluateCamera(plan, t);
      expect(Math.hypot(c.x - c.lx, c.y - c.ly, c.z - c.lz)).toBeGreaterThan(1.8);
    }
  });
});
