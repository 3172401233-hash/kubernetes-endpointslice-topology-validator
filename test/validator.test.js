import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpointSlices } from '../src/validator.js';

function baseInput() {
  return {
    service: {
      name: 'web',
      selector: { app: 'web' },
      trafficPolicy: 'PreferSameZone',
    },
    pods: [
      { name: 'web-a', labels: { app: 'web' }, zone: 'zone-a', ready: true, serving: true, terminating: false },
      { name: 'web-b', labels: { app: 'web' }, zone: 'zone-b', ready: true, serving: true, terminating: false },
    ],
    endpointSlices: [
      {
        name: 'web-abc',
        ports: [{ name: 'http', port: 80, protocol: 'TCP' }],
        endpoints: [
          {
            targetRef: { name: 'web-a' },
            addresses: ['10.0.0.1'],
            zone: 'zone-a',
            conditions: { ready: true, serving: true, terminating: false },
            hints: { forZones: [{ name: 'zone-a' }] },
          },
          {
            targetRef: { name: 'web-b' },
            addresses: ['10.0.0.2'],
            zone: 'zone-b',
            conditions: { ready: true, serving: true, terminating: false },
            hints: { forZones: [{ name: 'zone-b' }] },
          },
        ],
      },
    ],
  };
}

test('computes per-zone effective endpoints from hints', () => {
  const report = validateEndpointSlices(baseInput());
  assert.equal(report.endpoints.effective.length, 2);
  assert.deepEqual(
    report.zones['zone-a'].endpoints.map((e) => e.name),
    ['web-a'],
  );
  assert.deepEqual(
    report.zones['zone-b'].endpoints.map((e) => e.name),
    ['web-b'],
  );
  assert.equal(report.unsafeRoutes.length, 0);
});

test('reports zone failure when a zone has no effective endpoints', () => {
  const input = baseInput();
  input.pods[1].ready = false;
  input.endpointSlices[0].endpoints[1].conditions.ready = false;
  input.endpointSlices[0].endpoints[1].hints = undefined;

  const report = validateEndpointSlices(input);
  assert.equal(report.zones['zone-b'].count, 0);
  const failure = report.unsafeRoutes.find((route) => route.type === 'zone-failure');
  assert.ok(failure, 'expected a zone-failure unsafe route');
  assert.equal(failure.zone, 'zone-b');
});

test('excludes terminating endpoints and flags hints that still route to them', () => {
  const input = baseInput();
  input.pods[1].terminating = true;
  input.endpointSlices[0].endpoints[1].conditions.terminating = true;

  const report = validateEndpointSlices(input);
  assert.equal(report.endpoints.effective.length, 1);
  const excluded = report.endpoints.excluded.find((e) => e.name === 'web-b');
  assert.ok(excluded.reasons.includes('terminating'));
  assert.ok(excluded.reasons.includes('pod-terminating'));
  const unsafe = report.unsafeRoutes.find((route) => route.type === 'hints-to-terminating-endpoint');
  assert.ok(unsafe, 'expected hints-to-terminating-endpoint unsafe route');
  assert.deepEqual(unsafe.zones, ['zone-b']);
});

test('flags state mismatch when slice reports serving but pod is terminating', () => {
  const input = baseInput();
  input.pods[1].terminating = true;

  const report = validateEndpointSlices(input);
  const mismatch = report.unsafeRoutes.find((route) => route.type === 'state-mismatch');
  assert.ok(mismatch, 'expected state-mismatch unsafe route');
  assert.equal(mismatch.endpoint, 'pod:web-b');
});

test('deduplicates endpoints repeated across slices', () => {
  const input = baseInput();
  input.endpointSlices.push({
    name: 'web-def',
    ports: [{ name: 'http', port: 80, protocol: 'TCP' }],
    endpoints: [
      {
        targetRef: { name: 'web-a' },
        addresses: ['10.0.0.1'],
        zone: 'zone-a',
        conditions: { ready: true, serving: true, terminating: false },
        hints: { forZones: [{ name: 'zone-a' }] },
      },
    ],
  });

  const report = validateEndpointSlices(input);
  assert.equal(report.endpoints.effective.length, 2, 'duplicate endpoint must not be counted twice');
  assert.equal(report.zones['zone-a'].count, 1);
  assert.equal(report.duplicateSlices.length, 1);
  assert.deepEqual(report.duplicateSlices[0].slices, ['web-abc', 'web-def']);
});

test('flags inconsistent hints pointing at unserving endpoints', () => {
  const input = baseInput();
  input.endpointSlices[0].endpoints[0].conditions.serving = false;

  const report = validateEndpointSlices(input);
  const unsafe = report.unsafeRoutes.find((route) => route.type === 'hints-to-unserving-endpoint');
  assert.ok(unsafe, 'expected hints-to-unserving-endpoint unsafe route');
  assert.equal(unsafe.endpoint, 'pod:web-a');
  assert.equal(report.zones['zone-a'].count, 0);
});

test('detects same-name ports with conflicting definitions across slices', () => {
  const input = baseInput();
  input.endpointSlices.push({
    name: 'web-def',
    ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
    endpoints: [],
  });

  const report = validateEndpointSlices(input);
  assert.equal(report.conflictingSlices.length, 1);
  assert.equal(report.conflictingSlices[0].portName, 'http');
  assert.equal(report.conflictingSlices[0].definitions.length, 2);
});

test('rejects unsupported traffic policies', () => {
  const input = baseInput();
  input.service.trafficPolicy = 'Random';
  assert.throws(() => validateEndpointSlices(input), /unsupported trafficPolicy/);
});
