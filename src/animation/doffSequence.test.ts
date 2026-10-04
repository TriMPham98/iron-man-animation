import { describe, expect, it } from 'vitest';
import { buildSuitUpPlan } from './suitUpChoreography';
import { DOFF_ARM_STOW_SEC, doffArmStowAt, doffFloorDownAt, doffStandSinkAt } from './doffSequence';
import { robotStation } from '../workshop/fittingProgram';
import { STAND_RETRACT_SEC } from '../workshop/cradleStands';

describe('doff floor', () => {
  it('keeps the ring open until every floor arm and stand is down', () => {
    const plan = buildSuitUpPlan();
    const floor = plan.robots.filter((r) => robotStation(r.id).mount === 'floor');
    const shutFrom = doffFloorDownAt(floor, STAND_RETRACT_SEC);
    // The doff clock runs backwards: anything still going down at a seed
    // time below shutFrom would be caught by the closing blades
    for (const r of floor) {
      const stow = doffArmStowAt(r);
      if (stow != null) expect(stow - DOFF_ARM_STOW_SEC.floor).toBeGreaterThanOrEqual(shutFrom);
      for (const job of r.jobs) expect(doffStandSinkAt(job) - STAND_RETRACT_SEC).toBeGreaterThanOrEqual(shutFrom);
    }
  });
});
