import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from '../../src/decisions/service.js';
import { DecisionPromotion } from '../../src/decisions/promotion.js';
import { EventBus } from '../../src/events/bus.js';
import type { Event } from '../../src/events/types.js';

describe('DecisionPromotion event emission', () => {
  let dir: string;
  let db: Database.Database;
  let repo: DecisionsRepository;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-promoev-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    repo = new DecisionsRepository(db);
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('emits decision.promoted on promote() with from_tier and to_tier', () => {
    const bus = new EventBus();
    const service = new DecisionService({
      decisions: repo,
      links: new DecisionLinksRepository(db),
      bus,
      project_id: 'test',
    });
    const promotion = new DecisionPromotion(repo, { bus, project_id: 'test' });

    const d = service.create({
      title: 'Logging standard',
      description: 'desc',
      rationale: 'rationale',
    });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    promotion.promote(d.id, 'team');

    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event.kind).toBe('decision.promoted');
    if (event.kind === 'decision.promoted') {
      expect(event.payload.decision_id).toBe(d.id);
      expect(event.payload.from_tier).toBe('personal');
      expect(event.payload.to_tier).toBe('team');
    }
    expect(event.actor).toBe('claude');
    expect(event.project_id).toBe('test');
  });

  it('no bus is allowed — promote() still works', () => {
    const service = new DecisionService({
      decisions: repo,
      links: new DecisionLinksRepository(db),
    });
    const promotion = new DecisionPromotion(repo); // no bus — backwards compatible

    const d = service.create({ title: 't', description: '', rationale: '' });
    expect(() => promotion.promote(d.id, 'team')).not.toThrow();
  });
});
