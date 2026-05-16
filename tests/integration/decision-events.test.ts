import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from '../../src/decisions/service.js';
import { EventBus } from '../../src/events/bus.js';
import type { Event } from '../../src/events/types.js';

describe('DecisionService event emission', () => {
  let dir: string;
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-decevents-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    bus = new EventBus();
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function makeService(): DecisionService {
    return new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
      bus,
      project_id: 'test',
    });
  }

  it('emits decision.created on create()', () => {
    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    const service = makeService();
    const d = service.create({
      title: 'Use WAL',
      description: '',
      rationale: 'avoid blocking readers',
      governs: ['src/store.ts'],
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('decision.created');
    expect((emitted[0] as any).payload.decision_id).toBe(d.id);
    expect((emitted[0] as any).payload.governed_file_ids.length).toBe(1);
    expect(emitted[0].actor).toBe('claude');
    expect(emitted[0].project_id).toBe('test');
  });

  it('emits decision.updated on update()', () => {
    const service = makeService();
    const d = service.create({ title: 't', description: '', rationale: '' });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    service.update(d.id, { title: 't2' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('decision.updated');
    expect((emitted[0] as any).payload.changed_fields).toContain('title');
  });

  it('emits decision.superseded when update supplies superseded_by', () => {
    const service = makeService();
    const old = service.create({ title: 'old', description: '', rationale: '' });
    const nxt = service.create({ title: 'new', description: '', rationale: '' });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    service.update(old.id, { superseded_by: nxt.id, status: 'superseded' });

    const superseded = emitted.find((e) => e.kind === 'decision.superseded');
    expect(superseded).toBeDefined();
    expect((superseded as any).payload.old_id).toBe(old.id);
    expect((superseded as any).payload.new_id).toBe(nxt.id);
  });

  it('emits decision.deleted on delete() with title snapshot', () => {
    const service = makeService();
    const d = service.create({ title: 'gone', description: '', rationale: '' });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    service.delete(d.id);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('decision.deleted');
    expect((emitted[0] as any).payload.title).toBe('gone');
  });

  it('no bus is allowed — emissions silently skipped', () => {
    const service = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
    expect(() =>
      service.create({ title: 't', description: '', rationale: '' }),
    ).not.toThrow();
  });
});
